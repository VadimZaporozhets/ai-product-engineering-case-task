// The Report's fixed labels, in English and Ukrainian. Any other Report language gets the English
// labels; the agent's Narrative stays in the language it was written in.

import { ENGLISH_CHART_TEXT, type ChartText } from "./chart.ts";
import { percent } from "./format.ts";
import type { RankingCriterion } from "./ranking.ts";
import { THRESHOLDS } from "./thresholds.ts";
import type { Confidence, Direction } from "./verdict.ts";
import type { Window } from "./window.ts";

/** The band of Growth that counts as flat, as "10%". */
const BAND = percent(THRESHOLDS.flatBand, 0);

/** A span of months, as "2024-09 to 2026-08". */
type Span = { start: string; end: string };

export type Labels = {
  /** The dictionary's language, in English, as the report command prints it. */
  name: string;
  title: (window: Window) => string;
  verdicts: string;
  ranking: (by: RankingCriterion) => string;
  columns: { topic: string; edition: string; direction: string; confidence: string; growth: string; rawChange: string; median: string };
  perMillion: Record<"whole" | "secondHalf", string>;
  direction: Record<Direction | "none", string>;
  confidence: Record<Confidence, string>;
  error: string;
  more: (count: number) => string;
  chart: ChartText;
  chartHeading: string;
  findings: string;
  recommendation: string;
  nextStep: string;
  baskets: string;
  chosenNote: string;
  missingArticle: string;
  notMeasured: string;
  method: (halves: { first: Span; second: Span }) => string;
  caveats: string[];
  source: (run: { date: string; window: Window; id: string }) => string;
};

export const ENGLISH_LABELS: Labels = {
  name: "English",
  title: (window) => `Wikipedia interest report · ${span(window)}`,
  verdicts: "Verdicts",
  ranking: (by) =>
    `Ranked by ${{ growth: "Growth", interest: "median monthly views", share: "Share of edition in the second half" }[by]}, ` +
    "highest first; then Baskets with low or insufficient Confidence, Missing articles and errors, not ranked.",
  columns: {
    topic: "Topic",
    edition: "Edition",
    direction: "Direction",
    confidence: "Confidence",
    growth: "Growth",
    rawChange: "Raw change",
    median: "Median monthly views",
  },
  perMillion: { whole: "Views per million", secondHalf: "Views per million (2nd half)" },
  direction: { growing: "growing", flat: "flat", declining: "declining", none: "none" },
  confidence: { high: "high", medium: "medium", low: "low", insufficient: "insufficient" },
  error: "error",
  more: (count) => `+${count} more in the Run file`,
  chart: ENGLISH_CHART_TEXT,
  chartHeading: "Share of edition by month",
  findings: "Findings",
  recommendation: "Recommendation",
  nextStep: "Next step",
  baskets: "Baskets: the Wikidata item of each Topic and the Articles measured in each Edition",
  chosenNote: "* chosen by the agent, not linked from the Wikidata item",
  missingArticle: "no Article linked (Missing article)",
  notMeasured: "no Articles measured (failed to load)",
  method: ({ first, second }) =>
    "Method. Interest is human pageviews (bots excluded, all devices) of each Basket's Articles. Share of edition is " +
    "a Basket's views per million views of its whole Edition, so Editions of any size compare on one scale. Growth " +
    `compares Share of edition in the second half of the Window (${span(second)}) with the first ` +
    `(${span(first)}); Direction is growing above +${BAND}, declining below −${BAND}, flat in between. Confidence is ` +
    "high when all 7 Checks pass (enough data, volume, consistency, Spikes, agreement with raw views, full history, " +
    "seasonality), medium when one fails and low when two or more fail; insufficient means too little data to judge. " +
    "The Run file gives the Reason for each failed Check.",
  caveats: [
    "Interest is not willingness to pay: Wikipedia views show what people look up, not what they would buy.",
    "An Edition is a language, not a country: its readers are everyone who reads that language, wherever they live.",
  ],
  source: ({ date, window, id }) =>
    `Data: Wikimedia Pageviews API (human views) and Wikidata, fetched ${date}. ` +
    `Window ${span(window)} (${window.months} months). Run ${id}.`,
};

const UKRAINIAN: Labels = {
  name: "Ukrainian",
  title: (window) => `Звіт про інтерес у Вікіпедії · ${ukrainianSpan(window)}`,
  verdicts: "Вердикти",
  ranking: (by) =>
    `Упорядковано за ${{ growth: "зростанням", interest: "медіаною переглядів за місяць", share: "часткою розділу в другій половині" }[by]}, ` +
    "від найбільшого; далі без рангу кошики з низькою чи недостатньою впевненістю, відсутніми статтями й помилками.",
  columns: {
    topic: "Тема",
    edition: "Розділ",
    direction: "Напрям",
    confidence: "Впевненість",
    growth: "Зростання",
    rawChange: "Зміна переглядів",
    median: "Медіана переглядів/міс.",
  },
  perMillion: { whole: "Переглядів на млн", secondHalf: "Переглядів на млн (2-га пол.)" },
  direction: { growing: "зростає", flat: "без змін", declining: "спадає", none: "немає" },
  confidence: { high: "висока", medium: "середня", low: "низька", insufficient: "недостатня" },
  error: "помилка",
  more: (count) => `+${count} ще у файлі запуску`,
  chart: {
    axisTitle: "Переглядів на мільйон переглядів розділу",
    spikeLegend: "місяць із топ-5 днів (перевірку сплесків не пройдено)",
    spikeMonth: (line, month) => `Місяць сплеску ${line}: ${month}`,
    lowConfidence: "(низька впевненість)",
    insufficient: "(недостатньо даних)",
    months: [
      "січень",
      "лютий",
      "березень",
      "квітень",
      "травень",
      "червень",
      "липень",
      "серпень",
      "вересень",
      "жовтень",
      "листопад",
      "грудень",
    ],
    shortMonths: ["січ.", "лют.", "бер.", "квіт.", "трав.", "черв.", "лип.", "серп.", "вер.", "жовт.", "лист.", "груд."],
  },
  chartHeading: "Частка розділу за місяцями",
  findings: "Висновки",
  recommendation: "Рекомендація",
  nextStep: "Наступний крок",
  baskets: "Кошики: елемент Вікіданих кожної теми й статті, виміряні в кожному розділі",
  chosenNote: "* обрано агентом, а не пов'язано з елементом Вікіданих",
  missingArticle: "немає пов'язаної статті (відсутня стаття)",
  notMeasured: "статті не виміряно (не вдалося завантажити)",
  method: ({ first, second }) =>
    "Метод. Інтерес означає перегляди статей кошика людьми (без ботів, з усіх пристроїв). Частка розділу: перегляди " +
    "кошика на мільйон переглядів усього мовного розділу, тож розділи різного розміру порівнюються в одній шкалі. " +
    `Зростання порівнює частку розділу в другій половині періоду (${ukrainianSpan(second)}) з першою ` +
    `(${ukrainianSpan(first)}); напрям «зростає» понад +${BAND}, «спадає» нижче −${BAND}, інакше «без змін». Впевненість ` +
    "висока, коли пройдено всі 7 перевірок (достатньо даних, обсяг, послідовність, сплески, узгодженість із сирими " +
    "переглядами, повна історія, сезонність), середня, коли не пройдено одну, і низька, коли дві чи більше; " +
    "«недостатня» означає, що даних замало для висновку. Причину кожної непройденої перевірки наведено у файлі запуску.",
  caveats: [
    "Інтерес не означає готовність платити: перегляди Вікіпедії показують, що люди шукають, а не що вони купили б.",
    "Мовний розділ не є країною: його читачами є всі, хто читає цією мовою, де б вони не жили.",
  ],
  source: ({ date, window, id }) =>
    `Дані: Wikimedia Pageviews API (перегляди людьми) і Вікідані, отримано ${date}. ` +
    `Період ${ukrainianSpan(window)} (${window.months} міс.). Запуск ${id}.`,
};

const DICTIONARIES: Record<string, Labels> = { en: ENGLISH_LABELS, uk: UKRAINIAN };

/** The labels for a Report language, and whether they fall back to English because it has no dictionary. */
export function labelsFor(language: string): { labels: Labels; fallback: boolean } {
  const labels = DICTIONARIES[language.split("-")[0]!.toLowerCase()];
  return labels ? { labels, fallback: false } : { labels: ENGLISH_LABELS, fallback: true };
}

function span({ start, end }: Span): string {
  return `${start} to ${end}`;
}

function ukrainianSpan({ start, end }: Span): string {
  return `з ${start} по ${end}`;
}
