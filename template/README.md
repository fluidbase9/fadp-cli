# FADP Sample Project  (FADP/1.0)

Scaffolded by `@fluidwallet/fadp-cli` — a working demo of the full FADP flow:

- **`server.js`** — Express API server gated behind HTTP 402 (FADP/1.0 protocol)
- **`agent.js`** — Agent that auto-pays on 402 using your `fwag_` key and retries

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Your .env was pre-filled by fadp-cli — verify it looks like:
#    FLUID_AGENT_KEY=fwag_...
#    FADP_WALLET_ADDRESS=0x...   (optional — set to receive real payments)
cat .env

# 3. Start the gated server (Terminal 1)
node server.js

# 4. Run the paying agent (Terminal 2)
node agent.js
```

## How it works (FADP/1.0 protocol)

```
agent.js
  │
  ├─ GET /api/data ─────────────────────────────────► server.js
  │                                                       │
  │   ◄── 402 + X-FADP-Required header ───────────────────┤
  │       { amount, token, chain, payTo, nonce }          │
  │                                                       │
  ├─ POST https://fluidnative.com/v1/agents/send          │
  │   header: X-Agent-Key: fwag_...       (your key)      │
  │   body:   { to, amount, token, chain }                │
  │                                                       │
  │   Fluid server:                                       │
  │     SHA256(fwag_) → DB lookup → email                 │
  │     → derive EVM wallet key in RAM                    │
  │     → sign USDC transfer → broadcast to Base          │
  │     → return { txHash, receipt }                      │
  │                                                       │
  ├─ GET /api/data ─────────────────────────────────► server.js
  │   header: X-FADP-Proof: { txHash, nonce, timestamp }  │
  │                                                       │
  │   server calls /v1/fadp/verify → checks Base chain    │
  │   correct amount + to address + token? ───► ✓         │
  │                                                       │
  └─ ◄── 200 + data ──────────────────────────────────────┘
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `FLUID_AGENT_KEY` | **Yes** | Your fwag_ key (pre-filled by fadp-cli). Never share this. |
| `FADP_WALLET_ADDRESS` | For real payments | Your Fluid wallet address to receive payments |
| `FADP_PRICE_USDC` | No | Price per API call in USDC (default: 0.01) |
| `PORT` | No | Server port (default: 3001) |
| `FLUID_API_URL` | No | Fluid API base URL (default: https://fluidnative.com) |

Get your wallet address: log in to fluidnative.com → Settings → Wallet Address

## Key that matters here

**Only one key is needed to run this demo:** `FLUID_AGENT_KEY` (a `fwag_` key).

- The agent uses it to send payments via Fluid (`X-Agent-Key` header)
- Fluid validates it, derives your EVM wallet, signs the tx, broadcasts it
- You never touch the wallet private key directly

## Links

- **FADP Docs:** https://fluidnative.com/fadp
- **Agent SDK:** https://www.npmjs.com/package/fluid-wallet-agentkit
- **FADP npm:**  https://www.npmjs.com/package/fluid-fadp
- **Developer Console:** https://fluidnative.com/developer-dashboard
