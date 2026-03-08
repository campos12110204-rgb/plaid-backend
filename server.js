/* =========================
   DEPOSIT ENDPOINT (ACH via Plaid + Stripe)
========================= */
app.post("/deposit", async (req, res) => {
  try {
    const { user_id, amount } = req.body;

    if (!user_id || !amount) {
      return res.status(400).json({ error: "Missing user_id or amount" });
    }

    // Get user from Firestore
    const userDoc = await firestore.collection("users").doc(user_id).get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    const userData = userDoc.data();
    const accessToken = userData.plaidAccessToken; // fixed field name
    const stripeCustomerId = userData.stripe_customer_id;

    if (!accessToken || !stripeCustomerId) {
      return res.status(400).json({ error: "User not fully connected" });
    }

    // Get accounts from Plaid
    const accountsResp = await client.accountsGet({
      access_token: accessToken,
    });

    if (!accountsResp.data.accounts || accountsResp.data.accounts.length === 0) {
      return res.status(400).json({ error: "No bank accounts found" });
    }

    const accountId = accountsResp.data.accounts[0].account_id;

    // Create Stripe processor token via Plaid
    const processorTokenResp = await client.processorTokenCreate({
      access_token: accessToken,
      account_id: accountId,
      processor: "stripe",
    });

    const stripeBankToken = processorTokenResp.data.processor_token;

    // Create Stripe PaymentIntent (ACH)
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(Number(amount) * 100), // amount in cents
      currency: "usd",
      payment_method: stripeBankToken,
      payment_method_types: ["us_bank_account"],
      customer: stripeCustomerId,
      confirm: true,
      metadata: {
        userId: user_id,
        depositAmount: amount,
      },
    });

    res.json({
      success: true,
      paymentIntentId: paymentIntent.id,
      status: paymentIntent.status,
    });
  } catch (error) {
    console.error("Deposit error:", error);
    res.status(500).json({
      error: "Deposit failed",
      details: error.message,
    });
  }
});
