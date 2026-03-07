/* =========================
   IMPORTS
========================= */
const express = require("express");
const cors = require("cors");
const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");
const admin = require("firebase-admin");
const bodyParser = require("body-parser"); // for Stripe raw body
const Stripe = require("stripe");
const path = require("path");

/* =========================
   APP SETUP
========================= */
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // serve static files

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
   STRIPE CONFIG
========================= */
const stripe = new Stripe(process.env.STRIPE_SECRET);

/* =========================
   HEALTH CHECK
========================= */
app.get("/", (req, res) => {
  res.status(200).send("Plaid + Stripe backend is running");
});

/* =========================
   PLAID ENDPOINTS
========================= */

// Create Link Token
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

// Exchange Public Token
app.post("/exchange_public_token", async (req, res) => {
  try {
    const { public_token, user_id } = req.body;
    if (!public_token || !user_id)
      return res.status(400).json({ error: "Missing public_token or user_id" });

    const response = await client.itemPublicTokenExchange({ public_token });
    const access_token = response.data.access_token;
    const item_id = response.data.item_id;

    // Get account balances immediately
    const balanceResponse = await client.accountsBalanceGet({
      access_token: access_token,
    });

    const balances = balanceResponse.data.accounts.map((account) => ({
      account_id: account.account_id,
      name: account.name,
      available: account.balances.available,
      current: account.balances.current,
      subtype: account.subtype,
      type: account.type,
    }));

    const actualBalance = balances.length > 0 ? balances[0].available : 0;

    // Save to Firestore
    await firestore.collection("users").doc(user_id).set(
      {
        bankConnected: true,
        plaidAccessToken: access_token,
        plaidItemId: item_id,
        balances: balances,
        actualBalance: actualBalance,
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

// Success Page
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

// Get Balance
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

/* =========================
   STRIPE WEBHOOK
========================= */
app.post(
  "/stripe-webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const event = JSON.parse(req.body.toString());

      if (event.type === "payment_intent.succeeded") {
        const paymentIntent = event.data.object;
        const userId = paymentIntent.metadata.userId;
        const amount = paymentIntent.amount;

        await firestore
          .collection("users")
          .doc(userId)
          .update({
            balance: admin.firestore.FieldValue.increment(amount / 100),
          });

        console.log(`Updated balance for ${userId}: +${amount / 100} USD`);
      }

      res.status(200).send("ok");
    } catch (err) {
      console.error("Stripe webhook error:", err);
      res.status(400).send(`Webhook error: ${err.message}`);
    }
  }
);

app.get("/stripe-webhook", (req, res) => {
  res.send("Stripe webhook endpoint is live. POST only!");
});

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
