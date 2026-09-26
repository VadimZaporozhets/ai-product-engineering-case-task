// A fake of the Wikidata and Wikimedia pageviews APIs, answering fetch calls with
// API-shaped responses built from series the test declares.

/** Views for a month given as "YYYY-MM"; undefined means the Article has no data that month. */
type MonthlySeries =(month: string) => number | undefined;

type FakeItem = {
  label: string;
  description: string;
  /** Article title per Edition code. */
  articles: Record<string, string>;
  /** Instance of Wikimedia disambiguation page. */
  disambiguation?: boolean;
};

type FakeArticle = {
  series: MonthlySeries;
  /** Daily views by "YYYY-MM-DD" that replace the evenly spread figure (0 removes the day). */
  days: Record<string, number>;
  /** Daily views by "YYYY-MM-DD" added on top of that day's figure, e.g. a news Spike. */
  extra: Record<string, number>;
  /** Answer every request for this Article with this HTTP status instead of data. */
  status?: number;
};

type FakeTotals = { series: MonthlySeries; status?: number };

/** An error answer: an HTTP status and, optionally, a Retry-After header. */
type Interruption = { status: number; retryAfter?: string };

export function fakeWikimedia() {
  const items = new Map<string, FakeItem>();
  const totals = new Map<string, FakeTotals>();
  const articles = new Map<string, FakeArticle>();
  /** Item ids a Wikidata name search finds, by name. */
  const searches = new Map<string, string[]>();
  const requests: URL[] = [];
  /** The User-Agent header of each request, in the order of `requests`. */
  const userAgents: (string | null)[] = [];
  /** Error answers each host gives its next requests, before answering normally again. */
  const interruptions = new Map<string, Interruption[]>();

  const fake = {
    requests,
    userAgents,

    item(id: string, item: FakeItem) {
      items.set(id, item);
      return fake;
    },

    /** Wikidata's search for this name finds these items, in this order; each matches by its label. */
    search(name: string, ids: string[]) {
      searches.set(name, ids);
      return fake;
    },

    /** Answer the next requests to this host with these errors, in order, then answer normally. */
    interrupt(host: string, answers: Interruption[]) {
      interruptions.set(host, [...(interruptions.get(host) ?? []), ...answers]);
      return fake;
    },

    editionTotals(edition: string, series: MonthlySeries, options: { status?: number } = {}) {
      totals.set(edition, { series, status: options.status });
      return fake;
    },

    article(
      edition: string,
      title: string,
      series: MonthlySeries,
      options: { days?: Record<string, number>; extra?: Record<string, number>; status?: number } = {},
    ) {
      articles.set(`${edition}:${title}`, {
        series,
        days: options.days ?? {},
        extra: options.extra ?? {},
        status: options.status,
      });
      return fake;
    },

    fetch: async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input);
      requests.push(url);
      userAgents.push(new Headers(init?.headers).get("user-agent"));
      const interruption = interruptions.get(url.hostname)?.shift();
      if (interruption) {
        const headers: Record<string, string> = interruption.retryAfter ? { "retry-after": interruption.retryAfter } : {};
        return json(interruption.status, { error: "fake interruption" }, headers);
      }
      if (url.hostname === "www.wikidata.org") {
        const action = url.searchParams.get("action");
        if (action === "wbgetentities") return wbgetentities(url, items);
        if (action === "wbsearchentities") return wbsearchentities(url, items, searches);
        if (action === "wbgetclaims") return wbgetclaims(url, items);
        throw new Error(`fake-wikimedia: unexpected Wikidata request ${url}`);
      }
      if (url.hostname.endsWith(".wikipedia.org") && url.searchParams.get("list") === "search") {
        // An Edition's own search, run for a Missing article; the fake finds nothing.
        return json(200, { batchcomplete: "", query: { searchinfo: { totalhits: 0 }, search: [] } });
      }
      const path = url.pathname.split("/").map(decodeURIComponent);
      if (url.hostname === "wikimedia.org" && path[5] === "per-article") return perArticle(path, articles);
      if (url.hostname === "wikimedia.org" && path[5] === "aggregate") return aggregate(path, totals);
      throw new Error(`fake-wikimedia: unexpected request ${url}`);
    },

    /** Pageview requests (per-article and aggregate) made so far. */
    pageviewRequests: () => pageviewRequests(requests),
  };
  return fake;
}

function wbgetentities(url: URL, items: Map<string, FakeItem>): Response {
  const ids = (url.searchParams.get("ids") ?? "").split("|");
  const entities: Record<string, unknown> = {};
  for (const id of ids) {
    const item = items.get(id);
    if (!item) {
      entities[id] = { id, missing: "" };
      continue;
    }
    // Like the real API, every sitelink, with its URL; Commons stands in for the links that aren't Wikipedias.
    const sitelinks: Record<string, unknown> = {
      commonswiki: { site: "commonswiki", title: `Category:${item.label}`, badges: [], url: "https://commons.wikimedia.org/" },
    };
    for (const [edition, title] of Object.entries(item.articles)) {
      const site = `${edition.replaceAll("-", "_")}wiki`;
      const url = `https://${edition}.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(" ", "_"))}`;
      sitelinks[site] = { site, title, badges: [], url };
    }
    entities[id] = {
      type: "item",
      id,
      labels: { en: { language: "en", value: item.label } },
      descriptions: { en: { language: "en", value: item.description } },
      sitelinks,
    };
  }
  return json(200, { entities, success: 1 });
}

function wbsearchentities(url: URL, items: Map<string, FakeItem>, searches: Map<string, string[]>): Response {
  const ids = searches.get(url.searchParams.get("search") ?? "") ?? [];
  const search = ids.map((id) => {
    const { label, description } = items.get(id)!;
    return { id, label, description, match: { type: "label", language: "en", text: label } };
  });
  return json(200, { searchinfo: { search: url.searchParams.get("search") }, search, success: 1 });
}

function wbgetclaims(url: URL, items: Map<string, FakeItem>): Response {
  const item = items.get(url.searchParams.get("entity") ?? "");
  const P31 = [{ mainsnak: { datavalue: { value: { id: item?.disambiguation ? "Q4167410" : "Q35120" } } } }];
  return json(200, { claims: { P31 } });
}

// /api/rest_v1/metrics/pageviews/per-article/{project}/{access}/{agent}/{article}/daily/{start}/{end}
function perArticle(path: string[], articles: Map<string, FakeArticle>): Response {
  const [, , , , , , project, access, agent, title, granularity, start, end] = path;
  if (access !== "all-access" || agent !== "user" || granularity !== "daily") {
    throw new Error(`fake-wikimedia: unexpected filters ${path.join("/")}`);
  }
  const edition = project!.replace(".wikipedia.org", "");
  const article = articles.get(`${edition}:${title}`);
  if (article?.status) return json(article.status, { title: "Error", status: article.status });

  const items = [];
  if (article) {
    for (const day of daysBetween(start!, end!)) {
      const views = (article.days[day] ?? spreadOverMonth(article.series, day)) + (article.extra[day] ?? 0);
      if (views > 0) {
        items.push({
          project: `${edition}.wikipedia`,
          article: title,
          granularity: "daily",
          timestamp: `${day.replaceAll("-", "")}00`,
          access,
          agent,
          views,
        });
      }
    }
  }
  // The real API answers 404 when it has no data for the Article in the range.
  if (items.length === 0) return notFound();
  return json(200, { items });
}

// /api/rest_v1/metrics/pageviews/aggregate/{project}/{access}/{agent}/monthly/{start}/{end}
function aggregate(path: string[], totals: Map<string, FakeTotals>): Response {
  const [, , , , , , project, access, agent, granularity, start, end] = path;
  if (access !== "all-access" || agent !== "user" || granularity !== "monthly") {
    throw new Error(`fake-wikimedia: unexpected filters ${path.join("/")}`);
  }
  const edition = project!.replace(".wikipedia.org", "");
  const editionTotals = totals.get(edition);
  if (!editionTotals) return notFound();
  if (editionTotals.status) return json(editionTotals.status, { title: "Error", status: editionTotals.status });
  const { series } = editionTotals;
  const items = monthsBetween(start!, end!).flatMap((month) => {
    const views = series(month);
    if (views === undefined) return [];
    return [
      {
        project: `${edition}.wikipedia`,
        access,
        agent,
        granularity: "monthly",
        timestamp: `${month.replace("-", "")}0100`,
        views,
      },
    ];
  });
  return json(200, { items });
}

/** Spreads a monthly figure evenly across its days, with any remainder on the first days. */
function spreadOverMonth(series: MonthlySeries, day: string): number {
  const monthly = series(day.slice(0, 7));
  if (monthly === undefined) return 0;
  const [year, month, dayOfMonth] = day.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  const base = Math.floor(monthly / daysInMonth);
  const remainder = monthly - base * daysInMonth;
  return base + (dayOfMonth! <= remainder ? 1 : 0);
}

/** Days as "YYYY-MM-DD" between two API timestamps (YYYYMMDD or YYYYMMDDHH), inclusive. */
function daysBetween(start: string, end: string): string[] {
  const days = [];
  const last = toDate(end);
  for (let date = toDate(start); date <= last; date.setUTCDate(date.getUTCDate() + 1)) {
    days.push(date.toISOString().slice(0, 10));
  }
  return days;
}

/** Months as "YYYY-MM" whose first day falls between two API timestamps, inclusive. */
function monthsBetween(start: string, end: string): string[] {
  return daysBetween(start, end)
    .filter((day) => day.endsWith("-01"))
    .map((day) => day.slice(0, 7));
}

function toDate(timestamp: string): Date {
  return new Date(Date.UTC(+timestamp.slice(0, 4), +timestamp.slice(4, 6) - 1, +timestamp.slice(6, 8)));
}

function notFound(): Response {
  return json(404, {
    detail:
      "The date(s) you used are valid, but we either do not have data for those date(s), or the project you asked for is not loaded yet. Please check documentation for more information",
    method: "get",
    status: 404,
    title: "Not Found",
    type: "about:blank",
  });
}

export function pageviewRequests(requests: URL[]): URL[] {
  return requests.filter((url) => url.hostname === "wikimedia.org");
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
