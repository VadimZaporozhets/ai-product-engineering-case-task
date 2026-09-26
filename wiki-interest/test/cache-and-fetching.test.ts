import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { EXIT_CODES } from "../src/cli.ts";
import type { Fetch } from "../src/http.ts";
import { fakeWikimedia } from "./fake-wikimedia.ts";
import { astronomyInUkrainian, newCacheDir, run } from "./run-cli.ts";

/** Answers through `fetch` a few milliseconds late, counting the most requests of a kind waiting at the same time. */
function slowFetch(fetch: Fetch, kind: (url: URL) => boolean) {
  let inFlight = 0;
  const slow = {
    mostInFlight: 0,
    fetch: async (input: string | URL, init?: RequestInit) => {
      const counted = kind(new URL(input));
      if (counted) slow.mostInFlight = Math.max(slow.mostInFlight, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      const response = await fetch(input, init);
      if (counted) inFlight--;
      return response;
    },
  };
  return slow;
}

function astronomyWithViews() {
  return astronomyInUkrainian()
    .editionTotals("uk", () => 100_000_000)
    .article("uk", "Астрономія", () => 3_000);
}

describe("pageview cache", () => {
  test("a cache directory that can't be written to doesn't stop the Run", async () => {
    // A file where the cache directory should be, so nothing can be created inside it.
    const cacheDir = join(newCacheDir(), "not-a-directory");
    writeFileSync(cacheDir, "");

    const { code, stdout } = await run(["analyze", "--topics", "Q333", "--editions", "uk"], astronomyWithViews(), {
      cacheDir,
    });

    expect(code).toBe(EXIT_CODES.success);
    expect(stdout).toContain("| astronomy (Q333) | uk | flat |");
  });

  test("a second identical Run makes no pageview calls and gives the same Verdict row", async () => {
    const cacheDir = newCacheDir();
    const argv = ["analyze", "--topics", "Q333", "--editions", "uk", "--months", "12", "--end", "2026-08"];
    const first = await run(argv, astronomyWithViews(), { cacheDir });

    const fake = astronomyWithViews();
    const second = await run(argv, fake, { cacheDir });

    expect(second.code).toBe(EXIT_CODES.success);
    expect(fake.pageviewRequests()).toEqual([]);
    const row = /^\| astronomy .*$/m;
    expect(second.stdout.match(row)![0]).toBe(first.stdout.match(row)![0]);
  });

  test.each([
    {
      change: "lengthening the Window from 24 to 36 months",
      first: ["--months", "24", "--end", "2026-08"],
      second: ["--months", "36", "--end", "2026-08"],
      fetched: "20230901/20240831",
    },
    {
      change: "moving the end of the Window two months later",
      first: ["--months", "12", "--end", "2026-06"],
      second: ["--months", "12", "--end", "2026-08"],
      fetched: "20260701/20260831",
    },
  ])("$change fetches only the added months", async ({ first, second, fetched }) => {
    const cacheDir = newCacheDir();
    const argv = ["analyze", "--topics", "Q333", "--editions", "uk"];
    await run([...argv, ...first], astronomyWithViews(), { cacheDir });

    const fake = astronomyWithViews();
    const { code, stdout } = await run([...argv, ...second], fake, { cacheDir });

    expect(code).toBe(EXIT_CODES.success);
    expect(fake.pageviewRequests().map((url) => url.pathname)).toEqual([
      `/api/rest_v1/metrics/pageviews/aggregate/uk.wikipedia.org/all-access/user/monthly/${fetched}`,
      `/api/rest_v1/metrics/pageviews/per-article/uk.wikipedia.org/all-access/user/${encodeURIComponent("Астрономія")}/daily/${fetched}`,
    ]);
    // 3,000 views a month of 100 million, whichever months came from the cache.
    expect(stdout).toContain("| astronomy (Q333) | uk | flat | ");
    expect(stdout).toMatch(/\| 3000 \| 30\.00 \|$/m);
  });

  test("doesn't cache a month that ended too recently for Wikimedia to have published all its days", async () => {
    const cacheDir = newCacheDir();
    const argv = ["analyze", "--topics", "Q333", "--editions", "uk", "--months", "12", "--end", "2026-08"];
    await run(argv, astronomyWithViews(), { cacheDir, now: new Date("2026-09-01T00:30:00Z") });

    const fake = astronomyWithViews();
    await run(argv, fake, { cacheDir, now: new Date("2026-09-26T11:00:00Z") });

    expect(fake.pageviewRequests().map((url) => url.pathname.split("/").slice(-2).join("/"))).toEqual([
      "20260801/20260831",
      "20260801/20260831",
    ]);
  });

  test("never caches Wikidata or search responses", async () => {
    const cacheDir = newCacheDir();
    const argv = ["analyze", "--topics", "astronomy", "--editions", "uk", "--months", "12", "--end", "2026-08"];
    await run(argv, astronomyWithViews().search("astronomy", ["Q333"]), { cacheDir });

    const fake = astronomyWithViews().search("astronomy", ["Q333"]);
    const { code } = await run(argv, fake, { cacheDir });

    expect(code).toBe(EXIT_CODES.success);
    expect(fake.requests.filter((url) => url.hostname === "www.wikidata.org").map((url) => url.searchParams.get("action")))
      .toEqual(["wbsearchentities", "wbgetentities", "wbgetclaims"]);
  });

  test("reuses Edition totals fetched for one Topic for another Topic in the same Edition", async () => {
    const cacheDir = newCacheDir();
    const argv = ["--editions", "uk", "--months", "12", "--end", "2026-08"];
    const fake = () =>
      astronomyWithViews()
        .item("Q413", { label: "physics", description: "natural science", articles: { uk: "Фізика" } })
        .article("uk", "Фізика", () => 5_000);
    await run(["analyze", "--topics", "Q333", ...argv], fake(), { cacheDir });

    const second = fake();
    await run(["analyze", "--topics", "Q413", ...argv], second, { cacheDir });

    expect(second.pageviewRequests().map((url) => url.pathname)).toEqual([
      `/api/rest_v1/metrics/pageviews/per-article/uk.wikipedia.org/all-access/user/${encodeURIComponent("Фізика")}/daily/20250901/20260831`,
    ]);
  });
});

describe("request etiquette", () => {
  const argv = ["analyze", "--topics", "astronomy", "--editions", "uk", "--months", "12"];

  test("every request names the skill, its version and the repository URL in its User-Agent", async () => {
    const fake = astronomyWithViews().search("astronomy", ["Q333"]);

    await run(argv, fake);

    expect(new Set(fake.requests.map((url) => url.hostname))).toEqual(new Set(["www.wikidata.org", "wikimedia.org"]));
    for (const userAgent of fake.userAgents) {
      expect(userAgent).toMatch(
        /^wiki-interest\/\d+\.\d+\.\d+ \(https:\/\/github\.com\/VadimZaporozhets\/ai-product-engineering-case-task\)$/,
      );
    }
  });

  test("the User-Agent can be replaced", async () => {
    const fake = astronomyWithViews().search("astronomy", ["Q333"]);

    await run(argv, fake, { userAgent: "acme-research/2.0 (ops@acme.example)" });

    expect(fake.userAgents.length).toBeGreaterThan(0);
    expect(new Set(fake.userAgents)).toEqual(new Set(["acme-research/2.0 (ops@acme.example)"]));
  });

  test("waits as long as Retry-After says after an HTTP 429, then tries again", async () => {
    const fake = astronomyWithViews()
      .search("astronomy", ["Q333"])
      .interrupt("www.wikidata.org", [{ status: 429, retryAfter: "12" }]);

    const { code, stdout, sleeps } = await run(argv, fake);

    expect(code).toBe(EXIT_CODES.success);
    expect(sleeps).toEqual([12_000]);
    expect(stdout).toContain("| astronomy (Q333) | uk | flat |");
  });

  test("reads a Retry-After given as a date", async () => {
    // The injected clock says 2026-09-26 11:00:00 UTC.
    const fake = astronomyWithViews().interrupt("wikimedia.org", [
      { status: 503, retryAfter: "Sat, 26 Sep 2026 11:00:05 GMT" },
    ]);

    const { code, sleeps } = await run(["analyze", "--topics", "Q333", "--editions", "uk"], fake);

    expect(code).toBe(EXIT_CODES.success);
    expect(sleeps).toEqual([5_000]);
  });

  test("backs off between attempts when there is no Retry-After, and gives up after 3 attempts", async () => {
    const fake = astronomyWithViews().interrupt("wikimedia.org", [{ status: 502 }, { status: 503 }, { status: 504 }]);

    const { code, stdout, sleeps } = await run(["analyze", "--topics", "Q333", "--editions", "uk"], fake);

    expect(fake.pageviewRequests()).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThan(0);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0]!);
    expect(code).toBe(EXIT_CODES.partialFailure);
    expect(stdout).toContain("error: total views of uk Wikipedia: wikimedia.org answered HTTP 504 after 3 attempts");
  });

  test("backs off when Retry-After is neither whole seconds nor a date", async () => {
    const fake = astronomyWithViews().interrupt("wikimedia.org", [{ status: 503, retryAfter: "1.5" }]);

    const { code, sleeps } = await run(["analyze", "--topics", "Q333", "--editions", "uk"], fake);

    expect(code).toBe(EXIT_CODES.success);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(0);
  });

  test("doesn't retry an answer that won't change, such as HTTP 400", async () => {
    const fake = astronomyWithViews().interrupt("www.wikidata.org", [{ status: 400 }]);

    const { code, stdout, sleeps } = await run(["analyze", "--topics", "Q333", "--editions", "uk"], fake);

    expect(sleeps).toEqual([]);
    expect(code).toBe(EXIT_CODES.partialFailure);
    expect(stdout).toContain("error: Wikidata lookup failed: www.wikidata.org answered HTTP 400 |");
  });

  test("has at most 4 pageview requests in flight, and uses all 4", async () => {
    const editions = ["uk", "pl", "cs", "de", "fr", "es"];
    let fake = fakeWikimedia().item("Q333", {
      label: "astronomy",
      description: "natural science studying celestial objects",
      articles: Object.fromEntries(editions.map((edition) => [edition, `Astronomy (${edition})`])),
    });
    for (const edition of editions) {
      fake = fake.editionTotals(edition, () => 100_000_000).article(edition, `Astronomy (${edition})`, () => 3_000);
    }
    const slow = slowFetch(fake.fetch, (url) => url.hostname === "wikimedia.org");

    const { code } = await run(["analyze", "--topics", "Q333", "--editions", editions.join(",")], { fetch: slow.fetch });

    expect(code).toBe(EXIT_CODES.success);
    expect(fake.pageviewRequests()).toHaveLength(12);
    expect(slow.mostInFlight).toBe(4);
  });

  test("sends Wikidata and Wikipedia search requests one at a time", async () => {
    // Only uk has an Article, so each other Edition's own search runs for its Missing article.
    const fake = astronomyWithViews()
      .search("astronomy", ["Q333"])
      .editionTotals("pl", () => 100_000_000)
      .editionTotals("cs", () => 100_000_000)
      .editionTotals("de", () => 100_000_000);
    const mediaWiki = (url: URL) => url.hostname !== "wikimedia.org";
    const slow = slowFetch(fake.fetch, mediaWiki);

    const { code } = await run(["analyze", "--topics", "astronomy", "--editions", "uk,pl,cs,de"], {
      fetch: slow.fetch,
    });

    expect(code).toBe(EXIT_CODES.success);
    expect(fake.requests.filter(mediaWiki).map((url) => url.hostname)).toEqual([
      "www.wikidata.org",
      "www.wikidata.org",
      "www.wikidata.org",
      "pl.wikipedia.org",
      "cs.wikipedia.org",
      "de.wikipedia.org",
    ]);
    expect(slow.mostInFlight).toBe(1);
  });

  test("gives up at once instead of waiting longer than a minute", async () => {
    const fake = astronomyWithViews().interrupt("www.wikidata.org", [{ status: 429, retryAfter: "3600" }]);

    const { code, stdout, sleeps } = await run(["analyze", "--topics", "Q333", "--editions", "uk"], fake);

    expect(sleeps).toEqual([]);
    expect(code).toBe(EXIT_CODES.partialFailure);
    expect(stdout).toContain(
      "error: Wikidata lookup failed: www.wikidata.org answered HTTP 429 and asked to wait 3600 seconds",
    );
  });
});
