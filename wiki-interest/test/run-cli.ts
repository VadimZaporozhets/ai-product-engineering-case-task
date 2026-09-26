// Calls the CLI entry function the way the agent would, with the fake APIs and a fixed clock.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import type { Fetch } from "../src/http.ts";
import { fakeWikimedia } from "./fake-wikimedia.ts";

const SEPT_26_2026 = new Date("2026-09-26T11:00:00Z");

export async function run(
  argv: string[],
  fake: { fetch: Fetch },
  options: { now?: Date; outputDir?: string; cacheDir?: string; userAgent?: string } = {},
) {
  let stdout = "";
  const outputDir = options.outputDir ?? mkdtempSync(join(tmpdir(), "wiki-interest-out-"));
  /** Every wait between attempts, in milliseconds; tests never actually wait. */
  const sleeps: number[] = [];
  const code = await main(argv, {
    fetch: fake.fetch,
    now: () => options.now ?? SEPT_26_2026,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    cacheDir: options.cacheDir ?? newCacheDir(),
    outputDir,
    userAgent: options.userAgent,
    stdout: { write: (chunk: string) => (stdout += chunk) },
  });
  return { code, stdout, outputDir, sleeps };
}

/** An empty cache directory, for Runs that should share one. */
export function newCacheDir(): string {
  return mkdtempSync(join(tmpdir(), "wiki-interest-cache-"));
}

/** The Run JSON whose path the Run printed on its `run file:` line. */
export function runJson(stdout: string) {
  const runFile = stdout.match(/^run file: (.+)$/m)![1]!;
  return JSON.parse(readFileSync(runFile, "utf8"));
}

export function astronomyInUkrainian() {
  return fakeWikimedia().item("Q333", {
    label: "astronomy",
    description: "natural science studying celestial objects",
    articles: { uk: "Астрономія", en: "Astronomy" },
  });
}
