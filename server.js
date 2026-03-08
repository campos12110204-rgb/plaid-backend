const express = require("express");
const cors = require("cors");
const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");
const admin = require("firebase-admin");
const path = require("path");
const app = express();
const Stripe = require("stripe");

const stripe = new Stripe(process.env.STRIPE_SECRET); // Your Stripe secret key
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET; // From Stripe webhook setup

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // Serve static files

/* =========================
   FIREBASE SETUP
========================= */
// Load service account JSON directly (no env variable needed)
/* =========================
   FIREBASE SETUP
========================= */

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: serviceAccount.project_id,
    clientEmail: serviceAccount.client_email,
    privateKey: serviceAccount.private_key.replace(/\\n/g, '\n'),
  }),
});

const firestore = admin.firestore();

/* =========================
   PLAID CONFIG
========================= */
const client = new PlaidApi(
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
  res.status(200).send("Plaid backend is running");
});

/* =========================
   CREATE LINK TOKEN
========================= */
app.post("/create_link_token", async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: "Missing user_id" });

    const response = await client.linkTokenCreate({
      user: { client_user_id: user_id },
      client_name: "FlutterFlow App",
      products: ["auth", "transactions"],
      country_codes: ["US"],
      language: "en",
      redirect_uri: "https://plaid-backend-1.onrender.com/plaid-success",
    });

    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error("Link token error:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

/* =========================
   EXCHANGE PUBLIC TOKEN
========================= */
app.post("/exchange_public_token", async (req, res) => {
  try {
    const { public_token, user_id } = req.body;
    if (!public_token || !user_id)
      return res.status(400).json({ error: "Missing public_token or user_id" });

    const response = await client.itemPublicTokenExchange({ public_token });

    const access_token = response.data.access_token;
    const item_id = response.data.item_id;

    // Call Plaid balance endpoint immediately after exchanging token
const balanceResponse = await client.accountsBalanceGet({
  access_token: access_token,
});

// Build balance object
const balances = balanceResponse.data.accounts.map(account => ({
  account_id: account.account_id,
  name: account.name,
  available: account.balances.available,
  current: account.balances.current,
  subtype: account.subtype,
  type: account.type
}));
// Extract the first account’s available balance
const actualBalance = balances.length > 0 ? balances[0].available : 0;
// Save access token + balances in Firestore
await firestore.collection("users").doc(user_id).set(
  {
    bankConnected: true,
    plaidAccessToken: access_token,
    plaidItemId: item_id,
    balances: balances,
    actualBalance: actualBalance, // <-- now saved
    savingsBalance: 0, // <-- initialize to 0
    bankConnectedAt: admin.firestore.FieldValue.serverTimestamp(),
  },
  { merge: true }
);

    res.json({ success: true });
  } catch (err) {
    console.error("Exchange error:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

/* =========================
   DEPOSIT ENDPOINT (ACH via Plaid + Stripe)
========================= */
app.post("/deposit", async (req, res) => {
  try {
    const { user_id, amount } = req.body;

    if (!user_id || !amount) {
      return res.status(400).json({ error: "Missing user_id or amount" });
    }

    // Get user from Firestore
    const userDoc = await firestore.collection("users").doc(user_id).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    const accessToken = userDoc.data().plaidAccessToken;
    if (!accessToken) {
      return res.status(400).json({ error: "Bank not connected" });
    }

    // Use the first linked account
    const accountId = userDoc.data().balances[0].account_id;

    // Create Plaid processor token for Stripe
    const processorTokenResp = await client.processorTokenCreate({
      access_token: accessToken,
      account_id: accountId,
      processor: "stripe",
    });

    const stripeBankToken = processorTokenResp.data.processor_token;

    // Create Stripe customer if not exists
    let stripeCustomerId = userDoc.data().stripeCustomerId;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        metadata: { userId: user_id },
      });
      stripeCustomerId = customer.id;
      await firestore.collection("users").doc(user_id).update({ stripeCustomerId });
    }

    // Create PaymentIntent for ACH transfer
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // in cents
      currency: "usd",
      payment_method: stripeBankToken,
      customer: stripeCustomerId,
      off_session: true,
      confirm: true,
      metadata: { userId: user_id },
    });

    res.json({ success: true, paymentIntentId: paymentIntent.id });
  } catch (err) {
    console.error("Deposit error:", err.response?.data || err.message || err);
    res.status(500).json({ error: "Deposit failed" });
  }
});

/* =========================
   STRIPE WEBHOOK
========================= */
const bodyParser = require("body-parser"); // already imported

app.post(
  "/stripe-webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, stripeWebhookSecret);
    } catch (err) {
      console.error("Stripe signature error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      // When ACH deposit succeeds, update user's savings balance
      if (event.type === "payment_intent.succeeded") {
        const paymentIntent = event.data.object;
        const userId = paymentIntent.metadata.userId;
        const amount = paymentIntent.amount / 100; // convert cents to USD

        await firestore.collection("users").doc(userId).update({
          savingsBalance: admin.firestore.FieldValue.increment(amount),
        });

        console.log(`User ${userId} savings updated +$${amount}`);
      }

      res.status(200).send("ok");
    } catch (err) {
      console.error("Stripe webhook error:", err);
      res.status(500).send("Webhook processing error");
    }
  }
);

app.get("/stripe-webhook", (req, res) => {
  res.send("Stripe webhook endpoint active");
});

/* =========================
   SUCCESS PAGE
========================= */
app.get("/plaid-success", (req, res) => {
  res.send(`
    <html>
      <body style="text-align:center; font-family:sans-serif;">
        <h2>✅ Bank Connected Successfully</h2>
        <p>You may now return to the app.</p>
      </body>
    </html>
  `);
});
/* =========================
   GET ACCOUNT BALANCE
========================= */
app.post("/get-balance", async (req, res) => {
  try {
    const { user_id } = req.body;
    console.log("Received user_id:", user_id);

    if (!user_id) {
      return res.status(400).json({ error: "Missing user_id" });
    }

    // Get user from Firestore
    const userDoc = await firestore.collection("users").doc(user_id).get();
    console.log("Firestore doc exists:", userDoc.exists);

    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    const accessToken = userDoc.data().plaidAccessToken;
    console.log("Plaid Access Token:", accessToken);

    if (!accessToken) {
      return res.status(400).json({ error: "No Plaid access token found" });
    }

    // Call Plaid balance endpoint
    const balanceResponse = await client.accountsBalanceGet({
      access_token: accessToken,
    });

    console.log("Plaid balance response:", JSON.stringify(balanceResponse.data, null, 2));

    res.json(balanceResponse.data);

  } catch (err) {
    console.error("Balance error:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
