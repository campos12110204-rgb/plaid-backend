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
      language: "en"

    });

    res.json({
      link_token: response.data.link_token
    });

  } catch (err) {

    console.error("Link token error:", err.response?.data || err);

    res.status(500).json({
      error: "Failed to create link token"
    });

  }

});

/* =========================
   EXCHANGE PUBLIC TOKEN
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

    const account = accounts.data.accounts.find(
      acc => acc.subtype === "checking" || acc.subtype === "savings"
    );

    if (!account) {
      return res.status(400).json({
        error: "No valid account found"
      });
    }

    await firestore.collection("users").doc(user_id).set({

      plaidAccessToken: access_token,
      plaidItemId: item_id,
      plaidAccountId: account.account_id,
      bankConnected: true

    }, { merge: true });

    res.json({
      success: true
    });

  } catch (err) {

    console.error("Exchange error:", err.response?.data || err);

    res.status(500).json({
      error: "Token exchange failed"
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

    if (!user_id || isNaN(depositAmount) || depositAmount <= 0) {
      return res.status(400).json({
        error: "Invalid deposit request"
      });
    }

    const depositCents = Math.round(depositAmount * 100);

    const userRef = firestore.collection("users").doc(user_id);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({
        error: "User not found"
      });
    }

    const user = userDoc.data();

    const {
      plaidAccessToken,
      plaidAccountId,
      email,
      stripe_customer_id
    } = user;

    if (!plaidAccessToken || !plaidAccountId) {
      return res.status(400).json({
        error: "Bank not connected"
      });
    }

    /* Create Stripe customer if missing */

    let customerId = stripe_customer_id;

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

    const processor = await plaidClient.processorTokenCreate({

      access_token: plaidAccessToken,
      account_id: plaidAccountId,
      processor: "stripe"

    });

    const stripeBankToken = processor.data.processor_token;

    /* Create Stripe PaymentMethod */

    const paymentMethod = await stripe.paymentMethods.create({

      type: "us_bank_account",
      us_bank_account: {
        token: stripeBankToken
      },

      billing_details: {
        email
      }

    });

    /* Create PaymentIntent */

    const paymentIntent = await stripe.paymentIntents.create({

      amount: depositCents,
      currency: "usd",
      customer: customerId,
      payment_method: paymentMethod.id,
      payment_method_types: ["us_bank_account"],
      confirm: true,

      metadata: {
        userId: user_id
      },

      mandate_data: {
        customer_acceptance: {
          type: "online",
          online: {
            ip_address: "127.0.0.1",
            user_agent: "FlutterFlow"
          }
        }
      }

    });

    /* Save transaction */

    await userRef.collection("transactions").add({

      type: "deposit",
      amount: depositAmount,
      status: paymentIntent.status,
      created: admin.firestore.FieldValue.serverTimestamp()

    });

    res.json({

      success: true,
      status: paymentIntent.status

    });

  } catch (err) {

    console.error("Deposit error:", err.response?.data || err);

    res.status(500).json({
      success: false,
      error: err.message
    });

  }

});

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

      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        stripeWebhookSecret
      );

    } catch (err) {

      console.error("Webhook signature failed:", err.message);

      return res.status(400).send("Webhook error");

    }

    const paymentIntent = event.data.object;
    const userId = paymentIntent.metadata.userId;

    const userRef = firestore.collection("users").doc(userId);

    switch (event.type) {

      case "payment_intent.processing":

        await userRef.set({
          pendingDeposit: paymentIntent.amount / 100
        }, { merge: true });

        break;

      case "payment_intent.succeeded":

        await userRef.set({

          savingsBalance: admin.firestore.FieldValue.increment(
            paymentIntent.amount / 100
          ),

          pendingDeposit: 0

        }, { merge: true });

        break;

      case "payment_intent.payment_failed":

        await userRef.set({
          pendingDeposit: 0
        }, { merge: true });

        break;

    }

    res.json({
      received: true
    });

  }
);

/* =========================
   SERVER
========================= */

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
