// The Run's chart (spec "Chart", ADR 0006): monthly Share of edition, one line per Basket, as a Vega-Lite spec
// rendered to SVG by vega's headless renderer, with no browser and no native modules.

import type { TopLevelSpec } from "vega-lite";
import { monthShare, type MonthRow } from "./metrics.ts";

/** One line of the chart: a Basket, named by its Topic and Edition. */
export type ChartLine = {
  label: string;
  monthly: MonthRow[];
  /** Months to mark: those holding the Basket's highest-view days, when its Spike Check failed. */
  spikeMonths: string[];
  /** Drawn dashed: a Basket in the Not-enough-evidence group rather than the ranking. */
  dashed: boolean;
};

/** More lines than this can't be told apart, and the palette has this many colours. */
export const MAX_CHART_LINES = 8;

/**
 * The lines to draw, in the order given: every highlighted one, and the first of the others while there's room.
 * The caller highlights at most MAX_CHART_LINES.
 */
export function chooseLines<T>(lines: T[], isHighlighted: (line: T) => boolean): T[] {
  let room = MAX_CHART_LINES - lines.filter(isHighlighted).length;
  return lines.filter((line) => isHighlighted(line) || room-- > 0);
}

/** Categorical colours in fixed order, so the first line always gets the first colour (dataviz reference palette). */
const COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
const INK = { primary: "#0b0b0b", secondary: "#52514e", muted: "#898781", grid: "#e1e0d9", axis: "#c3c2b7" };
const SURFACE = "#fcfcfb";
const SPIKE_LEGEND = "month of a top-5 day (Spike Check failed)";
const RANKED = "ranked";
const NOT_RANKED = "not enough evidence";

type Layer = Extract<TopLevelSpec, { layer: unknown }>["layer"][number];

/** The chart as an SVG document, its legend in the order the lines are given. */
export async function renderChart(lines: ChartLine[]): Promise<string> {
  const labels = lines.map((line) => line.label);
  // Months before any Article of the Basket has data are left out, so the line starts where the data does.
  const points = lines.flatMap(({ label, monthly, spikeMonths, dashed }) =>
    monthly.filter((row) => row.hasData).map((row) => ({
      basket: label,
      evidence: dashed ? NOT_RANKED : RANKED,
      month: `${row.month}-01`,
      share: monthShare(row),
      spike: spikeMonths.includes(row.month),
    })),
  );
  const x = { field: "month", type: "temporal", timeUnit: "utcyearmonth", title: null, axis: { format: "%b %Y" } } as const;
  const y = { field: "share", type: "quantitative", title: "Views per million Edition views" } as const;
  const color = {
    field: "basket",
    type: "nominal",
    title: null,
    sort: labels,
    scale: { domain: labels, range: COLORS.slice(0, labels.length) },
  } as const;
  const spikes = points
    .filter((point) => point.spike)
    .map((point) => ({
      ...point,
      marker: SPIKE_LEGEND,
      description: `Spike month of ${point.basket}: ${monthName(point.month)}`,
    }));
  const layers: Layer[] = [
    {
      data: { values: points },
      mark: { type: "line", strokeWidth: 2, strokeJoin: "round", strokeCap: "round" },
      encoding: {
        x,
        y,
        color,
        // The legend labels say which lines are weak evidence, so the dashes need no legend of their own.
        strokeDash: {
          field: "evidence",
          type: "nominal",
          legend: null,
          scale: { domain: [RANKED, NOT_RANKED], range: [[1, 0], [6, 4]] },
        },
      },
    },
  ];
  // Without Spike marks there is no layer, so no empty shape legend either.
  if (spikes.length > 0) {
    layers.push({
      data: { values: spikes },
      mark: { type: "point", filled: true, size: 110, stroke: SURFACE, strokeWidth: 2, opacity: 1 },
      encoding: {
        x,
        y,
        color,
        shape: { field: "marker", type: "nominal", title: null, scale: { range: ["triangle-up"] } },
        // Read by screen readers, e.g. "Spike month of astronomy · pl: Apr 2026".
        description: { field: "description" },
      },
    });
  }
  const spec: TopLevelSpec = {
    width: 640,
    height: 320,
    background: SURFACE,
    layer: layers,
    config: {
      font: "sans-serif",
      view: { stroke: null },
      axis: {
        labelColor: INK.muted,
        titleColor: INK.secondary,
        gridColor: INK.grid,
        domainColor: INK.axis,
        tickColor: INK.axis,
        titleFontWeight: "normal",
      },
      legend: { labelColor: INK.primary, labelLimit: 600, orient: "bottom", columns: 2 },
    },
  };
  // Loaded here rather than at the top, so commands that draw no chart skip vega's ~150ms load.
  const [{ parse, View }, { compile }] = await Promise.all([import("vega"), import("vega-lite")]);
  const view = new View(parse(compile(spec).spec), { renderer: "none" });
  return view.toSVG();
}

/** "Apr 2026" for "2026-04-01", as the x axis writes it. */
function monthName(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}
