/* =========================
   Plaid + Stripe ACH Backend
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
   HEALTH CHECK
========================= */

app.get("/", (req, res) => {
  res.send("Backend running");
});

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
    });

    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error("Link token error:", err);
    res.status(500).json({ error: "Failed to create link token" });
  }
});

/* =========================
   EXCHANGE PUBLIC TOKEN
========================= */

app.post("/exchange_public_token", async (req, res) => {
  try {
    const { public_token, user_id } = req.body;

    const response = await plaidClient.itemPublicTokenExchange({
      public_token,
    });

    const access_token = response.data.access_token;
    const item_id = response.data.item_id;

    const accounts = await plaidClient.accountsGet({ access_token });

    const account = accounts.data.accounts.find(
      (a) => a.subtype === "checking" || a.subtype === "savings"
    );

    if (!account) {
      return res.status(400).json({ error: "No valid bank account found" });
    }

    await firestore.collection("users").doc(user_id).set(
      {
        plaidAccessToken: access_token,
        plaidItemId: item_id,
        plaidAccountId: account.account_id,
        bankConnected: true,
      },
      { merge: true }
    );

    res.json({ success: true });

  } catch (err) {
    console.error("Exchange error:", err);
    res.status(500).json({ error: "Token exchange failed" });
  }
});

/* =========================
   DEPOSIT
========================= */

app.post("/deposit", async (req, res) => {
  try {
    const { user_id, amount } = req.body;

    if (!user_id || !amount) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    const depositAmount = parseFloat(amount);
    const depositCents = Math.round(depositAmount * 100);

    const userRef = firestore.collection("users").doc(user_id);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = userDoc.data();

    const {
      plaidAccessToken,
      plaidAccountId,
      email,
      stripe_customer_id
    } = user;

    if (!plaidAccessToken || !plaidAccountId) {
      return res.status(400).json({ error: "Bank not connected" });
    }

    /* =========================
       CREATE STRIPE CUSTOMER
    ========================= */

    let customerId = stripe_customer_id;

    if (!customerId) {

      const customer = await stripe.customers.create({
        email: email,
      });

      customerId = customer.id;

      await userRef.set(
        { stripe_customer_id: customerId },
        { merge: true }
      );
    }

    /* =========================
       PLAID -> STRIPE TOKEN
    ========================= */

    const processorToken = await plaidClient.processorTokenCreate({
      access_token: plaidAccessToken,
      account_id: plaidAccountId,
      processor: "stripe",
    });

    const stripeBankToken = processorToken.data.processor_token;

    /* =========================
       CREATE PAYMENT METHOD
    ========================= */

    const paymentMethod = await stripe.paymentMethods.create({
      type: "us_bank_account",
      us_bank_account: { token: stripeBankToken },
      billing_details: {
        email: email,
      },
    });

    /* =========================
       CREATE PAYMENT INTENT
    ========================= */

    const paymentIntent = await stripe.paymentIntents.create({
      amount: depositCents,
      currency: "usd",
      customer: customerId,
      payment_method: paymentMethod.id,
      payment_method_types: ["us_bank_account"],
      confirm: true,
      metadata: {
        userId: user_id,
      },
      mandate_data: {
        customer_acceptance: {
          type: "online",
          online: {
            ip_address: "127.0.0.1",
            user_agent: "FlutterFlow",
          },
        },
      },
    });

    /* =========================
       SAVE TRANSACTION
    ========================= */

    await userRef.collection("transactions").add({
      type: "deposit",
      amount: depositAmount,
      status: paymentIntent.status,
      created: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({
      success: true,
      status: paymentIntent.status,
    });

  } catch (err) {

    console.error("DEPOSIT ERROR:");
    console.error(err);

    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/* =========================
   SERVER
========================= */

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
