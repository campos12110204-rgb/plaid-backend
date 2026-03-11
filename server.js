const express = require("express");
const cors = require("cors");
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
   HEALTH
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

      user: {
        client_user_id: user_id,
      },

      client_name: "Savings App",

      products: ["auth"],

      country_codes: ["US"],

      language: "en"

    });

    res.json({
      link_token: response.data.link_token
    });

  } catch (err) {

    console.error("Link token error:", err.response?.data || err);

    res.status(500).json({
      error: err.response?.data || err.message
    });

  }

});

/* =========================
   EXCHANGE TOKEN
========================= */

app.post("/exchange_public_token", async (req, res) => {

  try {

    const { public_token, user_id } = req.body;

    const exchange = await plaidClient.itemPublicTokenExchange({
      public_token
    });

    const access_token = exchange.data.access_token;
    const item_id = exchange.data.item_id;

    const accounts = await plaidClient.accountsGet({
      access_token
    });

    const account = accounts.data.accounts[0];

    await firestore.collection("users").doc(user_id).set({

      plaidAccessToken: access_token,
      plaidAccountId: account.account_id,
      plaidItemId: item_id,
      bankConnected: true

    }, { merge: true });

    res.json({ success: true });

  } catch (err) {

    console.error("Exchange error:", err.response?.data || err);

    res.status(500).json({
      error: err.response?.data || err.message
    });

  }

});

/* =========================
   DEPOSIT
========================= */

app.post("/deposit", async (req, res) => {

  try {

    const { user_id, amount } = req.body;

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
      email
    } = user;

    /* Create Stripe customer */

    let customerId = user.stripe_customer_id;

    if (!customerId) {

      const customer = await stripe.customers.create({
        email
      });

      customerId = customer.id;

      await userRef.set({
        stripe_customer_id: customerId
      }, { merge: true });

    }

    /* Plaid → Stripe processor token */

    const processorResponse = await plaidClient.processorTokenCreate({

      access_token: plaidAccessToken,
      account_id: plaidAccountId,
      processor: "stripe"

    });

    const stripeBankToken = processorResponse.data.processor_token;

    /* Create payment method */

    const paymentMethod = await stripe.paymentMethods.create({

      type: "us_bank_account",

      us_bank_account: {
        token: stripeBankToken
      },

      billing_details: {
        email
      }

    });

    /* Create payment intent */

    const paymentIntent = await stripe.paymentIntents.create({

      amount: depositCents,
      currency: "usd",

      customer: customerId,

      payment_method: paymentMethod.id,

      payment_method_types: ["us_bank_account"],

      confirm: true,

      metadata: {
        userId: user_id
      }

    });

    res.json({

      success: true,
      status: paymentIntent.status

    });

  } catch (err) {

    console.error("Deposit error:", err.response?.data || err);

    res.status(500).json({
      success: false,
      error: err.response?.data || err.message
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
