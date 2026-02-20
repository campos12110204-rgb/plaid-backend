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

// Create Link Token (for Plaid Link)
app.post("/create_link_token", async (req, res) => {
  try {
    const response = await client.linkTokenCreate({
      user: { client_user_id: "flutterflow-user" },
      client_name: "FlutterFlow App",
      products: ["auth"],
      country_codes: ["US"],
      language: "en",
    });
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Exchange Public Token for Access Token
app.post("/exchange_public_token", async (req, res) => {
  try {
    const { public_token } = req.body;

    if (!public_token) {
      return res.status(400).json({ success: false, error: "Missing public_token" });
    }

    const response = await client.itemPublicTokenExchange({ public_token });

    // Return success + access_token (sandbox/testing only)
    res.json({
      success: true,
      access_token: response.data.access_token
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Optional: Get Accounts
app.get("/get_accounts", async (req, res) => {
  try {
    const access_token = "<RETRIEVE_ACCESS_TOKEN_FOR_USER_FROM_DB>";
    const accountsResponse = await client.accountsGet({ access_token });
    res.json({ success: true, accounts: accountsResponse.data.accounts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(3000, () => console.log("Server running on port 3000"));
