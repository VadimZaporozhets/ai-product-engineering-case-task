// The Verdict of one Basket: a Direction read from Growth, and a Confidence set by the Checks,
// with a plain-language Reason for each failed Check (spec "Metrics and Verdict", ADRs 0003 and 0007).

import { percent, signedPercent } from "./format.ts";
import type { Half, Metrics } from "./metrics.ts";
import { THRESHOLDS } from "./thresholds.ts";
import type { Window } from "./window.ts";

export type Direction = "growing" | "flat" | "declining";
export type Confidence = "high" | "medium" | "low" | "insufficient";
export type CheckName =
  | "enough-data"
  | "volume"
  | "consistency"
  | "spikes"
  | "agreement"
  | "full-history"
  | "seasonality";

export type FailedCheck = { check: CheckName; reason: string };

export type Verdict = {
  /** null when Confidence is insufficient. */
  direction: Direction | null;
  confidence: Confidence;
  failedChecks: FailedCheck[];
};

/** The figures the Checks after Enough data rely on, known to be present once it passes. */
type Judgeable = { growth: number; median: number };

export function judge(metrics: Metrics, window: Window): Verdict {
  const judgeable = enoughData(metrics);
  if ("check" in judgeable) return { direction: null, confidence: "insufficient", failedChecks: [judgeable] };
  const { growth, median } = judgeable;
  const direction = directionOf(growth);
  const failedChecks = [
    volume(median),
    consistency(metrics, direction),
    spikes(metrics),
    agreement(metrics, growth, direction),
    fullHistory(metrics, window),
    seasonality(metrics, window),
  ].filter((failed) => failed !== undefined);
  const confidence = failedChecks.length === 0 ? "high" : failedChecks.length === 1 ? "medium" : "low";
  return { direction, confidence, failedChecks };
}

/** A Missing article fails Enough data: there are no views to judge (ADR 0002). */
export function missingArticleVerdict(edition: string): Verdict {
  return {
    direction: null,
    confidence: "insufficient",
    failedChecks: [
      {
        check: "enough-data",
        reason:
          `Enough data: no ${edition} Wikipedia Article is linked to this Topic's Wikidata item (a Missing article), ` +
          "so there are no views to judge.",
      },
    ],
  };
}

function directionOf(change: number): Direction {
  if (change > THRESHOLDS.flatBand) return "growing";
  if (change < -THRESHOLDS.flatBand) return "declining";
  return "flat";
}

function enoughData(metrics: Metrics): Judgeable | FailedCheck {
  const problems: string[] = [];
  for (const [name, half] of Object.entries(metrics.halves)) {
    if (half.monthsWithData < half.months * THRESHOLDS.minHalfCoverage) {
      problems.push(
        `the ${name} half of the Window (${span(half)}) has data in ${half.monthsWithData} of its ${half.months} months, ` +
          "and at least half are needed",
      );
    }
  }
  const { growth, medianMonthlyViews: median } = metrics;
  if (median === null || median < THRESHOLDS.minMedianViews) {
    problems.push(`median monthly views are ${views(median ?? 0)}, under ${views(THRESHOLDS.minMedianViews)}`);
  }
  if (problems.length === 0) {
    if (growth !== null && median !== null) return { growth, median };
    problems.push("the first half of the Window has no views to compare the second half with");
  }
  return {
    check: "enough-data",
    reason: `Enough data: ${problems.join("; ")}. There is too little to judge a Direction.`,
  };
}

function volume(median: number): FailedCheck | undefined {
  if (median >= THRESHOLDS.lowVolumeViews) return undefined;
  return {
    check: "volume",
    reason:
      `Volume: median monthly views are ${views(median)}, under ${views(THRESHOLDS.lowVolumeViews)}, ` +
      "so a few hundred views either way move Growth a lot.",
  };
}

function consistency(metrics: Metrics, direction: Direction): FailedCheck | undefined {
  const { s, p } = metrics.mannKendall;
  const significant = p < THRESHOLDS.significance;
  const steadily = s > 0 ? "keeps rising" : "keeps falling";
  const mannKendall = `Mann–Kendall ${pValue(p)}`;
  const fail = (reason: string): FailedCheck => ({ check: "consistency", reason: `Consistency: ${reason}` });
  if (direction === "flat") {
    if (!significant) return undefined;
    return fail(
      `the halves say flat, but month by month Share of edition ${steadily} (${mannKendall}), ` +
        "so a slow change may be under way.",
    );
  }
  if (!significant) {
    return fail(
      `the halves say ${direction}, but month by month Share of edition doesn't rise or fall steadily ` +
        `(${mannKendall}, needs under ${THRESHOLDS.significance}), so a few months may drive the Growth.`,
    );
  }
  if ((s > 0) === (direction === "growing")) return undefined;
  return fail(`the halves say ${direction}, but month by month Share of edition ${steadily} (${mannKendall}).`);
}

function spikes(metrics: Metrics): FailedCheck | undefined {
  const share = metrics.topDaysShare;
  if (share === null || share <= THRESHOLDS.maxSpikeShare) return undefined;
  const days = metrics.topDays.map((day) => day.day).sort();
  return {
    check: "spikes",
    reason:
      `Spikes: the ${days.length} highest-view days (${days.join(", ")}) hold ${percent(share)} of the Window's views, ` +
      `over ${percent(THRESHOLDS.maxSpikeShare, 0)}, so a burst of news may drive the Growth rather than lasting Interest.`,
  };
}

function agreement(metrics: Metrics, growth: number, direction: Direction): FailedCheck | undefined {
  if (metrics.rawChange === null || direction === "flat") return undefined;
  const raw = directionOf(metrics.rawChange);
  if (raw === "flat" || raw === direction) return undefined;
  return {
    check: "agreement",
    reason:
      `Agreement: Share of edition says ${direction} (${signedPercent(growth)}) ` +
      `but raw views say ${raw} (${signedPercent(metrics.rawChange)}), because the whole Edition's traffic changed; ` +
      "the answer depends on the measure.",
  };
}

function fullHistory(metrics: Metrics, window: Window): FailedCheck | undefined {
  const late = metrics.firstMonths.filter((first) => first.month === null || first.month > window.start);
  if (late.length === 0) return undefined;
  const articles = late.map((first) =>
    first.month === null ? `${first.article} has no data in the Window` : `${first.article} has data only from ${first.month}`,
  );
  return {
    check: "full-history",
    reason:
      `Full history: ${articles.join("; ")}, after the Window starts in ${window.start}. ` +
      "It was likely created or renamed partway through, so the Basket's early months are missing.",
  };
}

function seasonality(metrics: Metrics, window: Window): FailedCheck | undefined {
  if (window.months % THRESHOLDS.seasonMonths === 0) return undefined;
  const { first, second } = metrics.halves;
  // The nearest multiple, at least one; halfway between two, the shorter, which stays inside the span asked about.
  const multiples = Math.max(1, Math.ceil(window.months / THRESHOLDS.seasonMonths - 0.5));
  const suggested = multiples * THRESHOLDS.seasonMonths;
  return {
    check: "seasonality",
    reason:
      `Seasonality: the ${window.months}-month Window compares ${span(first)} with ${span(second)}, ` +
      "which are different times of year, so a seasonal Topic can look like growth or decline. " +
      `Re-run with --months ${suggested} to compare whole years.`,
  };
}

function span(half: Half): string {
  return `${half.start} to ${half.end}`;
}

function views(count: number): string {
  return Math.round(count).toLocaleString("en-US");
}

function pValue(p: number): string {
  return p < 0.001 ? "p < 0.001" : `p = ${p.toFixed(3)}`;
}
