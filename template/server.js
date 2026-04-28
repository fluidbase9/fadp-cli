/**
 * FADP Sample — Gated API Server
 *
 * Exposes one endpoint gated behind HTTP 402.
 * Agents that receive 402 automatically pay via Fluid Wallet
 * and retry the request with an X-Payment-Receipt header.
 *
 * Run:  node server.js
 */

"use strict";

const express = require("express");
const crypto  = require("crypto");
const https   = require("https");
const http    = require("http");

const PORT           = Number(process.env.PORT || 3001);
const PRICE_USDC     = process.env.FADP_PRICE_USDC || "0.01";
const FLUID_API_URL  = process.env.FLUID_API_URL   || "https://fluidnative.com";
const FLDP_KEY_NAME  = process.env.FLDP_API_KEY_NAME;

const app = express();
app.use(express.json());

// ── In-memory receipt store (use Redis/DB in production) ──────────────────────
const usedReceipts = new Set();

// ── FADP middleware — checks payment receipt ───────────────────────────────────
async function fadpGate(req, res, next) {
  const receipt = req.headers["x-payment-receipt"];

  if (!receipt) {
    // No payment — respond with 402 and payment instructions
    return res.status(402).json({
      error:    "Payment required",
      protocol: "FADP/1.0",
      payment: {
        amount:    PRICE_USDC,
        currency:  "USDC",
        network:   "base",
        recipient: FLDP_KEY_NAME || "fluid/devkeys/sample/0000",
        endpoint:  req.path,
        payUrl:    `${FLUID_API_URL}/api/fadp/pay`,
      },
    });
  }

  // Replay protection — each receipt is single-use
  if (usedReceipts.has(receipt)) {
    return res.status(402).json({ error: "Receipt already used" });
  }

  // Verify receipt with Fluid API
  try {
    const valid = await verifyReceipt(receipt);
    if (!valid) return res.status(402).json({ error: "Invalid payment receipt" });
    usedReceipts.add(receipt);
    next();
  } catch {
    // Offline / can't reach API — allow in dev mode
    console.warn("[FADP] Could not verify receipt — allowing (dev mode)");
    next();
  }
}

function verifyReceipt(receipt) {
  return new Promise((resolve) => {
    const url = new URL("/api/fadp/verify-receipt", FLUID_API_URL);
    const mod = url.protocol === "https:" ? https : http;
    const payload = JSON.stringify({ receipt });
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
        try { resolve(JSON.parse(d).valid === true); }
        catch { resolve(false); }
      });
    });
    req.on("error", () => resolve(false));
    req.write(payload);
    req.end();
  });
}

// ── Gated endpoint ─────────────────────────────────────────────────────────────
app.get("/api/data", fadpGate, (req, res) => {
  res.json({
    message:   "You paid and got access! 🎉",
    timestamp: new Date().toISOString(),
    data: {
      tokens:  ["ETH", "USDC", "SOL", "PEPE"],
      prices:  { ETH: 3200, USDC: 1, SOL: 140, PEPE: 0.000012 },
      network: "base",
    },
  });
});

// ── Free endpoint — health check ───────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", fadp: "1.0", price: `${PRICE_USDC} USDC` });
});

app.listen(PORT, () => {
  console.log(`\n  🌊 FADP Sample Server running on http://localhost:${PORT}`);
  console.log(`  Gated endpoint:  GET /api/data  (costs ${PRICE_USDC} USDC)`);
  console.log(`  Health check:    GET /health\n`);
});
