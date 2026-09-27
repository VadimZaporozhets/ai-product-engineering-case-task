// The Report's content: everything but the Narrative comes from the Run file, so nothing
// in a shared document is made up.

import { chartLines, renderChart, topicLabel, topicName, type ChartStyle } from "./chart.ts";
import type { Basket, BasketKey, RunRecord } from "./cli.ts";
import type { Labels } from "./labels.ts";
import { splitHalves } from "./metrics.ts";
import { monthRange } from "./months.ts";
import type { Narrative } from "./narrative.ts";
import { CHART_FONT, renderReportPdf, type ReportPage } from "./report-pdf.ts";
import { tableColumns, tableRow } from "./table.ts";

/** The table's rows beyond this are left to the Run file, so the Report stays one page. */
const MAX_TABLE_ROWS = 10;

/** The one-page PDF of a Run, with the agent's Narrative and the labels of the Report language. */
export async function makeReport(run: RunRecord, narrative: Narrative, labels: Labels, now: Date): Promise<Buffer> {
  const basketOf = ({ topic, edition }: BasketKey) =>
    run.baskets.find((basket) => basket.topic === topic && basket.edition === edition)!;
  const ranked = run.ranking.ranked.map(basketOf);
  const inTableOrder = [...ranked, ...run.ranking.notEnoughEvidence.map(basketOf)];
  const shown = inTableOrder.slice(0, MAX_TABLE_ROWS);
  const names = new Map(run.resolution.map(({ id, label }) => [id, label]));
  const { window } = run.request;

  const charted = run.chart.map(basketOf);
  const chartStyle: ChartStyle = {
    text: labels.chart,
    font: CHART_FONT,
    width: 380,
    height: 190,
    // vega estimates about 8.8px a character at the legend's size, so a label of maxLabelLength is never cut again.
    legend: { orient: "right", columns: 1, labelLimit: 400 },
    // Cut the legend's labels, keeping the Edition, so the chart keeps its width.
    maxLabelLength: 44,
  };
  const chart =
    charted.length === 0
      ? undefined
      : {
          heading: labels.chartHeading,
          svg: await renderChart(chartLines(charted, (basket) => ranked.includes(basket), names, chartStyle), chartStyle),
        };

  const hidden = inTableOrder.length - shown.length;
  // A highlighted Basket can be charted without a table row; its Articles are still defined.
  const defined = [...shown, ...charted.filter((basket) => !shown.includes(basket))];
  const [first, second] = splitHalves(monthRange(window.start, window.end));
  const spanOf = (months: string[]) => ({ start: months[0]!, end: months.at(-1)! });

  const page: ReportPage = {
    language: narrative.language,
    title: labels.title(window),
    headline: narrative.headline,
    verdicts: {
      heading: labels.verdicts,
      caption: labels.ranking(run.ranking.by),
      columns: tableColumns(labels, run.ranking.by),
      rows: shown.map((basket) => tableRow(basket, topicLabel(basket, shown, names), labels, run.ranking.by)),
      rankedRows: Math.min(ranked.length, shown.length),
      more: hidden > 0 ? labels.more(hidden) : undefined,
    },
    chart,
    findings: { heading: labels.findings, items: narrative.findings },
    recommendation: { heading: labels.recommendation, text: narrative.recommendation },
    nextStep: { heading: labels.nextStep, text: narrative.nextStep },
    baskets: {
      heading: labels.baskets,
      // One line per Topic, its Wikidata item and each shown or charted Edition's Articles.
      lines: [...new Set(defined.map((basket) => basket.topic))].map(
        (topic) =>
          `${topicName({ topic }, names)}: ` +
          defined
            .filter((basket) => basket.topic === topic)
            .map((basket) => `${basket.edition}: ${articlesOf(basket, labels)}`)
            .join("; "),
      ),
      note: defined.some((basket) => basket.chosenByAgent.length > 0) ? labels.chosenNote : undefined,
    },
    smallPrint: [
      labels.method({ first: spanOf(first), second: spanOf(second) }),
      ...labels.caveats,
      labels.source({ date: run.createdAt.slice(0, 10), window, id: run.id }),
    ],
  };
  return renderReportPdf(page, now);
}

/** The Basket's Articles, those chosen by the agent marked with an asterisk. */
function articlesOf(basket: Basket, labels: Labels): string {
  if (basket.missingArticle) return labels.missingArticle;
  if (basket.articles.length === 0) return labels.notMeasured;
  return basket.articles.map((title) => (basket.chosenByAgent.includes(title) ? `${title}*` : title)).join(" + ");
}
