// Client for Wikidata and the Wikimedia pageviews API.
// Traffic filters are fixed: human readers only, all access types.

import { RequestFailed, type Http } from "./http.ts";
import { daysInMonth, monthRange } from "./months.ts";

const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const PAGEVIEWS_API = "https://wikimedia.org/api/rest_v1/metrics/pageviews";

/** The most results Wikidata's search gives in one request. */
const MAX_SEARCH_RESULTS = 50;
/** Instance of (P31) this item means a Wikimedia disambiguation page. */
const DISAMBIGUATION_PAGE = "Q4167410";
/** Hosts under wikipedia.org that aren't a language Edition. */
const NOT_AN_EDITION = new Set(["abstract.wikipedia.org"]);
/** MediaWiki's namespace of Articles, as opposed to talk, user or category pages. */
const ARTICLE_NAMESPACE = 0;

export type WikidataItem = {
  id: string;
  /** By language code, in the languages asked for. */
  labels: Record<string, string>;
  descriptions: Record<string, string>;
  /** Linked Article title per Edition code, for every Wikipedia Edition (no other Wikimedia projects). */
  articles: Record<string, string>;
};

export type SearchHit = {
  id: string;
  /** The hit's label, and the label or alias the search matched, in the search language or a fallback. */
  texts: string[];
};

/** Daily figures for one Article, by "YYYY-MM-DD". Days the API leaves out are absent from the map. */
export type DailyViews = Map<string, number>;

/** Wikidata items whose label or alias matches a name, best match first. */
export async function searchItems(http: Http, name: string, language: string): Promise<SearchHit[]> {
  const body = (await http.getJson(
    wikidataUrl({ action: "wbsearchentities", search: name, language, type: "item", limit: String(MAX_SEARCH_RESULTS) }),
  )) as WbSearchEntities;
  return (body.search ?? []).map((hit) => ({
    id: hit.id,
    texts: [hit.label, hit.match?.text, ...(hit.aliases ?? [])].filter((text) => text !== undefined),
  }));
}

/**
 * Looks up Wikidata items in one request (at most 50, the API's limit), with labels and descriptions in the given
 * languages. Items that don't exist are absent from the result.
 */
export async function fetchItems(http: Http, ids: string[], languages: string[]): Promise<Map<string, WikidataItem>> {
  const items = new Map<string, WikidataItem>();
  if (ids.length === 0) return items;
  // Wikidata drops language codes it doesn't know (e.g. the Edition code "simple"), so Edition codes can be passed
  // as they are.
  const url = wikidataUrl({
    action: "wbgetentities",
    ids: ids.join("|"),
    props: "labels|descriptions|sitelinks/urls",
    languages: languages.join("|"),
  });
  const body = (await http.getJson(url)) as WbGetEntities;
  for (const id of ids) {
    const entity = body.entities?.[id];
    if (!entity || "missing" in entity) continue;
    const articles: Record<string, string> = {};
    for (const sitelink of Object.values(entity.sitelinks ?? {})) {
      const host = new URL(sitelink.url).hostname;
      if (host.endsWith(".wikipedia.org") && !NOT_AN_EDITION.has(host)) {
        articles[host.replace(".wikipedia.org", "")] = sitelink.title;
      }
    }
    items.set(id, { id, labels: values(entity.labels), descriptions: values(entity.descriptions), articles });
  }
  return items;
}

export async function isDisambiguationPage(http: Http, id: string): Promise<boolean> {
  const body = (await http.getJson(wikidataUrl({ action: "wbgetclaims", entity: id, property: "P31" }))) as WbGetClaims;
  return (body.claims?.P31 ?? []).some((claim) => claim.mainsnak?.datavalue?.value?.id === DISAMBIGUATION_PAGE);
}

/** Titles of the top Articles a Wikipedia Edition's own search finds for a term. */
export async function searchArticles(http: Http, edition: string, term: string, limit: number): Promise<string[]> {
  const url = apiUrl(`https://${project(edition)}/w/api.php`, {
    action: "query",
    list: "search",
    srsearch: term,
    srnamespace: "0",
    srlimit: String(limit),
    srprop: "",
  });
  const body = (await http.getJson(url)) as SearchResults;
  return (body.query?.search ?? []).map((result) => result.title);
}

export type ArticleLookup =
  /** The Article exists, under this title as the Edition writes it (e.g. with a capital first letter). */
  | { kind: "article"; title: string }
  | { kind: "missing" }
  /** The title only redirects to another Article, whose views it doesn't count. */
  | { kind: "redirect"; target: string }
  | { kind: "invalid"; reason: string };

/** Whether a title is an Article in an Edition. */
export async function lookupArticle(http: Http, edition: string, title: string): Promise<ArticleLookup> {
  const url = apiUrl(`https://${project(edition)}/w/api.php`, {
    action: "query",
    titles: title,
    redirects: "1",
    formatversion: "2",
  });
  const body = (await http.getJson(url)) as PageInfo;
  const page = body.query?.pages?.[0];
  if (!page) throw new RequestFailed(`${project(edition)} sent no page for "${title}"`);
  if (page.invalid) return { kind: "invalid", reason: page.invalidreason ?? "not a valid title" };
  if (page.missing) return { kind: "missing" };
  if (page.ns !== ARTICLE_NAMESPACE) return { kind: "invalid", reason: "it is a page of another namespace" };
  if (body.query?.redirects?.length) return { kind: "redirect", target: page.title };
  return { kind: "article", title: page.title };
}

/** Daily human views of an Article over whole months. */
export async function fetchArticleViews(
  http: Http,
  edition: string,
  title: string,
  start: string,
  end: string,
): Promise<DailyViews> {
  const article = encodeURIComponent(title.replaceAll(" ", "_"));
  const url = `${PAGEVIEWS_API}/per-article/${project(edition)}/all-access/user/${article}/daily/${firstDay(start)}/${lastDay(end)}`;
  const body = (await http.getJson(url, { notFoundIsEmpty: true })) as PageviewItems;
  const daily: DailyViews = new Map();
  for (const item of body.items ?? []) daily.set(dayOfTimestamp(item.timestamp), item.views);
  return daily;
}

/**
 * Monthly human views of a whole Edition, for every month from start to end; undefined when Wikimedia has no
 * totals at all for it, which means the Edition code is unknown.
 */
export async function fetchEditionTotals(
  http: Http,
  edition: string,
  start: string,
  end: string,
): Promise<Map<string, number> | undefined> {
  const url = `${PAGEVIEWS_API}/aggregate/${project(edition)}/all-access/user/monthly/${firstDay(start)}/${lastDay(end)}`;
  const body = (await http.getJson(url, { notFoundIsEmpty: true })) as PageviewItems;
  if (!body.items?.length) return undefined;
  const totals = new Map<string, number>();
  for (const item of body.items) {
    totals.set(monthOfTimestamp(item.timestamp), item.views);
  }
  const missing = monthRange(start, end).filter((month) => !totals.has(month));
  if (missing.length > 0) {
    throw new RequestFailed(`Wikimedia has no total views for ${edition} Wikipedia in ${missing.join(", ")}`);
  }
  return totals;
}

function wikidataUrl(parameters: Record<string, string>): URL {
  return apiUrl(WIKIDATA_API, parameters);
}

/** A MediaWiki action API request, answered as JSON. */
function apiUrl(endpoint: string, parameters: Record<string, string>): URL {
  const url = new URL(endpoint);
  url.search = new URLSearchParams({ ...parameters, format: "json" }).toString();
  return url;
}

function values(byLanguage: Record<string, { value: string }> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(byLanguage ?? {}).map(([language, { value }]) => [language, value]));
}

/** The hostname of an Edition, e.g. uk.wikipedia.org. */
export function project(edition: string): string {
  return `${edition}.wikipedia.org`;
}

function firstDay(month: string): string {
  return `${month.replace("-", "")}01`;
}

function lastDay(month: string): string {
  return `${month.replace("-", "")}${String(daysInMonth(month)).padStart(2, "0")}`;
}

/** "YYYY-MM-DD" of an API timestamp (YYYYMMDDHH). */
function dayOfTimestamp(timestamp: string): string {
  return `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`;
}

/** "YYYY-MM" of an API timestamp (YYYYMMDDHH). */
function monthOfTimestamp(timestamp: string): string {
  return dayOfTimestamp(timestamp).slice(0, 7);
}

type WbGetEntities = {
  entities?: Record<
    string,
    | { missing: string }
    | {
        labels?: Record<string, { value: string }>;
        descriptions?: Record<string, { value: string }>;
        sitelinks?: Record<string, { title: string; url: string }>;
      }
  >;
};

type WbSearchEntities = {
  search?: { id: string; label?: string; aliases?: string[]; match?: { text: string } }[];
};

type WbGetClaims = {
  claims?: Record<string, { mainsnak?: { datavalue?: { value?: { id?: string } } } }[]>;
};

type PageInfo = {
  query?: {
    redirects?: { from: string; to: string }[];
    pages?: { title: string; ns?: number; missing?: boolean; invalid?: boolean; invalidreason?: string }[];
  };
};

type SearchResults = { query?: { search?: { title: string }[] } };

type PageviewItems = { items?: { timestamp: string; views: number }[] };
