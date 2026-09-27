#!/usr/bin/env node
// Entry point of the wiki-interest CLI: node scripts/wiki-interest.js <command> [options]
//
// Plain JavaScript on purpose: it has to run on an old Node to say what's wrong before the
// TypeScript sources load. It prints the fix and never installs anything itself.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Same value as EXIT_CODES.setupError in src/exit-codes.ts; test/setup-guard.test.ts checks it.
const SETUP_ERROR = 4;
const REQUIRED_NODE = { major: 22, minor: 18 };

const skillDir = dirname(dirname(fileURLToPath(import.meta.url)));

function setupProblem() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const tooOld = major < REQUIRED_NODE.major || (major === REQUIRED_NODE.major && minor < REQUIRED_NODE.minor);
  // Node 23 only strips TypeScript types by default from 23.6 on.
  const noTypeStripping = major === 23 && minor < 6;
  if (tooOld || noTypeStripping) {
    return (
      `wiki-interest needs Node.js ${REQUIRED_NODE.major}.${REQUIRED_NODE.minor} or newer; this is Node.js ${process.versions.node}.\n` +
      "Install a newer Node (for example `nvm install 24`), then run the command again."
    );
  }

  const manifest = JSON.parse(readFileSync(join(skillDir, "package.json"), "utf8"));
  const missing = Object.keys(manifest.dependencies || {}).filter(
    (name) => !existsSync(join(skillDir, "node_modules", name, "package.json")),
  );
  if (missing.length > 0) {
    return (
      `wiki-interest's dependencies aren't installed (missing: ${missing.join(", ")}). Run this once, then run the command again:\n` +
      `  npm ci --omit=dev --prefix ${shellQuote(skillDir)}`
    );
  }
  return undefined;
}

// Same rule as shellQuote in src/cli.ts.
function shellQuote(text) {
  return /^[\w./-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}

const problem = setupProblem();
if (problem) {
  console.log(`setup error: ${problem}`);
  // exitCode rather than exit(), so the message isn't cut off when stdout is a pipe.
  process.exitCode = SETUP_ERROR;
} else {
  import("../src/cli.ts").then((cli) => cli.runFromProcess());
}
