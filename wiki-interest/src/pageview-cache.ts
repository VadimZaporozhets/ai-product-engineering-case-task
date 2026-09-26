// Permanent on-disk cache of pageviews (spec "Data fetching", ADR 0004): daily views per Article per month, and
// total views per Edition per month. Complete months never change, so entries never expire, and a Run fetches
// only the months it doesn't have. Wikidata and search responses are never cached: they can change.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { addMonths, monthOf, monthRange } from "./months.ts";
import { RequestFailed, type Http } from "./http.ts";
import { fetchArticleViews, fetchEditionTotals, type DailyViews } from "./wikimedia.ts";

/** Bump when the layout or meaning of cached files changes; older versions are then ignored. */
const LAYOUT = "v1";
/**
 * Wikimedia publishes a day's views within about a day, so a month that ended less than this many days ago may
 * still be missing its last days. It's used, but not cached, so a later Run fetches it again. (An Article's month is
 * only fetched once its Edition's total for that month exists, which Wikimedia computes after the month's days.)
 */
const SETTLE_DAYS = 2;

type ArticleFile = { title: string; months: Record<string, Record<string, number>> };
type TotalsFile = { months: Record<string, number> };

export function pageviewCache(http: Http, cacheDir: string, now: Date) {
  const root = join(cacheDir, LAYOUT);
  const settled = <T>(months: Record<string, T>) =>
    Object.fromEntries(Object.entries(months).filter(([month]) => hasSettled(month, now)));

  return {
    /** Daily human views of an Article over the months from start to end. */
    async articleViews(edition: string, title: string, start: string, end: string): Promise<DailyViews> {
      // Hashed, because titles can hold any character and differ only in case on a case-insensitive disk.
      const file = join(root, "articles", edition, `${sha256(`${edition}:${title}`)}.json`);
      const cached = readJson<ArticleFile>(file);
      const months = cached?.title === title ? cached.months : {};
      for (const [from, to] of uncachedSpans(months, start, end)) {
        const daily = await fetchArticleViews(http, edition, title, from, to);
        // Every fetched month gets an entry, also those without views: they are known to have none.
        for (const month of monthRange(from, to)) months[month] = {};
        for (const [day, views] of daily) months[day.slice(0, 7)]![day] = views;
        if (hasSettled(from, now)) writeJson(file, { title, months: settled(months) } satisfies ArticleFile);
      }
      const views: DailyViews = new Map();
      for (const month of monthRange(start, end)) {
        for (const [day, count] of Object.entries(months[month]!)) views.set(day, count);
      }
      return views;
    },

    /**
     * Monthly human views of a whole Edition from start to end; undefined when Wikimedia has none at all for it,
     * which means the Edition code is unknown.
     */
    async editionTotals(edition: string, start: string, end: string): Promise<Map<string, number> | undefined> {
      const file = join(root, "totals", `${edition}.json`);
      const months = readJson<TotalsFile>(file)?.months ?? {};
      for (const [from, to] of uncachedSpans(months, start, end)) {
        const totals = await fetchEditionTotals(http, edition, from, to);
        if (totals === undefined && Object.keys(months).length === 0) return undefined;
        for (const [month, views] of totals ?? []) months[month] = views;
        if (hasSettled(from, now)) writeJson(file, { months: settled(months) } satisfies TotalsFile);
      }
      // A month without a total fails the Edition: its Articles' views would be measured against nothing, and
      // fetching them anyway could cache a month Wikimedia hasn't finished publishing.
      const missing = monthRange(start, end).filter((month) => !(month in months));
      if (missing.length > 0) {
        throw new RequestFailed(`Wikimedia has no total views for ${edition} Wikipedia in ${missing.join(", ")}`);
      }
      return new Map(monthRange(start, end).map((month) => [month, months[month]!]));
    },
  };
}

/**
 * Whether a month ended at least SETTLE_DAYS ago. Spans run oldest month first, so a span whose first month hasn't
 * settled has nothing new to write.
 */
function hasSettled(month: string, now: Date): boolean {
  return month < monthOf(new Date(now.getTime() - SETTLE_DAYS * 24 * 60 * 60 * 1000));
}

/** The months from start to end that aren't cached, as spans of consecutive months [from, to]. */
function uncachedSpans(cached: Record<string, unknown>, start: string, end: string): [string, string][] {
  const spans: [string, string][] = [];
  for (const month of monthRange(start, end)) {
    if (month in cached) continue;
    const last = spans.at(-1);
    if (last && addMonths(last[1], 1) === month) last[1] = month;
    else spans.push([month, month]);
  }
  return spans;
}

/** A cached file, or undefined when there is none or it can't be read; it's then fetched again. */
function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/**
 * Writes through a temporary file, so a Run running at the same time never reads half a file. The cache only saves
 * requests: when it can't be written (no permission, disk full), the Run goes on and a later Run fetches again.
 */
function writeJson(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temporary, JSON.stringify(value));
    renameSync(temporary, file);
  } catch {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Nothing was written, e.g. because the cache directory itself couldn't be created.
    }
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
