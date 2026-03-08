/* =========================
   IMPORTS
========================= */
const express = require("express");
const cors = require("cors");
const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");
const admin = require("firebase-admin");
const bodyParser = require("body-parser");
const Stripe = require("stripe");

/* =========================
   APP SETUP
========================= */
const app = express();

app.use(cors());
app.use(express.json());

/* =========================
   FIREBASE SETUP
========================= */

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  throw new Error("Missing FIREBASE_SERVICE_ACCOUNT env variable");
}

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
    basePath: PlaidEnvironments.sandbox, // change to production later
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
        "PLAID-SECRET": process.env.PLAID_SECRET,
      },
    },
  })
);

/* =========================
   STRIPE CONFIG
========================= */

const stripe = new Stripe(process.env.STRIPE_SECRET);
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

/* =========================
   HEALTH CHECK
========================= */

app.get("/", (req, res) => {
  res.json({
    status: "running",
    services: ["plaid", "stripe", "firebase"],
  });
});

/* =========================
   PLAID ENDPOINTS
========================= */

/* Create Link Token */
app.post("/create_link_token", async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: "Missing user_id" });
    }

    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: user_id },
      client_name: "My Fintech App",
      products: ["auth", "transactions"],
      country_codes: ["US"],
      language: "en",
      redirect_uri: process.env.PLAID_REDIRECT_URI,
    });

    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error("Link token error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to create link token" });
  }
});

/* Exchange Public Token */
app.post("/exchange_public_token", async (req, res) => {
  try {
    const { public_token, user_id } = req.body;

    if (!public_token || !user_id) {
      return res.status(400).json({ error: "Missing data" });
    }

    const response = await plaidClient.itemPublicTokenExchange({
      public_token,
    });

    const access_token = response.data.access_token;
    const item_id = response.data.item_id;

    /* Get balances */
    const balanceResponse = await plaidClient.accountsBalanceGet({
      access_token,
    });

    const balances = balanceResponse.data.accounts.map((account) => ({
      account_id: account.account_id,
      name: account.name,
      available: account.balances.available,
      current: account.balances.current,
      subtype: account.subtype,
      type: account.type,
    }));

    const actualBalance =
      balances.length > 0
        ? balances[0].available ?? balances[0].current
        : 0;

    /* Save user data */
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
    res.status(500).json({ error: "Token exchange failed" });
  }
});

/* Get Balance */
app.post("/get-balance", async (req, res) => {
  try {
    const { user_id } = req.body;

    const userDoc = await firestore.collection("users").doc(user_id).get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    const accessToken = userDoc.data().plaidAccessToken;

    if (!accessToken) {
      return res.status(400).json({ error: "Bank not connected" });
    }

    const balanceResponse = await plaidClient.accountsBalanceGet({
      access_token: accessToken,
    });

    res.json(balanceResponse.data);
  } catch (err) {
    console.error("Balance error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch balance" });
  }
});

/* Get Transactions */
app.post("/get-transactions", async (req, res) => {
  try {
    const { user_id } = req.body;

    const userDoc = await firestore.collection("users").doc(user_id).get();

    const accessToken = userDoc.data().plaidAccessToken;

    const transactionsResponse = await plaidClient.transactionsGet({
      access_token: accessToken,
      start_date: "2024-01-01",
      end_date: new Date().toISOString().split("T")[0],
    });

    res.json(transactionsResponse.data.transactions);
  } catch (err) {
    console.error("Transactions error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

/* =========================
   STRIPE WEBHOOK
========================= */

app.post(
  "/stripe-webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        stripeWebhookSecret
      );
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
          balance: admin.firestore.FieldValue.increment(amount),
        });

        console.log(`User ${userId} balance updated +$${amount}`);
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
   PLAID SUCCESS PAGE
========================= */

app.get("/plaid-success", (req, res) => {
  res.send(`
    <html>
      <body style="font-family:sans-serif;text-align:center;">
        <h2>✅ Bank Connected</h2>
        <p>You can return to the app.</p>
      </body>
    </html>
  `);
});

/* =========================
   START SERVER
========================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
