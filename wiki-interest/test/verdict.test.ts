import { describe, expect, test } from "vitest";
import { EXIT_CODES } from "../src/cli.ts";
import type { CheckName, Confidence, Direction } from "../src/verdict.ts";
import { astronomyInUkrainian, EDITION_VIEWS, linear, run, runJson, WINDOW_24 } from "./run-cli.ts";

// A 6-month Window on 2026-09-26 is 2026-03..2026-08.
const WINDOW_6 = { start: "2026-03", months: 6 };

type Series = (month: string) => number | undefined;

async function analyze(
  views: Series,
  options: { months?: number; totals?: Series; extra?: Record<string, number> } = {},
) {
  const fake = astronomyInUkrainian()
    .editionTotals("uk", options.totals ?? (() => EDITION_VIEWS))
    .article("uk", "Астрономія", views, { extra: options.extra });
  const months = String(options.months ?? 24);
  const result = await run(["analyze", "--topics", "Q333", "--editions", "uk", "--months", months], fake);
  const [basket] = runJson(result.stdout).baskets;
  return { ...result, basket };
}

// Edition totals that fall 30% in a straight line together with the Basket's views, so Share of edition stays
// exactly 50 per million.
const shrinkingViews = linear(5_000, 3_500, WINDOW_24);

// Expected Verdicts written down in the spec before implementation. If one disagrees with the output,
// fix the implementation or raise the row for review; never edit a row to match the output.
const SYNTHETIC_SERIES: {
  name: string;
  views: Series;
  months?: number;
  totals?: Series;
  extra?: Record<string, number>;
  direction: Direction | null;
  confidence: Confidence;
  failedChecks: CheckName[];
}[] = [
  { name: "Flat", views: () => 5_000, direction: "flat", confidence: "high", failedChecks: [] },
  {
    name: "Steady growth",
    views: linear(2_000, 6_000, WINDOW_24),
    direction: "growing",
    confidence: "high",
    failedChecks: [],
  },
  {
    name: "News Spike",
    views: () => 3_000,
    extra: { "2026-04-15": 60_000 },
    direction: "growing",
    confidence: "low",
    failedChecks: ["spikes", "consistency"],
  },
  {
    name: "Created mid-Window",
    views: (month) => (month < "2025-03" ? undefined : 2_000),
    direction: "flat",
    confidence: "medium",
    failedChecks: ["full-history"],
  },
  {
    name: "Shrinking Edition",
    views: shrinkingViews,
    totals: (month) => shrinkingViews(month) * 20_000,
    direction: "flat",
    confidence: "high",
    failedChecks: [],
  },
  {
    name: "Short Window",
    months: 6,
    views: linear(2_000, 3_000, WINDOW_6),
    direction: "growing",
    confidence: "medium",
    failedChecks: ["seasonality"],
  },
  { name: "Tiny volume", views: () => 50, direction: null, confidence: "insufficient", failedChecks: ["enough-data"] },
  {
    name: "Low volume",
    views: linear(300, 900, WINDOW_24),
    direction: "growing",
    confidence: "medium",
    failedChecks: ["volume"],
  },
];

describe("Verdict", () => {
  test.each(SYNTHETIC_SERIES)(
    "$name: $direction, $confidence Confidence, failed Checks $failedChecks",
    async ({ views, months, totals, extra, direction, confidence, failedChecks }) => {
      const { code, stdout, basket } = await analyze(views, { months, totals, extra });

      expect(code).toBe(EXIT_CODES.success);
      expect({
        direction: basket.verdict.direction,
        confidence: basket.verdict.confidence,
        failedChecks: basket.verdict.failedChecks.map((failed: { check: string }) => failed.check).sort(),
      }).toEqual({ direction, confidence, failedChecks: [...failedChecks].sort() });
      expect(stdout).toMatch(
        new RegExp(`^\\| astronomy \\(Q333\\) \\| uk \\| ${direction ?? "none"} \\| ${confidence} \\|`, "m"),
      );
    },
  );

  test("a shrinking Edition keeps Share of edition flat while Raw change declines", async () => {
    const { stdout, basket } = await analyze(shrinkingViews, { totals: (month) => shrinkingViews(month) * 20_000 });

    expect(basket.metrics.rawChange).toBeLessThan(-0.1);
    expect(stdout).toMatch(/^\| astronomy \(Q333\) \| uk \| flat \| high \| \+0\.0% \| -16\.\d% \|/m);
  });

  test("a steady fall is declining with high Confidence", async () => {
    const { basket } = await analyze(linear(6_000, 2_000, WINDOW_24));

    expect(basket.verdict).toMatchObject({ direction: "declining", confidence: "high", failedChecks: [] });
  });

  test("prints each failed Check's Reason under its Basket, and saves it in the Run JSON", async () => {
    const { stdout, basket } = await analyze(() => 3_000, { extra: { "2026-04-15": 60_000 } });

    const reasons = basket.verdict.failedChecks.map((failed: { reason: string }) => failed.reason);
    expect(reasons).toHaveLength(2);
    const section = stdout.slice(stdout.indexOf("\nreasons:\n"));
    expect(section).toMatch(/^astronomy \(Q333\) in uk, low Confidence:$/m);
    for (const reason of reasons) expect(section).toContain(`  - ${reason}\n`);
  });

  test("prints no Reasons when every Check passes", async () => {
    const { stdout } = await analyze(() => 5_000);

    expect(stdout).toContain("\nreasons: none, every Check passed\n");
  });
});

describe("Checks", () => {
  test("Enough data fails when a half of the Window has data for fewer than half of its months", async () => {
    // Created in month 12 of 24: the first half (2024-09..2025-08) has 1 month with data.
    const { stdout, basket } = await analyze((month) => (month < "2025-08" ? undefined : 2_000));

    expect(basket.verdict).toMatchObject({ direction: null, confidence: "insufficient" });
    expect(stdout).toMatch(/^ {2}- Enough data: .*2024-09 to 2025-08.* 1 of its 12 months/m);
  });

  test("Enough data fails when median monthly views are under 100, and no other Check runs", async () => {
    const { stdout, basket } = await analyze(() => 50, { months: 6 });

    expect(basket.verdict.failedChecks.map((failed: { check: string }) => failed.check)).toEqual(["enough-data"]);
    expect(stdout).toMatch(/^ {2}- Enough data: median monthly views are 50, under 100/m);
  });

  test("Volume names the median monthly views", async () => {
    const { stdout } = await analyze(() => 600);

    expect(stdout).toMatch(/^ {2}- Volume: median monthly views are 600, under 1,000/m);
  });

  test("Consistency fails for a flat Direction when month by month Share of edition trends significantly", async () => {
    // Growth over the halves is about +8%, inside the flat band, but every month is higher than the one before.
    const { stdout, basket } = await analyze(linear(5_000, 5_800, WINDOW_24));

    expect(basket.verdict).toMatchObject({
      direction: "flat",
      confidence: "medium",
      failedChecks: [{ check: "consistency" }],
    });
    expect(stdout).toMatch(/^ {2}- Consistency: the halves say flat, but .* keeps rising .*Mann–Kendall p < 0\.001/m);
  });

  test("Consistency fails when the month-by-month trend runs against Direction", async () => {
    // A slow fall with one huge month in the second half: the halves say growing, the months say declining.
    const falling = linear(5_000, 4_000, WINDOW_24);
    const { stdout, basket } = await analyze((month) => (month === "2026-04" ? 100_000 : falling(month)));

    expect(basket.verdict).toMatchObject({
      direction: "growing",
      confidence: "medium",
      failedChecks: [{ check: "consistency" }],
    });
    expect(stdout).toMatch(/^ {2}- Consistency: the halves say growing, but .* keeps falling/m);
  });

  test("Consistency fails for a growing Direction without a significant trend, naming p", async () => {
    const { stdout } = await analyze(() => 3_000, { extra: { "2026-04-15": 60_000 } });

    expect(stdout).toMatch(/^ {2}- Consistency: .*doesn't rise or fall steadily .*Mann–Kendall p = 0\.3\d\d/m);
  });

  test("Spikes names the share of the 5 highest-view days and their dates", async () => {
    const { stdout } = await analyze(() => 3_000, { extra: { "2026-04-15": 60_000 } });

    // 60,100 on 2026-04-15 plus 4 × 108 (the first days of February 2025) = 60,532 of 132,000 views.
    expect(stdout).toMatch(
      /^ {2}- Spikes: the 5 highest-view days \(2025-02-01, 2025-02-02, 2025-02-03, 2025-02-04, 2026-04-15\) hold 45\.9% of the Window's views, over 25%/m,
    );
  });

  test("Agreement fails when raw views and Share of edition point opposite ways", async () => {
    // The Edition halves its traffic in the second half, while the Article loses only a third.
    const { stdout, basket } = await analyze((month) => (month < "2025-09" ? 3_000 : 2_000), {
      totals: (month) => (month < "2025-09" ? EDITION_VIEWS : EDITION_VIEWS / 2),
    });

    expect(basket.verdict).toMatchObject({ direction: "growing", failedChecks: [{ check: "agreement" }] });
    expect(stdout).toMatch(/^ {2}- Agreement: Share of edition says growing \(\+33\.3%\) but raw views say declining \(-33\.3%\)/m);
  });

  test("Full history names the Article and its first month, and says created or renamed", async () => {
    const { stdout } = await analyze((month) => (month < "2025-03" ? undefined : 2_000));

    expect(stdout).toMatch(/^ {2}- Full history: Астрономія has data only from 2025-03, .*2024-09.*created or renamed/m);
  });

  test.each([
    { months: 6, halves: "2026-03 to 2026-05 with 2026-06 to 2026-08", suggested: 24 },
    { months: 40, halves: "2023-05 to 2024-12 with 2025-01 to 2026-08", suggested: 48 },
    // Halfway between 48 and 72: the shorter Window stays inside the span asked about.
    { months: 60, halves: "2021-09 to 2024-02 with 2024-03 to 2026-08", suggested: 48 },
  ])(
    "Seasonality for a $months-month Window names the halves and suggests the nearest multiple of 24, --months $suggested",
    async ({ months, halves, suggested }) => {
      const { stdout } = await analyze(() => 5_000, { months });

      expect(stdout).toMatch(new RegExp(`^ {2}- Seasonality: .*compares ${halves}.*--months ${suggested}\\b`, "m"));
    },
  );
});
