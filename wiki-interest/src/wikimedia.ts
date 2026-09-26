// Client for Wikidata and the Wikimedia pageviews API.
// Traffic filters are fixed (spec "Data fetching"): human readers only, all access types.

import packageJson from "../package.json" with { type: "json" };
import { daysInMonth, monthRange } from "./months.ts";

export type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const PAGEVIEWS_API = "https://wikimedia.org/api/rest_v1/metrics/pageviews";
const USER_AGENT = `wiki-interest/${packageJson.version} (Agent Skill)`;

export type WikidataItem = {
  id: string;
  label: string | undefined;
  description: string | undefined;
  /** Article title per requested Edition code; absent when the Edition has no linked Article. */
  articles: Record<string, string | undefined>;
};

/** Monthly figures for one Article. Months without a single day of views are absent from the map. */
export type MonthlyViews = Map<string, number>;

export class RequestFailed extends Error {}

/** Looks up a Wikidata item and its linked Articles in the given Editions; undefined if the item doesn't exist. */
export async function fetchItem(fetch: Fetch, id: string, editions: string[]): Promise<WikidataItem | undefined> {
  const url = new URL(WIKIDATA_API);
  url.search = new URLSearchParams({
    action: "wbgetentities",
    format: "json",
    ids: id,
    props: "labels|descriptions|sitelinks",
    languages: "en",
    sitefilter: editions.map(siteId).join("|"),
  }).toString();
  const body = (await getJson(fetch, url)) as WbGetEntities;
  const entity = body.entities?.[id];
  if (!entity || "missing" in entity) return undefined;
  return {
    id,
    label: entity.labels?.en?.value,
    description: entity.descriptions?.en?.value,
    articles: Object.fromEntries(editions.map((edition) => [edition, entity.sitelinks?.[siteId(edition)]?.title])),
  };
}

/** Daily human views of an Article over whole months, summed per month. */
export async function fetchArticleViews(
  fetch: Fetch,
  edition: string,
  title: string,
  start: string,
  end: string,
): Promise<MonthlyViews> {
  const article = encodeURIComponent(title.replaceAll(" ", "_"));
  const url = `${PAGEVIEWS_API}/per-article/${project(edition)}/all-access/user/${article}/daily/${firstDay(start)}/${lastDay(end)}`;
  const body = (await getJson(fetch, url, { notFoundIsEmpty: true })) as PageviewItems;
  // Days the API leaves out count as zero views; a month with no days at all has no data.
  const monthly: MonthlyViews = new Map();
  for (const item of body.items ?? []) {
    const month = monthOfTimestamp(item.timestamp);
    monthly.set(month, (monthly.get(month) ?? 0) + item.views);
  }
  return monthly;
}

/** Monthly human views of a whole Edition, for every month from start to end. */
export async function fetchEditionTotals(
  fetch: Fetch,
  edition: string,
  start: string,
  end: string,
): Promise<Map<string, number>> {
  const url = `${PAGEVIEWS_API}/aggregate/${project(edition)}/all-access/user/monthly/${firstDay(start)}/${lastDay(end)}`;
  const body = (await getJson(fetch, url)) as PageviewItems;
  const totals = new Map<string, number>();
  for (const item of body.items ?? []) {
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

function siteId(edition: string): string {
  return `${edition.replaceAll("-", "_")}wiki`;
}

function project(edition: string): string {
  return `${edition}.wikipedia.org`;
}

function firstDay(month: string): string {
  return `${month.replace("-", "")}01`;
}

function lastDay(month: string): string {
  return `${month.replace("-", "")}${String(daysInMonth(month)).padStart(2, "0")}`;
}

/** "YYYY-MM" of an API timestamp (YYYYMMDDHH). */
function monthOfTimestamp(timestamp: string): string {
  return `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}`;
}

type WbGetEntities = {
  entities?: Record<
    string,
    | { missing: string }
    | {
        labels?: Record<string, { value: string }>;
        descriptions?: Record<string, { value: string }>;
        sitelinks?: Record<string, { title: string }>;
      }
  >;
};

type PageviewItems = { items?: { timestamp: string; views: number }[] };
