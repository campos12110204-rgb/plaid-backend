const express = require("express");
const cors = require("cors");
const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");
const admin = require("firebase-admin");
const path = require("path");
const app = express();

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
