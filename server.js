const express = require("express");
const cors = require("cors");
const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");
const admin = require("firebase-admin");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json());

// ✅ SERVE STATIC FILES (VERY IMPORTANT)
app.use(express.static(__dirname));

/* =========================
   FIREBASE SETUP
========================= */
// Load Firebase service account from environment variable
// server.js
const serviceAccount = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT.replace(/\\n/g, '\n')
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const firestore = admin.firestore();

/* =========================
   PLAID CONFIG
========================= */
const config = new Configuration({
  basePath: PlaidEnvironments.sandbox,
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
      "PLAID-SECRET": process.env.PLAID_SECRET,
    },
  },
});

const client = new PlaidApi(config);

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

    const response = await client.linkTokenCreate({
      user: { client_user_id: user_id },
      client_name: "FlutterFlow App",
      products: ["auth", "transactions"],
      country_codes: ["US"],
      language: "en",
    });

    res.json({ link_token: response.data.link_token });

  } catch (err) {
    console.error("Link token error:", err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   EXCHANGE PUBLIC TOKEN
========================= */
app.post("/exchange_public_token", async (req, res) => {
  try {
    const { public_token, user_id } = req.body;

    if (!public_token || !user_id) {
      return res.status(400).json({ error: "Missing public_token or user_id" });
    }

    const response = await client.itemPublicTokenExchange({
      public_token,
    });

    const access_token = response.data.access_token;
    const item_id = response.data.item_id;

    await firestore.collection("users").doc(user_id).set(
      {
        bankConnected: true,
        plaidAccessToken: access_token,
        plaidItemId: item_id,
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
   START SERVER
========================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
