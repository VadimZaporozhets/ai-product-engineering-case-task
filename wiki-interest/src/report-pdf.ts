// Lays out the one-page A4 Report with pdfkit. The chart goes in as vector graphics
// through svg-to-pdfkit. Every piece of text uses the bundled Noto Sans, the chart's text included, because the
// standard PDF fonts have no Cyrillic.
//
// The page never overflows: every block of text has a maximum number of lines and is cut with an ellipsis beyond
// it, the blocks under the chart are measured first, and the chart takes the height that's left.

import { fileURLToPath } from "node:url";
import { INK as CHART_INK } from "./chart.ts";

/** The Report's content, every piece of text final: the Run's figures, the agent's Narrative and the labels. */
export type ReportPage = {
  language: string;
  title: string;
  headline: string;
  verdicts: {
    heading: string;
    caption: string;
    columns: string[];
    /** A row's cells, one per column; a shorter row's last cell spans the columns left, e.g. an error's reason. */
    rows: string[][];
    /** How many of the rows are ranked; a rule separates them from the Not-enough-evidence rows. */
    rankedRows: number;
    more?: string;
  };
  chart?: { heading: string; svg: string };
  findings: { heading: string; items: string[] };
  recommendation: { heading: string; text: string };
  nextStep: { heading: string; text: string };
  baskets: { heading: string; lines: string[]; note?: string };
  smallPrint: string[];
};

const FONT_FILES = {
  regular: fileURLToPath(new URL("../fonts/NotoSans-Regular.ttf", import.meta.url)),
  bold: fileURLToPath(new URL("../fonts/NotoSans-Bold.ttf", import.meta.url)),
};
const REGULAR = "NotoSans-Regular";
const BOLD = "NotoSans-Bold";
/** The font family the Report's chart is drawn in; every family in it maps to the bundled font anyway. */
export const CHART_FONT = "Noto Sans";

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = { top: 34, bottom: 30, side: 40 };
const WIDTH = PAGE.width - 2 * MARGIN.side;
/** The chart's inks, so the page around it matches. */
const INK = { ...CHART_INK, rule: CHART_INK.axis, stripe: "#f1f0ea" };
const GAP = { section: 11, heading: 3 };

/**
 * Table column widths, in the order of `columns`: the Topic takes what the others leave. The figures are
 * right-aligned.
 */
const COLUMN_WIDTHS = [0, 50, 52, 62, 50, 52, 58, 62];
COLUMN_WIDTHS[0] = WIDTH - COLUMN_WIDTHS.reduce((total, width) => total + width, 0);
const FIGURE_COLUMNS = 4;
const isFigure = (column: number) => column >= COLUMN_WIDTHS.length - FIGURE_COLUMNS;

type Style = { font: string; size: number; color: string; lines: number; align?: "left" | "right" };

const STYLE = {
  title: { font: REGULAR, size: 8, color: INK.muted, lines: 1 },
  headline: { font: BOLD, size: 16, color: INK.primary, lines: 2 },
  heading: { font: BOLD, size: 9.5, color: INK.primary, lines: 1 },
  caption: { font: REGULAR, size: 7, color: INK.secondary, lines: 2 },
  columnHeading: { font: BOLD, size: 6.8, color: INK.secondary, lines: 3 },
  cell: { font: REGULAR, size: 7.8, color: INK.primary, lines: 1 },
  more: { font: REGULAR, size: 7, color: INK.secondary, lines: 1 },
  body: { font: REGULAR, size: 8.5, color: INK.primary, lines: 3 },
  column: { font: REGULAR, size: 8.5, color: INK.primary, lines: 6 },
  basket: { font: REGULAR, size: 7.2, color: INK.primary, lines: 2 },
  smallPrint: { font: REGULAR, size: 6.3, color: INK.secondary, lines: 7 },
} satisfies Record<string, Style>;
const LINE_GAP = 1;
const ROW_HEIGHT = 12;
const BULLET_INDENT = 9;
const COLUMN_GAP = 18;

export async function renderReportPdf(page: ReportPage, createdAt: Date): Promise<Buffer> {
  // Loaded here rather than at the top, so the other commands don't load them.
  const [{ default: PDFDocument }, { default: svgToPdf }] = await Promise.all([
    import("pdfkit"),
    import("svg-to-pdfkit"),
  ]);
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: MARGIN.top, bottom: MARGIN.bottom, left: MARGIN.side, right: MARGIN.side },
    // The document's default font; without it pdfkit would embed Helvetica, which has no Cyrillic.
    font: FONT_FILES.regular,
    lang: page.language,
    displayTitle: true,
    info: { Title: page.headline, Creator: "wiki-interest", CreationDate: createdAt },
  });
  doc.registerFont(REGULAR, FONT_FILES.regular);
  doc.registerFont(BOLD, FONT_FILES.bold);
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const ended = new Promise((resolve) => doc.on("end", resolve));

  /** The height text takes in a style, cut after the style's lines. */
  const measure = (text: string, width: number, style: Style): number => {
    doc.font(style.font).fontSize(style.size);
    const lineHeight = doc.currentLineHeight(true);
    return Math.min(doc.heightOfString(text, { width, lineGap: LINE_GAP }), style.lines * (lineHeight + LINE_GAP));
  };
  /** Writes text in a style, cut after the style's lines; returns the height it took, as measure gives it. */
  const write = (text: string, x: number, y: number, width: number, style: Style): number => {
    doc.font(style.font).fontSize(style.size).fillColor(style.color);
    const lineHeight = doc.currentLineHeight(true);
    // Room for exactly `lines` lines: pdfkit puts the ellipsis on the last line that fits.
    const height = style.lines * lineHeight + (style.lines - 1) * LINE_GAP + lineHeight / 2;
    doc.text(text, x, y, { width, height, ellipsis: true, lineGap: LINE_GAP, align: style.align ?? "left" });
    return measure(text, width, style);
  };

  const left = MARGIN.side;
  let y = MARGIN.top;
  y += write(page.title, left, y, WIDTH, STYLE.title) + 4;
  y += write(page.headline, left, y, WIDTH, STYLE.headline) + GAP.section - 2;

  // The Verdict table.
  const { verdicts } = page;
  y += write(verdicts.heading, left, y, WIDTH, STYLE.heading) + 1;
  y += write(verdicts.caption, left, y, WIDTH, STYLE.caption) + GAP.heading + 1;
  const headingHeights = verdicts.columns.map((column, i) => measure(column, COLUMN_WIDTHS[i]! - 4, STYLE.columnHeading));
  const headingHeight = Math.max(...headingHeights);
  let x = left;
  for (const [i, column] of verdicts.columns.entries()) {
    const align = isFigure(i) ? "right" : "left";
    // Headings sit on the rule under them.
    write(column, x, y + headingHeight - headingHeights[i]!, COLUMN_WIDTHS[i]! - 4, { ...STYLE.columnHeading, align });
    x += COLUMN_WIDTHS[i]!;
  }
  y += headingHeight + 2;
  rule(doc, y);
  y += 1.5;
  // Each cell's one line, centred in the row.
  const cellInset = (ROW_HEIGHT - measure("Hg", WIDTH, STYLE.cell)) / 2;
  for (const [index, row] of verdicts.rows.entries()) {
    if (index === verdicts.rankedRows && index > 0) {
      // The Not-enough-evidence rows follow the ranked ones.
      rule(doc, y);
      y += 1.5;
    }
    if (index % 2 === 1) doc.rect(left, y, WIDTH, ROW_HEIGHT).fill(INK.stripe);
    x = left;
    const top = y + cellInset;
    for (const [i, cell] of row.entries()) {
      const spanned = i === row.length - 1 ? COLUMN_WIDTHS.slice(i) : [COLUMN_WIDTHS[i]!];
      const width = spanned.reduce((total, column) => total + column, 0);
      const align = spanned.length === 1 && isFigure(i) ? "right" : "left";
      write(cell, x + (align === "left" ? 2 : 0), top, width - 4, { ...STYLE.cell, align });
      x += width;
    }
    y += ROW_HEIGHT;
  }
  if (verdicts.more) y += write(verdicts.more, left + 2, y + 2, WIDTH, STYLE.more) + 2;
  y += GAP.section;

  // Everything under the chart is measured first; the chart gets the height that's left.
  const half = (WIDTH - COLUMN_GAP) / 2;
  const headingHeight9 = measure("Hg", WIDTH, STYLE.heading) + GAP.heading;
  const findingsHeight =
    headingHeight9 +
    page.findings.items.reduce((total, item) => total + measure(item, WIDTH - BULLET_INDENT, STYLE.body) + 2, 0);
  const columnsHeight =
    headingHeight9 +
    Math.max(
      measure(page.recommendation.text, half, STYLE.column),
      measure(page.nextStep.text, half, STYLE.column),
    );
  const basketsHeight =
    headingHeight9 +
    page.baskets.lines.reduce((total, line) => total + measure(line, WIDTH, STYLE.basket), 0) +
    (page.baskets.note ? measure(page.baskets.note, WIDTH, STYLE.basket) : 0);
  const smallPrintHeight = page.smallPrint.reduce(
    (total, paragraph) => total + measure(paragraph, WIDTH, STYLE.smallPrint) + 1.5,
    0,
  );
  const smallPrintTop = PAGE.height - MARGIN.bottom - smallPrintHeight;
  const below = findingsHeight + columnsHeight + basketsHeight + 3 * GAP.section;

  if (page.chart) {
    y += write(page.chart.heading, left, y, WIDTH, STYLE.heading) + GAP.heading;
    const size = svgSize(page.chart.svg);
    const room = smallPrintTop - GAP.section - below - y;
    const scale = Math.min(WIDTH / size.width, Math.max(room, 0) / size.height);
    const width = size.width * scale;
    const height = size.height * scale;
    svgToPdf(doc as unknown as Parameters<typeof svgToPdf>[0], page.chart.svg, left + (WIDTH - width) / 2, y, {
      width,
      height,
      preserveAspectRatio: "xMidYMin meet",
      fontCallback: (_family, bold) => (bold ? BOLD : REGULAR),
      warningCallback: () => {},
    });
    y += height + GAP.section;
  }

  // The Narrative.
  y += write(page.findings.heading, left, y, WIDTH, STYLE.heading) + GAP.heading;
  for (const item of page.findings.items) {
    write("•", left + 1, y, BULLET_INDENT, STYLE.body);
    y += write(item, left + BULLET_INDENT, y, WIDTH - BULLET_INDENT, STYLE.body) + 2;
  }
  y += GAP.section;
  // The Recommendation and the Next step, side by side.
  const columnHeights = [page.recommendation, page.nextStep].map(({ heading, text }, i) => {
    const x = left + i * (half + COLUMN_GAP);
    const headingHeight = write(heading, x, y, half, STYLE.heading) + GAP.heading;
    return headingHeight + write(text, x, y + headingHeight, half, STYLE.column);
  });
  y += Math.max(...columnHeights) + GAP.section;

  // Basket definitions, one Topic a line.
  y += write(page.baskets.heading, left, y, WIDTH, STYLE.heading) + GAP.heading;
  for (const line of page.baskets.lines) y += write(line, left, y, WIDTH, STYLE.basket);
  if (page.baskets.note) write(page.baskets.note, left, y, WIDTH, { ...STYLE.basket, color: INK.secondary });

  // Method, Caveats, data source and date, at the foot of the page.
  y = smallPrintTop;
  rule(doc, y - 4);
  for (const paragraph of page.smallPrint) y += write(paragraph, left, y, WIDTH, STYLE.smallPrint) + 1.5;

  doc.end();
  await ended;
  return Buffer.concat(chunks);
}

/** A hairline across the page. */
function rule(doc: PDFKit.PDFDocument, y: number): void {
  doc.moveTo(MARGIN.side, y).lineTo(MARGIN.side + WIDTH, y).lineWidth(0.5).strokeColor(INK.rule).stroke();
}

/** The SVG's own size, from the width and height of its root element. */
function svgSize(svg: string): { width: number; height: number } {
  const root = svg.slice(0, svg.indexOf(">"));
  const number = (name: string) => Number(new RegExp(`\\s${name}="([\\d.]+)"`).exec(root)?.[1]);
  return { width: number("width"), height: number("height") };
}
