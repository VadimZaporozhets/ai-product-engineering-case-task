import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractText, getDocumentProxy } from "unpdf";
import { describe, expect, test } from "vitest";
import { EXIT_CODES } from "../src/cli.ts";
import { fakeWikimedia } from "./fake-wikimedia.ts";
import { EDITION_VIEWS, fourBaskets, linear, run, runFilePath, twoTopicsInTwoEditions } from "./run-cli.ts";

/** The Narrative limits the agent is told about. */
const LIMITS = { headline: 90, finding: 200, recommendation: 200, nextStep: 160 };

type Narrative = Record<string, unknown>;

const ENGLISH: Narrative = {
  language: "en",
  headline: "Astronomy is growing in Ukrainian Wikipedia",
  findings: ["Astronomy in uk grew +155.6% with high Confidence.", "Physics in pl has too few views to judge."],
  recommendation: "Build the astronomy course for Ukrainian readers first.",
  nextStep: "Re-run with a 48-month Window to compare whole years.",
};

const UKRAINIAN: Narrative = {
  language: "uk",
  headline: "Інтерес до астрономії в українській Вікіпедії зростає",
  findings: ["Астрономія в uk зросла на +155.6% з високою впевненістю.", "Фізика в pl має замало переглядів."],
  recommendation: "Спершу зробіть курс астрономії для українських читачів.",
  nextStep: "Повторіть аналіз за 48 місяців, щоб порівняти цілі роки.",
};

/** Writes the Narrative as the agent would, into a file of its own. */
function narrativeFile(narrative: Narrative | string): string {
  const path = join(mkdtempSync(join(tmpdir(), "wiki-interest-narrative-")), "narrative.json");
  writeFileSync(path, typeof narrative === "string" ? narrative : JSON.stringify(narrative, null, 2));
  return path;
}

/** Runs analyze, then report on that Run, the way the agent would. */
async function analyzeThenReport(analyzeArgs: string[], fake: ReturnType<typeof fakeWikimedia>, narrative: Narrative | string) {
  const analysis = await run(["analyze", ...analyzeArgs], fake);
  expect(analysis.code).toBe(EXIT_CODES.success);
  const folder = dirname(runFilePath(analysis.stdout));
  const report = await run(["report", "--run", folder, "--narrative", narrativeFile(narrative)], fake);
  return { ...report, folder, analysis: analysis.stdout };
}

/** The PDF whose path the report printed on its `report:` line: its pages' text, raw bytes and page size. */
async function readPdf(stdout: string) {
  const path = stdout.match(/^report: (.+)$/m)![1]!;
  const bytes = readFileSync(path);
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const [, , width, height] = (await pdf.getPage(1)).view;
  const raw = bytes.toString("latin1");
  return {
    path,
    totalPages,
    // Whitespace as laid out varies with line breaks; one space between words is enough to match on.
    text: text.map((page) => page.replace(/\s+/g, " ")).join("\n"),
    size: { width: Math.round(width!), height: Math.round(height!) },
    fonts: [...raw.matchAll(/\/BaseFont \/([^\s/]+)/g)].map(([, name]) => name!.replace(/^[A-Z]{6}\+/, "")),
    images: raw.match(/\/Subtype \/Image/g)?.length ?? 0,
  };
}

/**
 * Topics Q1 to Q5 in the given Editions, every Basket growing steadily at its own pace, so all of them are ranked.
 * Labels and titles can be made long to test the layout.
 */
function manyBaskets(editions: string[], name: (n: number) => string = (n) => `topic ${n}`, title = (n: number, edition: string) => `${edition} ${n}`) {
  let fake = fakeWikimedia();
  for (const edition of editions) fake = fake.editionTotals(edition, () => EDITION_VIEWS);
  for (let n = 1; n <= 5; n++) {
    const articles = Object.fromEntries(editions.map((edition) => [edition, title(n, edition)]));
    fake = fake.item(`Q${n}`, { label: name(n), description: "a Topic", articles });
    for (const [i, edition] of editions.entries()) {
      fake = fake.article(edition, title(n, edition), linear(2_000, 3_000 + 1_000 * n + 100 * i));
    }
  }
  return fake;
}

describe("report", () => {
  test("writes a one-page A4 PDF into the Run folder with the Narrative, the Verdict table, method, Caveats and data source", async () => {
    const { code, stdout, folder, analysis } = await analyzeThenReport(["--topics", "Q333,Q413", "--editions", "uk,pl"], fourBaskets(), ENGLISH);

    expect(code).toBe(EXIT_CODES.success);
    const pdf = await readPdf(stdout);
    expect(pdf.path).toBe(join(folder, "report.pdf"));
    expect(pdf.totalPages).toBe(1);
    expect(pdf.size).toEqual({ width: 595, height: 842 });
    expect(pdf.text).toContain("Astronomy is growing in Ukrainian Wikipedia");
    expect(pdf.text).toContain("Astronomy in uk grew +155.6% with high Confidence.");
    expect(pdf.text).toContain("Physics in pl has too few views to judge.");
    expect(pdf.text).toContain("Build the astronomy course for Ukrainian readers first.");
    expect(pdf.text).toContain("Re-run with a 48-month Window to compare whole years.");
    // The table's rows have the same figures as the table analyze printed.
    for (const [topic, edition] of [["astronomy", "uk"], ["physics", "uk"], ["astronomy", "pl"], ["physics", "pl"]]) {
      const cells = new RegExp(`^\\| ${topic} \\(Q\\d+\\) \\| ${edition} \\| (.*) \\|$`, "m").exec(analysis)![1]!.split(" | ");
      expect(pdf.text).toContain(`${topic} ${edition} ${cells.join(" ")}`);
    }
    expect(pdf.text).toContain("Interest is not willingness to pay");
    expect(pdf.text).toContain("An Edition is a language, not a country");
    expect(pdf.text).toMatch(/Wikimedia Pageviews API/);
    expect(pdf.text).toContain("2024-09 to 2026-08");
    expect(pdf.text).toContain("2026-09-26");
    expect(stdout).toMatch(/^report: .*report\.pdf$/m);
  });

  test("embeds the chart as vector graphics, its text in the bundled font", async () => {
    const { stdout } = await analyzeThenReport(["--topics", "Q333,Q413", "--editions", "uk,pl"], fourBaskets(), ENGLISH);

    const pdf = await readPdf(stdout);
    expect(pdf.images).toBe(0);
    // Axis and legend text are drawn as text, not pixels.
    expect(pdf.text).toContain("Views per million Edition views");
    expect(pdf.text).toContain("physics · pl (insufficient)");
    // Every font is the bundled Noto Sans: the chart's text would otherwise fall back to Helvetica, without Cyrillic.
    expect(new Set(pdf.fonts)).toEqual(new Set(["NotoSans-Regular", "NotoSans-Bold"]));
  });

  test("renders a Ukrainian Report: Narrative, labels and the chart's legend and axis in Cyrillic", async () => {
    const fake = twoTopicsInTwoEditions()
      .item("Q333", { label: "астрономія", description: "природнича наука", articles: { uk: "Астрономія", pl: "Astronomia" } })
      .article("uk", "Астрономія", linear(2_000, 6_000))
      .article("pl", "Astronomia", () => 5_000);

    const { code, stdout } = await analyzeThenReport(["--topics", "Q333", "--editions", "uk,pl"], fake, UKRAINIAN);

    expect(code).toBe(EXIT_CODES.success);
    const pdf = await readPdf(stdout);
    expect(pdf.totalPages).toBe(1);
    expect(pdf.text).toContain("Інтерес до астрономії в українській Вікіпедії зростає");
    expect(pdf.text).toContain("Спершу зробіть курс астрономії для українських читачів.");
    // Fixed labels from the Ukrainian dictionary, including the Verdict words.
    expect(pdf.text).toContain("Висновки");
    expect(pdf.text).toContain("астрономія uk зростає висока");
    expect(pdf.text).not.toContain("Findings");
    // The chart's legend and axis title.
    expect(pdf.text).toContain("астрономія · uk");
    expect(pdf.text).toContain("Переглядів на мільйон переглядів розділу");
    expect(new Set(pdf.fonts)).toEqual(new Set(["NotoSans-Regular", "NotoSans-Bold"]));
    expect(stdout).toMatch(/^labels: Ukrainian$/m);
  });

  test("uses English labels for a Report language without a dictionary, with the Narrative as written", async () => {
    const polish = { ...ENGLISH, language: "pl", headline: "Zainteresowanie astronomią rośnie" };

    const { code, stdout } = await analyzeThenReport(["--topics", "Q333,Q413", "--editions", "uk,pl"], fourBaskets(), polish);

    expect(code).toBe(EXIT_CODES.success);
    const pdf = await readPdf(stdout);
    expect(pdf.text).toContain("Zainteresowanie astronomią rośnie");
    expect(pdf.text).toContain("Findings");
    expect(stdout).toMatch(/^labels: English \(no labels for pl; the Narrative stays as written\)$/m);
  });

  test("shows at most 10 table rows, then how many more are in the Run file, and defines only the Baskets shown", async () => {
    const { stdout } = await analyzeThenReport(["--topics", "Q1,Q2,Q3,Q4,Q5", "--editions", "uk,pl,cs"], manyBaskets(["uk", "pl", "cs"]), ENGLISH);

    const pdf = await readPdf(stdout);
    expect(pdf.text).toContain("+5 more in the Run file");
    // Ranked fastest first: topics 5, 4 and 3, then topic 2 in cs (cs grows fastest within a Topic).
    expect(pdf.text).toContain("topic 2 cs");
    expect(pdf.text).not.toContain("topic 2 pl");
    expect(pdf.text).toContain("topic 2 (Q2): cs: cs 2");
    expect(pdf.text).not.toContain("pl: pl 2");
    expect(pdf.text).not.toContain("topic 1");
  });

  test("shows every row when there are 10 or fewer, with no line about more", async () => {
    const { stdout } = await analyzeThenReport(["--topics", "Q1,Q2,Q3,Q4,Q5", "--editions", "uk,pl"], manyBaskets(["uk", "pl"]), ENGLISH);

    const pdf = await readPdf(stdout);
    expect(pdf.text).toContain("topic 1 uk");
    expect(pdf.text).not.toContain("more in the Run file");
  });

  test("Basket definitions name each Topic's Wikidata item and each Basket's Articles, marking those chosen by the agent", async () => {
    const fake = fourBaskets()
      .article("uk", "Космологія", () => 1_000);

    const { stdout } = await analyzeThenReport(
      ["--topics", "Q333,Q413", "--editions", "uk,pl", "--add-article", "Q333:uk:Космологія"],
      fake,
      ENGLISH,
    );

    const pdf = await readPdf(stdout);
    expect(pdf.text).toContain("astronomy (Q333): uk: Астрономія + Космологія*; pl: Astronomia");
    expect(pdf.text).toContain("physics (Q413): uk: Фізика; pl: Fizyka");
    expect(pdf.text).toContain("* chosen by the agent, not linked from the Wikidata item");
  });

  test("shows a failed Basket's row with its reason", async () => {
    const fake = fourBaskets().article("pl", "Astronomia", () => 5_000, { status: 503 });

    const analysis = await run(["analyze", "--topics", "Q333,Q413", "--editions", "uk,pl"], fake);
    const folder = dirname(runFilePath(analysis.stdout));
    const { code, stdout } = await run(["report", "--run", folder, "--narrative", narrativeFile(ENGLISH)], fake);

    expect(code).toBe(EXIT_CODES.success);
    const reason = /\| astronomy \(Q333\) \| pl \| error: (pageviews of Astronomia: [^|]*?) \|/.exec(analysis.stdout)![1]!;
    expect((await readPdf(stdout)).text).toContain(`astronomy pl error: ${reason}`);
  });

  test("defines a Missing article's Basket as having no Article", async () => {
    const fake = twoTopicsInTwoEditions()
      .item("Q413", { label: "physics", description: "natural science", articles: { uk: "Фізика" } })
      .article("uk", "Астрономія", () => 5_000)
      .article("pl", "Astronomia", () => 5_000)
      .article("uk", "Фізика", () => 4_000);

    const { stdout } = await analyzeThenReport(["--topics", "Q333,Q413", "--editions", "uk,pl"], fake, ENGLISH);

    const pdf = await readPdf(stdout);
    expect(pdf.text).toContain("physics (Q413): uk: Фізика; pl: no Article linked (Missing article)");
  });

  test.each([
    { language: "en", narrative: ENGLISH },
    { language: "uk", narrative: UKRAINIAN },
  ])("stays on one page for the largest allowed Run and the longest Narrative ($language)", async ({ narrative }) => {
    const editions = ["en", "de", "fr", "es", "it", "pl", "uk", "cs", "sk", "zh-min-nan"];
    const longName = (n: number) => `English as a second or foreign language in secondary schools, part ${n}`;
    const longTitle = (n: number, edition: string) => `Teaching English as a second or foreign language (${edition}, ${n})`;
    const longest = (limit: number) => `${"Довге речення про інтерес до теми. ".repeat(20)}`.slice(0, limit);
    const longNarrative = {
      language: narrative.language,
      headline: longest(LIMITS.headline),
      findings: [longest(LIMITS.finding), longest(LIMITS.finding), longest(LIMITS.finding)],
      recommendation: longest(LIMITS.recommendation),
      nextStep: longest(LIMITS.nextStep),
    };

    const { code, stdout } = await analyzeThenReport(
      ["--topics", "Q1,Q2,Q3,Q4,Q5", "--editions", editions.join(","), "--rank", "share"],
      manyBaskets(editions, longName, longTitle),
      longNarrative,
    );

    expect(code).toBe(EXIT_CODES.success);
    const pdf = await readPdf(stdout);
    expect(pdf.totalPages).toBe(1);
    expect(pdf.text).toMatch(/\+40 (more in the Run file|ще у файлі запуску)/);
    // The 8 chart lines are the same Topic, so the legend shortens its label to keep each Edition in view.
    expect(pdf.text).toMatch(/English as a sec[^·]*… · zh-min-nan/);
    expect(pdf.text).toMatch(/English as a sec[^·]*… · sk/);
    // The last line of the page is still there.
    expect(pdf.text).toContain("Wikimedia Pageviews API");
  });

  describe("Narrative validation", () => {
    test("lists every problem and writes no PDF", async () => {
      const bad = {
        headline: "x".repeat(LIMITS.headline + 1),
        findings: [],
        recommendation: "",
        next_step: "Re-run it",
      };

      const { code, stdout, folder } = await analyzeThenReport(["--topics", "Q333", "--editions", "uk"], fourBaskets(), bad);

      expect(code).toBe(EXIT_CODES.blocked);
      expect(stdout).toContain(`blocked: the Narrative file needs fixing; no Report was made:\n`);
      expect(stdout).toContain(`  - language: missing. Give the Report language as a code, e.g. "en" or "uk".\n`);
      expect(stdout).toContain(`  - headline: ${LIMITS.headline + 1} characters, over the limit of ${LIMITS.headline}. Shorten it.\n`);
      expect(stdout).toContain("  - findings: give 1 to 3 findings, not 0.\n");
      expect(stdout).toContain("  - recommendation: empty.");
      expect(stdout).toContain("  - nextStep: missing.");
      expect(stdout).toContain(`  - next_step: not a Narrative field. The fields are language, headline, findings, recommendation and nextStep.\n`);
      expect(readdirSync(folder)).not.toContain("report.pdf");
    });

    test.each([
      { case: "too many findings", change: { findings: ["a", "b", "c", "d"] }, problem: "  - findings: give 1 to 3 findings, not 4." },
      { case: "a finding too long", change: { findings: ["ok", "y".repeat(LIMITS.finding + 1)] }, problem: `  - findings[2]: ${LIMITS.finding + 1} characters, over the limit of ${LIMITS.finding}. Shorten it.` },
      { case: "a finding that isn't text", change: { findings: [42] }, problem: "  - findings[1]: must be text." },
      { case: "findings that aren't a list", change: { findings: "one finding" }, problem: "  - findings: must be a list of 1 to 3 texts." },
      { case: "a next step too long", change: { nextStep: "z".repeat(LIMITS.nextStep + 1) }, problem: `  - nextStep: ${LIMITS.nextStep + 1} characters, over the limit of ${LIMITS.nextStep}.` },
      { case: "a language that isn't a code", change: { language: "Ukrainian" }, problem: `  - language: "Ukrainian" isn't a language code; use one like "en" or "uk".` },
    ])("refuses $case", async ({ change, problem }) => {
      const { code, stdout, folder } = await analyzeThenReport(["--topics", "Q333", "--editions", "uk"], fourBaskets(), { ...ENGLISH, ...change });

      expect(code).toBe(EXIT_CODES.blocked);
      expect(stdout).toContain(problem);
      expect(readdirSync(folder)).not.toContain("report.pdf");
    });

    test("refuses a file that isn't JSON", async () => {
      const { code, stdout } = await analyzeThenReport(["--topics", "Q333", "--editions", "uk"], fourBaskets(), "headline: hi");

      expect(code).toBe(EXIT_CODES.blocked);
      expect(stdout).toMatch(/^blocked: the Narrative file .* isn't valid JSON/m);
    });

    test("accepts a Narrative at every limit", async () => {
      const atLimits = {
        ...ENGLISH,
        headline: "h".repeat(LIMITS.headline),
        findings: ["f".repeat(LIMITS.finding)],
        recommendation: "r".repeat(LIMITS.recommendation),
        nextStep: "n".repeat(LIMITS.nextStep),
      };

      const { code } = await analyzeThenReport(["--topics", "Q333", "--editions", "uk"], fourBaskets(), atLimits);

      expect(code).toBe(EXIT_CODES.success);
    });
  });

  test.each([
    { case: "no --run", args: () => ["report", "--narrative", narrativeFile(ENGLISH)], problem: /^blocked: give the Run folder with --run and the Narrative file with --narrative\. Usage: report --run/m },
    { case: "a Run folder without a Run file", args: () => ["report", "--run", mkdtempSync(join(tmpdir(), "not-a-run-")), "--narrative", narrativeFile(ENGLISH)], problem: /^blocked: no Run file at .*run\.json\. Give the Run folder printed on analyze's run file: line\.$/m },
  ])("refuses $case", async ({ args, problem }) => {
    const { code, stdout } = await run(args(), fakeWikimedia());

    expect(code).toBe(EXIT_CODES.blocked);
    expect(stdout).toMatch(problem);
  });

  test("says so when the Run file isn't valid JSON, rather than that there is none", async () => {
    const analysis = await run(["analyze", "--topics", "Q333", "--editions", "uk"], fourBaskets());
    writeFileSync(runFilePath(analysis.stdout), "{ cut off");

    const { code, stdout } = await run(
      ["report", "--run", dirname(runFilePath(analysis.stdout)), "--narrative", narrativeFile(ENGLISH)],
      fakeWikimedia(),
    );

    expect(code).toBe(EXIT_CODES.blocked);
    expect(stdout).toMatch(/^blocked: the Run file at .*run\.json isn't valid JSON \(.*\)\. Run analyze again for a new Run\.$/m);
  });

  test("refuses a Narrative file that doesn't exist", async () => {
    const analysis = await run(["analyze", "--topics", "Q333", "--editions", "uk"], fourBaskets());
    const folder = dirname(runFilePath(analysis.stdout));

    const { code, stdout } = await run(["report", "--run", folder, "--narrative", join(folder, "nope.json")], fakeWikimedia());

    expect(code).toBe(EXIT_CODES.blocked);
    expect(stdout).toMatch(/^blocked: no Narrative file at .*nope\.json\.$/m);
  });

  test("makes no requests: everything comes from the Run file", async () => {
    const fake = fourBaskets();
    const analysis = await run(["analyze", "--topics", "Q333,Q413", "--editions", "uk,pl"], fake);
    const requests = fake.requests.length;

    await run(["report", "--run", dirname(runFilePath(analysis.stdout)), "--narrative", narrativeFile(ENGLISH)], fake);

    expect(fake.requests.length).toBe(requests);
  });

  test("analyze's next steps say how to make a Report", async () => {
    const { stdout } = await run(["analyze", "--topics", "Q333", "--editions", "uk"], fourBaskets());

    expect(stdout).toMatch(/^ {2}- For a one-page PDF Report, write a Narrative file .* report --run .* --narrative <file>/m);
  });

  test("the bundled font's OFL licence ships in the skill folder", () => {
    const fonts = fileURLToPath(new URL("../fonts/", import.meta.url));

    expect(existsSync(join(fonts, "NotoSans-Regular.ttf"))).toBe(true);
    expect(readFileSync(join(fonts, "OFL.txt"), "utf8")).toContain("SIL Open Font License, Version 1.1");
  });
});
