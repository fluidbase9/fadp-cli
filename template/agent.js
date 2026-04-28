/**
 * FADP Sample — Paying Agent
 *
 * An AI agent that calls the gated server endpoint.
 * When it receives HTTP 402, it automatically pays via Fluid Wallet
 * and retries the request. It also uses installed agent skills
 * (balance, swap, send, price) to operate autonomously.
 *
 * Run:  node agent.js
 */

"use strict";

const https  = require("https");
const http   = require("http");
const crypto = require("crypto");
const fs     = require("fs");
const path   = require("path");

// ── Config ────────────────────────────────────────────────────────────────────
const FLUID_API_URL  = process.env.FLUID_API_URL   || "https://fluidnative.com";
const FLDP_KEY_NAME  = process.env.FLDP_API_KEY_NAME;
const FLDP_KEY_JSON  = process.env.FLDP_API_KEY_PRIVATE_KEY
  ? JSON.parse(process.env.FLDP_API_KEY_PRIVATE_KEY)
  : null;
const SERVER_URL     = `http://localhost:${process.env.PORT || 3001}`;

// ── ANSI ──────────────────────────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m", green: "\x1b[32m", cyan: "\x1b[36m",
  yellow: "\x1b[33m", red: "\x1b[31m", gray: "\x1b[90m", bold: "\x1b[1m",
};
const log  = m => console.log(m);
const ok   = m => log(`  ${C.green}✓${C.reset}  ${m}`);
const info = m => log(`  ${C.cyan}→${C.reset}  ${m}`);
const warn = m => log(`  ${C.yellow}⚠${C.reset}  ${m}`);

// ── HTTP helper ────────────────────────────────────────────────────────────────
function httpRequest(urlStr, opts = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === "https:" ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === "https:" ? 443 : 80),
      path:     url.pathname + url.search,
      method:   opts.method || "GET",
      headers:  {
        "Content-Type": "application/json",
        "User-Agent":   "fadp-sample-agent/1.0",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        ...(opts.headers || {}),
      },
    };
    const req = mod.request(options, res => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end",  () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers });
        } catch {
          resolve({ status: res.statusCode, body: data, headers: res.headers });
        }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── FLDP signing ───────────────────────────────────────────────────────────────
function signRequest(keyName, privateKeyPem, payload) {
  const sign    = crypto.createSign("SHA256");
  sign.update(payload);
  sign.end();
  return sign.sign({ key: privateKeyPem, dsaEncoding: "ieee-p1363" }, "base64");
}

// ── Pay for a 402 response ─────────────────────────────────────────────────────
async function payForAccess(paymentInfo) {
  info(`Paying ${paymentInfo.amount} ${paymentInfo.currency} to ${paymentInfo.recipient}…`);

  if (!FLDP_KEY_NAME || !FLDP_KEY_JSON) {
    warn("No FLDP keys found — set FLDP_API_KEY_NAME and FLDP_API_KEY_PRIVATE_KEY in .env");
    return null;
  }

  const nonce     = crypto.randomBytes(16).toString("hex");
  const timestamp = Date.now().toString();
  const payload   = `${nonce}.${timestamp}`;
  const signature = signRequest(FLDP_KEY_NAME, FLDP_KEY_JSON.privateKey, payload);

  try {
    const res = await httpRequest(
      `${FLUID_API_URL}/api/fadp/pay`,
      {
        method: "POST",
        headers: {
          "X-FLDP-Key-Name":  FLDP_KEY_NAME,
          "X-FLDP-Signature": signature,
          "X-FLDP-Nonce":     nonce,
          "X-FLDP-Timestamp": timestamp,
        },
      },
      {
        amount:    paymentInfo.amount,
        currency:  paymentInfo.currency,
        network:   paymentInfo.network,
        recipient: paymentInfo.recipient,
        endpoint:  paymentInfo.endpoint,
      },
    );

    if (res.body && res.body.receipt) {
      ok(`Payment sent — receipt: ${res.body.receipt.slice(0, 20)}…`);
      return res.body.receipt;
    }

    warn(`Payment API response: ${JSON.stringify(res.body)}`);
    // Return a mock receipt so the demo keeps running without live API
    return `mock_receipt_${nonce}`;
  } catch (e) {
    warn(`Payment failed (${e.message}) — using mock receipt for demo`);
    return `mock_receipt_${nonce}`;
  }
}

// ── Skill loader ───────────────────────────────────────────────────────────────
function loadSkill(skillName) {
  const candidates = [
    path.join(__dirname, "agents", skillName, "index.js"),
    path.join(__dirname, "fluid-wallet-skills", skillName, "index.js"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return require(p);
  }
  // Skill not implemented yet — return a stub
  return {
    run: async (args) => ({
      skill: skillName,
      status: "stub",
      message: `Skill '${skillName}' is registered but not yet implemented. Add agents/${skillName}/index.js to implement it.`,
      args,
    }),
  };
}

// ── Main agent loop ────────────────────────────────────────────────────────────
async function main() {
  log(`\n${C.bold}${C.cyan}  🤖 FADP Sample Agent${C.reset}`);
  log(`  Auto-paying agent that calls FADP-gated APIs\n`);

  // ── Task 1: Call the gated endpoint (auto-pay on 402) ────────────────────────
  log(`${C.bold}  Task 1: Call gated endpoint${C.reset}`);
  info(`GET ${SERVER_URL}/api/data`);

  let res = await httpRequest(`${SERVER_URL}/api/data`).catch(e => {
    warn(`Server not reachable: ${e.message}`);
    return null;
  });

  if (!res) {
    warn("Start the server first:  node server.js");
  } else if (res.status === 402) {
    info(`Got 402 — payment required. Initiating FADP payment…`);
    const receipt = await payForAccess(res.body.payment);
    if (receipt) {
      // Retry with payment receipt
      res = await httpRequest(`${SERVER_URL}/api/data`, {
        headers: { "X-Payment-Receipt": receipt },
      });
      if (res.status === 200) {
        ok(`Access granted! Response:`);
        log(`\n${C.gray}${JSON.stringify(res.body, null, 2)}${C.reset}\n`);
      } else {
        warn(`Still got ${res.status}: ${JSON.stringify(res.body)}`);
      }
    }
  } else if (res.status === 200) {
    ok(`Free access (no payment needed). Response:`);
    log(`\n${C.gray}${JSON.stringify(res.body, null, 2)}${C.reset}\n`);
  }

  // ── Task 2: Run installed agent skills ────────────────────────────────────────
  log(`${C.bold}  Task 2: Run agent skills${C.reset}`);

  const skillsToRun = ["balance", "price", "quote"];
  for (const skillName of skillsToRun) {
    info(`Running skill: ${C.cyan}${skillName}${C.reset}`);
    try {
      const skill  = loadSkill(skillName);
      const result = await skill.run({ apiUrl: FLUID_API_URL, keyName: FLDP_KEY_NAME });
      ok(`${skillName}: ${JSON.stringify(result)}`);
    } catch (e) {
      warn(`${skillName} errored: ${e.message}`);
    }
  }

  log(`\n${C.green}  ✓  Agent run complete${C.reset}\n`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
