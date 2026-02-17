const express = require("express");
const cors = require("cors");
const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");

const app = express();
app.use(cors());
app.use(express.json());

const config = new Configuration({
  basePath: PlaidEnvironments.sandbox,
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": "691bf04834d0760024984be5",
      "PLAID-SECRET":"b49ee3ce442042ef5ea1187cb40a40",
    },
  },
});

const client = new PlaidApi(config);

app.post("/create_link_token", async (req, res) => {
  const response = await client.linkTokenCreate({
    user: { client_user_id: "flutterflow-user" },
    client_name: "FlutterFlow App",
    products: ["auth"],
    country_codes: ["US"],
    language: "en",
  });

  res.json({ link_token: response.data.link_token });
});

app.post("/exchange_public_token", async (req, res) => {
  const { public_token } = req.body;

  const response = await client.itemPublicTokenExchange({
    public_token,
  });

  res.json({ access_token: response.data.access_token });
});

app.listen(3000, () => console.log("Server running on port 3000"));
