const express = require("express");
const cors = require("cors");
const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");

const app = express();
app.use(cors());
app.use(express.json());

// Plaid config
const config = new Configuration({
  basePath: PlaidEnvironments.sandbox,
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": "691bf04834d0760024984be5",
      "PLAID-SECRET": "b49ee3ce442042ef5ea1187cb40a40",
    },
  },
});

const client = new PlaidApi(config);

// CREATE LINK TOKEN
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
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// EXCHANGE PUBLIC TOKEN
app.post("/exchange_public_token", async (req, res) => {
  try {
    const { public_token, user_id } = req.body;

    const response = await client.itemPublicTokenExchange({
      public_token
    });

    const access_token = response.data.access_token;

    // 🔥 STORE access_token in database under user_id
    console.log("User:", user_id);
    console.log("Access Token:", access_token);

    res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => console.log("Server running"));
