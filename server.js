/* =========================
   PLAID + STRIPE ACH SERVER
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
app.use(express.static(__dirname));

/* Stripe webhook raw body */
app.use("/webhook", bodyParser.raw({ type: "application/json" }));

/* =========================
   STRIPE
========================= */

const stripe = new Stripe(process.env.STRIPE_SECRET);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

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
   HEALTH CHECK
========================= */

app.get("/", (req, res) => {
  res.send("Plaid + Stripe ACH backend running");
});

/* =========================
   CREATE LINK TOKEN
========================= */

app.post("/create_link_token", async (req, res) => {
  try {
    const { user_id } = req.body;

    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: user_id },
      client_name: "Savings App",
      products: ["auth", "transactions"],
      country_codes: ["US"],
      language: "en",
    });

    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error("Plaid error:", err);
    res.status(500).json({ error: "Link token failed" });
  }
});

/* =========================
   EXCHANGE TOKEN & AUTO-CREATE STRIPE CUSTOMER
========================= */
app.post("/exchange_public_token", async (req, res) => {
  try {
    const { public_token, user_id, email } = req.body;

    // Exchange Plaid public token
    const response = await plaidClient.itemPublicTokenExchange({ public_token });
    const accessToken = response.data.access_token;
    const itemId = response.data.item_id;

    // Fetch user doc
    const userRef = db.collection("users").doc(user_id);
    const userDoc = await userRef.get();

    // Auto-use Firestore email if not provided in request
    const userEmail = email || userDoc.data()?.email;

    if (!userEmail) {
      return res.status(400).json({ error: "Email required to create Stripe customer" });
    }

    // Create Stripe customer if missing
    let stripeCustomerId = userDoc.data()?.stripeCustomerId;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({ email: userEmail });
      stripeCustomerId = customer.id;
    }

    // Save Plaid info + Stripe customer ID
    await userRef.set(
      {
        plaidAccessToken: accessToken,
        plaidItemId: itemId,
        bankConnected: true,
        stripeCustomerId,
        connectedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    res.json({ success: true, stripeCustomerId });
  } catch (err) {
    console.error("Token exchange error:", err);
    res.status(500).json({ error: "Exchange or customer creation failed" });
  }
});

/* =========================
   DEPOSIT MONEY (ACH)
========================= */

app.post("/deposit", async (req, res) => {
  try {
    const { user_id, amount } = req.body;

    console.log("Deposit called with user_id:", user_id, "amount:", amount);

    // 1️⃣ Validate user_id
    if (!user_id || typeof user_id !== "string" || user_id.trim() === "") {
      return res.status(400).json({ error: "Missing or invalid user_id" });
    }

    // 2️⃣ Validate amount
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ error: "Invalid deposit amount" });
    }

    // 3️⃣ Fetch user document
    const userDoc = await db.collection("users").doc(user_id).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = userDoc.data();
    const accessToken = user.plaidAccessToken;
    const stripeCustomerId = user.stripeCustomerId;

    if (!accessToken || !stripeCustomerId) {
      return res.status(400).json({ error: "User not connected" });
    }

    // 4️⃣ Get Plaid bank account
    const accounts = await plaidClient.accountsGet({ access_token: accessToken });
    if (!accounts.data.accounts || accounts.data.accounts.length === 0) {
      return res.status(400).json({ error: "No bank account found" });
    }
    const accountId = accounts.data.accounts[0].account_id;

    // 5️⃣ Create Plaid → Stripe token
    const processorToken = await plaidClient.processorTokenCreate({
      access_token: accessToken,
      account_id: accountId,
      processor: "stripe",
    });
    const bankToken = processorToken.data.processor_token;

    // 6️⃣ Create Stripe PaymentMethod
    const paymentMethod = await stripe.paymentMethods.create({
      type: "us_bank_account",
      us_bank_account: { token: bankToken },
    });
    await stripe.paymentMethods.attach(paymentMethod.id, { customer: stripeCustomerId });

    // 7️⃣ Create Stripe PaymentIntent (Stripe expects integer cents)
    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: Math.round(amountNum * 100), // convert dollars to cents
        currency: "usd",
        customer: stripeCustomerId,
        payment_method: paymentMethod.id,
        payment_method_types: ["us_bank_account"],
        confirm: true,
        metadata: { userId: user_id, depositAmount: amountNum },
      },
      { idempotencyKey: `${user_id}_${Date.now()}` }
    );

    res.json({
      success: true,
      status: paymentIntent.status,
      paymentIntentId: paymentIntent.id,
    });
  } catch (err) {
    console.error("Deposit error:", err);
    res.status(500).json({ error: "Deposit failed", details: err.message });
  }
});
/* =========================
   STRIPE WEBHOOK
========================= */

app.post("/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error("Webhook error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const paymentIntent = event.data.object;

  if (event.type === "payment_intent.succeeded") {
    const userId = paymentIntent.metadata.userId;
    const amount = paymentIntent.amount / 100;

    await db.collection("users").doc(userId).update({
      savingsBalance: admin.firestore.FieldValue.increment(amount),
    });

    console.log("Balance updated:", userId, amount);
  }

  res.json({ received: true });
});

/* =========================
   GET SAVINGS BALANCE
========================= */

app.post("/get-balance", async (req, res) => {
  try {
    const { user_id } = req.body;
    const doc = await db.collection("users").doc(user_id).get();

    if (!doc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ savingsBalance: doc.data().savingsBalance || 0 });
  } catch (err) {
    res.status(500).json({ error: "Balance fetch failed" });
  }
});

/* =========================
   START SERVER
========================= */

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running on port", PORT));
