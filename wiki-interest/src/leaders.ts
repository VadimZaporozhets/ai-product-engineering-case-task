// The leaders of the ranked table: which row has the most views, the highest Share of edition and the
// highest and lowest Growth. They are comparisons across rows, so the code makes them and the agent copies them.
// Only ranked rows lead, so weak evidence never looks like the winner. The ranked rows are also grouped by Direction,
// so a claim such as "the only stable one" is read from the output rather than worked out.

import type { Metrics } from "./metrics.ts";
import type { RankingCriterion } from "./ranking.ts";
import type { Direction, Verdict } from "./verdict.ts";
import { ENGLISH_LABELS } from "./labels.ts";
import { figureCells, perMillionIsSecondHalf, perMillionOf, type FigureCells } from "./table.ts";

/** The rows that lead one column, with the value the table prints for them. Rows tie when they print the same. */
export type Leader<T> = { label: string; value: string; baskets: T[] };

type Column = {
  label: string;
  figure: (metrics: Metrics) => number;
  cell: keyof FigureCells;
  lowest?: boolean;
};

/** The leader of each column over the ranked rows, or none when fewer than 2 rows are ranked. */
export function leaders<T extends { metrics?: Metrics }>(ranked: T[], ranking: RankingCriterion): Leader<T>[] {
  if (ranked.length < 2) return [];
  // Ranked rows passed Enough data, so every figure is present.
  const columns: Column[] = [
    { label: "most median monthly views", figure: (metrics) => metrics.medianMonthlyViews!, cell: "median" },
    {
      // Named as the table's column: "views per million (2nd half)" when ranked by share.
      label: `highest ${ENGLISH_LABELS.perMillion[perMillionIsSecondHalf(ranking) ? "secondHalf" : "whole"].toLowerCase()}`,
      figure: (metrics) => perMillionOf(metrics, ranking)!,
      cell: "perMillion",
    },
    { label: "highest Growth", figure: (metrics) => metrics.growth!, cell: "growth" },
    { label: "lowest Growth", figure: (metrics) => metrics.growth!, cell: "growth", lowest: true },
  ];
  return columns.map(({ label, figure, cell, lowest }) => {
    const sign = lowest ? -1 : 1;
    const best = ranked.reduce((a, b) => (sign * figure(b.metrics!) > sign * figure(a.metrics!) ? b : a));
    const value = figureCells(best.metrics, ranking)[cell];
    return { label, value, baskets: ranked.filter((basket) => figureCells(basket.metrics, ranking)[cell] === value) };
  });
}

const DIRECTIONS: Direction[] = ["growing", "flat", "declining"];

/** The ranked rows of each Direction, in table order. Ranked rows are judged, so each has a Direction. */
export function byDirection<T extends { verdict?: Verdict }>(ranked: T[]): Record<Direction, T[]> {
  const groups = DIRECTIONS.map((direction) => [
    direction,
    ranked.filter((basket) => basket.verdict?.direction === direction),
  ]);
  return Object.fromEntries(groups) as Record<Direction, T[]>;
}
