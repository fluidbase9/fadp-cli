#!/usr/bin/env node
"use strict";

const fs            = require("fs");
const path          = require("path");
const os            = require("os");
const readline      = require("readline");
const crypto        = require("crypto");
const { execSync }  = require("child_process");
const https         = require("https");
const http          = require("http");

// When run via postinstall, npm sets INIT_CWD to the user's project root.
// When run via npx/fadp directly, cwd is already the project root.
const PROJECT_DIR = process.env.INIT_CWD || process.cwd();
process.chdir(PROJECT_DIR);

// ─── ANSI ─────────────────────────────────────────────────────────────────────

const C = {
  reset:   "\x1b[0m",
  bold:    "\x1b[1m",
  dim:     "\x1b[2m",
  cyan:    "\x1b[36m",
  green:   "\x1b[32m",
  yellow:  "\x1b[33m",
  red:     "\x1b[31m",
  blue:    "\x1b[34m",
  magenta: "\x1b[35m",
  white:   "\x1b[37m",
  gray:    "\x1b[90m",
  bgGreen: "\x1b[42m",
  bgBlue:  "\x1b[44m",
};

const W = process.stdout.columns || 72;
const hr    = (ch = "─") => C.dim + ch.repeat(W) + C.reset;
const nl    = ()          => process.stdout.write("\n");
const log   = (m = "")   => process.stdout.write(m + "\n");
const ok    = m           => log(`  ${C.green}✓${C.reset}  ${m}`);
const fail  = m           => log(`  ${C.red}✗${C.reset}  ${m}`);
const warn  = m           => log(`  ${C.yellow}⚠${C.reset}  ${m}`);
const step  = (n, t)      => log(`\n${C.bold}${C.cyan}── Step ${n}: ${t}${C.reset}\n`);
const label = (k, v)      => log(`  ${C.gray}${k.padEnd(28)}${C.reset}${v}`);

// ─── API base URL ─────────────────────────────────────────────────────────────

const API_BASE = process.env.FADP_API_URL || "https://fluidnative.com";

// ─── HTTP helper (no axios/node-fetch needed) ─────────────────────────────────

function apiPost(urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url     = new URL(urlPath, API_BASE);
    const mod     = url.protocol === "https:" ? https : http;
    const opts    = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === "https:" ? 443 : 80),
      path:     url.pathname + url.search,
      method:   "POST",
      headers:  {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "User-Agent":     "@fluidwallet/fadp-cli",
      },
    };
    const req = mod.request(opts, res => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end",  () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ success: false, error: data }); }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ─── Readline helpers ─────────────────────────────────────────────────────────

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(`  ${C.cyan}?${C.reset}  ${question}: `, ans => {
    rl.close();
    resolve(ans.trim());
  }));
}

function promptPassword(question) {
  return new Promise(resolve => {
    process.stdout.write(`  ${C.cyan}?${C.reset}  ${question}: `);
    const rl = readline.createInterface({ input: process.stdin, output: null });
    let pass = "";
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.on("data", function handler(ch) {
      ch = ch.toString();
      if (ch === "\r" || ch === "\n") {
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdin.removeListener("data", handler);
        process.stdout.write("\n");
        rl.close();
        resolve(pass);
      } else if (ch === "") {
        process.exit();
      } else if (ch === "") {
        if (pass.length > 0) { pass = pass.slice(0, -1); process.stdout.write("\b \b"); }
      } else {
        pass += ch;
        process.stdout.write("•");
      }
    });
    process.stdin.resume();
  });
}

function pressEnter(msg = "Press ENTER to continue") {
  return prompt(`${C.gray}${msg}${C.reset}`).then(() => {});
}

// ─── Multi-select checkbox ────────────────────────────────────────────────────

async function multiSelect(items) {
  const selected = new Set();
  let cursor     = 0;

  function render() {
    process.stdout.write("\x1b[?25l"); // hide cursor
    for (let i = 0; i < items.length; i++) {
      const isSel = selected.has(i);
      const isCur = cursor === i;
      const box   = isSel ? `${C.green}[✓]${C.reset}` : `${C.gray}[ ]${C.reset}`;
      const arrow = isCur ? `${C.cyan}›${C.reset}` : " ";
      const name  = isCur
        ? `${C.bold}${C.white}${items[i].name.padEnd(22)}${C.reset}`
        : `${C.white}${items[i].name.padEnd(22)}${C.reset}`;
      log(`  ${arrow} ${box} ${name}  ${C.gray}${items[i].desc}${C.reset}`);
    }
    // move cursor back up
    process.stdout.write(`\x1b[${items.length}A`);
  }

  function clearRender() {
    for (let i = 0; i < items.length; i++) process.stdout.write("\x1b[2K\n");
    process.stdout.write(`\x1b[${items.length}A`);
  }

  return new Promise(resolve => {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();

    nl();
    log(`  ${C.dim}↑↓ navigate  SPACE select/deselect  A select all  ENTER confirm${C.reset}`);
    nl();

    render();

    process.stdin.on("data", function handler(buf) {
      const key = buf.toString();
      if (key === "\x1b[A" || key === "k") { // up
        cursor = (cursor - 1 + items.length) % items.length;
      } else if (key === "\x1b[B" || key === "j") { // down
        cursor = (cursor + 1) % items.length;
      } else if (key === " ") { // toggle
        if (selected.has(cursor)) selected.delete(cursor);
        else selected.add(cursor);
      } else if (key === "a" || key === "A") { // select all
        if (selected.size === items.length) selected.clear();
        else items.forEach((_, i) => selected.add(i));
      } else if (key === "\r" || key === "\n") { // confirm
        clearRender();
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdin.removeListener("data", handler);
        process.stdout.write("\x1b[?25h"); // show cursor
        resolve([...selected].sort((a, b) => a - b).map(i => items[i]));
        return;
      } else if (key === "") {
        process.exit();
      }
      clearRender();
      render();
    });
  });
}

// ─── EC P-256 key generation ──────────────────────────────────────────────────

async function generateFLDPKeyPair(email) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
    publicKeyEncoding:  { type: "spki",  format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const orgSlug = crypto.createHash("sha256").update(email).digest("hex").slice(0, 8);
  const keyId   = crypto.randomBytes(4).toString("hex");
  const keyName = `fluid/devkeys/${orgSlug}/${keyId}`;

  const privateKeyJson = {
    name:        keyName,
    publicKey:   publicKey,
    privateKey:  privateKey,
    type:        "fldp_api_key",
    createdAt:   new Date().toISOString(),
  };

  return { keyName, publicKeyPem: publicKey, privateKeyJson };
}

// ─── 20 Agent Skills ──────────────────────────────────────────────────────────

const AGENT_SKILLS = [
  { name: "authenticate",       desc: "Get a Fluid Wallet agent key (fwag_...)" },
  { name: "balance",            desc: "Check USDC, ETH and token balances" },
  { name: "send",               desc: "Send ETH or USDC to any address or email" },
  { name: "swap",               desc: "Swap tokens via Fluid SOR — best price on Base" },
  { name: "agent-pay",          desc: "Agent-to-agent USDC payments by email" },
  { name: "fadp-pay",           desc: "Auto-pay FADP-gated services in USDC" },
  { name: "quote",              desc: "Get swap quotes without executing" },
  { name: "price",              desc: "Fetch live token prices from Fluid oracle" },
  { name: "portfolio",          desc: "Full portfolio overview across chains" },
  { name: "yield",              desc: "Find best yield opportunities on Base" },
  { name: "bridge",             desc: "Cross-chain bridge assets via Fluid" },
  { name: "stake",              desc: "Stake ETH or tokens for on-chain yield" },
  { name: "liquidity",          desc: "Add or remove AMM liquidity positions" },
  { name: "borrow",             desc: "Borrow against collateral (Aave / Compound)" },
  { name: "nft-buy",            desc: "Buy NFTs on Base via agent command" },
  { name: "gas",                desc: "Estimate gas costs before executing" },
  { name: "monitor",            desc: "Watch wallet for incoming payments" },
  { name: "token-research",     desc: "Research token metrics, holders, volume" },
  { name: "dao-vote",           desc: "Vote on DAO proposals on Base" },
  { name: "deploy-contract",    desc: "Deploy Solidity contracts to Base mainnet" },
];

// ─── Clone skills repo ────────────────────────────────────────────────────────

const SKILLS_REPO = "https://github.com/fluidbase9/fluid-wallet-skills.git";
const SKILLS_DIR  = path.join(process.cwd(), "fluid-wallet-skills");

function cloneSkillsRepo() {
  if (fs.existsSync(SKILLS_DIR)) {
    log(`  ${C.cyan}ℹ${C.reset}  ${C.dim}fluid-wallet-skills already exists — pulling latest${C.reset}`);
    try { execSync("git pull --quiet", { cwd: SKILLS_DIR, stdio: "pipe" }); }
    catch { /* ignore pull errors */ }
  } else {
    log(`  Cloning ${C.cyan}${SKILLS_REPO}${C.reset}`);
    try {
      execSync(`git clone --quiet ${SKILLS_REPO} ${SKILLS_DIR}`, { stdio: "pipe" });
      ok("Cloned to ./fluid-wallet-skills/");
    } catch (e) {
      warn("Could not clone repo (network or repo unavailable). Continuing without it.");
    }
  }
}

// ─── Symlink selected skills ──────────────────────────────────────────────────

function symlinkSkills(selected) {
  const agentsDir = path.join(process.cwd(), "agents");
  fs.mkdirSync(agentsDir, { recursive: true });

  let linked = 0;
  for (const skill of selected) {
    const src  = path.join(SKILLS_DIR, skill.name);
    const dest = path.join(agentsDir, skill.name);

    if (!fs.existsSync(src)) {
      // Skill not in cloned repo yet — create a stub dir
      fs.mkdirSync(src, { recursive: true });
      fs.writeFileSync(path.join(src, "SKILL.md"),
        `---\nname: ${skill.name}\ndescription: ${skill.desc}\n---\n\n# ${skill.name}\n\n${skill.desc}\n`
      );
    }

    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    try {
      fs.symlinkSync(src, dest, "dir");
      ok(`Linked  ${C.cyan}agents/${skill.name}${C.reset}`);
      linked++;
    } catch (e) {
      fail(`Could not symlink ${skill.name}: ${e.message}`);
    }
  }
  return linked;
}

// ─── Scaffold sample project ──────────────────────────────────────────────────

const TEMPLATE_DIR  = path.join(__dirname, "..", "template");
const SAMPLE_DIR    = path.join(process.cwd(), "fadp-sample");

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function scaffoldSampleProject(keyName) {
  if (!fs.existsSync(TEMPLATE_DIR)) {
    warn("Template not found — skipping sample project scaffold.");
    return;
  }

  if (fs.existsSync(SAMPLE_DIR)) {
    warn(`${C.cyan}fadp-sample/${C.reset} already exists — skipping.`);
    return;
  }

  copyDir(TEMPLATE_DIR, SAMPLE_DIR);

  // Rename .env.example → make a copy as .env with the real key name pre-filled
  const envExample = path.join(SAMPLE_DIR, ".env.example");
  const envDest    = path.join(SAMPLE_DIR, ".env");
  if (fs.existsSync(envExample)) {
    let envContent = fs.readFileSync(envExample, "utf8");
    envContent = envContent.replace(
      'FLDP_API_KEY_NAME="fluid/devkeys/YOUR_ORG/YOUR_KEY_ID"',
      `FLDP_API_KEY_NAME="${keyName}"`,
    );
    envContent += "\n# ⚠ Paste your FLDP_API_KEY_PRIVATE_KEY from .env.fadp\n";
    fs.writeFileSync(envDest, envContent, { mode: 0o600 });
  }

  ok(`Scaffolded ${C.cyan}fadp-sample/${C.reset}  — server + agent + README`);
}

// ─── Write .env snippet ───────────────────────────────────────────────────────

function writeEnvSnippet(keyName, privateKeyJson) {
  const envPath = path.join(process.cwd(), ".env.fadp");
  const content = [
    "# FADP Developer Keys — generated by @fluidwallet/fadp-cli",
    `# Created: ${new Date().toISOString()}`,
    "",
    `FLDP_API_KEY_NAME="${keyName}"`,
    `FLDP_API_KEY_PRIVATE_KEY='${JSON.stringify(privateKeyJson)}'`,
    "",
  ].join("\n");
  fs.writeFileSync(envPath, content, { mode: 0o600 });
  ok(`Wrote   ${C.cyan}.env.fadp${C.reset}  ${C.dim}(chmod 600 — keep secret)${C.reset}`);
}

// ─── Mode selector ────────────────────────────────────────────────────────────

async function selectMode() {
  const modes = [
    {
      key:   "1",
      title: `${C.bold}${C.cyan}Install FADP in my existing project${C.reset}`,
      desc:  `${C.gray}Generate keys + add fluid-fadp to package.json. No sample project.${C.reset}`,
    },
    {
      key:   "2",
      title: `${C.bold}${C.white}Scaffold a full TypeScript project${C.reset}`,
      desc:  `${C.gray}Keys + agent skills + sample server/agent project ready to run.${C.reset}`,
    },
  ];

  log(`  ${C.bold}What would you like to do?${C.reset}`);
  nl();
  for (const m of modes) log(`  ${C.cyan}[${m.key}]${C.reset}  ${m.title}`);
  for (const m of modes) log(`       ${m.desc}`);
  nl();

  while (true) {
    const ans = await prompt(`Choose ${C.cyan}1${C.reset} or ${C.cyan}2${C.reset}`);
    if (ans === "1" || ans === "2") return ans;
    warn("Enter 1 or 2");
  }
}

// ─── Logo (ANSI block art — works in every terminal) ─────────────────────────

function printLogo() {
  const T  = "\x1b[36m";
  const G  = "\x1b[32m";
  const R  = "\x1b[0m";
  const B  = "\x1b[1m";
  const D  = "\x1b[2m";

  log(`  ${G}  ██████╗ ${T} ███████╗${R}`);
  log(`  ${G}  ██╔══██╗${T} ██╔════╝${R}   ${B}${T}FLUID WALLET${R}`);
  log(`  ${G}  ██████╔╝${T} █████╗  ${R}   ${T}FADP Developer CLI${R}`);
  log(`  ${G}  ██╔══██╗${T} ██╔══╝  ${R}   ${D}fluidnative.com/fadp${R}`);
  log(`  ${G}  ██║  ██║${T} ██║     ${R}`);
  log(`  ${G}  ╚═╝  ╚═╝${T} ╚═╝     ${R}`);
}

// ─── Banner ───────────────────────────────────────────────────────────────────

async function banner() {
  nl();
  log(hr("═"));
  nl();
  printLogo();
  nl();
  log(hr("═"));
  nl();
}

// ─── Shared: account + key steps ─────────────────────────────────────────────

async function stepAccountAndKeys() {
  step(1, "Developer Account");
  log(`  ${C.dim}Create a new Fluid developer account, or sign in if you already have one.${C.reset}`);
  nl();

  const email    = await prompt("Email");
  const password = await promptPassword("Password");
  nl();

  log(`  ${C.dim}Registering…${C.reset}`);
  try {
    const res = await apiPost("/api/auth/register-developer", { email, password });
    if (res.success || res.uid) {
      ok("Developer account created");
    } else if (res.error && res.error.toLowerCase().includes("exist")) {
      warn("Account already exists — signing in");
      const loginRes = await apiPost("/api/auth/login-developer", { email, password });
      if (loginRes.success || loginRes.uid) ok("Signed in to existing account");
      else fail(`Login failed: ${loginRes.error || "unknown error"}`);
    } else {
      warn(`API response: ${res.error || JSON.stringify(res)}`);
    }
  } catch (e) {
    warn(`Could not reach API (${e.message}). Continuing offline.`);
  }

  step(2, "FLDP EC Key Pair");
  log(`  ${C.dim}Generating P-256 ECDSA key pair in this terminal…${C.reset}`);
  nl();

  const { keyName, publicKeyPem, privateKeyJson } = await generateFLDPKeyPair(email);

  apiPost("/api/developer/fldp-keys/register", {
    email, keyName, publicKeyPem, label: "CLI Generated",
  }).catch(() => {});

  log(hr());
  nl();
  warn(`${C.bold}${C.yellow}SHOWN ONCE — copy and save NOW. This will not be displayed again.${C.reset}`);
  nl();
  label("FLDP_API_KEY_NAME",        `${C.cyan}${keyName}${C.reset}`);
  nl();
  label("FLDP_API_KEY_PRIVATE_KEY", `${C.yellow}(shown below)${C.reset}`);
  nl();
  for (const line of JSON.stringify(privateKeyJson, null, 2).split("\n"))
    log(`  ${C.gray}${line}${C.reset}`);
  nl();
  log(hr());
  nl();

  writeEnvSnippet(keyName, privateKeyJson);
  nl();
  log(`  ${C.dim}Keys also written to ${C.reset}${C.cyan}.env.fadp${C.reset}${C.dim} — add it to .gitignore.${C.reset}`);
  nl();
  await pressEnter("I have saved my key — press ENTER to continue");

  // ── Step 3: Fluid Agent Key (fwag_) ────────────────────────────────────────
  step(3, "Fluid Agent Key  (fwag_...)");
  log(`  ${C.dim}This key lets your agent move crypto — send, swap, check balance.${C.reset}`);
  log(`  ${C.dim}It is separate from the FLDP EC key. Shown once — save it now.${C.reset}`);
  nl();

  let agentKey = null;
  try {
    const res = await apiPost("/api/agent-keys", { email, label: "CLI Generated" });
    if (res.key || res.agentKey) {
      agentKey = res.key || res.agentKey;
    } else {
      warn(`Could not generate agent key: ${res.error || JSON.stringify(res)}`);
    }
  } catch (e) {
    warn(`Could not reach API (${e.message}).`);
  }

  if (agentKey) {
    log(hr());
    nl();
    warn(`${C.bold}${C.yellow}SHOWN ONCE — copy and save NOW. Cannot be retrieved again.${C.reset}`);
    nl();
    label("FLUID_AGENT_KEY", `${C.green}${agentKey}${C.reset}`);
    nl();
    log(hr());
    nl();

    // Append to .env.fadp
    const envPath = path.join(process.cwd(), ".env.fadp");
    const append  = `\n# Fluid Agent Key — powers crypto operations (send, swap, balance)\nFLUID_AGENT_KEY="${agentKey}"\n`;
    fs.appendFileSync(envPath, append);
    ok(`Appended ${C.cyan}FLUID_AGENT_KEY${C.reset} to ${C.cyan}.env.fadp${C.reset}`);
    nl();
    await pressEnter("I have saved my agent key — press ENTER to continue");
  } else {
    warn("Agent key not generated — get it later from Developer Dashboard → API Keys.");
    nl();
  }

  return { email, keyName, agentKey };
}

// ─── Mode 1: install only ─────────────────────────────────────────────────────

async function runModeInstall() {
  log(`\n  ${C.dim}Mode: ${C.reset}${C.bold}Install FADP in existing project${C.reset}\n`);

  const { keyName } = await stepAccountAndKeys();

  // Add fluid-fadp to project dependencies
  step(3, "Install fluid-fadp");
  log(`  ${C.dim}Adding fluid-fadp to your project…${C.reset}`);
  nl();
  try {
    execSync("npm install fluid-fadp", { stdio: "pipe", cwd: process.cwd() });
    ok(`${C.cyan}fluid-fadp${C.reset} installed`);
  } catch {
    warn("npm install failed — run manually: npm install fluid-fadp");
  }
  nl();

  // Show usage snippet
  log(hr());
  nl();
  log(`  ${C.bold}${C.white}Quick start — add to your Express server:${C.reset}`);
  nl();
  log(`  ${C.gray}const { fadpGate } = require("fluid-fadp/server");${C.reset}`);
  nl();
  log(`  ${C.gray}app.get("/api/data", fadpGate({${C.reset}`);
  log(`  ${C.gray}  keyName: "${keyName}",${C.reset}`);
  log(`  ${C.gray}  amount:  "0.01",        // USDC per call${C.reset}`);
  log(`  ${C.gray}}), (req, res) => {${C.reset}`);
  log(`  ${C.gray}  res.json({ data: "paid access!" });${C.reset}`);
  log(`  ${C.gray}});${C.reset}`);
  nl();
  log(hr());
  nl();

  log(hr("═"));
  log(`${C.bold}${C.green}  ✓  FADP installed!${C.reset}`);
  log(hr("═"));
  nl();
  label("1. Protect keys",        `${C.dim}echo '.env.fadp' >> .gitignore${C.reset}`);
  label("2. Load keys in .env",   `${C.dim}cp .env.fadp .env${C.reset}`);
  label("3. FLDP_API_KEY_NAME",   `${C.cyan}in .env.fadp${C.reset}`);
  label("4. FLUID_AGENT_KEY",     `${C.cyan}in .env.fadp${C.reset}`);
  label("5. npm package",         `${C.cyan}https://www.npmjs.com/package/fluid-fadp${C.reset}`);
  label("6. Docs",                `${C.cyan}https://fluidnative.com/fadp${C.reset}`);
  nl();
}

// ─── Mode 2: full TypeScript project ─────────────────────────────────────────

async function runModeProject() {
  log(`\n  ${C.dim}Mode: ${C.reset}${C.bold}Scaffold full TypeScript project${C.reset}\n`);

  const { email, keyName } = await stepAccountAndKeys();

  step(3, "Clone Agent Skills Repo");
  log(`  ${C.dim}Repo: ${SKILLS_REPO}${C.reset}`);
  nl();
  cloneSkillsRepo();
  nl();

  step(4, "Select Agent Skills to Install");
  log(`  ${C.dim}Choose which Fluid agent skills to symlink into ${C.reset}${C.cyan}./agents/${C.reset}`);
  const chosen = await multiSelect(AGENT_SKILLS);
  nl();
  if (chosen.length === 0) {
    warn("No skills selected. Run `fadp` again to install skills.");
  } else {
    const linked = symlinkSkills(chosen);
    nl();
    ok(`${C.bold}${linked} skill${linked === 1 ? "" : "s"} installed to ./agents/${C.reset}`);
  }

  step(5, "Sample TypeScript Project");
  log(`  ${C.dim}Scaffolding fadp-sample/ — gated API server + paying agent.${C.reset}`);
  nl();
  scaffoldSampleProject(keyName);
  nl();

  log(hr("═"));
  log(`${C.bold}${C.green}  ✓  FADP project ready!${C.reset}`);
  log(hr("═"));
  nl();
  label("1. Protect keys",          `${C.dim}echo '.env.fadp' >> .gitignore${C.reset}`);
  label("2. Install dependencies",  `${C.cyan}cd fadp-sample && npm install${C.reset}`);
  label("3. Start gated server",    `${C.dim}node fadp-sample/server.js${C.reset}`);
  label("4. Run paying agent",      `${C.dim}node fadp-sample/agent.js${C.reset}`);
  label("5. Browse agent skills",   `${C.dim}ls ./agents/${C.reset}`);
  label("6. Protocol package",      `${C.cyan}https://www.npmjs.com/package/fluid-fadp${C.reset}`);
  label("7. Docs",                  `${C.cyan}https://fluidnative.com/fadp${C.reset}`);
  nl();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  await banner();
  const mode = await selectMode();
  if (mode === "1") await runModeInstall();
  else              await runModeProject();
}

main().catch(e => {
  fail(e.message || String(e));
  process.exit(1);
});
