/* =========================
   Fully automated Plaid + Stripe ACH Backend
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
      event = stripe.webhooks.constructEvent(req.body, sig, stripeWebhookSecret);
    } catch (err) {
      console.error("Webhook signature failed:", err.message);
      return res.status(400).send("Webhook error");
    }

    const paymentIntent = event.data.object;
    const userId = paymentIntent.metadata.userId;

    switch (event.type) {
      case "payment_intent.processing":
        await firestore.collection("users").doc(userId).set(
          { pendingDeposit: paymentIntent.amount / 100 },
          { merge: true }
        );
        break;
      case "payment_intent.succeeded":
        await firestore.collection("users").doc(userId).set(
          {
            savingsBalance: admin.firestore.FieldValue.increment(paymentIntent.amount / 100),
            pendingDeposit: 0,
          },
          { merge: true }
        );
        break;
      case "payment_intent.payment_failed":
        await firestore.collection("users").doc(userId).set(
          { pendingDeposit: 0 },
          { merge: true }
        );
        break;
    }

    res.json({ received: true });
  }
);

/* =========================
   HEALTH CHECK
========================= */
app.get("/", (req, res) => res.send("Plaid + Stripe backend running"));

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
      redirect_uri: "https://plaid-backend-1.onrender.com/plaid-success",
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
    if (!public_token || !user_id)
      return res.status(400).json({ error: "Missing parameters" });

    const response = await plaidClient.itemPublicTokenExchange({ public_token });
    const access_token = response.data.access_token;
    const item_id = response.data.item_id;

    // Get accounts
    const accountsResp = await plaidClient.accountsGet({ access_token });
    const accounts = accountsResp.data.accounts;
    const primaryAccount = accounts.find(
      (acc) => acc.subtype === "checking" || acc.subtype === "savings"
    );

    if (!primaryAccount)
      return res.status(400).json({ error: "No checking/savings account found" });

    const plaidAccountId = primaryAccount.account_id;

    // Store in Firestore
    await firestore.collection("users").doc(user_id).set(
      {
        plaidAccessToken: access_token,
        plaidItemId: item_id,
        plaidAccountId,
        bankConnected: true,
      },
      { merge: true }
    );

    res.json({ success: true, plaidAccountId });
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
    if (!user_id || !email) return res.status(400).json({ error: "Missing user_id or email" });

    const customer = await stripe.customers.create({ email });
    await firestore.collection("users").doc(user_id).set(
      { stripe_customer_id: customer.id },
      { merge: true }
    );

    res.json({ customerId: customer.id });
  } catch (err) {
    console.error("Stripe customer error:", err);
    res.status(500).json({ error: "Customer creation failed" });
  }
});

/* =========================
   DEPOSIT (Plaid → Stripe ACH) - with full logging
========================= */
app.post("/deposit", async (req, res) => {
  try {
    const { user_id, amount } = req.body;
    if (!user_id || amount === undefined)
      return res.status(400).json({ error: "Missing parameters" });

    const depositAmount = parseFloat(amount);
    if (isNaN(depositAmount) || depositAmount <= 0)
      return res.status(400).json({ error: "Invalid amount" });

    const userRef = firestore.collection("users").doc(user_id);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ error: "User not found" });

    const userData = userDoc.data();
    const { plaidAccessToken, plaidAccountId, email } = userData;

    if (!plaidAccessToken || !plaidAccountId)
      return res.status(400).json({ error: "Missing Plaid bank info" });

    let stripeCustomerId = userData.stripe_customer_id;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({ email });
      stripeCustomerId = customer.id;
      await userRef.set({ stripe_customer_id: stripeCustomerId }, { merge: true });
    }

    // Logging for identification
    console.log("User ID:", user_id);
    console.log("Plaid Access Token:", plaidAccessToken);
    console.log("Plaid Account ID:", plaidAccountId);
    console.log("Stripe Customer ID:", stripeCustomerId);
    console.log("Deposit Amount (double):", depositAmount);

    const processorResp = await plaidClient.processorTokenCreate({
      access_token: plaidAccessToken,
      account_id: plaidAccountId,
      processor: "stripe",
    });

    const stripeBankToken = processorResp.data.processor_token;
    console.log("Stripe Bank Token:", stripeBankToken);

    const paymentMethod = await stripe.paymentMethods.create({
      type: "us_bank_account",
      us_bank_account: { token: stripeBankToken },
      billing_details: { name: userData.name || "FlutterFlow User", email },
    });

    console.log("Stripe PaymentMethod ID:", paymentMethod.id);

    const depositCents = Math.round(depositAmount * 100);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: depositCents,
      currency: "usd",
      customer: stripeCustomerId,
      payment_method: paymentMethod.id,
      off_session: true,
      confirm: true,
      metadata: { userId: user_id },
    });

    console.log("PaymentIntent Status:", paymentIntent.status);
    console.log("PaymentIntent ID:", paymentIntent.id);

    // Firestore transaction
    const transactionRef = userRef.collection("transactions").doc();
    await transactionRef.set({
      type: "deposit",
      amount: depositAmount,
      date: admin.firestore.Timestamp.now(),
      status: paymentIntent.status,
      paymentIntentId: paymentIntent.id,
    });

    res.json({
      success: true,
      status: paymentIntent.status,
      paymentIntentId: paymentIntent.id,
    });
  } catch (err) {
    console.error("Deposit error full details:", err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message || "Deposit failed" });
  }
});

/* =========================
   GET BALANCE
========================= */
app.post("/get-balance", async (req, res) => {
  try {
    const { user_id } = req.body;
    const doc = await firestore.collection("users").doc(user_id).get();
    if (!doc.exists) return res.status(404).json({ error: "User not found" });

    const data = doc.data();
    res.json({
      savingsBalance: data.savingsBalance || 0,
      pendingDeposit: data.pendingDeposit || 0,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to get balance" });
  }
});

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running on port", PORT));
