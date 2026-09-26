// Metrics of one Basket over the Window (spec "Metrics and Verdict", ADR 0001).

import { mannKendall, type MannKendall } from "./mann-kendall.ts";
import { THRESHOLDS } from "./thresholds.ts";
import type { DailyViews } from "./wikimedia.ts";

export type ArticleViews = { title: string; daily: DailyViews };

export type TopDay = { day: string; views: number };

export type MonthRow = {
  month: string;
  /** Summed views of the Basket's Articles; 0 when no Article has data. */
  views: number;
  editionViews: number;
  /** At least one Article of the Basket has pageview data this month. */
  hasData: boolean;
};

export type Metrics = {
  monthsWithData: number;
  /** Median over months with data; null when there are none. */
  medianMonthlyViews: number | null;
  /** Share of edition over the months with data, in views per million Edition views. */
  viewsPerMillion: number | null;
  /** Second half against first half of the Window, on Share of edition; 0.25 means +25%. */
  growth: number | null;
  /** The same comparison on average monthly raw views. */
  rawChange: number | null;
  halves: { first: Half; second: Half };
  /** Mann–Kendall test on the monthly Share of edition over months with data. */
  mannKendall: MannKendall;
  /** The Basket's highest-view days, most views first. */
  topDays: TopDay[];
  /** The top days' share of all the Basket's views in the Window; null when it has none. */
  topDaysShare: number | null;
  /** Each Article's first month with data; null when it has none in the Window. */
  firstMonths: { article: string; month: string | null }[];
};

export type Half = {
  start: string;
  end: string;
  months: number;
  monthsWithData: number;
  /** Share of edition over the half's months with data, in views per million; null when it has none. */
  viewsPerMillion: number | null;
};

/** A Basket's monthly rows over the Window's months and its Metrics, from its Articles' daily views and its Edition's totals. */
export function measureBasket(
  months: string[],
  articles: ArticleViews[],
  editionTotals: Map<string, number>,
): { monthly: MonthRow[]; metrics: Metrics } {
  const perArticle = articles.map((article) => {
    const monthly = monthlyViews(article.daily);
    const first = [...monthly.keys()].sort()[0] ?? null;
    return { title: article.title, monthly, first };
  });
  const firstMonths = perArticle.map(({ title, first }) => ({ article: title, month: first }));
  // An Article has data from its first month with views on; later months without views count as zero.
  const rows = months.map((month) => ({
    month,
    views: perArticle.reduce((total, article) => total + (article.monthly.get(month) ?? 0), 0),
    editionViews: editionTotals.get(month)!,
    hasData: perArticle.some((article) => article.first !== null && article.first <= month),
  }));
  return { monthly: rows, metrics: computeMetrics(rows, articles, firstMonths) };
}

function computeMetrics(rows: MonthRow[], articles: ArticleViews[], firstMonths: Metrics["firstMonths"]): Metrics {
  const withData = rows.filter((row) => row.hasData);
  // For an odd number of months, the middle month belongs to neither half.
  const halfLength = Math.floor(rows.length / 2);
  const firstHalf = rows.slice(0, halfLength);
  const secondHalf = rows.slice(rows.length - halfLength);
  const first = firstHalf.filter((row) => row.hasData);
  const second = secondHalf.filter((row) => row.hasData);
  const topDays = highestDays(articles, THRESHOLDS.spikeDays);
  const windowViews = sum(rows.map((row) => row.views));
  const halves = { first: half(firstHalf, first), second: half(secondHalf, second) };

  return {
    monthsWithData: withData.length,
    medianMonthlyViews: withData.length > 0 ? median(withData.map((row) => row.views)) : null,
    viewsPerMillion: shareOfEdition(withData),
    growth: change(halves.first.viewsPerMillion, halves.second.viewsPerMillion),
    rawChange: change(averageViews(first), averageViews(second)),
    halves,
    mannKendall: mannKendall(withData.map((row) => monthShare(row) ?? 0)),
    topDays,
    topDaysShare: windowViews > 0 ? sum(topDays.map((day) => day.views)) / windowViews : null,
    firstMonths,
  };
}

function monthlyViews(daily: DailyViews): Map<string, number> {
  const monthly = new Map<string, number>();
  for (const [day, views] of daily) {
    const month = day.slice(0, 7);
    monthly.set(month, (monthly.get(month) ?? 0) + views);
  }
  return monthly;
}

/** The Basket's `count` highest-view days, its Articles' views summed per day; the earlier day wins a tie. */
function highestDays(articles: ArticleViews[], count: number): TopDay[] {
  const byDay = new Map<string, number>();
  for (const article of articles) {
    for (const [day, views] of article.daily) byDay.set(day, (byDay.get(day) ?? 0) + views);
  }
  return [...byDay]
    .map(([day, views]) => ({ day, views }))
    .sort((a, b) => b.views - a.views || a.day.localeCompare(b.day))
    .slice(0, count);
}

/** Share of edition of one month, in views per million; null when the Edition has no views that month. */
export function monthShare(row: MonthRow): number | null {
  return shareOfEdition([row]);
}

/** Share of edition as a ratio of sums over the given months, in views per million. */
function shareOfEdition(rows: MonthRow[]): number | null {
  const editionViews = sum(rows.map((row) => row.editionViews));
  if (rows.length === 0 || editionViews === 0) return null;
  return (sum(rows.map((row) => row.views)) / editionViews) * 1_000_000;
}

function averageViews(rows: MonthRow[]): number | null {
  return rows.length > 0 ? sum(rows.map((row) => row.views)) / rows.length : null;
}

function change(before: number | null, after: number | null): number | null {
  if (before === null || after === null || before === 0) return null;
  return after / before - 1;
}

function half(months: MonthRow[], withData: MonthRow[]): Half {
  return {
    start: months[0]!.month,
    end: months.at(-1)!.month,
    months: months.length,
    monthsWithData: withData.length,
    viewsPerMillion: shareOfEdition(withData),
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
