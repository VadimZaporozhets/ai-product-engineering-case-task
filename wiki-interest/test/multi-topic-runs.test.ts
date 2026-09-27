import { readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { EXIT_CODES } from "../src/cli.ts";
import { fakeWikimedia } from "./fake-wikimedia.ts";
import { EDITION_VIEWS, fourBaskets, linear, run, runJson, twoTopicsInTwoEditions } from "./run-cli.ts";

const NOT_ENOUGH_EVIDENCE = "not enough evidence (low or insufficient Confidence, Missing articles and errors; not ranked):";

/** Splits a command line into words the way a POSIX shell does for the quoting the CLI prints: '…' and '\''. */
function shellWords(command: string): string[] {
  return [...command.matchAll(/(?:[^\s'\\]+|'[^']*'|\\.)+/g)].map(([word]) =>
    word.replace(/'([^']*)'|\\(.)/g, (_, quoted: string | undefined, escaped: string) => quoted ?? escaped),
  );
}

/** "Topic in Edition" of each result row, in printed order, under each table heading. */
function tables(stdout: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  let heading = "";
  for (const line of stdout.split("\n")) {
    if (/^(ranked|not enough evidence)/.test(line)) result[(heading = line)] = [];
    else if (line === "") heading = "";
    else if (heading && line.startsWith("| ") && !line.startsWith("| Topic |")) {
      const [topic, edition] = line.split(" | ").map((cell) => cell.replace(/^\| /, ""));
      result[heading]!.push(`${topic} in ${edition}`);
    }
  }
  return result;
}

describe("Run size limit", () => {
  test("refuses more than 5 Topics, before any request, and prints the Runs to split it into", async () => {
    const fake = fakeWikimedia();

    const { code, stdout, outputDir } = await run(
      ["analyze", "--topics", "Q1,Q2,Q3,Q4,Q5,Q6", "--editions", "uk,pl", "--months", "12"],
      fake,
    );

    expect(code).toBe(EXIT_CODES.blocked);
    expect(stdout).toMatch(/^blocked: a Run analyses at most 5 Topics and 10 Editions, and this one asks for 6 Topics\./m);
    expect(stdout).toMatch(/^ {2}node .* analyze --topics Q1,Q2,Q3 --editions uk,pl --months 12 --end 2026-08$/m);
    expect(stdout).toMatch(/^ {2}node .* analyze --topics Q4,Q5,Q6 --editions uk,pl --months 12 --end 2026-08$/m);
    expect(fake.requests).toEqual([]);
    expect(readdirSync(outputDir)).toEqual([]);
  });

  test("refuses more than 10 Editions, and splits both Topics and Editions when both are over", async () => {
    const editions = ["en", "de", "fr", "es", "it", "pl", "uk", "cs", "sk", "nl", "sv"];

    const { code, stdout } = await run(
      ["analyze", "--topics", "astronomy,physics,chemistry,biology,geology,botany", "--editions", editions.join(",")],
      fakeWikimedia(),
    );

    expect(code).toBe(EXIT_CODES.blocked);
    expect(stdout).toMatch(/asks for 6 Topics and 11 Editions\./);
    const commands = stdout.split("\n").filter((line) => line.startsWith("  node "));
    expect(commands).toHaveLength(4);
    expect(commands[0]).toMatch(/ analyze --topics 'astronomy,physics,chemistry' --editions en,de,fr,es,it,pl --months 24 --end 2026-08$/);
    expect(commands[3]).toMatch(/ analyze --topics 'biology,geology,botany' --editions uk,cs,sk,nl,sv --months 24 --end 2026-08$/);
  });
});

/** English language (Q1860), found by name, with an Article in uk only. */
function englishLanguage() {
  return fakeWikimedia()
    .item("Q1860", { label: "English language", description: "West Germanic language", articles: { uk: "Англійська мова" } })
    .search("English language", ["Q1860"])
    .editionTotals("uk", () => EDITION_VIEWS)
    .editionTotals("pl", () => EDITION_VIEWS)
    .article("uk", "Англійська мова", () => 3_000);
}

describe("extra Articles", () => {
  test("are added to the Basket of their Topic and Edition, their views summed, and marked as chosen by the agent", async () => {
    const fake = englishLanguage().article("uk", "Англійська як іноземна", () => 1_000);

    const { code, stdout } = await run(
      ["analyze", "--topics", "English language", "--editions", "uk", "--add-article", "English language:uk:Англійська як іноземна"],
      fake,
    );

    expect(code).toBe(EXIT_CODES.success);
    expect(stdout).toMatch(
      /^rerun: .* analyze --topics Q1860 --editions uk --months 24 --end 2026-08 --add-article 'Q1860:uk:Англійська як іноземна'$/m,
    );
    expect(stdout).toContain("    uk: Англійська мова + Англійська як іноземна (chosen by the agent)\n");
    // 3,000 + 1,000 views a month of 100 million.
    expect(stdout).toContain("| English language (Q1860) | uk | flat | high | +0.0% | +0.0% | 4000 | 40.00 |");
    expect(runJson(stdout).baskets[0]).toMatchObject({
      articles: ["Англійська мова", "Англійська як іноземна"],
      chosenByAgent: ["Англійська як іноземна"],
    });
  });

  test("can fill a Missing article: the Basket is analysed, marked as chosen by the agent, and not searched for", async () => {
    const fake = englishLanguage().article("pl", "Język angielski", () => 2_000);

    const { code, stdout } = await run(
      ["analyze", "--topics", "Q1860", "--editions", "uk,pl", "--add-article", "Q1860:pl:Język angielski"],
      fake,
    );

    expect(code).toBe(EXIT_CODES.success);
    expect(stdout).toContain("    pl: no Article is linked to Q1860; the Basket is Język angielski (chosen by the agent)\n");
    expect(stdout).toContain("| English language (Q1860) | pl | flat | high | +0.0% | +0.0% | 2000 | 20.00 |");
    expect(stdout).not.toMatch(/pl: Missing article|has no Article in pl Wikipedia/);
    expect(fake.requests.some((url) => url.searchParams.get("list") === "search")).toBe(false);
  });

  test("uses the title as the Edition writes it", async () => {
    const fake = englishLanguage().article("uk", "Англійська як іноземна", () => 1_000);

    const { stdout } = await run(
      ["analyze", "--topics", "Q1860", "--editions", "uk", "--add-article", "Q1860:uk:англійська_як іноземна"],
      fake,
    );

    expect(stdout).toContain("    uk: Англійська мова + Англійська як іноземна (chosen by the agent)\n");
    expect(stdout).toMatch(/^\| English language \(Q1860\) \| uk \| flat \| high \| .* \| 4000 \| 40\.00 \|$/m);
  });

  test.each([
    {
      problem: "doesn't exist",
      fake: () => englishLanguage(),
      reason: '"Англійська як іноземна", added with --add-article, is not an Article of uk Wikipedia',
    },
    {
      problem: "only redirects to another Article",
      fake: () =>
        englishLanguage()
          .article("uk", "Англійська як друга мова", () => 1_000)
          .redirect("uk", "Англійська як іноземна", "Англійська як друга мова"),
      reason:
        '"Англійська як іноземна", added with --add-article, only redirects to "Англійська як друга мова" in uk ' +
        'Wikipedia; add "Англійська як друга мова" instead',
    },
  ])("makes the Basket an error row when the extra Article $problem, and the Run goes on", async ({ fake, reason }) => {
    const wikimedia = fake().article("pl", "Język angielski", () => 2_000);

    const { code, stdout } = await run(
      [
        "analyze",
        "--topics",
        "Q1860",
        "--editions",
        "uk,pl",
        "--add-article",
        "Q1860:uk:Англійська як іноземна",
        "--add-article",
        "Q1860:pl:Język angielski",
      ],
      wikimedia,
    );

    expect(code).toBe(EXIT_CODES.partialFailure);
    expect(stdout).toContain(`| English language (Q1860) | uk | error: ${reason} | | | | | |`);
    expect(stdout).toContain("| English language (Q1860) | pl | flat | high |");
    expect(wikimedia.pageviewRequests().some((url) => url.pathname.includes("/per-article/uk."))).toBe(false);
  });

  test.each([
    { value: "English:uk:Англійська як іноземна", problem: "with the Topic written as in --topics (Q1860)" },
    { value: "Q1860:uk:", problem: "must be <Topic>:<edition code>:<Article title>" },
    { value: "Q1860:de:Englische Sprache", problem: '"de" isn\'t one of --editions (uk,pl)' },
  ])("refuses --add-article $value", async ({ value, problem }) => {
    const fake = englishLanguage();

    const { code, stdout } = await run(
      ["analyze", "--topics", "Q1860", "--editions", "uk,pl", "--add-article", value],
      fake,
    );

    expect(code).toBe(EXIT_CODES.blocked);
    expect(stdout).toMatch(/^blocked: --add-article /);
    expect(stdout).toContain(problem);
    expect(fake.requests).toEqual([]);
  });

  test("Full history fails when any Article in the Basket starts late, and the Reason names it", async () => {
    const fake = englishLanguage().article("uk", "Англійська як іноземна", (month) =>
      month < "2025-03" ? undefined : 1_000,
    );

    const { stdout } = await run(
      ["analyze", "--topics", "Q1860", "--editions", "uk", "--add-article", "Q1860:uk:Англійська як іноземна"],
      fake,
    );

    expect(stdout).toMatch(/^ {2}- Full history: Англійська як іноземна has data only from 2025-03, /m);
    expect(stdout).not.toMatch(/Full history: .*Англійська мова has data/);
  });

  test("Enough data judges the Basket's summed views", async () => {
    // Each Article alone has a median of 60 views a month, under 100; together they have 120.
    const fake = englishLanguage()
      .article("uk", "Англійська мова", () => 60)
      .article("uk", "Англійська як іноземна", () => 60);

    const { stdout } = await run(
      ["analyze", "--topics", "Q1860", "--editions", "uk", "--add-article", "Q1860:uk:Англійська як іноземна"],
      fake,
    );

    expect(stdout).toContain("| English language (Q1860) | uk | flat | medium | +0.0% | +0.0% | 120 | 1.20 |");
    expect(stdout).toMatch(/^ {2}- Volume: median monthly views are 120, under 1,000/m);
  });
});

describe("a Run of several Topics and Editions", () => {
  test("shows a Basket whose requests failed as an error row after the others, completes, and says what to do", async () => {
    const fake = twoTopicsInTwoEditions()
      .article("uk", "Астрономія", () => 5_000)
      .article("pl", "Astronomia", () => 5_000, { status: 503 })
      .article("uk", "Фізика", () => 50)
      .article("pl", "Fizyka", () => 5_000);

    const { code, stdout } = await run(["analyze", "--topics", "Q333,Q413", "--editions", "uk,pl"], fake);

    expect(code).toBe(EXIT_CODES.partialFailure);
    expect(tables(stdout)).toEqual({
      "ranked by growth (Growth, highest first):": ["astronomy (Q333) in uk", "physics (Q413) in pl"],
      [NOT_ENOUGH_EVIDENCE]: [
        "physics (Q413) in uk",
        "astronomy (Q333) in pl",
      ],
    });
    expect(stdout).toContain(
      "| astronomy (Q333) | pl | error: pageviews of Astronomia: wikimedia.org answered HTTP 503 after 3 attempts | | | | | |",
    );
    expect(stdout).toMatch(
      /^ {2}- astronomy \(Q333\) in pl failed: pageviews of Astronomia: .*\. Answer from the other rows and tell the user what failed\./m,
    );
  });

  test.each([
    { run: "whose only Basket failed", pl: { status: 503 } },
    { run: "whose other Baskets passed every Check", pl: {} },
  ])("a Run $run doesn't say every Check passed when a Basket is an error row", async ({ pl }) => {
    const fake = twoTopicsInTwoEditions()
      .article("uk", "Астрономія", () => 5_000, { status: 503 })
      .article("pl", "Astronomia", () => 5_000, pl);

    const { code, stdout } = await run(["analyze", "--topics", "Q333", "--editions", "uk,pl"], fake);

    expect(code).toBe(EXIT_CODES.partialFailure);
    expect(stdout).not.toContain("every Check passed");
    expect(stdout).toContain("reasons: none; error rows have no Checks, and next steps say what failed\n");
  });

  test("prints the rerun line, resolution, tables, Reasons, Caveats, next steps, the Run file and the chart, in that order", async () => {
    const fake = twoTopicsInTwoEditions()
      .article("uk", "Астрономія", () => 5_000)
      .article("pl", "Astronomia", () => 600)
      .article("uk", "Фізика", () => 50)
      .article("pl", "Fizyka", () => 5_000);

    const { stdout } = await run(["analyze", "--topics", "Q333,Q413", "--editions", "uk,pl"], fake);

    const sections = [
      /^rerun: /m,
      /^resolution:$/m,
      /^ranked by growth /m,
      /^not enough evidence /m,
      /^reasons:$/m,
      /^caveats:$/m,
      /^next steps:$/m,
      /^run file: /m,
      /^chart: /m,
    ].map((section) => stdout.search(section));
    expect(sections.every((index) => index >= 0)).toBe(true);
    expect(sections).toEqual([...sections].sort((a, b) => a - b));
    expect(stdout).toMatch(/^caveats:\n {2}- Interest is not willingness to pay: .*\n {2}- An Edition is a language, not a country: /m);
    expect(stdout).toMatch(/^ {2}- For a follow-up .*edit the rerun: line and run it again/m);
  });
});

describe("Ambiguous topics in a Run of several Topics", () => {
  test("the suggested command keeps a placeholder for each Ambiguous topic", async () => {
    const inEditions = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`e${i}`, `T${i}`]));
    const fake = fakeWikimedia()
      .item("Q308", { label: "Mercury", description: "planet", articles: inEditions(10) })
      .item("Q925", { label: "mercury", description: "chemical element", articles: inEditions(8) })
      .item("Q35694", { label: "Jaguar", description: "animal", articles: inEditions(10) })
      .item("Q30055", { label: "Jaguar", description: "car brand", articles: inEditions(9) })
      .search("Mercury", ["Q308", "Q925"])
      .search("Jaguar", ["Q35694", "Q30055"])
      .editionTotals("uk", () => EDITION_VIEWS);

    const { code, stdout } = await run(
      ["analyze", "--topics", "Mercury,Jaguar", "--editions", "uk", "--add-article", "Jaguar:uk:Ягуар"],
      fake,
    );

    expect(code).toBe(EXIT_CODES.blocked);
    expect(stdout).toMatch(
      /^ {4}node .* analyze --topics '<item id>,<item id>' --editions uk --months 24 --end 2026-08 --add-article '<item id>:uk:Ягуар'$/m,
    );
  });
});

describe("the rerun line", () => {
  test("reproduces the same Window and results months later, without searching Wikidata", async () => {
    const fake = () =>
      englishLanguage()
        .item("Q333", { label: "astronomy", description: "natural science", articles: { uk: "Астрономія", pl: "Astronomia" } })
        .search("astronomy", ["Q333"])
        .article("uk", "Англійська як іноземна", () => 1_000)
        .article("pl", "Język angielski", linear(2_000, 3_000))
        .article("uk", "Астрономія", linear(4_000, 3_000))
        .article("pl", "Astronomia", () => 600)
        // An apostrophe, which the rerun line has to quote.
        .article("uk", "Об'єкти глибокого космосу", () => 200);
    const first = await run(
      [
        "analyze",
        "--topics",
        "English language,astronomy",
        "--editions",
        "uk,pl",
        "--rank",
        "interest",
        "--add-article",
        "English language:uk:Англійська як іноземна",
        "--add-article",
        "English language:pl:Język angielski",
        "--add-article",
        "astronomy:uk:Об'єкти глибокого космосу",
      ],
      fake(),
    );
    const rerun = first.stdout.match(/^rerun: (.+)$/m)![1]!;
    expect(rerun).toMatch(
      / analyze --topics Q1860,Q333 --editions uk,pl --months 24 --end 2026-08 --rank interest --add-article 'Q1860:uk:Англійська як іноземна' --add-article 'Q1860:pl:Język angielski' --add-article 'Q333:uk:Об'\\''єкти глибокого космосу'$/,
    );

    const later = fake();
    // The rerun line starts with `node <entry script>`; the CLI gets the rest.
    const second = await run(shellWords(rerun).slice(2), later, { now: new Date("2027-03-10T09:00:00Z") });

    expect(second.code).toBe(first.code);
    expect(later.requests.some((url) => url.searchParams.get("action") === "wbsearchentities")).toBe(false);
    // The report step names each Run's own folder.
    const results = (stdout: string) =>
      stdout.split("\n").filter((line) => /^(window: |ranked |\| |reasons:| {2}- )/.test(line) && !line.includes(" report --run "));
    expect(results(second.stdout)).toEqual(results(first.stdout).filter((line) => !line.includes("was chosen for")));
    expect(second.stdout).toContain(`rerun: ${rerun}\n`);
  });
});

describe("ranking", () => {
  test("ranks Baskets with high or medium Confidence by Growth, and lists the rest as not enough evidence", async () => {
    const fake = fourBaskets();

    const { code, stdout } = await run(["analyze", "--topics", "Q333,Q413", "--editions", "uk,pl"], fake);

    expect(code).toBe(EXIT_CODES.success);
    expect(stdout).toMatch(/^rerun: .* analyze --topics Q333,Q413 --editions uk,pl --months 24 --end 2026-08$/m);
    expect(tables(stdout)).toEqual({
      "ranked by growth (Growth, highest first):": [
        "astronomy (Q333) in uk",
        "physics (Q413) in uk",
        "astronomy (Q333) in pl",
      ],
      [NOT_ENOUGH_EVIDENCE]: [
        "physics (Q413) in pl",
      ],
    });
    expect(runJson(stdout).ranking).toEqual({
      by: "growth",
      ranked: [
        { topic: "Q333", edition: "uk" },
        { topic: "Q413", edition: "uk" },
        { topic: "Q333", edition: "pl" },
      ],
      notEnoughEvidence: [{ topic: "Q413", edition: "pl" }],
      // The leaders and directions lines have their own tests.
      leaders: expect.any(Array),
      directions: expect.any(Object),
    });
  });

  // Median monthly views: astronomy in uk 4,000, in pl 5,000, physics in uk 3,500. Second half of the Window:
  // astronomy in uk rises to about 5,040 views a month (50.4 per million), in pl stays at 50 per million,
  // physics in uk about 3,760 (37.6 per million).
  test.each([
    { by: "interest", heading: "median monthly views", order: ["astronomy (Q333) in pl", "astronomy (Q333) in uk", "physics (Q413) in uk"] },
    {
      by: "share",
      heading: "Share of edition over the second half of the Window",
      order: ["astronomy (Q333) in uk", "astronomy (Q333) in pl", "physics (Q413) in uk"],
    },
  ])("ranks by $by when asked, and keeps the criterion in the rerun line", async ({ by, heading, order }) => {
    const fake = fourBaskets();

    const { code, stdout } = await run(["analyze", "--topics", "Q333,Q413", "--editions", "uk,pl", "--rank", by], fake);

    expect(code).toBe(EXIT_CODES.success);
    expect(stdout).toMatch(new RegExp(`^rerun: .* --months 24 --end 2026-08 --rank ${by}$`, "m"));
    expect(tables(stdout)[`ranked by ${by} (${heading}, highest first):`]).toEqual(order);
  });

  test("ranked by share, the views per million column shows the second half's figure it ranks by", async () => {
    const fake = fourBaskets();

    const { stdout } = await run(["analyze", "--topics", "Q333,Q413", "--editions", "uk,pl", "--rank", "share"], fake);

    const lines = stdout.split("\n");
    const headings = lines.filter((line) => line.startsWith("| Topic |"));
    expect(headings).toHaveLength(2);
    for (const heading of headings) expect(heading).toMatch(/\| Views per million \(2nd half\) \|$/);
    const start = lines.findIndex((line) => line.startsWith("ranked by share"));
    const rows = lines.slice(start + 3, lines.indexOf("", start));
    const perMillion = rows.map((row) => Number(row.split(" | ").at(-1)!.replace(" |", "")));
    expect(perMillion).toEqual([...perMillion].sort((a, b) => b - a));
    expect(perMillion[0]).toBeCloseTo(50.4, 0);
  });

  test("keeps low Confidence and Missing articles out of the ranking, low Confidence first", async () => {
    const fake = twoTopicsInTwoEditions()
      .item("Q413", { label: "physics", description: "natural science", articles: { uk: "Фізика" } })
      .article("uk", "Астрономія", () => 5_000)
      // A news Spike: growing, with low Confidence (Spikes and Consistency fail).
      .article("pl", "Astronomia", () => 3_000, { extra: { "2026-04-15": 60_000 } })
      .article("uk", "Фізика", () => 4_000);

    const { code, stdout } = await run(["analyze", "--topics", "Q413,Q333", "--editions", "pl,uk"], fake);

    expect(code).toBe(EXIT_CODES.success);
    expect(stdout).toContain("| astronomy (Q333) | pl | growing | low |");
    expect(tables(stdout)).toEqual({
      "ranked by growth (Growth, highest first):": ["physics (Q413) in uk", "astronomy (Q333) in uk"],
      [NOT_ENOUGH_EVIDENCE]: ["astronomy (Q333) in pl", "physics (Q413) in pl"],
    });
  });

  test("refuses an unknown ranking criterion, naming the ones there are", async () => {
    const fake = twoTopicsInTwoEditions();

    const { code, stdout } = await run(["analyze", "--topics", "Q333", "--editions", "uk", "--rank", "audience"], fake);

    expect(code).toBe(EXIT_CODES.blocked);
    expect(stdout).toContain('blocked: --rank must be growth, interest or share, not "audience".');
    expect(fake.requests).toEqual([]);
  });

  test("says so when no Basket can be ranked", async () => {
    const fake = twoTopicsInTwoEditions().article("uk", "Астрономія", () => 50);

    const { stdout } = await run(["analyze", "--topics", "Q333", "--editions", "uk"], fake);

    expect(stdout).toContain("ranked by growth (Growth, highest first): none\n");
    expect(tables(stdout)).toMatchObject({
      [NOT_ENOUGH_EVIDENCE]: [
        "astronomy (Q333) in uk",
      ],
    });
  });
});

/** The cells of a result row, found by its Topic and Edition cells. */
function rowCells(stdout: string, topic: string, edition: string): string[] {
  const line = stdout.split("\n").find((candidate) => candidate.startsWith(`| ${topic} | ${edition} | `))!;
  return line.slice(2, -2).split(" | ");
}

function directionsLine(stdout: string): string {
  return stdout.split("\n").find((line) => line.startsWith("directions (ranked rows): "))!;
}

function leadersLine(stdout: string): string {
  return stdout.split("\n").find((line) => line.startsWith("leaders (ranked rows): "))!;
}

describe("the leaders line", () => {
  test("follows the ranked table and names the leader of each column with the value the table prints and its Direction", async () => {
    const fake = fourBaskets();

    const { stdout } = await run(["analyze", "--topics", "Q333,Q413", "--editions", "uk,pl"], fake);

    const astronomyUk = rowCells(stdout, "astronomy (Q333)", "uk");
    const astronomyPl = rowCells(stdout, "astronomy (Q333)", "pl");
    // Cells: Topic, Edition, Direction, Confidence, Growth, Raw change, median monthly views, views per million.
    expect(leadersLine(stdout)).toBe(
      "leaders (ranked rows): " +
        `most median monthly views: astronomy (Q333) pl ${astronomyPl[6]} (${astronomyPl[2]}); ` +
        `highest views per million: astronomy (Q333) pl ${astronomyPl[7]} (${astronomyPl[2]}); ` +
        `highest Growth: astronomy (Q333) uk ${astronomyUk[4]} (${astronomyUk[2]}); ` +
        `lowest Growth: astronomy (Q333) pl ${astronomyPl[4]} (${astronomyPl[2]})`,
    );
    const lines = stdout.split("\n");
    const tableEnd = lines.indexOf("", lines.findIndex((line) => line.startsWith("ranked by growth")));
    expect(lines[tableEnd - 1]).toBe(directionsLine(stdout));
    expect(lines[tableEnd - 2]).toBe(leadersLine(stdout));
    expect(lines[tableEnd - 3]).toMatch(/^\| astronomy \(Q333\) \| pl \|/);
  });

  test("never names a row with not enough evidence, even when its figures are the highest", async () => {
    const fake = twoTopicsInTwoEditions()
      .item("Q413", { label: "physics", description: "natural science", articles: { uk: "Фізика" } })
      .article("uk", "Астрономія", () => 5_000)
      // A news Spike: growing, with low Confidence, and the highest views per million and Growth of the Run.
      .article("pl", "Astronomia", () => 3_000, { extra: { "2026-04-15": 60_000 } })
      .article("uk", "Фізика", () => 4_000);

    const { stdout } = await run(["analyze", "--topics", "Q413,Q333", "--editions", "pl,uk"], fake);

    expect(stdout).toContain("| astronomy (Q333) | pl | growing | low |");
    // Both ranked rows are flat at +0.0%, so both lead on Growth, and the Direction says the highest isn't growing.
    expect(leadersLine(stdout)).toBe(
      "leaders (ranked rows): most median monthly views: astronomy (Q333) uk 5000 (flat); " +
        "highest views per million: astronomy (Q333) uk 50.00 (flat); " +
        "highest Growth: physics (Q413) uk +0.0% (flat), astronomy (Q333) uk +0.0% (flat); " +
        "lowest Growth: physics (Q413) uk +0.0% (flat), astronomy (Q333) uk +0.0% (flat)",
    );
    // The growing row has low Confidence, so no ranked row is growing.
    expect(directionsLine(stdout)).toBe(
      "directions (ranked rows): growing: none; flat: physics (Q413) uk, astronomy (Q333) uk; declining: none",
    );
  });

  test("ranked by share, names the leader of the second half's views per million, as the column does", async () => {
    const fake = fourBaskets();

    const { stdout } = await run(["analyze", "--topics", "Q333,Q413", "--editions", "uk,pl", "--rank", "share"], fake);

    const astronomyUk = rowCells(stdout, "astronomy (Q333)", "uk");
    expect(leadersLine(stdout)).toContain(
      `; highest views per million (2nd half): astronomy (Q333) uk ${astronomyUk[7]} (${astronomyUk[2]});`,
    );
  });

  test.each([
    { rows: "one ranked row", pl: () => 5_000 },
    { rows: "no ranked rows", pl: () => 50 },
  ])("with $rows, says there is nothing to compare", async ({ pl }) => {
    const fake = twoTopicsInTwoEditions().article("uk", "Астрономія", () => 50).article("pl", "Astronomia", pl);

    const { stdout } = await run(["analyze", "--topics", "Q333", "--editions", "uk,pl"], fake);

    expect(leadersLine(stdout)).toBe("leaders (ranked rows): none, fewer than 2 ranked rows to compare");
    expect(stdout).not.toContain("directions (ranked rows)");
    expect(runJson(stdout).ranking.leaders).toEqual([]);
  });

  test("groups every ranked row by its Direction, in table order, so a claim like \"the only stable one\" can be read", async () => {
    const fake = fourBaskets();

    const { stdout } = await run(["analyze", "--topics", "Q333,Q413", "--editions", "uk,pl"], fake);

    const ranked = [
      ["astronomy (Q333)", "uk"],
      ["physics (Q413)", "uk"],
      ["astronomy (Q333)", "pl"],
    ] as const;
    const group = (direction: string) => {
      const rows = ranked
        .filter(([topic, edition]) => rowCells(stdout, topic, edition)[2] === direction)
        .map(([topic, edition]) => `${topic} ${edition}`);
      return `${direction}: ${rows.length ? rows.join(", ") : "none"}`;
    };
    expect(directionsLine(stdout)).toBe(
      `directions (ranked rows): ${group("growing")}; ${group("flat")}; ${group("declining")}`,
    );
    // physics in pl isn't ranked, so it's in no group.
    expect(directionsLine(stdout)).not.toContain("physics (Q413) pl");
  });

  test("the Run file records the same leaders", async () => {
    const fake = fourBaskets();

    const { stdout } = await run(["analyze", "--topics", "Q333,Q413", "--editions", "uk,pl"], fake);

    const astronomyUk = rowCells(stdout, "astronomy (Q333)", "uk");
    const astronomyPl = rowCells(stdout, "astronomy (Q333)", "pl");
    const pl = { topic: "Q333", edition: "pl", direction: astronomyPl[2] };
    const uk = { topic: "Q333", edition: "uk", direction: astronomyUk[2] };
    expect(runJson(stdout).ranking.leaders).toEqual([
      { label: "most median monthly views", value: astronomyPl[6], baskets: [pl] },
      { label: "highest views per million", value: astronomyPl[7], baskets: [pl] },
      { label: "highest Growth", value: astronomyUk[4], baskets: [uk] },
      { label: "lowest Growth", value: astronomyPl[4], baskets: [pl] },
    ]);
    const { directions } = runJson(stdout).ranking;
    const recorded = [...directions.growing, ...directions.flat, ...directions.declining];
    expect(recorded).toHaveLength(3);
    expect(directions[astronomyPl[2]!]).toContainEqual({ topic: "Q333", edition: "pl" });
    expect(directions[astronomyUk[2]!]).toContainEqual({ topic: "Q333", edition: "uk" });
  });
});
