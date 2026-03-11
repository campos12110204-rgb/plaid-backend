/* =========================
   PLAID + STRIPE ACH SERVER
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
app.use(express.static(__dirname));

/* Stripe webhook raw body */
app.use("/webhook", bodyParser.raw({ type: "application/json" }));

/* =========================
   STRIPE
========================= */

const stripe = new Stripe(process.env.STRIPE_SECRET);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

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

const db = admin.firestore();

/* =========================
   PLAID
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
  res.send("Plaid + Stripe ACH backend running");
});

/* =========================
   CREATE LINK TOKEN
========================= */

app.post("/create_link_token", async (req, res) => {
  try {

    const { user_id } = req.body;

    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: user_id },
      client_name: "Savings App",
      products: ["auth", "transactions"],
      country_codes: ["US"],
      language: "en",
    });

    res.json({ link_token: response.data.link_token });

  } catch (err) {
    console.error("Plaid error:", err);
    res.status(500).json({ error: "Link token failed" });
  }
});

/* =========================
   EXCHANGE TOKEN
========================= */

app.post("/exchange_public_token", async (req, res) => {

  try {

    const { public_token, user_id } = req.body;

    const response = await plaidClient.itemPublicTokenExchange({
      public_token,
    });

    const accessToken = response.data.access_token;
    const itemId = response.data.item_id;

    await db.collection("users").doc(user_id).set(
      {
        plaidAccessToken: accessToken,
        plaidItemId: itemId,
        bankConnected: true,
        connectedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    res.json({ success: true });

  } catch (err) {
    console.error("Token exchange error:", err);
    res.status(500).json({ error: "Exchange failed" });
  }

});

/* =========================
   CREATE STRIPE CUSTOMER
========================= */

app.post("/create-stripe-customer", async (req, res) => {

  try {

    const { user_id, email } = req.body;

    const customer = await stripe.customers.create({
      email,
    });

    await db.collection("users").doc(user_id).set(
      {
        stripeCustomerId: customer.id,
      },
      { merge: true }
    );

    res.json({ customerId: customer.id });

  } catch (err) {

    console.error(err);
    res.status(500).json({ error: "Customer creation failed" });

  }

});

/* =========================
   DEPOSIT MONEY (ACH)
========================= */

app.post("/deposit", async (req, res) => {

  try {

    const { user_id, amount } = req.body;

    const userDoc = await db.collection("users").doc(user_id).get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = userDoc.data();

    const accessToken = user.plaidAccessToken;
    const stripeCustomerId = user.stripeCustomerId;

    if (!accessToken || !stripeCustomerId) {
      return res.status(400).json({ error: "User not connected" });
    }

    /* Get bank account */

    const accounts = await plaidClient.accountsGet({
      access_token: accessToken,
    });

    const accountId = accounts.data.accounts[0].account_id;

    /* Convert Plaid → Stripe */

    const processorToken = await plaidClient.processorTokenCreate({
      access_token: accessToken,
      account_id: accountId,
      processor: "stripe",
    });

    const bankToken = processorToken.data.processor_token;

    const paymentMethod = await stripe.paymentMethods.create({
      type: "us_bank_account",
      us_bank_account: { token: bankToken },
    });

    await stripe.paymentMethods.attach(paymentMethod.id, {
      customer: stripeCustomerId,
    });

    /* Idempotency key prevents double withdrawal */

    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: Math.round(amount * 100),
        currency: "usd",
        customer: stripeCustomerId,
        payment_method: paymentMethod.id,
        payment_method_types: ["us_bank_account"],
        confirm: true,
        metadata: {
          userId: user_id,
          depositAmount: amount,
        },
      },
      {
        idempotencyKey: `${user_id}_${Date.now()}`,
      }
    );

    res.json({
      success: true,
      status: paymentIntent.status,
      paymentIntentId: paymentIntent.id,
    });

  } catch (err) {

    console.error("Deposit error:", err);

    res.status(500).json({
      error: "Deposit failed",
      details: err.message,
    });

  }

});

/* =========================
   STRIPE WEBHOOK
========================= */

app.post("/webhook", async (req, res) => {

  const sig = req.headers["stripe-signature"];

  let event;

  try {

    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      webhookSecret
    );

  } catch (err) {

    console.error("Webhook error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);

  }

  const paymentIntent = event.data.object;

  if (event.type === "payment_intent.succeeded") {

    const userId = paymentIntent.metadata.userId;
    const amount = paymentIntent.amount / 100;

    await db.collection("users").doc(userId).update({
      savingsBalance: admin.firestore.FieldValue.increment(amount),
    });

    console.log("Balance updated:", userId, amount);

  }

  res.json({ received: true });

});

/* =========================
   GET SAVINGS BALANCE
========================= */

app.post("/get-balance", async (req, res) => {

  try {

    const { user_id } = req.body;

    const doc = await db.collection("users").doc(user_id).get();

    if (!doc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({
      savingsBalance: doc.data().savingsBalance || 0,
    });

  } catch (err) {

    res.status(500).json({ error: "Balance fetch failed" });

  }

});

/* =========================
   START SERVER
========================= */

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
