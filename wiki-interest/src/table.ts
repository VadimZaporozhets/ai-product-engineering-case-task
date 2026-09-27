// The Verdict table, shared by analyze's printed table and the Report's, so both show the same columns and numbers.

import { signedPercent } from "./format.ts";
import type { Labels } from "./labels.ts";
import type { Metrics } from "./metrics.ts";
import type { RankingCriterion } from "./ranking.ts";
import type { Verdict } from "./verdict.ts";

/** A Basket's figures as the table prints them. */
export type FigureCells = Record<"growth" | "rawChange" | "median" | "perMillion", string>;

/** The parts of a Basket the table reads. */
type TableBasket = { edition: string; metrics?: Metrics; verdict?: Verdict; error?: string };

/** The table's column headings, in the labels' language. */
export function tableColumns(labels: Labels, ranking: RankingCriterion): string[] {
  return [
    ...Object.values(labels.columns),
    labels.perMillion[perMillionIsSecondHalf(ranking) ? "secondHalf" : "whole"],
  ];
}

/**
 * A Basket's row, its Topic named by the caller. A failed Basket's row stops at its error's reason, which spans the
 * columns left; the Run keeps the reason in English, as analyze printed it.
 */
export function tableRow(basket: TableBasket, topic: string, labels: Labels, ranking: RankingCriterion): string[] {
  const { verdict } = basket;
  if (basket.error || !verdict) return [topic, basket.edition, `${labels.error}: ${basket.error}`];
  return [
    topic,
    basket.edition,
    labels.direction[verdict.direction ?? "none"],
    labels.confidence[verdict.confidence],
    ...tableFigures(basket.metrics, ranking),
  ];
}

/** The figures in the table's column order. */
function tableFigures(metrics: Metrics | undefined, ranking: RankingCriterion): string[] {
  const { growth, rawChange, median, perMillion } = figureCells(metrics, ranking);
  return [growth, rawChange, median, perMillion];
}

/**
 * Growth, Raw change, median monthly views and views per million, as the table writes them. A Basket judged without
 * views (a Missing article) has no metrics: every figure is n/a.
 */
export function figureCells(metrics: Metrics | undefined, ranking: RankingCriterion): FigureCells {
  const median = metrics?.medianMonthlyViews ?? null;
  const perMillion = metrics ? perMillionOf(metrics, ranking) : null;
  return {
    growth: percent(metrics?.growth ?? null),
    rawChange: percent(metrics?.rawChange ?? null),
    median: median === null ? "n/a" : String(Math.round(median)),
    perMillion: perMillion === null ? "n/a" : perMillion.toFixed(2),
  };
}

/**
 * Whether the views per million column is the second half's. Ranked by share, it shows the second half's figure the
 * ranking sorts by, so the column reads in rank order; otherwise the whole Window's.
 */
export function perMillionIsSecondHalf(ranking: RankingCriterion): boolean {
  return ranking === "share";
}

export function perMillionOf(metrics: Metrics, ranking: RankingCriterion): number | null {
  return perMillionIsSecondHalf(ranking) ? metrics.halves.second.viewsPerMillion : metrics.viewsPerMillion;
}

function percent(value: number | null): string {
  return value === null ? "n/a" : signedPercent(value);
}
