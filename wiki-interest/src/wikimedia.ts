// Client for Wikidata and the Wikimedia pageviews API.
// Traffic filters are fixed (spec "Data fetching"): human readers only, all access types.

import packageJson from "../package.json" with { type: "json" };
import { daysInMonth, monthRange } from "./months.ts";

export type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const PAGEVIEWS_API = "https://wikimedia.org/api/rest_v1/metrics/pageviews";
const USER_AGENT = `wiki-interest/${packageJson.version} (Agent Skill)`;

/** The most results Wikidata's search gives in one request. */
const MAX_SEARCH_RESULTS = 50;
/** Instance of (P31) this item means a Wikimedia disambiguation page. */
const DISAMBIGUATION_PAGE = "Q4167410";
/** Hosts under wikipedia.org that aren't a language Edition. */
const NOT_AN_EDITION = new Set(["abstract.wikipedia.org"]);

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

export class RequestFailed extends Error {}

/** Wikidata items whose label or alias matches a name, best match first. */
export async function searchItems(fetch: Fetch, name: string, language: string): Promise<SearchHit[]> {
  const body = (await getJson(
    fetch,
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
export async function fetchItems(fetch: Fetch, ids: string[], languages: string[]): Promise<Map<string, WikidataItem>> {
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
  const body = (await getJson(fetch, url)) as WbGetEntities;
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

export async function isDisambiguationPage(fetch: Fetch, id: string): Promise<boolean> {
  const body = (await getJson(fetch, wikidataUrl({ action: "wbgetclaims", entity: id, property: "P31" }))) as WbGetClaims;
  return (body.claims?.P31 ?? []).some((claim) => claim.mainsnak?.datavalue?.value?.id === DISAMBIGUATION_PAGE);
}

/** Titles of the top Articles a Wikipedia Edition's own search finds for a term. */
export async function searchArticles(fetch: Fetch, edition: string, term: string, limit: number): Promise<string[]> {
  const url = apiUrl(`https://${project(edition)}/w/api.php`, {
    action: "query",
    list: "search",
    srsearch: term,
    srnamespace: "0",
    srlimit: String(limit),
    srprop: "",
  });
  const body = (await getJson(fetch, url)) as SearchResults;
  return (body.query?.search ?? []).map((result) => result.title);
}

/** Daily human views of an Article over whole months. */
export async function fetchArticleViews(
  fetch: Fetch,
  edition: string,
  title: string,
  start: string,
  end: string,
): Promise<DailyViews> {
  const article = encodeURIComponent(title.replaceAll(" ", "_"));
  const url = `${PAGEVIEWS_API}/per-article/${project(edition)}/all-access/user/${article}/daily/${firstDay(start)}/${lastDay(end)}`;
  const body = (await getJson(fetch, url, { notFoundIsEmpty: true })) as PageviewItems;
  const daily: DailyViews = new Map();
  for (const item of body.items ?? []) daily.set(dayOfTimestamp(item.timestamp), item.views);
  return daily;
}

/**
 * Monthly human views of a whole Edition, for every month from start to end; undefined when Wikimedia has no
 * totals at all for it, which means the Edition code is unknown.
 */
export async function fetchEditionTotals(
  fetch: Fetch,
  edition: string,
  start: string,
  end: string,
): Promise<Map<string, number> | undefined> {
  const url = `${PAGEVIEWS_API}/aggregate/${project(edition)}/all-access/user/monthly/${firstDay(start)}/${lastDay(end)}`;
  const body = (await getJson(fetch, url, { notFoundIsEmpty: true })) as PageviewItems;
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

async function getJson(fetch: Fetch, url: string | URL, options: { notFoundIsEmpty?: boolean } = {}) {
  let response: Response;
  try {
    response = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" } });
  } catch (error) {
    throw new RequestFailed(`request to ${new URL(url).hostname} failed: ${(error as Error).message}`);
  }
  if (response.status === 404 && options.notFoundIsEmpty) return {};
  if (!response.ok) throw new RequestFailed(`${new URL(url).hostname} answered HTTP ${response.status}`);
  try {
    return await response.json();
  } catch (error) {
    throw new RequestFailed(`${new URL(url).hostname} sent an unreadable answer: ${(error as Error).message}`);
  }
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

type SearchResults = { query?: { search?: { title: string }[] } };

type PageviewItems = { items?: { timestamp: string; views: number }[] };
