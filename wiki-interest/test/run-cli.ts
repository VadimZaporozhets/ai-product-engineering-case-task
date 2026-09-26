// Calls the CLI entry function the way the agent would, with the fake APIs and a fixed clock.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import type { Fetch } from "../src/http.ts";
import { monthsFrom } from "../src/months.ts";
import { fakeWikimedia } from "./fake-wikimedia.ts";

const SEPT_26_2026 = new Date("2026-09-26T11:00:00Z");

/** The default Window on 2026-09-26: 2024-09..2026-08. */
export const WINDOW_24 = { start: "2024-09", months: 24 };
export const EDITION_VIEWS = 100_000_000;

/** Views on a straight line from `from` in the Window's first month to `to` in its last, rounded. */
export function linear(from: number, to: number, window: { start: string; months: number } = WINDOW_24) {
  return (month: string) => Math.round(from + ((to - from) * monthsFrom(window.start, month)) / (window.months - 1));
}

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

/** The path the Run printed on its `run file:` line. */
export function runFilePath(stdout: string): string {
  return stdout.match(/^run file: (.+)$/m)![1]!;
}

/** The Run JSON whose path the Run printed on its `run file:` line. */
export function runJson(stdout: string) {
  return JSON.parse(readFileSync(runFilePath(stdout), "utf8"));
}

export function astronomyInUkrainian() {
  return fakeWikimedia().item("Q333", {
    label: "astronomy",
    description: "natural science studying celestial objects",
    articles: { uk: "Астрономія", en: "Astronomy" },
  });
}

/** Astronomy (Q333) and physics (Q413), each with an Article in uk and pl. */
export function twoTopicsInTwoEditions() {
  return fakeWikimedia()
    .item("Q333", {
      label: "astronomy",
      description: "natural science studying celestial objects",
      articles: { uk: "Астрономія", pl: "Astronomia" },
    })
    .item("Q413", { label: "physics", description: "natural science", articles: { uk: "Фізика", pl: "Fizyka" } })
    .editionTotals("uk", () => EDITION_VIEWS)
    .editionTotals("pl", () => EDITION_VIEWS);
}

/** Growing fast, flat, growing slowly, and too few views to judge. */
export function fourBaskets() {
  return twoTopicsInTwoEditions()
    .article("uk", "Астрономія", linear(2_000, 6_000))
    .article("pl", "Astronomia", () => 5_000)
    .article("uk", "Фізика", linear(3_000, 4_000))
    .article("pl", "Fizyka", () => 50);
}
