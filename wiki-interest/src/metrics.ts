// Metrics of one Basket over the Window (spec "Metrics and Verdict", ADR 0001).

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
};

type Half = { start: string; end: string; monthsWithData: number };

/**
 * A Basket's rows over the Window's months, from its Articles' monthly views and its Edition's totals.
 * An Article has data from its first month with views on; later months without views count as zero.
 */
export function basketMonths(
  months: string[],
  articleViews: Map<string, number>[],
  editionTotals: Map<string, number>,
): MonthRow[] {
  const firstMonths = articleViews.flatMap((views) => (views.size > 0 ? [[...views.keys()].sort()[0]!] : []));
  return months.map((month) => ({
    month,
    views: articleViews.reduce((total, views) => total + (views.get(month) ?? 0), 0),
    editionViews: editionTotals.get(month)!,
    hasData: firstMonths.some((first) => first <= month),
  }));
}

export function computeMetrics(rows: MonthRow[]): Metrics {
  const withData = rows.filter((row) => row.hasData);
  // For an odd number of months, the middle month belongs to neither half.
  const halfLength = Math.floor(rows.length / 2);
  const firstHalf = rows.slice(0, halfLength);
  const secondHalf = rows.slice(rows.length - halfLength);
  const first = firstHalf.filter((row) => row.hasData);
  const second = secondHalf.filter((row) => row.hasData);

  return {
    monthsWithData: withData.length,
    medianMonthlyViews: withData.length > 0 ? median(withData.map((row) => row.views)) : null,
    viewsPerMillion: shareOfEdition(withData),
    growth: change(shareOfEdition(first), shareOfEdition(second)),
    rawChange: change(averageViews(first), averageViews(second)),
    halves: { first: half(firstHalf, first), second: half(secondHalf, second) },
  };
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
  return { start: months[0]!.month, end: months.at(-1)!.month, monthsWithData: withData.length };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
