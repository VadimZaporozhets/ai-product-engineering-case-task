import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { EXIT_CODES } from "../src/cli.ts";
import { fakeWikimedia } from "./fake-wikimedia.ts";
import { EDITION_VIEWS, fourBaskets, linear, run, runFilePath, twoTopicsInTwoEditions } from "./run-cli.ts";

/**
 * Topics Q1 to Q5, labelled "topic 1" to "topic 5", each with an Article in uk and pl. Every Basket grows steadily
 * from 2,000 views a month; the higher the Topic's number, the faster, and pl faster than uk.
 */
function tenBaskets() {
  let fake = fakeWikimedia().editionTotals("uk", () => EDITION_VIEWS).editionTotals("pl", () => EDITION_VIEWS);
  for (let n = 1; n <= 5; n++) {
    fake = fake
      .item(`Q${n}`, { label: `topic ${n}`, description: "a Topic", articles: { uk: `Uk ${n}`, pl: `Pl ${n}` } })
      .article("uk", `Uk ${n}`, linear(2_000, 2_000 + 2_000 * n))
      .article("pl", `Pl ${n}`, linear(2_000, 3_000 + 2_000 * n));
  }
  return fake;
}

/** The chart whose path the Run printed on its `chart:` line. */
function chart(stdout: string): { path: string; svg: string } {
  const path = stdout.match(/^chart: (.+)$/m)![1]!;
  return { path, svg: readFileSync(path, "utf8") };
}

/** The accessible labels vega writes into the SVG, one per axis, legend and labelled mark. */
function ariaLabels(svg: string): string[] {
  return [...svg.matchAll(/aria-label="([^"]*)"/g)].map(([, label]) => label!.replaceAll("&#39;", "'"));
}

/** The lines of the chart, in legend order, as the legend names them; the Spike marks' legend entry is left out. */
function legend(svg: string): string[] {
  return [...svg.matchAll(/role-legend-label"[^>]*><text[^>]*>([^<]*)<\/text>/g)]
    .map(([, label]) => label!.replaceAll("&#39;", "'"))
    .filter((label) => !label.startsWith("month of a top-5 day"));
}

/** The lines drawn dashed, by the name vega gives each line in its accessible label. */
function dashed(svg: string): string[] {
  return [...svg.matchAll(/<path aria-label="[^"]*; basket: ([^";]*)[^"]*"[^>]*aria-roledescription="line mark"[^>]*>/g)]
    .filter(([path]) => !/stroke-dasharray="1,0"/.test(path!))
    .map(([, label]) => label!);
}

describe("chart", () => {
  test("every Run writes an SVG chart to its folder, one line per Basket labelled by Topic and Edition, in table order", async () => {
    const { code, stdout } = await run(["analyze", "--topics", "Q333,Q413", "--editions", "uk,pl"], fourBaskets());

    expect(code).toBe(EXIT_CODES.success);
    const runFile = runFilePath(stdout);
    const { path, svg } = chart(stdout);
    expect(path).toBe(join(dirname(runFile), "chart.svg"));
    expect(svg).toMatch(/^<svg /);
    // The ranked table first, then the Not-enough-evidence group.
    expect(legend(svg)).toEqual(["astronomy · uk", "physics · uk", "astronomy · pl", "physics · pl (insufficient)"]);
    const labels = ariaLabels(svg);
    expect(labels).toContain("X-axis for a utc scale with values from September 2024 to August 2026");
    // Astronomy in uk ends at 6,000 views of 100 million a month: 60 per million.
    expect(labels).toContain("Y-axis titled 'Views per million Edition views' for a linear scale with values from 0 to 60");
  });

  test("tells apart Topics with the same label by their item ids", async () => {
    const fake = fakeWikimedia()
      .item("Q308", { label: "Mercury", description: "planet", articles: { uk: "Меркурій" } })
      .item("Q925", { label: "mercury", description: "chemical element", articles: { uk: "Ртуть" } })
      .editionTotals("uk", () => EDITION_VIEWS)
      .article("uk", "Меркурій", () => 5_000)
      .article("uk", "Ртуть", () => 4_000);

    const { stdout } = await run(["analyze", "--topics", "Q308,Q925", "--editions", "uk", "--name-lang", "en"], fake);

    expect(legend(chart(stdout).svg)).toEqual(["Mercury (Q308) · uk", "mercury (Q925) · uk"]);
  });

  test("ranked by share, the legend follows the table's order", async () => {
    const { stdout } = await run(
      ["analyze", "--topics", "Q333,Q413", "--editions", "uk,pl", "--rank", "share"],
      fourBaskets(),
    );

    expect(legend(chart(stdout).svg)).toEqual([
      "astronomy · uk",
      "astronomy · pl",
      "physics · uk",
      "physics · pl (insufficient)",
    ]);
  });

  test("draws Not-enough-evidence Baskets with views dashed, after the ranked ones, and labels their Confidence", async () => {
    const fake = twoTopicsInTwoEditions()
      .article("uk", "Астрономія", () => 5_000)
      // A news Spike: growing, with low Confidence (Spikes and Consistency fail).
      .article("pl", "Astronomia", () => 3_000, { extra: { "2026-04-15": 60_000 } })
      // Too few views to judge: insufficient Confidence.
      .article("uk", "Фізика", () => 50)
      .article("pl", "Fizyka", () => 4_000);

    const { stdout } = await run(["analyze", "--topics", "Q333,Q413", "--editions", "uk,pl"], fake);

    const { svg } = chart(stdout);
    expect(legend(svg)).toEqual([
      "astronomy · uk",
      "physics · pl",
      "astronomy · pl (low confidence)",
      "physics · uk (insufficient)",
    ]);
    expect(dashed(svg)).toEqual(["astronomy · pl (low confidence)", "physics · uk (insufficient)"]);
  });

  test("marks the months holding the 5 highest-view days, only for Baskets whose Spike Check failed", async () => {
    const fake = twoTopicsInTwoEditions()
      .article("uk", "Астрономія", () => 5_000)
      // 3,000 views a month spread over the days: February's first 4 days get the most, then a 60,000-view day.
      .article("pl", "Astronomia", () => 3_000, { extra: { "2026-04-15": 60_000 } })
      // The same February days, but without a Spike the Check passes.
      .article("uk", "Фізика", () => 3_000);

    const { stdout } = await run(["analyze", "--topics", "Q333,Q413", "--editions", "uk,pl"], fake);

    expect(stdout).toMatch(/^ {2}- Spikes: the 5 highest-view days \(2025-02-01, .*, 2026-04-15\)/m);
    const { svg } = chart(stdout);
    expect(ariaLabels(svg).filter((label) => label.startsWith("Spike"))).toEqual([
      "Spike month of astronomy · pl (low confidence): Feb 2025",
      "Spike month of astronomy · pl (low confidence): Apr 2026",
    ]);
    expect(ariaLabels(svg)).toContain(
      "Symbol legend for shape with 1 value: month of a top-5 day (Spike Check failed)",
    );
  });

  test("draws at most 8 lines, the first rows of the tables, and says how to chart the others", async () => {
    const { code, stdout } = await run(["analyze", "--topics", "Q1,Q2,Q3,Q4,Q5", "--editions", "uk,pl"], tenBaskets());

    expect(code).toBe(EXIT_CODES.success);
    expect(legend(chart(stdout).svg)).toEqual([
      "topic 5 · pl",
      "topic 5 · uk",
      "topic 4 · pl",
      "topic 4 · uk",
      "topic 3 · pl",
      "topic 3 · uk",
      "topic 2 · pl",
      "topic 2 · uk",
    ]);
    expect(stdout).toMatch(
      /^ {2}- The chart shows 8 of the 10 Baskets with views, the first rows of the tables\. To chart another, add --highlight '<Topic>:<edition>' to the rerun: line/m,
    );
  });

  test("draws highlighted Baskets in place of the lowest rows, keeping table order, and keeps them in the rerun line", async () => {
    const fake = tenBaskets().search("topic 1", ["Q1"]);

    const { code, stdout } = await run(
      ["analyze", "--topics", "topic 1,Q2,Q3,Q4,Q5", "--editions", "uk,pl", "--highlight", "topic 1:uk", "--highlight", "topic 1:pl"],
      fake,
    );

    expect(code).toBe(EXIT_CODES.success);
    expect(stdout).toMatch(
      /^rerun: .* analyze --topics Q1,Q2,Q3,Q4,Q5 --editions uk,pl --months 24 --end 2026-08 --highlight 'Q1:uk' --highlight 'Q1:pl'$/m,
    );
    expect(legend(chart(stdout).svg)).toEqual([
      "topic 5 · pl",
      "topic 5 · uk",
      "topic 4 · pl",
      "topic 4 · uk",
      "topic 3 · pl",
      "topic 3 · uk",
      "topic 1 · pl",
      "topic 1 · uk",
    ]);
    expect(stdout).toMatch(/^ {2}- The chart shows 8 of the 10 Baskets with views, the highlighted ones and the first rows of the tables\./m);
  });

  test("says when a highlighted Basket has no views to draw", async () => {
    const fake = twoTopicsInTwoEditions()
      .item("Q413", { label: "physics", description: "natural science", articles: { uk: "Фізика" } })
      .article("uk", "Астрономія", () => 5_000)
      .article("pl", "Astronomia", () => 5_000)
      .article("uk", "Фізика", () => 4_000);

    const { stdout } = await run(["analyze", "--topics", "Q333,Q413", "--editions", "uk,pl", "--highlight", "Q413:pl"], fake);

    expect(legend(chart(stdout).svg)).toEqual(["astronomy · uk", "astronomy · pl", "physics · uk"]);
    expect(stdout).toMatch(/^ {2}- physics \(Q413\) in pl is highlighted, but it has no views to draw on the chart\.$/m);
  });

  test.each([
    { value: "Q333", problem: /^blocked: --highlight "Q333" must be <Topic>:<edition code>, with the Topic written as in --topics \(Q333\)/m },
    { value: "Q1:uk", problem: /^blocked: --highlight "Q1:uk" must be <Topic>:<edition code>/m },
    { value: "Q333:de", problem: /^blocked: --highlight "Q333:de": "de" isn't one of --editions \(uk,pl\)\.$/m },
  ])("refuses --highlight $value, before any request", async ({ value, problem }) => {
    const fake = twoTopicsInTwoEditions();

    const { code, stdout } = await run(["analyze", "--topics", "Q333", "--editions", "uk,pl", "--highlight", value], fake);

    expect(code).toBe(EXIT_CODES.blocked);
    expect(stdout).toMatch(problem);
    expect(fake.requests).toEqual([]);
  });

  test("refuses more than 8 highlighted Baskets, the chart's line limit", async () => {
    const editions = ["en", "de", "fr", "es", "it", "pl", "uk", "cs", "sk"];
    const highlights = editions.flatMap((edition) => ["--highlight", `Q333:${edition}`]);

    const { code, stdout } = await run(
      ["analyze", "--topics", "Q333", "--editions", editions.join(","), ...highlights],
      twoTopicsInTwoEditions(),
    );

    expect(code).toBe(EXIT_CODES.blocked);
    expect(stdout).toContain("blocked: the chart draws at most 8 lines, so highlight at most 8 Baskets, not 9.\n");
  });

  test("leaves out Missing articles and failed Baskets, which have no views", async () => {
    const fake = twoTopicsInTwoEditions()
      .item("Q413", { label: "physics", description: "natural science", articles: { uk: "Фізика" } })
      .article("uk", "Астрономія", () => 5_000)
      .article("pl", "Astronomia", () => 5_000, { status: 503 })
      .article("uk", "Фізика", () => 4_000);

    const { stdout } = await run(["analyze", "--topics", "Q333,Q413", "--editions", "uk,pl"], fake);

    expect(legend(chart(stdout).svg)).toEqual(["astronomy · uk", "physics · uk"]);
    expect(stdout).not.toContain("The chart shows");
  });

  test("writes no chart when no Basket has views, and says so", async () => {
    const fake = twoTopicsInTwoEditions().article("uk", "Астрономія", () => 5_000, { status: 503 });

    const { stdout } = await run(["analyze", "--topics", "Q333", "--editions", "uk"], fake);

    const runFile = runFilePath(stdout);
    expect(stdout).toContain("chart: none, no Basket has views to draw\n");
    expect(readdirSync(dirname(runFile))).toEqual(["run.json"]);
  });

  test("has no Spike marks or their legend when every Spike Check passed", async () => {
    const { stdout } = await run(["analyze", "--topics", "Q333,Q413", "--editions", "uk,pl"], fourBaskets());

    const { svg } = chart(stdout);
    expect(ariaLabels(svg).filter((label) => /Spike|shape/.test(label))).toEqual([]);
  });
});
