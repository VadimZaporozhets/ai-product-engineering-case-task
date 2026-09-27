// Ranking of a Run's Baskets: only Baskets with high or medium Confidence are ranked, so weak
// evidence never looks like the winner. Everything else goes to the Not-enough-evidence group.

import type { Metrics } from "./metrics.ts";
import type { Confidence, Verdict } from "./verdict.ts";

/**
 * Each criterion's figure, highest first, and how the output names it. High and medium Confidence pass Enough data,
 * so every figure a criterion reads is present.
 */
const CRITERIA = {
  growth: { figure: "Growth", value: (metrics: Metrics) => metrics.growth! },
  interest: { figure: "median monthly views", value: (metrics: Metrics) => metrics.medianMonthlyViews! },
  share: {
    figure: "Share of edition over the second half of the Window",
    value: (metrics: Metrics) => metrics.halves.second.viewsPerMillion!,
  },
};

export type RankingCriterion = keyof typeof CRITERIA;
export const RANKING_CRITERIA = Object.keys(CRITERIA) as RankingCriterion[];
export const DEFAULT_RANKING: RankingCriterion = "growth";

type Rankable = { metrics?: Metrics; verdict?: Verdict; error?: string };
type Group = Confidence | "error";

/** Order of the Not-enough-evidence group: the closest to being ranked first, failed Baskets last. */
// High and medium never reach this sort; they are listed so every Group has an entry.
const NOT_RANKED_ORDER: Record<Group, number> = { high: 0, medium: 0, low: 1, insufficient: 2, error: 3 };

export function isRankingCriterion(text: string): text is RankingCriterion {
  return Object.hasOwn(CRITERIA, text);
}

/** The heading of the ranked table: the criterion and the figure it ranks by. */
export function rankingHeading(by: RankingCriterion): string {
  return `ranked by ${by} (${CRITERIA[by].figure}, highest first)`;
}

/**
 * Ranked Baskets, highest figure of the criterion first, and the Not-enough-evidence group. Sorting is stable, so
 * ties and Baskets of the same group keep the order they were given in.
 */
export function rank<T extends Rankable>(baskets: T[], by: RankingCriterion): { ranked: T[]; notEnoughEvidence: T[] } {
  const { value } = CRITERIA[by];
  const ranked = baskets.filter(isRanked).sort((a, b) => value(b.metrics!) - value(a.metrics!));
  const notEnoughEvidence = baskets
    .filter((basket) => !isRanked(basket))
    .sort((a, b) => NOT_RANKED_ORDER[groupOf(a)] - NOT_RANKED_ORDER[groupOf(b)]);
  return { ranked, notEnoughEvidence };
}

function isRanked(basket: Rankable): boolean {
  const group = groupOf(basket);
  return group === "high" || group === "medium";
}

function groupOf(basket: Rankable): Group {
  return basket.error || !basket.verdict ? "error" : basket.verdict.confidence;
}
