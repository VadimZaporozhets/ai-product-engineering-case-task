// The Run's chart: monthly Share of edition, one line per Basket, as a Vega-Lite spec
// rendered to SVG by vega's headless renderer, with no browser and no native modules.

import type { TopLevelSpec } from "vega-lite";
import { monthShare, type Metrics, type MonthRow } from "./metrics.ts";
import type { Verdict } from "./verdict.ts";

/** One line of the chart: a Basket, named by its Topic and Edition. */
export type ChartLine = {
  label: string;
  monthly: MonthRow[];
  /** Months to mark: those holding the Basket's highest-view days, when its Spike Check failed. */
  spikeMonths: string[];
  /** Drawn dashed: a Basket in the Not-enough-evidence group rather than the ranking. */
  dashed: boolean;
};

/** The parts of a Basket the chart reads. */
export type ChartBasket = { topic: string; edition: string; monthly: MonthRow[]; metrics?: Metrics; verdict?: Verdict };

/** The chart's fixed text; a Report draws it in the Report's language. */
export type ChartText = {
  axisTitle: string;
  spikeLegend: string;
  /** Read by screen readers for each Spike mark, e.g. "Spike month of astronomy · pl: Apr 2026". */
  spikeMonth: (line: string, month: string) => string;
  /** Added to the label of a line whose Confidence is too low to rank. */
  lowConfidence: string;
  insufficient: string;
  /** January to December, as screen readers read the x axis. */
  months: TwelveMonths;
  /** January to December, as the x axis abbreviates them. */
  shortMonths: TwelveMonths;
};

type TwelveMonths = [string, string, string, string, string, string, string, string, string, string, string, string];

export const ENGLISH_CHART_TEXT: ChartText = {
  axisTitle: "Views per million Edition views",
  spikeLegend: "month of a top-5 day (Spike Check failed)",
  spikeMonth: (line, month) => `Spike month of ${line}: ${month}`,
  lowConfidence: "(low confidence)",
  insufficient: "(insufficient)",
  months: [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ],
  shortMonths: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
};

/** How the chart is drawn. The Run's chart.svg uses RUN_CHART; the Report sets its own font, size and legend. */
export type ChartStyle = {
  text: ChartText;
  font: string;
  /** The plot's size; axes and legend add to it. */
  width: number;
  height: number;
  legend: { orient: "bottom" | "right"; columns: number; labelLimit: number };
  /** Labels longer than this many characters shorten the Topic's name, so the Edition stays in view. */
  maxLabelLength: number;
};

const RUN_CHART: ChartStyle = {
  text: ENGLISH_CHART_TEXT,
  font: "sans-serif",
  width: 640,
  height: 320,
  legend: { orient: "bottom", columns: 2, labelLimit: 600 },
  maxLabelLength: Infinity,
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

/**
 * The lines of the Baskets chosen to be drawn, in legend order. Baskets that aren't ranked are drawn dashed: weak
 * evidence stays on the chart, but never looks like a ranked line. The labels follow the style the chart is drawn in.
 */
export function chartLines<B extends ChartBasket>(
  charted: B[],
  isRanked: (basket: B) => boolean,
  names: Map<string, string | undefined>,
  style: ChartStyle = RUN_CHART,
): ChartLine[] {
  return charted.map((basket) => ({
    label: chartLabel(basket, charted, names, style.text, style.maxLabelLength),
    monthly: basket.monthly,
    spikeMonths: spikeMonths(basket),
    dashed: !isRanked(basket),
  }));
}

export function hasViews(basket: ChartBasket): boolean {
  return basket.monthly.some((row) => row.hasData);
}

/** The Topic's label and item id, e.g. "astronomy (Q333)", or the Topic as given when it has no label. */
export function topicName(basket: { topic: string }, names: Map<string, string | undefined>): string {
  const label = names.get(basket.topic);
  return label ? `${label} (${basket.topic})` : basket.topic;
}

/**
 * A Topic's name for readers: its label. When another of the Baskets has the same label, told apart only by case or
 * not at all ("Mercury" and "mercury"), the item id is added.
 */
export function topicLabel(
  basket: { topic: string },
  among: { topic: string }[],
  names: Map<string, string | undefined>,
): string {
  const label = (topic: string) => names.get(topic) ?? topic;
  const shared = among.some(
    (other) => other.topic !== basket.topic && label(other.topic).toLowerCase() === label(basket.topic).toLowerCase(),
  );
  return shared ? topicName(basket, names) : label(basket.topic);
}

/**
 * A chart line's name: the Topic's name and the Edition, then the Confidence when it's too low to rank. Over
 * `maxLength` characters, the Topic's name is cut short with an ellipsis.
 */
function chartLabel(
  basket: ChartBasket,
  charted: ChartBasket[],
  names: Map<string, string | undefined>,
  text: ChartText,
  maxLength: number,
): string {
  const confidence = basket.verdict?.confidence;
  const note =
    confidence === "low" ? ` ${text.lowConfidence}` : confidence === "insufficient" ? ` ${text.insufficient}` : "";
  const tail = ` · ${basket.edition}${note}`;
  // Counted in characters as a reader sees them.
  const topic = [...topicLabel(basket, charted, names)];
  const tailLength = [...tail].length;
  if (topic.length + tailLength <= maxLength) return `${topic.join("")}${tail}`;
  const room = Math.max(maxLength - tailLength - 1, 1);
  return `${topic.slice(0, room).join("").trimEnd()}…${tail}`;
}

/** The months holding the Basket's highest-view days, when its Spike Check failed; otherwise none. */
function spikeMonths({ metrics, verdict }: ChartBasket): string[] {
  if (!metrics || !verdict?.failedChecks.some((failed) => failed.check === "spikes")) return [];
  return [...new Set(metrics.topDays.map(({ day }) => day.slice(0, 7)))];
}

/** Categorical colours in fixed order, so the first line always gets the first colour (dataviz reference palette). */
const COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
export const INK = { primary: "#0b0b0b", secondary: "#52514e", muted: "#898781", grid: "#e1e0d9", axis: "#c3c2b7" };
const SURFACE = "#fcfcfb";
const RANKED = "ranked";
const NOT_RANKED = "not enough evidence";

type Layer = Extract<TopLevelSpec, { layer: unknown }>["layer"][number];

/** The chart as an SVG document, its legend in the order the lines are given. */
export async function renderChart(lines: ChartLine[], style: ChartStyle = RUN_CHART): Promise<string> {
  const { text, font, width, height, legend } = style;
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
  const y = { field: "share", type: "quantitative", title: text.axisTitle } as const;
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
      marker: text.spikeLegend,
      description: text.spikeMonth(point.basket, monthName(point.month, text)),
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
          scale: { domain: [RANKED, NOT_RANKED], range: [[], [6, 4]] },
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
        description: { field: "description" },
      },
    });
  }
  const spec: TopLevelSpec = {
    width,
    height,
    background: SURFACE,
    layer: layers,
    config: {
      font,
      // The x axis reads only the month names; the rest is d3's English default.
      locale: {
        time: {
          dateTime: "%x, %X",
          date: "%-m/%-d/%Y",
          time: "%-I:%M:%S %p",
          periods: ["AM", "PM"],
          days: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
          shortDays: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
          months: text.months,
          shortMonths: text.shortMonths,
        },
      },
      view: { stroke: null },
      axis: {
        labelColor: INK.muted,
        titleColor: INK.secondary,
        gridColor: INK.grid,
        domainColor: INK.axis,
        tickColor: INK.axis,
        titleFontWeight: "normal",
      },
      // The y axis's title reads across, above the axis, so a long one never pushes the plot down or aside.
      axisY: { titleAngle: 0, titleAlign: "left", titleBaseline: "bottom", titleX: 0, titleY: -8 },
      legend: { labelColor: INK.primary, ...legend },
    },
  };
  // Loaded here rather than at the top, so commands that draw no chart skip vega's ~150ms load.
  const [{ parse, View }, { compile }] = await Promise.all([import("vega"), import("vega-lite")]);
  const view = new View(parse(compile(spec).spec), { renderer: "none" });
  return view.toSVG();
}

/** "Apr 2026" for "2026-04-01", as the x axis writes it. */
function monthName(day: string, text: ChartText): string {
  return `${text.shortMonths[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
}
