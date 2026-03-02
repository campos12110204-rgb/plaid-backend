// server.js
const express = require("express");
const cors = require("cors");
const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");
const admin = require("firebase-admin");
const path = require("path");
const serviceAccount = require(path.join(__dirname, "serviceAccountKey.json"));
const app = express();
app.use(cors());
app.use(express.json());

// ----------------------
// Firebase / Firestore setup
// ----------------------
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const firestore = admin.firestore();

// ----------------------
// Plaid config
// ----------------------
const config = new Configuration({
  basePath: PlaidEnvironments.sandbox, // Change to 'development' or 'production' as needed
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": "691bf04834d0760024984be5",
      "PLAID-SECRET": "b49ee3ce442042ef5ea1187cb40a40",
    },
  },
});

const client = new PlaidApi(config);

// ----------------------
// CREATE LINK TOKEN
app.post("/create_link_token", async (req, res) => {
  console.log("🔥 create_link_token HIT", new Date().toISOString(), req.body);

  try {
    const { user_id } = req.body;
    const response = await client.linkTokenCreate({
      user: { client_user_id: user_id },
      client_name: "FlutterFlow App",
      products: ["auth", "transactions"],
      country_codes: ["US"],
      language: "en",
    });

    console.log("Link token created for user:", user_id);
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error("Error creating link token:", err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// EXCHANGE PUBLIC TOKEN
app.post("/exchange_public_token", async (req, res) => {
  console.log("🔥 exchange_public_token HIT", new Date().toISOString(), req.body);

  try {
    const { public_token, user_id } = req.body;
    if (!public_token || !user_id) {
      return res.status(400).json({ error: "Missing public_token or user_id" });
    }

    const response = await client.itemPublicTokenExchange({ public_token });
    const access_token = response.data.access_token;
    const item_id = response.data.item_id;

    console.log("Plaid exchange successful for user:", user_id, access_token);

    await firestore.collection("users").doc(user_id).set({
      bankConnected: true,
      plaidAccessToken: access_token,
      plaidItemId: item_id,
      bankConnectedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    console.log("✅ Firestore updated successfully for user:", user_id);
    res.json({ success: true });
  } catch (err) {
    console.error("Exchange error:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});
// ----------------------
// PLAID SUCCESS PAGE
// ----------------------
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
// ----------------------
// Start server
// ----------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
