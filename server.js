/* =========================
   server.js – Plaid + Stripe ACH Backend
========================= */

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const Stripe = require("stripe");
const admin = require("firebase-admin");
const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // allows index.html

/* =========================
   ENV VARIABLES
========================= */

const stripe = new Stripe(process.env.STRIPE_SECRET);
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

/* =========================
   FIREBASE SETUP
========================= */

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: serviceAccount.project_id,
    clientEmail: serviceAccount.client_email,
    privateKey: serviceAccount.private_key.replace(/\\n/g, "\n"),
  }),
});

const firestore = admin.firestore();

/* =========================
   PLAID CONFIG
========================= */

const plaidClient = new PlaidApi(
  new Configuration({
    basePath: PlaidEnvironments.sandbox,
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
        "PLAID-SECRET": process.env.PLAID_SECRET,
      },
    },
  })
);

/* =========================
   HEALTH CHECK
========================= */

app.get("/", (req, res) => {
  res.send("Plaid + Stripe backend running");
});

/* =========================
   PLAID SUCCESS PAGE
========================= */

app.get("/plaid-success", (req, res) =>
  res.send(`
    <html>
      <body style="text-align:center;font-family:sans-serif">
        <h2>✅ Bank Connected</h2>
        <p>You may return to the app.</p>
      </body>
    </html>
  `)
);

/* =========================
   CREATE LINK TOKEN
========================= */

app.post("/create_link_token", async (req, res) => {
  try {
    const { user_id } = req.body;

    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: user_id },
      client_name: "FlutterFlow App",
      products: ["auth", "transactions"],
      country_codes: ["US"],
      language: "en",
      redirect_uri: "https://plaid-backend-1.onrender.com/plaid-success",
    });

    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error("Plaid link token error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to create link token" });
  }
});

/* =========================
   EXCHANGE PUBLIC TOKEN
========================= */

app.post("/exchange_public_token", async (req, res) => {
  try {
    const { public_token, user_id } = req.body;

    const response = await plaidClient.itemPublicTokenExchange({
      public_token,
    });

    const access_token = response.data.access_token;
    const item_id = response.data.item_id;

    await firestore.collection("users").doc(user_id).set(
      {
        plaidAccessToken: access_token,
        plaidItemId: item_id,
        bankConnected: true,
        bankConnectedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Exchange error:", err);
    res.status(500).json({ error: "Token exchange failed" });
  }
});

/* =========================
   CREATE STRIPE CUSTOMER
========================= */

app.post("/create-stripe-customer", async (req, res) => {
  try {
    const { user_id, email } = req.body;

    const customer = await stripe.customers.create({
      email: email,
    });

    await firestore.collection("users").doc(user_id).set(
      {
        stripe_customer_id: customer.id,
      },
      { merge: true }
    );

    res.json({ customerId: customer.id });
  } catch (err) {
    console.error("Stripe customer error:", err);
    res.status(500).json({ error: "Customer creation failed" });
  }
});

/* =========================
   DEPOSIT (PLAID → STRIPE ACH)
========================= */

app.post("/deposit", async (req, res) => {
  try {
    const { user_id, amount } = req.body;

    const userDoc = await firestore.collection("users").doc(user_id).get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    const userData = userDoc.data();

    const accessToken = userData.plaidAccessToken;
    const stripeCustomerId = userData.stripe_customer_id;

    if (!accessToken || !stripeCustomerId) {
      return res.status(400).json({ error: "User not connected properly" });
    }

    const accounts = await plaidClient.accountsGet({
      access_token: accessToken,
    });

    const accountId = accounts.data.accounts[0].account_id;

    const processorToken = await plaidClient.processorTokenCreate({
      access_token: accessToken,
      account_id: accountId,
      processor: "stripe",
    });

    const bankToken = processorToken.data.processor_token;

    const paymentMethod = await stripe.paymentMethods.create({
      type: "us_bank_account",
      us_bank_account: {
        token: bankToken,
      },
    });

    await stripe.paymentMethods.attach(paymentMethod.id, {
      customer: stripeCustomerId,
    });

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(Number(amount) * 100),
      currency: "usd",
      customer: stripeCustomerId,
      payment_method: paymentMethod.id,
      payment_method_types: ["us_bank_account"],
      confirm: true,
      metadata: {
        userId: user_id,
        depositAmount: amount,
      },
    });

    res.json({
      success: true,
      status: paymentIntent.status,
      paymentIntentId: paymentIntent.id,
    });
  } catch (error) {
    console.error("Deposit error:", error);
    res.status(500).json({
      error: "Deposit failed",
      details: error.message,
    });
  }
});

/* =========================
   STRIPE WEBHOOK
========================= */

app.post(
  "/stripe-webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    let event;

    try {
      const sig = req.headers["stripe-signature"];

      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        stripeWebhookSecret
      );
    } catch (err) {
      console.error("Webhook signature failed:", err.message);
      return res.status(400).send("Webhook error");
    }

    const paymentIntent = event.data.object;

    if (event.type === "payment_intent.processing") {
      console.log("ACH processing:", paymentIntent.id);
    }

    if (event.type === "payment_intent.succeeded") {
      const userId = paymentIntent.metadata.userId;
      const amount = paymentIntent.amount / 100;

      await firestore.collection("users").doc(userId).update({
        savingsBalance: admin.firestore.FieldValue.increment(amount),
      });

      console.log("Savings updated:", userId, amount);
    }

    res.status(200).json({ received: true });
  }
);

/* =========================
   GET BALANCE
========================= */

app.post("/get-balance", async (req, res) => {
  try {
    const { user_id } = req.body;

    const doc = await firestore.collection("users").doc(user_id).get();

    if (!doc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({
      savingsBalance: doc.data().savingsBalance || 0,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to get balance" });
  }
});

/* =========================
   START SERVER
========================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
