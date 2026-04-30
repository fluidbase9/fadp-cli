/**
 * FADP Sample — Gated API Server  (FADP/1.0)
 *
 * Exposes one endpoint gated behind HTTP 402 (FADP protocol).
 * When an agent receives 402, it pays via Fluid Wallet and retries
 * the request with an X-FADP-Proof header. This server verifies that proof.
 *
 * Run:  node server.js
 */

"use strict";

require("dotenv").config();

const express = require("express");
const https   = require("https");
const http    = require("http");
const crypto  = require("crypto");

const PORT          = Number(process.env.PORT || 3001);
const PRICE_USDC    = process.env.FADP_PRICE_USDC   || "0.01";
const FLUID_API_URL = process.env.FLUID_API_URL     || "https://fluidnative.com";
// Your wallet address that receives payments — set FADP_WALLET_ADDRESS in .env
// Get it by logging in to fluidnative.com → Settings → Wallet Address
const PAY_TO        = process.env.FADP_WALLET_ADDRESS || process.env.WALLET_ADDRESS || "";

const app = express();
app.use(express.json());

// ── In-memory nonce store (prevents replay attacks) ────────────────────────────
// Maps nonce → expiry timestamp (ms). Use Redis in production.
const nonceStore = new Map();

function pruneNonces() {
  const now = Date.now();
  for (const [nonce, expiry] of nonceStore) {
    if (expiry < now) nonceStore.delete(nonce);
  }
}

// ── Verify FADP proof with Fluid verifier ─────────────────────────────────────
function verifyFadpProof(txHash, payTo, amount, token, chain, nonce) {
  return new Promise(resolve => {
    const url     = new URL("/v1/fadp/verify", FLUID_API_URL);
    const mod     = url.protocol === "https:" ? https : http;
    const payload = JSON.stringify({ txHash, payTo, amount, token, chain, nonce });
    const opts = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === "https:" ? 443 : 80),
      path:     url.pathname,
      method:   "POST",
      headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    };
    const req = mod.request(opts, r => {
      let d = "";
      r.on("data", c => (d += c));
      r.on("end",  () => {
        try { resolve(JSON.parse(d).verified === true); }
        catch { resolve(false); }
      });
    });
    req.on("error", () => resolve(false));
    req.write(payload);
    req.end();
  });
}

// ── FADP gate middleware (FADP/1.0 — uses X-FADP-Required header) ─────────────
async function fadpGate(req, res, next) {
  pruneNonces();

  const proofHeader = req.headers["x-fadp-proof"];

  if (!proofHeader) {
    // No proof — issue a 402 with payment requirements in X-FADP-Required header
    const nonce   = crypto.randomBytes(16).toString("hex");
    const expires = Math.floor(Date.now() / 1000) + 300;   // 5 min window
    nonceStore.set(nonce, Date.now() + 300_000);

    const paymentRequired = {
      version:     "1.0",
      amount:      PRICE_USDC,
      token:       "USDC",
      chain:       "base",
      payTo:       PAY_TO,
      description: "Demo API access",
      nonce,
      expires,
      verifyUrl:   `${FLUID_API_URL}/v1/fadp/verify`,
    };

    res.setHeader("X-FADP-Required", JSON.stringify(paymentRequired));
    res.setHeader("Access-Control-Expose-Headers", "X-FADP-Required");
    return res.status(402).json({
      error:    "Payment required",
      protocol: "FADP/1.0",
      paymentRequired,
      instructions: "Pay using Fluid Wallet: https://www.npmjs.com/package/fluid-wallet-agentkit",
    });
  }

  // Proof present — parse and validate
  let proof;
  try { proof = JSON.parse(proofHeader); }
  catch { return res.status(400).json({ error: "Invalid X-FADP-Proof header — must be JSON" }); }

  if (!proof.txHash || !proof.nonce || !proof.timestamp) {
    return res.status(400).json({ error: "X-FADP-Proof missing required fields: txHash, nonce, timestamp" });
  }

  // Check nonce is known and not expired
  const nonceExpiry = nonceStore.get(proof.nonce);
  if (!nonceExpiry) {
    return res.status(402).json({ error: "Unknown or expired nonce — request a fresh 402 first" });
  }
  if (Date.now() > nonceExpiry) {
    nonceStore.delete(proof.nonce);
    return res.status(402).json({ error: "Payment nonce expired — request a fresh 402" });
  }

  // Proof timestamp must be recent (within 5 minutes)
  const ageSeconds = Math.floor(Date.now() / 1000) - proof.timestamp;
  if (ageSeconds > 300 || ageSeconds < -60) {
    return res.status(402).json({ error: "Payment proof timestamp out of range" });
  }

  // Verify on-chain via Fluid
  try {
    const valid = await verifyFadpProof(
      proof.txHash, PAY_TO, PRICE_USDC, "USDC", "base", proof.nonce
    );
    if (!valid) return res.status(402).json({ error: "Payment verification failed — tx not found or wrong amount" });
    nonceStore.delete(proof.nonce);  // consume nonce, prevents replay
    req.fadpPayment = proof;
    next();
  } catch {
    // Can't reach Fluid API — allow in dev mode so demo works offline
    console.warn("[FADP] Could not verify proof — allowing (dev/offline mode)");
    nonceStore.delete(proof.nonce);
    req.fadpPayment = proof;
    next();
  }
}

// ── Gated endpoint ─────────────────────────────────────────────────────────────
app.get("/api/data", fadpGate, (req, res) => {
  res.json({
    message:   "Payment verified — access granted!",
    protocol:  "FADP/1.0",
    timestamp: new Date().toISOString(),
    payedWith: req.fadpPayment?.txHash,
    data: {
      tokens:  ["ETH", "USDC", "SOL", "PEPE"],
      prices:  { ETH: 3200, USDC: 1, SOL: 140, PEPE: 0.000012 },
      network: "base",
      source:  "demo-server",
    },
  });
});

// ── Health check ───────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status:  "ok",
    fadp:    "1.0",
    price:   `${PRICE_USDC} USDC`,
    payTo:   PAY_TO || "(FADP_WALLET_ADDRESS not set — payments skipped in dev mode)",
  });
});

app.listen(PORT, () => {
  console.log(`\n  🌊 FADP Sample Server — FADP/1.0`);
  console.log(`  Listening:        http://localhost:${PORT}`);
  console.log(`  Gated endpoint:   GET /api/data   (costs ${PRICE_USDC} USDC)`);
  console.log(`  Health check:     GET /health`);
  if (!PAY_TO) {
    console.log(`\n  ⚠️  FADP_WALLET_ADDRESS not set in .env`);
    console.log(`     Payments will be skipped in dev mode.`);
    console.log(`     Set it to your Fluid Wallet address to receive real payments.\n`);
  } else {
    console.log(`  Receiving payments to: ${PAY_TO}\n`);
  }
});
