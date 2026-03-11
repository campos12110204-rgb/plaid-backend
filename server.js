const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const admin = require("firebase-admin");
const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");
const bodyParser = require("body-parser");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// Stripe webhook requires raw body
app.use("/webhook", bodyParser.raw({ type: "application/json" }));

/* =========================
   STRIPE
========================= */
const stripe = new Stripe(process.env.STRIPE_SECRET);

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
   SERVE FRONTEND
========================= */
// Serve static files from 'public' folder
app.use(express.static(path.join(__dirname, "public")));

// For SPA routing: send index.html for all unmatched routes
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
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
      products: ["auth"],
      country_codes: ["US"],
      language: "en",
    });

    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error("Link token error:", err.response?.data || err);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

/* =========================
   EXCHANGE PUBLIC TOKEN
========================= */
app.post("/exchange_public_token", async (req, res) => {
  try {
    const { public_token, user_id } = req.body;
    const exchange = await plaidClient.itemPublicTokenExchange({ public_token });
    const access_token = exchange.data.access_token;
    const item_id = exchange.data.item_id;

    const accountsResponse = await plaidClient.accountsGet({ access_token });
    const accounts = accountsResponse.data.accounts.map((acct) => ({
      account_id: acct.account_id,
      name: acct.name,
      mask: acct.mask,
    }));

    await firestore.collection("users").doc(user_id).set(
      {
        plaidAccessToken: access_token,
        plaidItemId: item_id,
        plaidAccounts: accounts,
        bankConnected: true,
      },
      { merge: true }
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Exchange error:", err.response?.data || err);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

/* =========================
   DEPOSIT
========================= */
app.post("/deposit", async (req, res) => {
  try {
    const { user_id, amount, account_index = 0, idempotency_key } = req.body;
    const depositAmount = parseFloat(amount);

    if (isNaN(depositAmount) || depositAmount <= 0) {
      return res.status(400).json({ success: false, error: "Invalid amount" });
    }

    const depositCents = Math.round(depositAmount * 100);
    const userRef = firestore.collection("users").doc(user_id);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    const user = userDoc.data();
    const { plaidAccessToken, email, stripe_customer_id, plaidAccounts } = user;

    if (!plaidAccessToken || !Array.isArray(plaidAccounts) || !plaidAccounts[account_index]) {
      return res.status(400).json({ success: false, error: "Bank account not found or not linked" });
    }

    const account = plaidAccounts[account_index];

    // Ensure Stripe customer exists
    let customerId = stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email });
      customerId = customer.id;
      await userRef.set({ stripe_customer_id: customerId }, { merge: true });
    }

    // Plaid → Stripe processor token
    const processorResponse = await plaidClient.processorTokenCreate({
      access_token: plaidAccessToken,
      account_id: account.account_id,
      processor: "stripe",
    });

    const stripeBankToken = processorResponse.data.processor_token;

    // Create payment method
    const paymentMethod = await stripe.paymentMethods.create({
      type: "us_bank_account",
      us_bank_account: { token: stripeBankToken },
      billing_details: { email },
    });

    // Create payment intent
    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: depositCents,
        currency: "usd",
        customer: customerId,
        payment_method: paymentMethod.id,
        payment_method_types: ["us_bank_account"],
        confirm: true,
        metadata: { userId: user_id },
      },
      { idempotencyKey: idempotency_key || `deposit_${user_id}_${Date.now()}` }
    );

    res.json({ success: true, status: paymentIntent.status });
  } catch (err) {
    console.error("Deposit error:", err.response?.data || err);
    res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

/* =========================
   STRIPE WEBHOOK
========================= */
app.post("/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed.", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case "payment_intent.succeeded": {
      const paymentIntent = event.data.object;
      const userId = paymentIntent.metadata.userId;
      await firestore.collection("users").doc(userId).set(
        {
          lastDeposit: {
            amount: paymentIntent.amount / 100,
            currency: paymentIntent.currency,
            status: "succeeded",
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
          },
        },
        { merge: true }
      );
      console.log("Deposit succeeded for user:", userId);
      break;
    }
    case "payment_intent.payment_failed": {
      const paymentIntent = event.data.object;
      const userId = paymentIntent.metadata.userId;
      await firestore.collection("users").doc(userId).set(
        {
          lastDeposit: {
            amount: paymentIntent.amount / 100,
            currency: paymentIntent.currency,
            status: "failed",
            failure_message: paymentIntent.last_payment_error?.message || "Unknown",
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
          },
        },
        { merge: true }
      );
      console.log("Deposit failed for user:", userId);
      break;
    }
    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  res.json({ received: true });
});

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
