/* =========================
   DEPOSIT (Plaid → Stripe ACH) - with Firestore transactions
========================= */
app.post("/deposit", async (req, res) => {
  try {
    const { user_id, amount } = req.body;
    if (!user_id || amount === undefined)
      return res.status(400).json({ error: "Missing parameters" });

    // Convert slider input safely to float
    const depositAmount = parseFloat(amount);
    if (isNaN(depositAmount) || depositAmount <= 0)
      return res.status(400).json({ error: "Invalid amount" });

    const userRef = firestore.collection("users").doc(user_id);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ error: "User not found" });

    const userData = userDoc.data();
    const { plaidAccessToken, plaidAccountId, email } = userData;
    if (!plaidAccessToken || !plaidAccountId)
      return res.status(400).json({ error: "Missing Plaid bank info" });

    // Ensure Stripe customer exists
    let stripeCustomerId = userData.stripe_customer_id;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({ email });
      stripeCustomerId = customer.id;
      await userRef.set({ stripe_customer_id: stripeCustomerId }, { merge: true });
    }

    // Plaid → Stripe processor token
    const processorResp = await plaidClient.processorTokenCreate({
      access_token: plaidAccessToken,
      account_id: plaidAccountId,
      processor: "stripe",
    });
    const stripeBankToken = processorResp.data.processor_token;

    // Create PaymentMethod
    const paymentMethod = await stripe.paymentMethods.create({
      type: "us_bank_account",
      us_bank_account: { token: stripeBankToken },
      billing_details: { name: userData.name || "FlutterFlow User", email },
    });

    // Stripe expects integer cents
    const depositCents = Math.round(depositAmount * 100);

    // Create PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: depositCents,
      currency: "usd",
      customer: stripeCustomerId,
      payment_method: paymentMethod.id,
      off_session: true,
      confirm: true,
      metadata: { userId: user_id },
    });

    // ✅ Create Firestore transaction document
    const transactionRef = userRef.collection("transactions").doc();
    await transactionRef.set({
      type: "deposit",
      amount: depositAmount, // keep as double
      date: admin.firestore.Timestamp.now(),
      status: paymentIntent.status, // 'processing', 'succeeded', etc.
      paymentIntentId: paymentIntent.id,
    });

    res.json({
      success: true,
      status: paymentIntent.status,
      paymentIntentId: paymentIntent.id,
    });
  } catch (err) {
    console.error("Deposit error:", err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message || "Deposit failed" });
  }
});
