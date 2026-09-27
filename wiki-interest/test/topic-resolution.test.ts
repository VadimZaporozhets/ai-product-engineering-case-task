import { readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { EXIT_CODES } from "../src/cli.ts";
import { fakeWikimedia } from "./fake-wikimedia.ts";
import { recordedWikimedia } from "./recorded-wikimedia.ts";
import { run, runJson } from "./run-cli.ts";

// Recorded on 2026-09-26 from the live APIs; the test clock is the same day, so the default Window is
// 2024-09..2026-08.

describe("Topic resolution by name", () => {
  test("accepts astronomy despite other items with the same label, and prints the resolution before the results", async () => {
    const fake = recordedWikimedia("astronomy");

    const { code, stdout } = await run(["analyze", "--topics", "astronomy", "--editions", "uk"], fake);

    expect(code).toBe(EXIT_CODES.success);
    expect(stdout).toMatch(/^rerun: .* analyze --topics Q333 --editions uk --months 24 --end 2026-08$/m);
    const search = fake.requests.find((url) => url.searchParams.get("action") === "wbsearchentities")!;
    expect(search.searchParams.get("search")).toBe("astronomy");
    expect(search.searchParams.get("language")).toBe("en");
    expect(search.searchParams.get("limit")).toBe("50");
    // 252 Wikipedia Articles: its 318 sitelinks include Commons, Wikiquote, Abstract Wikipedia and more.
    expect(stdout).toContain(
      "Q333 astronomy: natural science studying celestial objects and phenomena in the cosmos (252 Wikipedia Articles)",
    );
    // The runner-up has 9: the magazine. The song with the same label has none.
    expect(stdout).toMatch(/chosen for "astronomy" \(en\) from \d+ exact matches; the next is Q3232273 Astronomy: American magazine \(9\)/);
    expect(stdout).toContain("    uk: Астрономія");
    expect(stdout.indexOf("resolution:")).toBeLessThan(stdout.indexOf("| Topic |"));
    expect(stdout).toMatch(/^\| astronomy \(Q333\) \| uk \| \w+ \| \w+ \|/m);
  });

  test("searches a Topic named in another language in that language, and shows the item in it", async () => {
    const fake = recordedWikimedia("astronomy");

    const { code, stdout } = await run(
      ["analyze", "--topics", "астрономія", "--name-lang", "uk", "--editions", "uk"],
      fake,
    );

    expect(code).toBe(EXIT_CODES.success);
    const search = fake.requests.find((url) => url.searchParams.get("action") === "wbsearchentities")!;
    expect(search.searchParams.get("search")).toBe("астрономія");
    expect(search.searchParams.get("language")).toBe("uk");
    // The resolved form needs no name language: it holds the item id.
    expect(stdout).toMatch(/^rerun: .* analyze --topics Q333 --editions uk --months 24 --end 2026-08$/m);
    expect(stdout).toMatch(/^ {2}Q333 астрономія: одна з найдавніших наук.* \(252 Wikipedia Articles\)$/m);
    expect(stdout).toMatch(/chosen for "астрономія" \(uk\) from \d+ exact matches/);
    expect(stdout).toMatch(/^\| астрономія \(Q333\) \| uk \|/m);
  });
});

describe("Missing articles", () => {
  test("reports an Edition without a linked Article with search candidates, never substituting one", async () => {
    const fake = recordedWikimedia("intermittent-fasting");

    const { code, stdout } = await run(["analyze", "--topics", "intermittent fasting", "--editions", "cs,pl"], fake);

    expect(code).toBe(EXIT_CODES.success);
    expect(stdout).toMatch(/^rerun: .* analyze --topics Q1666254 --editions cs,pl --months 24 --end 2026-08$/m);
    expect(stdout).toMatch(/^ {2}Q1666254 intermittent fasting: .*\(31 Wikipedia Articles\)$/m);
    expect(stdout).toContain("    cs: Přerušovaný půst");
    // The item has no Polish label, so pl Wikipedia's search gets the Topic name as given, and finds only
    // neighbouring Articles.
    const plSearch = fake.requests.find((url) => url.hostname === "pl.wikipedia.org")!;
    expect(plSearch.searchParams.get("srsearch")).toBe("intermittent fasting");
    expect(plSearch.searchParams.get("srlimit")).toBe("3");
    expect(stdout).toContain(
      '    pl: Missing article, no Article is linked to Q1666254; search candidates, not analysed: ' +
        '"Stres oksydacyjny", "Głodówka lecznicza", "Paleolityczny styl życia"',
    );
    expect(stdout).toMatch(/^\| intermittent fasting \(Q1666254\) \| cs \| \w+ \| \w+ \| [+-]\d/m);
    expect(stdout).toContain("| intermittent fasting (Q1666254) | pl | none | insufficient | n/a | n/a | n/a | n/a |");
    expect(stdout).toMatch(/intermittent fasting \(Q1666254\) in pl, insufficient Confidence:\n {2}- Enough data: no pl Wikipedia Article is linked/);
    expect(stdout).toMatch(/^next steps:$[\s\S]*intermittent fasting \(Q1666254\) has no Article in pl Wikipedia/m);
    // Only the cs Article's pageviews are fetched; nothing stands in for the Missing pl Article.
    expect(fake.pageviewRequests().filter((url) => url.pathname.includes("/per-article/"))).toHaveLength(1);
    expect(fake.pageviewRequests().some((url) => url.pathname.includes("/per-article/pl."))).toBe(false);
  });

  test("a Run where every Basket is a Missing article still succeeds", async () => {
    const fake = recordedWikimedia("intermittent-fasting");

    const { code, stdout } = await run(["analyze", "--topics", "intermittent fasting", "--editions", "pl"], fake);

    expect(code).toBe(EXIT_CODES.success);
    expect(stdout).toContain("| intermittent fasting (Q1666254) | pl | none | insufficient | n/a | n/a | n/a | n/a |");
    expect(runJson(stdout).baskets[0]).toMatchObject({
      topic: "Q1666254",
      edition: "pl",
      articles: [],
      missingArticle: { candidates: ["Stres oksydacyjny", "Głodówka lecznicza", "Paleolityczny styl życia"] },
      verdict: { direction: null, confidence: "insufficient" },
    });
  });

  test("a failed candidate search keeps the Missing article, and exits with partial failure", async () => {
    const fake = fakeWikimedia()
      .item("Q1666254", { label: "intermittent fasting", description: "a diet", articles: { cs: "Přerušovaný půst" } })
      .editionTotals("pl", () => 100_000_000)
      .interrupt("pl.wikipedia.org", [{ status: 400 }]);

    const { code, stdout } = await run(["analyze", "--topics", "Q1666254", "--editions", "pl"], fake);

    expect(code).toBe(EXIT_CODES.partialFailure);
    expect(stdout).toMatch(/^ {4}pl: Missing article; the search for candidates failed: search of pl Wikipedia: /m);
    expect(stdout).toContain("| intermittent fasting (Q1666254) | pl | none | insufficient | n/a | n/a | n/a | n/a |");
  });

  test("searches for candidates with the item's label in the Edition's language when it has one", async () => {
    const fake = recordedWikimedia("intermittent-fasting");

    const { stdout } = await run(["analyze", "--topics", "intermittent fasting", "--editions", "pt"], fake);

    const ptSearch = fake.requests.find((url) => url.hostname === "pt.wikipedia.org")!;
    expect(ptSearch.searchParams.get("srsearch")).toBe("jejum intermitente");
    expect(stdout).toMatch(/^ {4}pt: Missing article, no Article is linked to Q1666254; search candidates, not analysed: "/m);
  });
});

describe("Ambiguous topics", () => {
  test("blocks the Run when no exact match has 3 times as many Wikipedia Articles as the next, listing the candidates", async () => {
    const fake = recordedWikimedia("mercury");

    const { code, stdout, outputDir } = await run(["analyze", "--topics", "Mercury", "--editions", "uk"], fake);

    expect(code).toBe(EXIT_CODES.blocked);
    // The top search hit is the car brand; it isn't picked just for being first.
    const lookup = fake.requests.find((url) => url.searchParams.get("action") === "wbgetentities")!;
    expect(lookup.searchParams.get("ids")!.split("|")[0]).toBe("Q613883");
    expect(stdout).toMatch(/^blocked: Ambiguous topic "Mercury" \(en\): no exact label or alias match has at least 3 times as many Wikipedia Articles as the next/m);
    // The planet 250 vs the element 176.
    const candidates = stdout.split("\n").filter((line) => /^ {2}Q\d+ /.test(line));
    expect(candidates[0]).toMatch(/^ {2}Q308 Mercury: first planet from the Solar System.* \(250 Wikipedia Articles\)$/);
    expect(candidates[1]).toMatch(/^ {2}Q925 mercury: chemical element with symbol Hg.* \(176 Wikipedia Articles\)$/);
    expect(candidates).toHaveLength(5);
    expect(stdout).toMatch(/^ {2}\+\d+ more with fewer Wikipedia Articles$/m);
    expect(stdout).toMatch(/^next steps:\n.*Ask the user which meaning they mean.*\n {4}node .* analyze --topics '<item id>' --editions uk --months 24 --end 2026-08$/m);
    expect(fake.pageviewRequests().filter((url) => url.pathname.includes("/per-article/"))).toEqual([]);
    expect(readdirSync(outputDir)).toEqual([]);
  });
});

describe("exact matches without a Wikipedia Article", () => {
  // "SOLAR ECLIPSES", a scientific article with 0 Wikipedia Articles, is the only exact match for the plural. It can
  // never be measured, so it isn't a meaning of the Topic: its de Basket would be a false Missing article.
  test("are left out, and a name with no other exact match blocks with the closest search hits", async () => {
    const fake = recordedWikimedia("solar-eclipses");

    const { code, stdout, outputDir } = await run(["analyze", "--topics", "solar eclipses", "--editions", "de"], fake);

    expect(code).toBe(EXIT_CODES.blocked);
    expect(stdout).toMatch(
      /^blocked: Ambiguous topic "solar eclipses" \(en\): no Wikidata item with a Wikipedia Article has this exact label or alias\. Closest search hits:$/m,
    );
    expect(stdout).not.toContain("Q81058885");
    const candidates = stdout.split("\n").filter((line) => /^ {2}Q\d+ /.test(line));
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) expect(candidate).not.toMatch(/\(0 Wikipedia Articles\)$/);
    expect(stdout).toMatch(/^ {4}node .* analyze --topics '<item id>' --editions de --months 24 --end 2026-08$/m);
    expect(fake.pageviewRequests().filter((url) => url.pathname.includes("/per-article/"))).toEqual([]);
    expect(readdirSync(outputDir)).toEqual([]);
  });

  test("are left out of the resolve command's list too", async () => {
    const fake = recordedWikimedia("solar-eclipses");

    const { code, stdout } = await run(["resolve", "--topic", "solar eclipses", "--editions", "de"], fake);

    expect(code).toBe(EXIT_CODES.success);
    expect(stdout).toMatch(
      /^resolve: no Wikidata item with a Wikipedia Article has "solar eclipses" \(en\) as its exact label or alias\. Closest search hits:$/m,
    );
    expect(stdout).not.toContain("Q81058885");
    expect(stdout).toMatch(/^result: Ambiguous topic: /m);
  });

  test("don't count as the next meaning when another exact match has Articles", async () => {
    const fake = fakeWikimedia()
      .item("Q3887", { label: "solar eclipse", description: "natural phenomenon", articles: { de: "Sonnenfinsternis" } })
      .item("Q81058885", { label: "solar eclipse", description: "scientific article", articles: {} })
      .search("solar eclipse", ["Q81058885", "Q3887"])
      .editionTotals("de", () => 100_000_000)
      .article("de", "Sonnenfinsternis", () => 3_000);

    const { code, stdout } = await run(["analyze", "--topics", "solar eclipse", "--editions", "de"], fake);

    expect(code).toBe(EXIT_CODES.success);
    expect(stdout).toContain('    chosen for "solar eclipse" (en) from 1 exact match\n');
    expect(stdout).not.toContain("Q81058885");
  });
});

describe("Ambiguous topics without an exact match", () => {
  test("blocks the Run and lists the closest search hits", async () => {
    const fake = fakeWikimedia()
      .item("Q1666254", { label: "intermittent fasting", description: "a diet", articles: { cs: "Přerušovaný půst" } })
      .search("intermitent fasting", ["Q1666254"])
      .editionTotals("cs", () => 100_000_000);

    const { code, stdout } = await run(["analyze", "--topics", "intermitent fasting", "--editions", "cs"], fake);

    expect(code).toBe(EXIT_CODES.blocked);
    expect(stdout).toContain(
      'blocked: Ambiguous topic "intermitent fasting" (en): no Wikidata item with a Wikipedia Article has this exact label ' +
        "or alias. Closest search hits:\n" +
        "  Q1666254 intermittent fasting: a diet (1 Wikipedia Article)\n",
    );
    expect(stdout).toMatch(/^ {4}node .* analyze --topics '<item id>' --editions cs --months 24 --end 2026-08$/m);
  });

  test("blocks the Run when the search finds nothing", async () => {
    const fake = fakeWikimedia().editionTotals("cs", () => 100_000_000);

    const { code, stdout } = await run(["analyze", "--topics", "xyzzy", "--editions", "cs"], fake);

    expect(code).toBe(EXIT_CODES.blocked);
    expect(stdout).toContain('blocked: Ambiguous topic "xyzzy" (en): Wikidata search found no items with a Wikipedia Article.');
    expect(stdout).toContain("check the spelling");
    expect(stdout).not.toContain("analyze --topics");
  });
});

describe("resolve", () => {
  test("lists the candidate meanings of a name with the Article each links in the requested Editions", async () => {
    const fake = recordedWikimedia("mercury");

    const { code, stdout } = await run(["resolve", "--topic", "Mercury", "--editions", "en,uk"], fake);

    expect(code).toBe(EXIT_CODES.success);
    expect(stdout).toMatch(/^resolve: "Mercury" \(en\) matches \d+ Wikidata items by exact label or alias, most Wikipedia Articles first:$/m);
    expect(stdout).toMatch(/^ {2}Q308 Mercury: first planet .* \(250 Wikipedia Articles\)\n {4}en: Mercury \(planet\)\n {4}uk: Меркурій \(планета\)$/m);
    expect(stdout).toMatch(/^ {2}Q925 mercury: chemical element .* \(176 Wikipedia Articles\)\n {4}en: Mercury \(element\)\n {4}uk: Ртуть$/m);
    expect(stdout).toContain("result: Ambiguous topic: analyze won't pick one. Ask the user which meaning they mean, then run analyze with --topics <item id>.");
    expect(fake.pageviewRequests()).toEqual([]);
  });

  test("matches a name by alias, and says which item analyze accepts", async () => {
    const fake = recordedWikimedia("english-language");

    const { code, stdout } = await run(["resolve", "--topic", "English language", "--editions", "uk"], fake);

    expect(code).toBe(EXIT_CODES.success);
    // Q1860's label is "English"; "English language" is one of its aliases, and also one of English studies'.
    expect(stdout).toMatch(/^ {2}Q1860 English: West Germanic language \(317 Wikipedia Articles\)\n {4}uk: Англійська мова$/m);
    expect(stdout).toMatch(/^ {2}Q27968 English studies: .* \(31 Wikipedia Articles\)$/m);
    expect(stdout).toContain(
      'result: analyze accepts Q1860 for "English language": it has at least 3 times as many Wikipedia Articles as the next match.',
    );
  });
});

describe("disambiguation pages", () => {
  test("are left out before the most Wikipedia Articles are compared", async () => {
    // Wikidata's search doesn't return disambiguation pages for the recorded names, so this one is synthetic.
    const inEditions = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`e${i}`, `Title ${i}`]));
    const fake = fakeWikimedia()
      .item("Q1", { label: "Mercury", description: "Wikimedia disambiguation page", articles: inEditions(300), disambiguation: true })
      .item("Q308", { label: "Mercury", description: "planet", articles: { ...inEditions(200), uk: "Меркурій (планета)" } })
      .item("Q925", { label: "mercury", description: "chemical element", articles: inEditions(50) })
      .search("Mercury", ["Q1", "Q308", "Q925"])
      .editionTotals("uk", () => 100_000_000)
      .article("uk", "Меркурій (планета)", () => 3_000);

    const { code, stdout } = await run(["analyze", "--topics", "Mercury", "--editions", "uk"], fake);

    // 201 vs 50 Wikipedia Articles. With the disambiguation page counted, 300 vs 201 would be ambiguous.
    expect(code).toBe(EXIT_CODES.success);
    expect(stdout).toContain("  Q308 Mercury: planet (201 Wikipedia Articles)");
    expect(stdout).toContain("the next is Q925 mercury: chemical element (50)");
  });
});
