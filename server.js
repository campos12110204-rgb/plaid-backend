/* =========================
   server.js – Ready to Run
========================= */

const express = require("express");
const cors = require("cors");
const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");
const admin = require("firebase-admin");
const Stripe = require("stripe");
const bodyParser = require("body-parser");

const app = express();

// ====== ENV VARIABLES ======
// Make sure these are set in your environment:
// FIREBASE_SERVICE_ACCOUNT, STRIPE_SECRET, STRIPE_WEBHOOK_SECRET, PLAID_CLIENT_ID, PLAID_SECRET
const stripe = new Stripe(process.env.STRIPE_SECRET);
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

// ====== MIDDLEWARE ======
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ====== FIREBASE SETUP ======
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: serviceAccount.project_id,
    clientEmail: serviceAccount.client_email,
    privateKey: serviceAccount.private_key.replace(/\\n/g, "\n"),
  }),
});

const firestore = admin.firestore();

// ====== PLAID CONFIG ======
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

// ====== HEALTH CHECK ======
app.get("/", (req, res) => res.send("Plaid backend is running"));

// ====== CREATE LINK TOKEN ======
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

// ====== EXCHANGE PUBLIC TOKEN ======
app.post("/exchange_public_token", async (req, res) => {
  try {
    const { public_token, user_id } = req.body;
    if (!public_token || !user_id)
      return res.status(400).json({ error: "Missing public_token or user_id" });

    const response = await client.itemPublicTokenExchange({ public_token });
    const access_token = response.data.access_token;
    const item_id = response.data.item_id;

    const balanceResponse = await client.accountsBalanceGet({ access_token });
    const balances = balanceResponse.data.accounts.map((acct) => ({
      account_id: acct.account_id,
      name: acct.name,
      available: acct.balances.available,
      current: acct.balances.current,
      subtype: acct.subtype,
      type: acct.type,
    }));
    const actualBalance = balances.length > 0 ? balances[0].available : 0;

    await firestore.collection("users").doc(user_id).set(
      {
        bankConnected: true,
        plaidAccessToken: access_token,
        plaidItemId: item_id,
        balances,
        actualBalance,
        savingsBalance: 0,
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

// ====== DEPOSIT (ACH via Plaid + Stripe) ======
app.post("/deposit", async (req, res) => {
  try {
    const { user_id, amount } = req.body;
    if (!user_id || !amount) return res.status(400).json({ error: "Missing user_id or amount" });

    const userDoc = await firestore.collection("users").doc(user_id).get();
    if (!userDoc.exists) return res.status(404).json({ error: "User not found" });

    const userData = userDoc.data();
    const accessToken = userData.plaidAccessToken;
    const stripeCustomerId = userData.stripe_customer_id;

    if (!accessToken || !stripeCustomerId)
      return res.status(400).json({ error: "User not fully connected" });

    // Get Plaid accounts
    const accountsResp = await client.accountsGet({ access_token: accessToken });
    if (!accountsResp.data.accounts || accountsResp.data.accounts.length === 0)
      return res.status(400).json({ error: "No bank accounts found" });

    const accountId = accountsResp.data.accounts[0].account_id;

    const processorTokenResp = await client.processorTokenCreate({
      access_token: accessToken,
      account_id: accountId,
      processor: "stripe",
    });
    const stripeBankToken = processorTokenResp.data.processor_token;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(Number(amount) * 100),
      currency: "usd",
      payment_method: stripeBankToken,
      payment_method_types: ["us_bank_account"],
      customer: stripeCustomerId,
      confirm: true,
      metadata: { userId: user_id, depositAmount: amount },
    });

    res.json({ success: true, paymentIntentId: paymentIntent.id, status: paymentIntent.status });
  } catch (error) {
    console.error("Deposit error:", error);
    res.status(500).json({ error: "Deposit failed", details: error.message });
  }
});

// ====== STRIPE WEBHOOK ======
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
      if (event.type === "payment_intent.succeeded") {
        const paymentIntent = event.data.object;
        const userId = paymentIntent.metadata.userId;
        const amount = paymentIntent.amount / 100;

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

app.get("/stripe-webhook", (req, res) => res.send("Stripe webhook endpoint active"));

// ====== SUCCESS PAGE ======
app.get("/plaid-success", (req, res) =>
  res.send(`
    <html>
      <body style="text-align:center; font-family:sans-serif;">
        <h2>✅ Bank Connected Successfully</h2>
        <p>You may now return to the app.</p>
      </body>
    </html>
  `)
);

// ====== GET BALANCE ======
app.post("/get-balance", async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: "Missing user_id" });

    const userDoc = await firestore.collection("users").doc(user_id).get();
    if (!userDoc.exists) return res.status(404).json({ error: "User not found" });

    const accessToken = userDoc.data().plaidAccessToken;
    if (!accessToken) return res.status(400).json({ error: "No Plaid access token found" });

    const balanceResponse = await client.accountsBalanceGet({ access_token: accessToken });
    res.json(balanceResponse.data);
  } catch (err) {
    console.error("Balance error:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ====== START SERVER ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
