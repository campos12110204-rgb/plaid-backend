/* =========================
   Plaid + Stripe ACH Backend
========================= */

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const Stripe = require("stripe");
const admin = require("firebase-admin");
const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");

const app = express();

app.use(cors());
app.use(express.static(__dirname));

/* =========================
   STRIPE
========================= */

const stripe = new Stripe(process.env.STRIPE_SECRET);
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

/* =========================
   FIREBASE
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

      console.log("Balance updated:", userId, amount);
    }

    if (event.type === "payment_intent.payment_failed") {
      console.log("Payment failed:", paymentIntent.id);
    }

    res.json({ received: true });
  }
);

/* =========================
   JSON BODY PARSER
========================= */

app.use(express.json());

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
      products: ["auth"],
      country_codes: ["US"],
      language: "en",
      redirect_uri:
        "https://plaid-backend-1.onrender.com/plaid-success",
    });

    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error("Plaid link token error:", err);
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

    const user_id = req.body.user_id || req.body.userId;
    const email = req.body.email;

    if (!user_id || !email) {
      return res.status(400).json({ error: "Missing user_id or email" });
    }

    const customer = await stripe.customers.create({
      email: email,
    });

    await firestore.collection("users").doc(user_id).set(
      {
        stripe_customer_id: customer.id,
      },
      { merge: true }
    );

    console.log("Stripe customer saved:", user_id, customer.id);

    res.json({ customerId: customer.id });

  } catch (err) {
    console.error("Stripe customer error:", err);
    res.status(500).json({ error: "Customer creation failed" });
  }
});

/* =========================
   DEPOSIT (PLAID → STRIPE)
========================= */

app.post("/deposit", async (req, res) => {
  try {
    const { user_id, email, amount } = req.body;

    if (!user_id || !amount || !email) {
      return res.status(400).json({ error: "Missing user_id, email, or amount" });
    }

    const depositAmount = parseFloat(amount);
    if (isNaN(depositAmount) || depositAmount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    // 1️⃣ Fetch user from Firebase
    const userDoc = await firestore.collection("users").doc(user_id).get();
    let userData = userDoc.exists ? userDoc.data() : {};

    // 2️⃣ Ensure Stripe customer exists
    let stripeCustomerId = userData.stripe_customer_id;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({ email });
      stripeCustomerId = customer.id;

      await firestore.collection("users").doc(user_id).set(
        { stripe_customer_id: stripeCustomerId },
        { merge: true }
      );

      console.log("Created Stripe customer:", stripeCustomerId);
    }

    // 3️⃣ Ensure Plaid is connected
    const accessToken = userData.plaidAccessToken;
    if (!accessToken) {
      return res.status(400).json({ error: "User has not connected a bank" });
    }

    // 4️⃣ Get user bank account
    const accounts = await plaidClient.accountsGet({ access_token: accessToken });
    const account =
      accounts.data.accounts.find((a) => a.subtype === "checking") || accounts.data.accounts[0];
    const accountId = account.account_id;

    // 5️⃣ Create Stripe processor token from Plaid
    const processorTokenResponse = await plaidClient.processorTokenCreate({
      access_token: accessToken,
      account_id: accountId,
      processor: "stripe",
    });
    const processorToken = processorTokenResponse.data.processor_token;

    // 6️⃣ Create Stripe PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(depositAmount * 100),
      currency: "usd",
      customer: stripeCustomerId,
      payment_method_types: ["us_bank_account"],
      payment_method_data: {
        us_bank_account: { processor_token: processorToken },
      },
      confirm: true,
      metadata: { userId: user_id, depositAmount },
    });

    console.log("PaymentIntent created:", paymentIntent.id, paymentIntent.status);

    res.json({
      success: true,
      paymentIntentId: paymentIntent.id,
      status: paymentIntent.status,
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

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
