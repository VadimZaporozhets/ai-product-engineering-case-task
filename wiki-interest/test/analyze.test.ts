import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { EXIT_CODES } from "../src/cli.ts";
import { fakeWikimedia } from "./fake-wikimedia.ts";
import { astronomyInUkrainian, run, runJson } from "./run-cli.ts";

describe("analyze one Topic in one Edition", () => {
  test("prints the rerun line in resolved form and one result row", async () => {
    // Window 2024-09..2026-08. The Article rises from 1,000 to 1,500 views a month,
    // while the whole Edition doubles in the second half, so its Share of edition falls.
    const fake = astronomyInUkrainian()
      .editionTotals("uk", (month) => (month < "2025-09" ? 100_000_000 : 200_000_000))
      .article("uk", "Астрономія", (month) => (month < "2025-09" ? 1_000 : 1_500));

    const { code, stdout } = await run(["analyze", "--topics", "Q333", "--editions", "uk"], fake);

    expect(code).toBe(EXIT_CODES.success);
    expect(stdout).toMatch(/^rerun: node .*wiki-interest\.js.? analyze --topics Q333 --editions uk --months 24 --end 2026-08$/m);
    // Median of 12 × 1,000 and 12 × 1,500 = 1,250. Views per million = 30,000 / 3.6e9 × 1e6.
    // Growth = (7.5 per million) / (10 per million) − 1. Raw change = 1,500 / 1,000 − 1.
    // Declining, with medium Confidence: raw views point the opposite way, failing the Agreement Check.
    expect(stdout).toContain("| astronomy (Q333) | uk | declining | medium | -25.0% | +50.0% | 1250 | 8.33 |");
  });

  test("fetches human daily views and monthly Edition totals for exactly the given Window", async () => {
    const fake = astronomyInUkrainian()
      .editionTotals("uk", () => 100_000_000)
      .article("uk", "Астрономія", () => 3_000);

    const { code, stdout } = await run(
      ["analyze", "--topics", "Q333", "--editions", "uk", "--months", "6", "--end", "2026-03"],
      fake,
    );

    expect(code).toBe(EXIT_CODES.success);
    expect(stdout).toMatch(/^rerun: .* --months 6 --end 2026-03$/m);
    expect(fake.pageviewRequests().map((url) => url.pathname)).toEqual([
      "/api/rest_v1/metrics/pageviews/aggregate/uk.wikipedia.org/all-access/user/monthly/20251001/20260331",
      `/api/rest_v1/metrics/pageviews/per-article/uk.wikipedia.org/all-access/user/${encodeURIComponent("Астрономія")}/daily/20251001/20260331`,
    ]);
  });

  test("defaults to the 24 months ending with the last complete month, and never requests the current month", async () => {
    const fake = astronomyInUkrainian()
      .editionTotals("uk", () => 100_000_000)
      .article("uk", "Астрономія", () => 3_000);

    // 1 September: August is the last complete month even on the first day of the next one.
    await run(["analyze", "--topics", "Q333", "--editions", "uk"], fake, { now: new Date("2026-09-01T00:30:00Z") });

    for (const url of fake.pageviewRequests()) {
      expect(url.pathname).toMatch(/\/20240901\/20260831$/);
    }
  });

  test("compares the halves over their months with data, and counts missing days as zero", async () => {
    // Window 2024-09..2026-08. The Article has no data before 2025-03, then 3,000 views a month
    // (100 a day in June), except that the API leaves out 1..10 June 2025.
    const missingDays = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`2025-06-${String(i + 1).padStart(2, "0")}`, 0]),
    );
    const fake = astronomyInUkrainian()
      .editionTotals("uk", () => 100_000_000)
      .article("uk", "Астрономія", (month) => (month < "2025-03" ? undefined : 3_000), { days: missingDays });

    const { stdout } = await run(["analyze", "--topics", "Q333", "--editions", "uk"], fake);

    // First half: 6 months with data, 5 × 3,000 + 2,000 = 17,000 views → 28.33 per million.
    // Second half: 12 × 3,000 = 36,000 views → 30 per million. Growth = 30 / 28.33 − 1.
    // Views per million over the 18 months with data = 53,000 / 1.8e9 × 1e6.
    expect(stdout).toContain("| astronomy (Q333) | uk | flat | medium | +5.9% | +5.9% | 3000 | 29.44 |");
  });

  test("counts a month without views after the Article's first data as a month with zero views", async () => {
    // Window 2025-09..2026-08, 1,000 views a month, but the API returns no days at all for 2026-02.
    const fake = astronomyInUkrainian()
      .editionTotals("uk", () => 100_000_000)
      .article("uk", "Астрономія", (month) => (month === "2026-02" ? undefined : 1_000));

    const { stdout } = await run(["analyze", "--topics", "Q333", "--editions", "uk", "--months", "12"], fake);

    // First half: 5,000 views over 6 months → 8.33 per million; second half: 6,000 → 10 per million.
    // Views per million over all 12 months = 11,000 / 1.2e9 × 1e6.
    expect(stdout).toContain("| astronomy (Q333) | uk | growing | low | +20.0% | +20.0% | 1000 | 9.17 |");
  });

  test("leaves the middle month out of both halves of an odd-length Window", async () => {
    const views: Record<string, number> = {
      "2026-04": 1_000,
      "2026-05": 1_000,
      "2026-06": 9_000,
      "2026-07": 2_000,
      "2026-08": 2_000,
    };
    const fake = astronomyInUkrainian()
      .editionTotals("uk", () => 100_000_000)
      .article("uk", "Астрономія", (month) => views[month]);

    const { stdout } = await run(["analyze", "--topics", "Q333", "--editions", "uk", "--months", "5"], fake);

    // Halves are 2026-04..05 and 2026-07..08. Median of the five months = 2,000.
    expect(stdout).toContain("| astronomy (Q333) | uk | growing | low | +100.0% | +100.0% | 2000 | 30.00 |");
  });

  test("takes the median over months with data only, and shows no Growth when a half has none", async () => {
    // Window 2025-09..2026-08; the Article only has data from 2026-04, 500 views a month.
    const fake = astronomyInUkrainian()
      .editionTotals("uk", () => 100_000_000)
      .article("uk", "Астрономія", (month) => (month < "2026-04" ? undefined : 500));

    const { stdout } = await run(["analyze", "--topics", "Q333", "--editions", "uk", "--months", "12"], fake);

    expect(stdout).toContain("| astronomy (Q333) | uk | none | insufficient | n/a | n/a | 500 | 5.00 |");
  });

  test("refuses an unknown Edition code before any Wikidata or Article request", async () => {
    const fake = astronomyInUkrainian()
      .editionTotals("uk", () => 100_000_000)
      .article("uk", "Астрономія", () => 3_000);

    const { code, stdout, outputDir } = await run(["analyze", "--topics", "Q333", "--editions", "uk,xx"], fake);

    expect(code).toBe(EXIT_CODES.blocked);
    expect(stdout).toMatch(/^blocked: unknown Edition code: xx\. Wikimedia has no pageviews for xx\.wikipedia\.org/m);
    expect(fake.requests.map((url) => url.pathname)).toEqual([
      "/api/rest_v1/metrics/pageviews/aggregate/uk.wikipedia.org/all-access/user/monthly/20240901/20260831",
      "/api/rest_v1/metrics/pageviews/aggregate/xx.wikipedia.org/all-access/user/monthly/20240901/20260831",
    ]);
    expect(readdirSync(outputDir)).toEqual([]);
  });

  test.each([
    {
      failing: "pageviews of the Article",
      fake: () =>
        astronomyInUkrainian()
          .editionTotals("uk", () => 100_000_000)
          .article("uk", "Астрономія", () => 3_000, { status: 500 }),
    },
    {
      failing: "Edition totals",
      fake: () =>
        astronomyInUkrainian()
          .editionTotals("uk", () => 100_000_000, { status: 503 })
          .article("uk", "Астрономія", () => 3_000),
    },
  ])("shows an error row and exits with partial failure when the $failing can't be fetched", async ({ fake }) => {
    const { code, stdout } = await run(["analyze", "--topics", "Q333", "--editions", "uk"], fake());

    expect(code).toBe(EXIT_CODES.partialFailure);
    expect(stdout).toMatch(/^\| astronomy \(Q333\) \| uk \| error: .*HTTP 50\d/m);
    const [basket] = runJson(stdout).baskets;
    expect(basket.error).toMatch(/HTTP 50\d/);
  });

  test("shows an error row and exits with partial failure when Wikidata can't be reached", async () => {
    const fake = astronomyInUkrainian()
      .editionTotals("uk", () => 100_000_000)
      .interrupt("www.wikidata.org", Array(3).fill({ status: 503 }));

    const { code, stdout } = await run(["analyze", "--topics", "Q333", "--editions", "uk"], fake);

    expect(code).toBe(EXIT_CODES.partialFailure);
    expect(stdout).toContain("| Q333 | uk | error: Wikidata lookup failed: www.wikidata.org answered HTTP 503 after 3 attempts |");
  });

  test("refuses something that isn't an Edition code", async () => {
    const fake = astronomyInUkrainian();

    const { code, stdout } = await run(["analyze", "--topics", "Q333", "--editions", "Ukrainian"], fake);

    expect(code).toBe(EXIT_CODES.blocked);
    expect(stdout).toContain("blocked: not an Edition code: Ukrainian");
    expect(fake.requests).toEqual([]);
  });

  test("refuses an unknown command with usage", async () => {
    const { code, stdout } = await run(["analyse"], fakeWikimedia());

    expect(code).toBe(EXIT_CODES.blocked);
    expect(stdout).toMatch(/^blocked: unknown command "analyse"\. Usage: analyze --topics/m);
  });

  test("blocks the Run when the Wikidata item doesn't exist", async () => {
    const fake = fakeWikimedia().editionTotals("uk", () => 100_000_000);

    const { code, stdout } = await run(["analyze", "--topics", "Q999999999", "--editions", "uk"], fake);

    expect(code).toBe(EXIT_CODES.blocked);
    expect(stdout).toContain("blocked: Wikidata item Q999999999 doesn't exist");
  });

  test.each([
    { window: ["--months", "1"], problem: "at least 2 months", nearest: "--months 2 --end 2026-08" },
    { window: ["--end", "2026-09"], problem: "not complete yet", nearest: "--months 24 --end 2026-08" },
    { window: ["--months", "6", "--end", "2027-01"], problem: "not complete yet", nearest: "--months 6 --end 2026-08" },
    { window: ["--months", "24", "--end", "2016-06"], problem: "July 2015", nearest: "--months 12 --end 2016-06" },
    { window: ["--months", "3", "--end", "2015-07"], problem: "July 2015", nearest: "--months 2 --end 2015-08" },
  ])("refuses the invalid Window $window with the nearest valid one", async ({ window, problem, nearest }) => {
    const fake = astronomyInUkrainian();

    const { code, stdout } = await run(["analyze", "--topics", "Q333", "--editions", "uk", ...window], fake);

    expect(code).toBe(EXIT_CODES.blocked);
    expect(stdout).toContain(problem);
    expect(stdout).toContain(`Nearest valid Window: ${nearest}`);
    expect(fake.requests).toEqual([]);
  });

  test.each([["--months", "two"], ["--months", "6.5"], ["--end", "2026-13"], ["--end", "08/2026"]])(
    "refuses a malformed Window argument %s %s",
    async (...window) => {
      const fake = astronomyInUkrainian();

      const { code, stdout } = await run(["analyze", "--topics", "Q333", "--editions", "uk", ...window], fake);

      expect(code).toBe(EXIT_CODES.blocked);
      expect(stdout).toMatch(/^blocked: .*(whole number of months|YYYY-MM)/m);
      expect(fake.requests).toEqual([]);
    },
  );

  test("writes the full Run as JSON into a new Run folder, and a second Run never overwrites the first", async () => {
    const fake = astronomyInUkrainian()
      .editionTotals("uk", () => 100_000_000)
      .article("uk", "Астрономія", () => 3_000);
    const outputDir = mkdtempSync(join(tmpdir(), "wiki-interest-out-"));
    const argv = ["analyze", "--topics", "Q333", "--editions", "uk", "--months", "12"];

    const first = await run(argv, fake, { outputDir });
    const second = await run(argv, fake, { outputDir });

    const runFolders = readdirSync(join(outputDir, "wiki-interest-runs"));
    expect(runFolders).toHaveLength(2);
    for (const { stdout } of [first, second]) {
      const runFile = stdout.match(/^run file: (.+)$/m)![1]!;
      expect(runFile.startsWith(join(outputDir, "wiki-interest-runs"))).toBe(true);
      const saved = runJson(stdout);
      expect(saved.request).toMatchObject({
        topics: ["Q333"],
        editions: ["uk"],
        window: { months: 12, start: "2025-09", end: "2026-08" },
      });
      expect(saved.resolution[0]).toMatchObject({ id: "Q333", label: "astronomy", articles: { uk: "Астрономія" } });
      const [basket] = saved.baskets;
      expect(basket.monthly).toHaveLength(12);
      expect(basket.monthly[0]).toEqual({ month: "2025-09", views: 3000, editionViews: 100_000_000, hasData: true });
      expect(basket.metrics).toMatchObject({ medianMonthlyViews: 3000, viewsPerMillion: 30, growth: 0, rawChange: 0 });
    }
  });
});
