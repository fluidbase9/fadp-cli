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
      const hint = items[i].desc || (items[i].group === "universal" ? `${C.cyan}universal${C.reset}` : items[i].dir ? `${C.gray}${items[i].dir}${C.reset}` : "");
      log(`  ${arrow} ${box} ${name}  ${C.gray}${hint}${C.reset}`);
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
    log(`  ${C.bold}${C.cyan}  SPACE${C.reset}${C.bold}  =  select / deselect a skill${C.reset}`);
    log(`  ${C.bold}${C.cyan}  ↑ ↓  ${C.reset}${C.bold}  =  move up / down${C.reset}`);
    log(`  ${C.bold}${C.cyan}    A  ${C.reset}${C.bold}  =  select ALL${C.reset}`);
    log(`  ${C.bold}${C.cyan}ENTER  ${C.reset}${C.bold}  =  confirm and continue${C.reset}`);
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

// ─── Single-select (pick one agent target) ───────────────────────────────────

// ─── Installation scope selector (Project vs Global) ─────────────────────────

async function selectScope() {
  const SCOPE_OPTS = [
    {
      key:   "project",
      label: `${C.bold}${C.white}Project${C.reset}`,
      desc:  `Install in current directory ${C.gray}(committed with your project)${C.reset}`,
    },
    {
      key:   "global",
      label: `${C.white}Global${C.reset}`,
      desc:  `Install in ~/ home dir ${C.gray}(available in all projects)${C.reset}`,
    },
  ];

  let cursor = 0;

  function render() {
    process.stdout.write("\x1b[?25l");
    for (let i = 0; i < SCOPE_OPTS.length; i++) {
      const isCur = cursor === i;
      const radio = isCur ? `${C.cyan}●${C.reset}` : `${C.gray}○${C.reset}`;
      const arrow = isCur ? `${C.cyan}›${C.reset}` : " ";
      log(`  ${arrow} ${radio}  ${SCOPE_OPTS[i].label}   ${SCOPE_OPTS[i].desc}`);
    }
    process.stdout.write(`\x1b[${SCOPE_OPTS.length}A`);
  }

  function clearRender() {
    for (let i = 0; i < SCOPE_OPTS.length; i++) process.stdout.write("\x1b[2K\n");
    process.stdout.write(`\x1b[${SCOPE_OPTS.length}A`);
  }

  return new Promise(resolve => {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    nl();
    render();
    process.stdin.on("data", function handler(buf) {
      const key = buf.toString();
      if (key === "\x1b[A" || key === "k") cursor = (cursor - 1 + SCOPE_OPTS.length) % SCOPE_OPTS.length;
      else if (key === "\x1b[B" || key === "j") cursor = (cursor + 1) % SCOPE_OPTS.length;
      else if (key === "\r" || key === "\n") {
        clearRender();
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdin.removeListener("data", handler);
        process.stdout.write("\x1b[?25h");
        resolve(SCOPE_OPTS[cursor].key);
        return;
      } else if (key === "\x03") { process.exit(); }
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

// ─── Agent targets — where skills get installed ──────────────────────────────

const AGENT_TARGETS = [
  // Universal (.agents/skills/) — all 15 universal-standard agents read this dir
  { key: "universal",      name: "Universal  (all compatible agents)", dir: ".agents/skills", ext: "md",  group: "universal" },
  { key: "amp",            name: "Amp",                                dir: ".agents/skills", ext: "md",  group: "universal" },
  { key: "antigravity",    name: "Antigravity",                        dir: ".agents/skills", ext: "md",  group: "universal" },
  { key: "cline",          name: "Cline",                              dir: ".agents/skills", ext: "md",  group: "universal" },
  { key: "codex",          name: "Codex",                              dir: ".agents/skills", ext: "md",  group: "universal" },
  { key: "cursor",         name: "Cursor",                             dir: ".agents/skills", ext: "md",  group: "universal" },
  { key: "deepagents",     name: "Deep Agents",                        dir: ".agents/skills", ext: "md",  group: "universal" },
  { key: "dexto",          name: "Dexto",                              dir: ".agents/skills", ext: "md",  group: "universal" },
  { key: "firebender",     name: "Firebender",                         dir: ".agents/skills", ext: "md",  group: "universal" },
  { key: "gemini-cli",     name: "Gemini CLI",                         dir: ".agents/skills", ext: "md",  group: "universal" },
  { key: "github-copilot", name: "GitHub Copilot",                     dir: ".agents/skills", ext: "md",  group: "universal" },
  { key: "kimi-cli",       name: "Kimi Code CLI",                      dir: ".agents/skills", ext: "md",  group: "universal" },
  { key: "opencode",       name: "OpenCode",                           dir: ".agents/skills", ext: "md",  group: "universal" },
  { key: "replit",         name: "Replit",                             dir: ".agents/skills", ext: "md",  group: "universal" },
  { key: "warp",           name: "Warp",                               dir: ".agents/skills", ext: "md",  group: "universal" },
  // Dedicated — each agent reads its own directory
  { key: "adal",           name: "AdaL",                               dir: ".adal/skills",          ext: "md",  group: "dedicated" },
  { key: "aider-desk",     name: "AiderDesk",                          dir: ".aider/skills",          ext: "md",  group: "dedicated" },
  { key: "rovodev",        name: "Atlassian Rovo Dev",                 dir: ".rovodev/skills",        ext: "md",  group: "dedicated" },
  { key: "augment",        name: "Augment",                            dir: ".augment/skills",        ext: "md",  group: "dedicated" },
  { key: "claude-code",    name: "Claude Code",                        dir: ".claude/skills",         ext: "md",  group: "dedicated" },
  { key: "codestudio",     name: "Code Studio",                        dir: ".codestudio/skills",     ext: "md",  group: "dedicated" },
  { key: "codearts-agent", name: "CodeArts Agent",                     dir: ".codearts/skills",       ext: "md",  group: "dedicated" },
  { key: "codebuddy",      name: "CodeBuddy",                          dir: ".codebuddy/skills",      ext: "md",  group: "dedicated" },
  { key: "codemaker",      name: "Codemaker",                          dir: ".codemaker/skills",      ext: "md",  group: "dedicated" },
  { key: "command-code",   name: "Command Code",                       dir: ".command-code/skills",   ext: "md",  group: "dedicated" },
  { key: "continue",       name: "Continue",                           dir: ".continue/rules",        ext: "md",  group: "dedicated" },
  { key: "cortex",         name: "Cortex Code",                        dir: ".cortex/skills",         ext: "md",  group: "dedicated" },
  { key: "crush",          name: "Crush",                              dir: ".crush/skills",          ext: "md",  group: "dedicated" },
  { key: "devin",          name: "Devin (for Terminal)",               dir: ".devin/skills",          ext: "md",  group: "dedicated" },
  { key: "droid",          name: "Droid (Factory AI)",                 dir: ".droid/skills",          ext: "md",  group: "dedicated" },
  { key: "forgecode",      name: "ForgeCode",                          dir: ".forgecode/skills",      ext: "md",  group: "dedicated" },
  { key: "goose",          name: "Goose",                              dir: ".goose/skills",          ext: "md",  group: "dedicated" },
  { key: "bob",            name: "IBM Bob",                            dir: ".bob/skills",            ext: "md",  group: "dedicated" },
  { key: "iflow-cli",      name: "iFlow CLI",                          dir: ".iflow/skills",          ext: "md",  group: "dedicated" },
  { key: "junie",          name: "Junie",                              dir: ".junie/skills",          ext: "md",  group: "dedicated" },
  { key: "kilo",           name: "Kilo Code",                          dir: ".kilo/skills",           ext: "md",  group: "dedicated" },
  { key: "kiro-cli",       name: "Kiro CLI",                           dir: ".kiro/skills",           ext: "md",  group: "dedicated" },
  { key: "kode",           name: "Kode",                               dir: ".kode/skills",           ext: "md",  group: "dedicated" },
  { key: "mcpjam",         name: "MCPJam",                             dir: ".mcpjam/skills",         ext: "md",  group: "dedicated" },
  { key: "mistral-vibe",   name: "Mistral Vibe",                       dir: ".mistral/skills",        ext: "md",  group: "dedicated" },
  { key: "mux",            name: "Mux",                                dir: ".mux/skills",            ext: "md",  group: "dedicated" },
  { key: "neovate",        name: "Neovate",                            dir: ".neovate/skills",        ext: "md",  group: "dedicated" },
  { key: "openclaw",       name: "OpenClaw",                           dir: ".openclaw/skills",       ext: "md",  group: "dedicated" },
  { key: "openhands",      name: "OpenHands",                          dir: ".openhands/skills",      ext: "md",  group: "dedicated" },
  { key: "pi",             name: "Pi",                                 dir: ".pi/skills",             ext: "md",  group: "dedicated" },
  { key: "pochi",          name: "Pochi",                              dir: ".pochi/skills",          ext: "md",  group: "dedicated" },
  { key: "qoder",          name: "Qoder",                              dir: ".qoder/skills",          ext: "md",  group: "dedicated" },
  { key: "qwen-code",      name: "Qwen Code",                          dir: ".qwen/skills",           ext: "md",  group: "dedicated" },
  { key: "roo",            name: "Roo Code",                           dir: ".roo/rules",             ext: "md",  group: "dedicated" },
  { key: "tabnine-cli",    name: "Tabnine CLI",                        dir: ".tabnine/skills",        ext: "md",  group: "dedicated" },
  { key: "trae",           name: "Trae",                               dir: ".trae/skills",           ext: "md",  group: "dedicated" },
  { key: "trae-cn",        name: "Trae CN",                            dir: ".trae-cn/skills",        ext: "md",  group: "dedicated" },
  { key: "windsurf",       name: "Windsurf",                           dir: ".windsurf/rules",        ext: "md",  group: "dedicated" },
  { key: "zencoder",       name: "Zencoder",                           dir: ".zencoder/skills",       ext: "md",  group: "dedicated" },
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

// ─── Install skills into chosen agent directory ───────────────────────────────

function skillStub(skill) {
  return [
    `---`,
    `name: fluid-${skill.name}`,
    `description: ${skill.desc}`,
    `---`,
    ``,
    `# fluid-${skill.name}`,
    ``,
    `${skill.desc}`,
    ``,
    `## Requirements`,
    ``,
    `Set \`FLUID_AGENT_KEY\` in your environment (generated by \`npx fadp\`).`,
    ``,
    `## Usage`,
    ``,
    `\`\`\`js`,
    `import { FluidAgent } from '@fluid-wallet/agentkit';`,
    `const agent = new FluidAgent({ agentKey: process.env.FLUID_AGENT_KEY });`,
    `// agent can now ${skill.desc.toLowerCase()}`,
    `\`\`\``,
    ``,
  ].join("\n");
}

function installSkillsForAgent(selected, target, scope) {
  const base    = scope === "global" ? os.homedir() : process.cwd();
  const baseDir = path.join(base, target.dir);
  fs.mkdirSync(baseDir, { recursive: true });

  const scopeTag = scope === "global"
    ? `${C.magenta}global${C.reset}`
    : `${C.blue}project${C.reset}`;

  let count = 0;
  for (const skill of selected) {
    const srcDir = path.join(SKILLS_DIR, skill.name);

    // ensure source exists (create stub if repo wasn't cloned)
    if (!fs.existsSync(srcDir)) {
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, "SKILL.md"), skillStub(skill));
    }

    if (target.group === "universal" && scope === "project") {
      // Project + universal: symlink (stays in sync with cloned repo)
      const dest = path.join(baseDir, `fluid-${skill.name}`);
      if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
      try {
        fs.symlinkSync(srcDir, dest, "dir");
        ok(`${scopeTag}  ${C.cyan}${target.dir}/fluid-${skill.name}/${C.reset}  ${C.gray}symlinked → ${target.name}${C.reset}`);
        count++;
      } catch (e) {
        fail(`Could not symlink ${skill.name}: ${e.message}`);
      }
    } else {
      // Global universal or any dedicated: copy file (symlinks across dirs are fragile)
      const srcMd  = path.join(srcDir, "SKILL.md");
      const isDir  = target.group === "universal";
      const destDir = isDir ? path.join(baseDir, `fluid-${skill.name}`) : null;
      const destFile = isDir
        ? path.join(destDir, "SKILL.md")
        : path.join(baseDir, `fluid-${skill.name}.${target.ext}`);

      if (isDir) fs.mkdirSync(destDir, { recursive: true });

      const content = fs.existsSync(srcMd)
        ? fs.readFileSync(srcMd, "utf8")
        : skillStub(skill);
      fs.writeFileSync(destFile, content);

      const shortPath = isDir
        ? `${target.dir}/fluid-${skill.name}/`
        : `${target.dir}/fluid-${skill.name}.${target.ext}`;
      ok(`${scopeTag}  ${C.cyan}${shortPath}${C.reset}  ${C.gray}→ ${target.name}${C.reset}`);
      count++;
    }
  }
  return count;
}

function installSkillsForAgents(selected, agentTargets, scope) {
  let total = 0;
  for (const target of agentTargets) {
    total += installSkillsForAgent(selected, target, scope);
  }
  return total;
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

function scaffoldSampleProject(keyName, privateKeyJson, agentKey) {
  if (!fs.existsSync(TEMPLATE_DIR)) {
    warn("Template not found — skipping sample project scaffold.");
    return;
  }

  if (fs.existsSync(SAMPLE_DIR)) {
    warn(`${C.cyan}fadp-sample/${C.reset} already exists — skipping.`);
    return;
  }

  copyDir(TEMPLATE_DIR, SAMPLE_DIR);

  // Write .env with ALL keys pre-filled — user needs nothing else
  const envDest = path.join(SAMPLE_DIR, ".env");
  const envContent = [
    "# Auto-generated by @fluidwallet/fadp-cli — do NOT commit this file",
    `FLDP_API_KEY_NAME="${keyName}"`,
    `FLDP_API_KEY_PRIVATE_KEY='${JSON.stringify(privateKeyJson)}'`,
    agentKey ? `FLUID_AGENT_KEY="${agentKey}"` : "# FLUID_AGENT_KEY=  (not generated)",
    "",
    "FLUID_API_URL=https://fluidnative.com",
    "PORT=3001",
  ].join("\n");
  fs.writeFileSync(envDest, envContent, { mode: 0o600 });

  ok(`Scaffolded ${C.cyan}fadp-sample/${C.reset}  — all keys pre-filled in .env`);
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

// ─── Logo ─────────────────────────────────────────────────────────────────────

function printLogo() {
  const TQ = "\x1b[38;2;72;209;204m";  // exact #48d1cc
  const B  = "\x1b[1m";
  const D  = "\x1b[2m";
  const R  = "\x1b[0m";

  // FLUID
  log(`  ${B}${TQ}█████ █     █   █ ███ ████ ${R}`);
  log(`  ${B}${TQ}█     █     █   █  █  █   █${R}`);
  log(`  ${B}${TQ}████  █     █   █  █  █   █${R}`);
  log(`  ${B}${TQ}█     █     █   █  █  █   █${R}`);
  log(`  ${B}${TQ}█     █████ █████ ███ ████ ${R}`);
  nl();
  // WALLET
  log(`  ${B}${TQ}█     █  ███  █     █     █████ █████${R}`);
  log(`  ${B}${TQ}█  █  █ █   █ █     █     █       █  ${R}`);
  log(`  ${B}${TQ}█ █ █ █ █████ █     █     ████    █  ${R}`);
  log(`  ${B}${TQ}██   ██ █   █ █     █     █       █  ${R}`);
  log(`  ${B}${TQ}█     █ █   █ █████ █████ █████   █  ${R}`);
  nl();
  log(`  ${D}FADP Developer CLI  ·  fluidnative.com/fadp${R}`);
  nl();
}

// ─── Banner ───────────────────────────────────────────────────────────────────

async function banner() {
  nl();
  log(hr("═"));
  printLogo();
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
  log(`  ${C.dim}Generated on your device — only a hash is sent to Fluid servers.${C.reset}`);
  log(`  ${C.dim}This key lets your agent send, swap, and check balance on Base.${C.reset}`);
  nl();

  // Generate key locally (non-custodial) — raw key never leaves this device
  const rawKeyBytes  = crypto.randomBytes(32);
  const rawAgentKey  = `fwag_${rawKeyBytes.toString("hex")}`;          // fwag_ + 64 hex chars
  const agentKeyHash = crypto.createHash("sha256").update(rawAgentKey).digest("hex"); // 64-char hex
  const agentKeyPfx  = rawAgentKey.slice(0, 16);                       // first 16 chars
  const agentKeyName = `fluid/agentkeys/${email.replace(/[@.]/g, "_")}/agent-0`;

  let agentKey = null;
  try {
    const res = await apiPost("/api/agent-keys", {
      email,
      name:   agentKeyName,
      keyHash: agentKeyHash,
      keyPrefix: agentKeyPfx,
      scopes: ["read", "pay", "swap", "agentpay"],
    });
    if (res.keyPrefix || res.message) {
      agentKey = rawAgentKey;  // raw key shown to user — never stored server-side
    } else {
      warn(`Could not register agent key: ${res.error || JSON.stringify(res)}`);
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

  return { email, keyName, agentKey, privateKeyJson };
}

// ─── Write keys to project .env ───────────────────────────────────────────────

function writeProjectEnv(keyName, privateKeyJson, agentKey) {
  const envPath = path.join(process.cwd(), ".env");
  const marker  = "# FADP keys — added by @fluidwallet/fadp-cli";

  let existing = "";
  if (fs.existsSync(envPath)) existing = fs.readFileSync(envPath, "utf8");
  if (existing.includes(marker)) return; // already written

  const snippet = [
    "",
    marker,
    `FLDP_API_KEY_NAME="${keyName}"`,
    `FLDP_API_KEY_PRIVATE_KEY='${JSON.stringify(privateKeyJson)}'`,
    agentKey ? `FLUID_AGENT_KEY="${agentKey}"` : "",
    "",
  ].filter(l => l !== undefined).join("\n");

  fs.appendFileSync(envPath, snippet);
  ok(`Keys appended to ${C.cyan}.env${C.reset}`);
}

// ─── Yes/No prompt ────────────────────────────────────────────────────────────

async function ask(question) {
  const ans = await prompt(`${question} ${C.gray}[Y/n]${C.reset}`);
  return ans === "" || ans.toLowerCase() === "y" || ans.toLowerCase() === "yes";
}

// ─── Mode 1: install only (interactive per-component) ─────────────────────────

async function runModeInstall() {
  log(`\n  ${C.dim}Mode: ${C.reset}${C.bold}Install FADP in existing project${C.reset}\n`);
  log(`  ${C.dim}You'll be asked about each component. Press Enter to accept default [Y].${C.reset}\n`);

  const { keyName, agentKey, privateKeyJson } = await stepAccountAndKeys();

  let stepNum = 4;
  const installed = [];

  // ── fluid-fadp ──────────────────────────────────────────────────────────────
  step(stepNum++, "fluid-fadp  (FADP/1.0 payment gate middleware)");
  log(`  ${C.dim}Adds HTTP 402 payment gating to your Express routes.${C.reset}\n`);
  if (await ask("Install fluid-fadp?")) {
    try {
      execSync("npm install fluid-fadp", { stdio: "pipe", cwd: process.cwd() });
      ok(`${C.cyan}fluid-fadp${C.reset} installed`);
      installed.push("fluid-fadp");
    } catch { warn("npm install failed — run: npm install fluid-fadp"); }
  } else { log(`  ${C.gray}Skipped.${C.reset}`); }
  nl();

  // ── fluid-ticker ────────────────────────────────────────────────────────────
  step(stepNum++, "fluid-ticker  (live crypto price aggregator)");
  log(`  ${C.dim}11-source price oracle — ETH, BTC, SOL and 1000+ tokens.${C.reset}\n`);
  if (await ask("Install fluid-ticker?")) {
    try {
      execSync("npm install fluid-ticker", { stdio: "pipe", cwd: process.cwd() });
      ok(`${C.cyan}fluid-ticker${C.reset} installed`);
      installed.push("fluid-ticker");
    } catch { warn("npm install failed — run: npm install fluid-ticker"); }
  } else { log(`  ${C.gray}Skipped.${C.reset}`); }
  nl();

  // ── agent skills ────────────────────────────────────────────────────────────
  step(stepNum++, "Agent Skills  (send, swap, balance, price…)");
  log(`  ${C.dim}54 agents supported — Universal (.agents/skills/) and dedicated dirs.${C.reset}\n`);
  if (await ask("Install agent skills?")) {
    log(`  ${C.dim}Repo: ${SKILLS_REPO}${C.reset}`);
    cloneSkillsRepo();
    nl();
    log(`  ${C.dim}Select which skills to install:${C.reset}\n`);
    const chosen = await multiSelect(AGENT_SKILLS);
    nl();
    if (chosen.length > 0) {
      log(`  ${C.bold}Which agents do you want to install to?${C.reset}`);
      log(`  ${C.dim}${C.cyan}SPACE${C.reset}${C.dim} = select/deselect  ${C.reset}${C.cyan}A${C.reset}${C.dim} = select all  ${C.reset}${C.cyan}ENTER${C.reset}${C.dim} = confirm${C.reset}`);
      const agentTargets = await multiSelect(AGENT_TARGETS);
      nl();
      if (agentTargets.length > 0) {
        log(`  ${C.bold}Installation scope${C.reset}`);
        const scope = await selectScope();
        nl();
        const scopeLabel = scope === "global" ? `${C.magenta}global ~/${C.reset}` : `${C.blue}project ./${C.reset}`;
        const names = agentTargets.map(t => t.name).join(", ");
        ok(`Installing ${C.bold}${chosen.length} skill${chosen.length === 1 ? "" : "s"}${C.reset} into ${C.bold}${agentTargets.length} agent${agentTargets.length === 1 ? "" : "s"}${C.reset}  [${scopeLabel}]`);
        log(`  ${C.dim}${names}${C.reset}\n`);
        const count = installSkillsForAgents(chosen, agentTargets, scope);
        nl();
        ok(`${C.bold}${count} installation${count === 1 ? "" : "s"} complete${C.reset}`);
        installed.push("agent-skills");
      } else {
        warn("No agents selected.");
      }
    } else {
      warn("No skills selected.");
    }
  } else { log(`  ${C.gray}Skipped.${C.reset}`); }
  nl();

  // ── sample gated server snippet ─────────────────────────────────────────────
  step(stepNum++, "Sample code  (gated server + paying agent)");
  log(`  ${C.dim}Copies a ready-to-run server.js and agent.js into fadp-sample/.${C.reset}\n`);
  if (await ask("Scaffold fadp-sample/ with example server + agent?")) {
    scaffoldSampleProject(keyName);
    installed.push("fadp-sample");
  } else { log(`  ${C.gray}Skipped.${C.reset}`); }
  nl();

  // ── write keys to .env ──────────────────────────────────────────────────────
  step(stepNum++, "Write keys to .env");
  log(`  ${C.dim}Appending FADP keys to your project .env…${C.reset}\n`);
  writeProjectEnv(keyName, privateKeyJson, agentKey);
  nl();

  // ── summary ─────────────────────────────────────────────────────────────────
  log(hr("═"));
  log(`${C.bold}${C.green}  ✓  FADP ready in your project!${C.reset}`);
  log(hr("═"));
  nl();
  log(`  ${C.bold}${C.white}Next steps:${C.reset}`);
  nl();
  log(`  ${C.cyan}[1]${C.reset}  ${C.bold}code .${C.reset}                       ${C.dim}← open this project in VS Code${C.reset}`);
  log(`  ${C.cyan}[2]${C.reset}  ${C.bold}echo '.env.fadp' >> .gitignore${C.reset}${C.dim}  ← protect your keys${C.reset}`);
  if (installed.includes("fadp-sample")) {
    log(`  ${C.cyan}[3]${C.reset}  ${C.bold}cd fadp-sample && npm install${C.reset}${C.dim}   ← install sample dependencies${C.reset}`);
    log(`  ${C.cyan}[4]${C.reset}  ${C.bold}node fadp-sample/server.js${C.reset}   ${C.dim}← terminal 1: gated API server${C.reset}`);
    log(`  ${C.cyan}[5]${C.reset}  ${C.bold}node fadp-sample/agent.js${C.reset}    ${C.dim}← terminal 2: paying agent${C.reset}`);
  }
  nl();
  log(`  ${C.dim}Installed: ${installed.length ? installed.join(", ") : "none"}${C.reset}`);
  log(`  ${C.dim}Skills in your agent's directory  ·  Keys in .env + .env.fadp${C.reset}`);
  log(`  ${C.dim}Docs: fluidnative.com/fadp${C.reset}`);
  nl();
}

// ─── Mode 2: full TypeScript project ─────────────────────────────────────────

async function runModeProject() {
  log(`\n  ${C.dim}Mode: ${C.reset}${C.bold}Scaffold full TypeScript project${C.reset}\n`);

  const { email, keyName, agentKey, privateKeyJson } = await stepAccountAndKeys();

  step(3, "Clone Agent Skills Repo");
  log(`  ${C.dim}Repo: ${SKILLS_REPO}${C.reset}`);
  nl();
  cloneSkillsRepo();
  nl();

  step(4, "Select Agent Skills to Install");
  log(`  ${C.dim}Choose which Fluid agent skills to install:${C.reset}`);
  const chosen = await multiSelect(AGENT_SKILLS);
  nl();
  if (chosen.length === 0) {
    warn("No skills selected. Run `fadp` again to install skills.");
  } else {
    log(`  ${C.bold}Which agents do you want to install to?${C.reset}`);
    log(`  ${C.dim}${C.cyan}SPACE${C.reset}${C.dim} = select/deselect  ${C.reset}${C.cyan}A${C.reset}${C.dim} = select all  ${C.reset}${C.cyan}ENTER${C.reset}${C.dim} = confirm${C.reset}`);
    const agentTargets = await multiSelect(AGENT_TARGETS);
    nl();
    if (agentTargets.length > 0) {
      log(`  ${C.bold}Installation scope${C.reset}`);
      const scope = await selectScope();
      nl();
      const scopeLabel = scope === "global" ? `${C.magenta}global ~/${C.reset}` : `${C.blue}project ./${C.reset}`;
      const names = agentTargets.map(t => t.name).join(", ");
      ok(`Installing ${C.bold}${chosen.length} skill${chosen.length === 1 ? "" : "s"}${C.reset} into ${C.bold}${agentTargets.length} agent${agentTargets.length === 1 ? "" : "s"}${C.reset}  [${scopeLabel}]`);
      log(`  ${C.dim}${names}${C.reset}\n`);
      const count = installSkillsForAgents(chosen, agentTargets, scope);
      nl();
      ok(`${C.bold}${count} installation${count === 1 ? "" : "s"} complete${C.reset}`);
    } else {
      warn("No agents selected — run `fadp` again to install skills.");
    }
  }

  step(5, "Sample TypeScript Project");
  log(`  ${C.dim}Scaffolding fadp-sample/ — gated API server + paying agent.${C.reset}`);
  log(`  ${C.dim}All your keys will be written to fadp-sample/.env automatically.${C.reset}`);
  nl();
  scaffoldSampleProject(keyName, privateKeyJson, agentKey);
  nl();

  log(hr("═"));
  log(`${C.bold}${C.green}  ✓  FADP project ready!${C.reset}`);
  log(hr("═"));
  nl();
  log(`  ${C.bold}${C.white}Next steps:${C.reset}`);
  nl();
  log(`  ${C.cyan}[1]${C.reset}  ${C.bold}cd fadp-sample${C.reset}              ${C.dim}← enter your project${C.reset}`);
  log(`  ${C.cyan}[2]${C.reset}  ${C.bold}code .${C.reset}                       ${C.dim}← open in VS Code${C.reset}`);
  log(`  ${C.cyan}[3]${C.reset}  ${C.bold}npm install${C.reset}                  ${C.dim}← install dependencies${C.reset}`);
  log(`  ${C.cyan}[4]${C.reset}  ${C.bold}node server.js${C.reset}               ${C.dim}← terminal 1: start gated API${C.reset}`);
  log(`  ${C.cyan}[5]${C.reset}  ${C.bold}node agent.js${C.reset}                ${C.dim}← terminal 2: run paying agent${C.reset}`);
  nl();
  log(`  ${C.dim}Keys saved in .env.fadp — run: echo '.env.fadp' >> .gitignore${C.reset}`);
  log(`  ${C.dim}Skills installed into your agent's directory  —  Docs: fluidnative.com/fadp${C.reset}`);
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
