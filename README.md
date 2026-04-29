# @fluidwallet/fadp-cli

Interactive setup CLI for the **Fluid Agentic Developer Protocol (FADP)**. Registers your developer account, generates a P-256 EC key pair, and optionally scaffolds a full TypeScript project with agent skills.

## Usage

```bash
npx @fluidwallet/fadp-cli
```

No installation required. Run it in the root of your project directory.

## What it does

The CLI walks you through two setup modes:

### Mode 1 — Install FADP in an existing project

1. Creates or signs in to a Fluid developer account
2. Generates a P-256 ECDSA key pair locally (never leaves your machine)
3. Registers the public key with the Fluid API
4. Writes your keys to `.env.fadp` (chmod 600)
5. Installs the `fluid-fadp` npm package into your project
6. Prints a quick-start code snippet for Express

### Mode 2 — Scaffold a full TypeScript project

Everything in Mode 1, plus:

1. Clones the `fluid-wallet-skills` repo
2. Interactive skill selector — pick from 20 agent skills to symlink into `./agents/`
3. Scaffolds a `fadp-sample/` project with a gated API server and a paying agent ready to run

## Generated files

| File | Description |
|------|-------------|
| `.env.fadp` | Your `FLDP_API_KEY_NAME` and `FLDP_API_KEY_PRIVATE_KEY` — keep secret, add to `.gitignore` |
| `agents/` | Symlinked agent skills (Mode 2 only) |
| `fadp-sample/` | Scaffolded TypeScript project (Mode 2 only) |

## Environment variables

After setup, copy `.env.fadp` into your `.env`:

```env
FLDP_API_KEY_NAME="fluid/devkeys/<org>/<keyid>"
FLDP_API_KEY_PRIVATE_KEY='{"name":"...","privateKey":"-----BEGIN EC PRIVATE KEY-----\n..."}'
```

## EC key format

Keys are **P-256 ECDSA** (secp256r1), generated with Node's built-in `crypto` module — no dependencies required.

- Public key: SPKI PEM — registered with Fluid API for request verification
- Private key: PKCS8 PEM — signs your agent requests, shown once and written to `.env.fadp`

Key name format: `fluid/devkeys/<sha256-email-prefix>/<random-hex>`

## Agent skills

When using Mode 2, you can select from 20 composable agent skills:

| Skill | Description |
|-------|-------------|
| `authenticate` | Get a Fluid Wallet agent key (`fwag_...`) |
| `balance` | Check USDC, ETH and token balances |
| `send` | Send ETH or USDC to any address or email |
| `swap` | Swap tokens via Fluid SOR — best price on Base |
| `agent-pay` | Agent-to-agent USDC payments by email |
| `fadp-pay` | Auto-pay FADP-gated services in USDC |
| `quote` | Get swap quotes without executing |
| `price` | Fetch live token prices from Fluid oracle |
| `portfolio` | Full portfolio overview across chains |
| `yield` | Find best yield opportunities on Base |
| `bridge` | Cross-chain bridge assets via Fluid |
| `stake` | Stake ETH or tokens for on-chain yield |
| `liquidity` | Add or remove AMM liquidity positions |
| `borrow` | Borrow against collateral (Aave / Compound) |
| `nft-buy` | Buy NFTs on Base via agent command |
| `gas` | Estimate gas costs before executing |
| `monitor` | Watch wallet for incoming payments |
| `token-research` | Research token metrics, holders, volume |
| `dao-vote` | Vote on DAO proposals on Base |
| `deploy-contract` | Deploy Solidity contracts to Base mainnet |

Skills are symlinked from `fluid-wallet-skills/` into `./agents/` so you can edit them in place.

## Quick start (Mode 2 output)

```bash
# Install dependencies for the scaffolded sample project
cd fadp-sample && npm install

# Start the FADP-gated API server
node fadp-sample/server.js

# Run the paying agent (auto-pays 402 walls)
node fadp-sample/agent.js
```

## Security

- Your private key is **generated locally** and never sent to any server
- The CLI registers only the public key with the Fluid API
- `.env.fadp` is written with `chmod 600` — add it to `.gitignore` immediately
- Keys are shown **once** in the terminal — save them before pressing ENTER

## Requirements

- Node.js >= 18.0.0
- Git (for cloning agent skills in Mode 2)

## Links

- Protocol docs: https://fluidnative.com/fadp
- npm (`fluid-fadp` server/client package): https://www.npmjs.com/package/fluid-fadp
- GitHub: https://github.com/fluidbase9/fadp-cli

## License

MIT — Fluid Wallet &lt;dev@fluidnative.com&gt;
