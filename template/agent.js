/**
 * FADP Sample — Paying Agent  (FADP/1.0)
 *
 * Uses your FLUID_AGENT_KEY (fwag_...) to autonomously:
 *   1. Show wallet balance — checks funds BEFORE attempting any payment
 *   2. Call a FADP-gated endpoint — auto-pay on 402, retry with proof
 *   3. Send USDC to another agent (agent-to-agent payment)
 *   4. Fetch a live token price
 *
 * Every payment shows a full receipt with BaseScan explorer proof.
 * If balance is too low, you are told exactly how to fund the wallet.
 *
 * Run:  node agent.js
 */

"use strict";

require("dotenv").config();

const https  = require("https");
const http   = require("http");
const { spawn } = require("child_process");
const path   = require("path");

// ── Config ────────────────────────────────────────────────────────────────────
const FLUID_API_URL   = process.env.FLUID_API_URL  || "https://fluidnative.com";
const FLUID_AGENT_KEY = process.env.FLUID_AGENT_KEY;  // fwag_...
const SERVER_URL      = `http://localhost:${process.env.PORT || 3001}`;

if (!FLUID_AGENT_KEY || !FLUID_AGENT_KEY.startsWith("fwag_")) {
  console.error([
    "",
    "  ✗  FLUID_AGENT_KEY is not set or invalid.",
    "     It must start with fwag_ — run fadp-cli setup to generate one.",
    "",
  ].join("\n"));
  process.exit(1);
}

// ── ANSI colour helpers ───────────────────────────────────────────────────────
const C = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  green:  "\x1b[32m",
  cyan:   "\x1b[36m",
  yellow: "\x1b[33m",
  red:    "\x1b[31m",
  gray:   "\x1b[90m",
  blue:   "\x1b[34m",
  white:  "\x1b[37m",
};
const log  = m  => console.log(m);
const ok   = m  => log(`  ${C.green}✓${C.reset}  ${m}`);
const info = m  => log(`  ${C.cyan}→${C.reset}  ${m}`);
const warn = m  => log(`  ${C.yellow}⚠${C.reset}  ${m}`);
const err  = m  => log(`  ${C.red}✗${C.reset}  ${m}`);
const div  = () => log(`  ${C.gray}${"─".repeat(60)}${C.reset}`);

// ── HTTP helper ────────────────────────────────────────────────────────────────
// Returns { status, body, headers }.  headers is the Node IncomingMessage object.
function httpRequest(urlStr, opts = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url     = new URL(urlStr);
    const mod     = url.protocol === "https:" ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === "https:" ? 443 : 80),
      path:     url.pathname + url.search,
      method:   opts.method || "GET",
      headers:  {
        "Content-Type": "application/json",
        "User-Agent":   "fadp-agent/1.0",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        ...(opts.headers || {}),
      },
    };
    const req = mod.request(options, res => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end",  () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Fluid API (always sends X-Agent-Key) ──────────────────────────────────────
function fluidApi(path, method = "GET", body = null) {
  return httpRequest(`${FLUID_API_URL}${path}`, {
    method,
    headers: { "X-Agent-Key": FLUID_AGENT_KEY },
  }, body);
}

// ── Receipt printer ───────────────────────────────────────────────────────────
// Shows every detail of a transaction + a clickable BaseScan explorer link.
function printReceipt(payRes) {
  const { txHash, explorerUrl, receipt } = payRes.body || {};
  if (!txHash) return;

  log("");
  log(`  ${C.bold}${C.green}  ┌─ PAYMENT RECEIPT ─────────────────────────────────────┐${C.reset}`);

  if (receipt) {
    log(`  ${C.bold}  │ Receipt ID:  ${C.reset}${receipt.id ?? "—"}`);
    log(`  ${C.bold}  │ Protocol:    ${C.reset}${receipt.protocol ?? "FADP/1.0"}`);
    log(`  ${C.bold}  │ Network:     ${C.reset}${receipt.network ?? "Base Mainnet"} (Chain ${receipt.chainId ?? 8453})`);
    log(`  ${C.bold}  │ Timestamp:   ${C.reset}${receipt.timestamp ?? new Date().toISOString()}`);
    log(`  ${C.bold}  │`);

    const fromUoi = receipt.from?.uoi ?? null;
    const fromAddr = receipt.from?.address ?? "—";
    log(`  ${C.bold}  │ From (sender)${C.reset}`);
    if (fromUoi)  log(`  ${C.bold}  │   UOI:     ${C.reset}${C.cyan}${fromUoi}${C.reset}`);
    log(`  ${C.bold}  │   Address: ${C.reset}${fromAddr}`);

    const toUoi  = receipt.to?.uoi ?? null;
    const toAddr = receipt.to?.address ?? "—";
    log(`  ${C.bold}  │`);
    log(`  ${C.bold}  │ To (recipient)${C.reset}`);
    if (toUoi)    log(`  ${C.bold}  │   UOI:     ${C.reset}${C.cyan}${toUoi}${C.reset}`);
    log(`  ${C.bold}  │   Address: ${C.reset}${toAddr}`);

    if (receipt.payment) {
      log(`  ${C.bold}  │`);
      log(`  ${C.bold}  │ Amount:      ${C.reset}${C.green}${receipt.payment.amount} ${receipt.payment.token}${C.reset}`);
      if (receipt.payment.tokenAddress) {
        log(`  ${C.bold}  │ Token Addr:  ${C.reset}${C.gray}${receipt.payment.tokenAddress}${C.reset}`);
      }
    }
  }

  log(`  ${C.bold}  │`);
  log(`  ${C.bold}  │ Tx Hash:     ${C.reset}${txHash}`);
  const link = explorerUrl ?? `https://basescan.org/tx/${txHash}`;
  log(`  ${C.bold}  │ BaseScan:    ${C.reset}${C.blue}${link}${C.reset}`);
  log(`  ${C.bold}${C.green}  └───────────────────────────────────────────────────────┘${C.reset}`);
  log("");
}

// ── Balance checker ───────────────────────────────────────────────────────────
// Fetches USDC balance on Base.
// Returns { balances, walletAddress, usdc } where usdc is a number.
async function getBalance(chain = "base") {
  const res = await fluidApi(`/v1/agents/balance?chain=${chain}`);
  if (!res || res.status !== 200) return { balances: [], walletAddress: null, usdc: 0 };
  const { balances = [], walletAddress } = res.body;
  const usdcEntry = balances.find(b =>
    b.token?.toUpperCase() === "USDC" && (b.chain === chain || !b.chain)
  );
  const usdc = parseFloat(usdcEntry?.amount ?? "0");
  return { balances, walletAddress, usdc };
}

// ── Pre-payment balance check ─────────────────────────────────────────────────
// Shows current balance. If insufficient, prints funding instructions and returns false.
async function checkBalanceBeforePayment(amount, token = "USDC", chain = "base") {
  info(`Checking ${token} balance on ${chain} before payment…`);

  const { balances, walletAddress, usdc } = await getBalance(chain);

  log("");
  log(`  ${C.bold}  Wallet Balance (${chain}):${C.reset}`);
  if (balances.length === 0) {
    log(`    ${C.gray}No balances found${C.reset}`);
  }
  for (const b of balances) {
    const highlight = b.token?.toUpperCase() === "USDC" ? C.green : C.gray;
    log(`    ${highlight}${b.token}: ${b.amount}${C.reset}`);
  }
  if (walletAddress) {
    log(`  ${C.dim}  Wallet: ${walletAddress}${C.reset}`);
  }
  log("");

  const needed = parseFloat(amount);
  if (token.toUpperCase() !== "USDC") {
    ok(`Proceeding (non-USDC payment — balance check skipped for ${token})`);
    return true;
  }

  if (!walletAddress) {
    warn("Balance endpoint unavailable — proceeding without balance check");
    return true;
  }

  if (usdc < needed) {
    err(`Insufficient USDC balance`);
    log(`    Have:   ${C.yellow}${usdc.toFixed(6)} USDC${C.reset}`);
    log(`    Need:   ${C.green}${needed.toFixed(6)} USDC${C.reset}`);
    log(`    Short:  ${C.red}${(needed - usdc).toFixed(6)} USDC${C.reset}`);
    log("");
    log(`  ${C.bold}${C.cyan}  How to fund your wallet:${C.reset}`);
    log(`    1. Network: Base mainnet (Chain ID 8453)`);
    log(`    2. Token:   USDC (native on Base)`);
    log(`       Contract: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`);
    log(`    3. Send ${needed.toFixed(6)} USDC or more to:`);
    log(`       ${C.bold}${walletAddress}${C.reset}`);
    log(`    4. Then run this agent again.\n`);
    return false;
  }

  ok(`Balance OK — ${usdc.toFixed(6)} USDC available (need ${needed.toFixed(6)})`);
  return true;
}

// ── FADP: auto-pay on 402, retry with proof ────────────────────────────────────
// Full FADP/1.0 implementation:
//   1. Check balance before paying
//   2. Pay via Fluid (X-Agent-Key → server derives wallet key → signs on-chain)
//   3. Print receipt with BaseScan proof
//   4. Retry original request with X-FADP-Proof
async function fadpFetch(url, opts = {}) {
  const res = await httpRequest(url, opts).catch(e => {
    warn(`Could not reach server at ${url}: ${e.message}`);
    return null;
  });
  if (!res) return null;
  if (res.status !== 402) return res;

  // ── Parse X-FADP-Required header ─────────────────────────────────────────
  const fadpHeader = res.headers["x-fadp-required"];
  if (!fadpHeader) {
    warn("Got 402 but no X-FADP-Required header — not a FADP/1.0 endpoint");
    return res;
  }

  let payment;
  try { payment = JSON.parse(fadpHeader); }
  catch { warn("X-FADP-Required header is not valid JSON"); return res; }

  const { amount = "0.01", token = "USDC", chain = "base", payTo, nonce, description } = payment;

  log(`\n  ${C.bold}  FADP Payment Required${C.reset}`);
  div();
  log(`  Service:  ${description ?? "API access"}`);
  log(`  Amount:   ${C.green}${amount} ${token}${C.reset} on ${chain}`);
  log(`  Payee:    ${payTo ?? "(unset)"}`);
  div();

  if (!payTo) {
    err("402 response has no payTo address — cannot pay");
    return null;
  }

  // ── Check balance before paying ───────────────────────────────────────────
  const canPay = await checkBalanceBeforePayment(amount, token, chain);
  if (!canPay) {
    err("Payment aborted — please fund your wallet and try again");
    return null;
  }

  // ── Send payment via Fluid ────────────────────────────────────────────────
  info(`Sending ${amount} ${token} via Fluid Wallet…`);
  const payRes = await fluidApi("/v1/agents/send", "POST", { to: payTo, amount, token, chain });

  if (!payRes || payRes.status !== 200) {
    err(`Payment failed (${payRes?.status}): ${JSON.stringify(payRes?.body)}`);
    return null;
  }

  const { txHash } = payRes.body;
  ok(`Payment confirmed on-chain!`);

  // ── Print full receipt ────────────────────────────────────────────────────
  printReceipt(payRes);

  // ── Retry original request with X-FADP-Proof ─────────────────────────────
  info(`Retrying ${url} with payment proof…`);
  return httpRequest(url, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      "X-FADP-Proof": JSON.stringify({
        txHash,
        nonce,
        agentKeyPrefix: FLUID_AGENT_KEY.slice(0, 12),
        timestamp: Math.floor(Date.now() / 1000),
      }),
    },
  });
}

// ── Agent-to-agent USDC payment ───────────────────────────────────────────────
// Sends USDC directly to another Fluid Wallet user by email.
// Checks balance first and prints the full receipt.
async function agentPay(toEmail, amount, token = "USDC", memo = "") {
  log(`\n  ${C.bold}  Agent-to-Agent Payment${C.reset}`);
  div();
  log(`  To:     ${toEmail}`);
  log(`  Amount: ${C.green}${amount} ${token}${C.reset}`);
  if (memo) log(`  Memo:   ${memo}`);
  div();

  // Check balance first
  const canPay = await checkBalanceBeforePayment(amount, token);
  if (!canPay) {
    err("Payment aborted — please fund your wallet and try again");
    return null;
  }

  info(`Sending ${amount} ${token} to ${toEmail}…`);
  const res = await fluidApi("/v1/agents/agent-pay", "POST", {
    toEmail, amount, token, memo,
  });

  if (!res || res.status !== 200) {
    err(`Payment failed (${res?.status}): ${JSON.stringify(res?.body)}`);
    return null;
  }

  ok(`Payment sent!`);
  printReceipt(res);
  return res.body;
}

// ── Auto-start server if not running ─────────────────────────────────────────
function isServerUp(url) {
  return new Promise(resolve => {
    http.get(`${url}/health`, res => resolve(res.statusCode < 500))
        .on("error", () => resolve(false));
  });
}

async function ensureServer() {
  if (await isServerUp(SERVER_URL)) return;
  info("Server not running — starting server.js automatically…");
  const serverPath = path.join(__dirname, "server.js");
  const child = spawn(process.execPath, [serverPath], {
    detached: true,
    stdio:    "ignore",
    env:      process.env,
  });
  child.unref();
  // Wait up to 4s for it to be ready
  for (let i = 0; i < 8; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await isServerUp(SERVER_URL)) { ok("Server started."); return; }
  }
  warn("Server didn't respond in time — requests may fail.");
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  log(`\n${C.bold}${C.cyan}  ╔══════════════════════════════════════════╗${C.reset}`);
  log(`${C.bold}${C.cyan}  ║     FADP Sample Agent  (FADP/1.0)        ║${C.reset}`);
  log(`${C.bold}${C.cyan}  ╚══════════════════════════════════════════╝${C.reset}`);
  log(`  ${C.gray}Agent key: ${FLUID_AGENT_KEY.slice(0, 16)}…${C.reset}`);
  log(`  ${C.gray}Fluid API: ${FLUID_API_URL}${C.reset}\n`);

  await ensureServer();

  // ── Step 0: Show identity + balance upfront ───────────────────────────────
  log(`${C.bold}  Step 0: Agent identity & wallet balance${C.reset}`);
  div();

  const meRes = await fluidApi("/v1/agents/me");
  if (meRes?.status === 200) {
    const { email, keyPrefix, name, scopes } = meRes.body;
    ok(`Authenticated as: ${email}`);
    ok(`Key name:         ${name ?? keyPrefix}`);
    ok(`Scopes:           ${(scopes || []).join(", ") || "(none)"}`);
  } else {
    warn(`Could not verify identity: ${JSON.stringify(meRes?.body)}`);
  }

  log("");
  const { balances, walletAddress, usdc } = await getBalance("base");
  log(`  ${C.bold}  Current Wallet Balance (Base mainnet):${C.reset}`);
  if (balances.length === 0) {
    warn("No balances found — wallet may be empty or not yet active");
  }
  for (const b of balances) {
    const highlight = b.token?.toUpperCase() === "USDC" ? C.green : C.gray;
    ok(`${highlight}${b.token}: ${b.amount}${C.reset} on ${b.chain}`);
  }
  if (walletAddress) {
    log(`  ${C.dim}  Wallet address: ${walletAddress}${C.reset}`);
    log(`  ${C.dim}  BaseScan:       https://basescan.org/address/${walletAddress}${C.reset}`);
  }
  log("");

  // ── Step 1: Call FADP-gated endpoint (auto-pay 402) ───────────────────────
  log(`${C.bold}  Step 1: Call FADP-gated API endpoint${C.reset}`);
  div();
  info(`GET ${SERVER_URL}/api/data`);

  const gatedRes = await fadpFetch(`${SERVER_URL}/api/data`);
  if (gatedRes?.status === 200) {
    ok(`Access granted! Data received:`);
    log(`\n${C.gray}${JSON.stringify(gatedRes.body, null, 2)}${C.reset}\n`);
  } else if (gatedRes) {
    warn(`Got ${gatedRes.status}: ${JSON.stringify(gatedRes.body)}`);
  }

  // ── Step 2: Agent-to-agent payment demo ──────────────────────────────────
  // Uncomment and set a real email to test agent-to-agent payments.
  // const DEMO_RECIPIENT_EMAIL = "another-agent@example.com";
  // if (DEMO_RECIPIENT_EMAIL) {
  //   log(`${C.bold}  Step 2: Agent-to-agent payment${C.reset}`);
  //   await agentPay(DEMO_RECIPIENT_EMAIL, "1.00", "USDC", "Demo payment");
  // }

  // ── Step 3: Fetch live ETH price via FADP-gated local server ────────────
  log(`${C.bold}  Step 2: Fetch live ETH price (FADP-gated)${C.reset}`);
  div();
  info(`GET ${SERVER_URL}/api/price/ethereum  [FADP/1.0 — auto-pays 402]`);

  const priceRes = await fadpFetch(`${SERVER_URL}/api/price/ethereum`, {
    headers: { "X-Agent-Key": FLUID_AGENT_KEY },
  });
  if (priceRes?.status === 200) {
    const body = priceRes.body || {};
    const price = body.price ?? body.usd ?? body.data?.price;
    const source = body.source ?? "";
    ok(`ETH: $${price != null ? price : "unavailable"} USD${source ? `  (source: ${source})` : ""}`);
  } else {
    warn(`Price fetch failed (${priceRes?.status}): ${JSON.stringify(priceRes?.body)}`);
  }

  // ── Step 4: Fetch USDC and SOL prices ────────────────────────────────────
  const tokens = [
    { id: "usd-coin", label: "USDC" },
    { id: "solana",   label: "SOL"  },
  ];
  for (const t of tokens) {
    const r = await fadpFetch(`${SERVER_URL}/api/price/${t.id}`, {
      headers: { "X-Agent-Key": FLUID_AGENT_KEY },
    });
    if (r?.status === 200) {
      const body = r.body || {};
      const price = body.price ?? body.usd ?? body.data?.price;
      ok(`${t.label}: $${price != null ? price : "unavailable"} USD`);
    }
  }

  log(`\n${C.green}${C.bold}  ✓  Agent run complete${C.reset}\n`);
}

main().catch(e => {
  console.error(`\n  ${C.red}Fatal error:${C.reset}`, e.message ?? e);
  process.exit(1);
});
