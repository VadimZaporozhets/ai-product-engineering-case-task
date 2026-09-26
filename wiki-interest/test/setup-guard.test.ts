// The entry script's setup checks run before any TypeScript loads, so these tests spawn it.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { EXIT_CODES } from "../src/cli.ts";

const ENTRY_SCRIPT = fileURLToPath(new URL("../scripts/wiki-interest.js", import.meta.url));

function spawnEntry(script: string, args: string[], nodeOptions: string[] = []) {
  const cwd = mkdtempSync(join(tmpdir(), "wiki-interest-cwd-"));
  const result = spawnSync(process.execPath, [...nodeOptions, script, ...args], { cwd, encoding: "utf8" });
  return { code: result.status, output: result.stdout + result.stderr, cwd };
}

describe("setup guard", () => {
  // Node 23.0–23.5 are newer than 22.18 but don't strip TypeScript types by default.
  test.each(["20.11.0", "22.17.1", "23.5.0"])(
    "on Node %s it prints the required version with an install hint",
    (version) => {
      const pretend = `data:text/javascript,Object.defineProperty(process.versions,"node",{value:"${version}"})`;

      const { code, output } = spawnEntry(ENTRY_SCRIPT, ["analyze"], ["--import", pretend]);

      expect(code).toBe(EXIT_CODES.setupError);
      expect(output).toContain("needs Node.js 22.18 or newer");
      expect(output).toContain(version);
      expect(output).toContain("nvm install 24");
    },
  );

  test("without installed dependencies it prints the exact install command and installs nothing", () => {
    // Real path, because Node resolves the script to it (on macOS /var is a link to /private/var).
    const skillDir = realpathSync(mkdtempSync(join(tmpdir(), "skill dir-")));
    mkdirSync(join(skillDir, "scripts"));
    copyFileSync(ENTRY_SCRIPT, join(skillDir, "scripts", "wiki-interest.js"));
    writeFileSync(
      join(skillDir, "package.json"),
      JSON.stringify({ name: "wiki-interest", type: "module", dependencies: { "left-pad": "1.3.0" } }),
    );

    const { code, output } = spawnEntry(join(skillDir, "scripts", "wiki-interest.js"), ["analyze"]);

    expect(code).toBe(EXIT_CODES.setupError);
    expect(output).toContain(`npm ci --omit=dev --prefix '${skillDir}'`);
    expect(existsSync(join(skillDir, "node_modules"))).toBe(false);
  });

  test("with Node and dependencies in place it hands over to the CLI", () => {
    const { code, output, cwd } = spawnEntry(ENTRY_SCRIPT, ["no-such-command"]);

    expect(code).toBe(EXIT_CODES.blocked);
    expect(output).toContain('blocked: unknown command "no-such-command"');
    expect(existsSync(join(cwd, "wiki-interest-runs"))).toBe(false);
  });
});
