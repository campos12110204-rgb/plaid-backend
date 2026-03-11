const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const admin = require("firebase-admin");
const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");
const bodyParser = require("body-parser");

const app = express();

app.use(cors());
app.use(express.json());

/* STRIPE WEBHOOK RAW BODY */
app.use("/webhook", bodyParser.raw({ type: "application/json" }));

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

const db = admin.firestore();

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
   ROOT
========================= */

app.get("/", (req, res) => {
  res.send("Plaid Stripe backend running");
});

/* =========================
   CREATE PLAID LINK TOKEN
========================= */

app.post("/create_link_token", async (req, res) => {

  try {

    const { user_id } = req.body;

    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: user_id },
      client_name: "Savings App",
      products: ["auth"],
      country_codes: ["US"],
      language: "en",
    });

    res.json({ link_token: response.data.link_token });

  } catch (err) {

    console.error(err);
    res.status(500).json({ error: err.message });

  }

});

/* =========================
   EXCHANGE TOKEN
========================= */

app.post("/exchange_public_token", async (req, res) => {

  try {

    const { public_token, user_id } = req.body;

    const exchange = await plaidClient.itemPublicTokenExchange({
      public_token,
    });

    const access_token = exchange.data.access_token;

    const accounts = await plaidClient.accountsGet({
      access_token,
    });

    const account = accounts.data.accounts[0];

    await db.collection("users").doc(user_id).set(
      {
        plaidAccessToken: access_token,
        plaidAccountId: account.account_id,
      },
      { merge: true }
    );

    res.json({ success: true });

  } catch (err) {

    console.error(err);
    res.status(500).json({ error: err.message });

  }

});

/* =========================
   DEPOSIT MONEY
========================= */

app.post("/deposit", async (req, res) => {

  try {

    const { user_id, amount } = req.body;

    const userDoc = await db.collection("users").doc(user_id).get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = userDoc.data();

    const access_token = user.plaidAccessToken;
    const account_id = user.plaidAccountId;

    /* PLAID → STRIPE TOKEN */

    const processorToken = await plaidClient.processorTokenCreate({
      access_token,
      account_id,
      processor: "stripe",
    });

    const stripeBankToken = processorToken.data.processor_token;

    /* CREATE PAYMENT METHOD */

    const paymentMethod = await stripe.paymentMethods.create({
      type: "us_bank_account",
      us_bank_account: {
        token: stripeBankToken,
      },
    });

    /* CREATE PAYMENT INTENT */

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: "usd",
      payment_method_types: ["us_bank_account"],
      payment_method: paymentMethod.id,
      confirm: true,
      metadata: {
        userId: user_id,
      },
    });

    res.json({
      success: true,
      status: paymentIntent.status,
    });

  } catch (err) {

    console.error("Deposit error:", err);
    res.status(500).json({ error: err.message });

  }

});

/* =========================
   STRIPE WEBHOOK
========================= */

app.post("/webhook", async (req, res) => {

  const sig = req.headers["stripe-signature"];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {

    event = stripe.webhooks.constructEvent(req.body, sig, secret);

  } catch (err) {

    return res.status(400).send(`Webhook Error: ${err.message}`);

  }

  if (event.type === "payment_intent.succeeded") {

    const paymentIntent = event.data.object;
    const userId = paymentIntent.metadata.userId;

    await db.collection("users").doc(userId).set(
      {
        lastDeposit: paymentIntent.amount / 100,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

  }

  res.json({ received: true });

});

/* =========================
   START SERVER
========================= */

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
