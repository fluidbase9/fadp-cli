# FADP Sample Project

Scaffolded by `@fluidwallet/fadp-cli` — a complete starter showing:

- **`server.js`** — Express API gated behind HTTP 402 (FADP protocol)
- **`agent.js`** — Agent that auto-pays on 402 and runs installed agent skills
- **`agents/`** — Symlinked Fluid agent skills (balance, swap, send, price, …)

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Copy your FLDP keys (generated during fadp setup)
cp ../.env.fadp .env          # or paste manually from .env.example

# 3. Start the gated server
node server.js

# 4. In a second terminal — run the paying agent
node agent.js
```

## How it works

```
agent.js
  │
  ├─ GET /api/data  ──────────────────────────────► server.js
  │                                                    │
  │                          ◄── 402 + payment info ───┤
  │                                                    │
  ├─ POST /api/fadp/pay ──► Fluid Wallet API           │
  │   (signs with FLDP key)                            │
  │                                                    │
  │                          ◄── receipt ──────────────┤
  │                                                    │
  ├─ GET /api/data                                     │
  │   X-Payment-Receipt: <receipt>  ──────────────► verified ✓
  │                                                    │
  └─ ◄── 200 + data ──────────────────────────────────┘
```

## Agent skills

Skills in `./agents/` are symlinked from `./fluid-wallet-skills/`.
Each skill has an `index.js` that exports `{ run(args) }`.

```js
const balance = require("./agents/balance");
const result  = await balance.run({ apiUrl, keyName });
```

| Skill | What it does |
|---|---|
| `authenticate` | Get a Fluid agent key |
| `balance` | Check wallet balances |
| `send` | Send USDC/ETH |
| `swap` | Swap tokens via Fluid SOR |
| `price` | Fetch live token prices |
| `quote` | Get swap quotes |
| `agent-pay` | Agent-to-agent payments |
| `fadp-pay` | Auto-pay FADP services |
| … | 20 skills total |

## Environment variables

| Variable | Description |
|---|---|
| `FLDP_API_KEY_NAME` | Your FLDP key name (`fluid/devkeys/…`) |
| `FLDP_API_KEY_PRIVATE_KEY` | JSON object with your private key |
| `PORT` | Server port (default 3001) |
| `FADP_PRICE_USDC` | Price to charge per API call (default 0.01) |
| `FLUID_API_URL` | Fluid API base URL |

## Links

- **FADP Docs:** https://fluidnative.com/fadp
- **Developer Console:** https://fluidnative.com/developer-dashboard
- **Agent Skills:** https://github.com/fluidbase9/fluid-wallet-skills
