// The CLI entry function. scripts/wiki-interest.js calls runFromProcess() after its setup checks;
// tests call main() directly with injected dependencies.

import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { EXIT_CODES, type ExitCode } from "./exit-codes.ts";
import { signedPercent } from "./format.ts";
import { measureBasket, type Metrics, type MonthRow } from "./metrics.ts";
import { monthRange } from "./months.ts";
import { createRunFolder, writeRunJson } from "./run-files.ts";
import { judge, type Verdict } from "./verdict.ts";
import { resolveWindow } from "./window.ts";
import {
  fetchArticleViews,
  fetchEditionTotals,
  fetchItem,
  RequestFailed,
  type Fetch,
  type WikidataItem,
} from "./wikimedia.ts";

export { EXIT_CODES } from "./exit-codes.ts";

export type Dependencies = {
  fetch: Fetch;
  now: () => Date;
  /** Where fetched pageviews are cached between Runs. */
  cacheDir: string;
  /** Where Run folders are created; the user's working directory in production. */
  outputDir: string;
  stdout: { write(chunk: string): unknown };
};

const ENTRY_SCRIPT = fileURLToPath(new URL("../scripts/wiki-interest.js", import.meta.url));

export async function main(argv: string[], deps: Dependencies): Promise<ExitCode> {
  const [command, ...rest] = argv;
  if (command === "analyze") return analyze(rest, deps);
  return blocked(deps, `unknown command "${command ?? ""}". Usage: ${USAGE}`);
}

export async function runFromProcess(): Promise<void> {
  process.exitCode = await main(process.argv.slice(2), {
    fetch: globalThis.fetch,
    now: () => new Date(),
    cacheDir: join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "wiki-interest"),
    outputDir: process.cwd(),
    stdout: process.stdout,
  });
}

const USAGE = "analyze --topics <Wikidata item id> --editions <edition code> [--months <count>] [--end <YYYY-MM>]";

type Basket = {
  topic: string;
  edition: string;
  articles: string[];
  monthly: MonthRow[];
  metrics?: Metrics;
  verdict?: Verdict;
  error?: string;
};

async function analyze(argv: string[], deps: Dependencies): Promise<ExitCode> {
  let options: { topics?: string; editions?: string; months?: string; end?: string };
  try {
    options = parseArgs({
      args: argv,
      options: {
        topics: { type: "string" },
        editions: { type: "string" },
        months: { type: "string" },
        end: { type: "string" },
      },
    }).values;
  } catch (error) {
    return blocked(deps, `${(error as Error).message}. Usage: ${USAGE}`);
  }
  const topics = splitList(options.topics);
  const editions = splitList(options.editions);
  if (topics.length === 0 || editions.length === 0) {
    return blocked(deps, `give at least one Topic and one Edition. Usage: ${USAGE}`);
  }
  const names = topics.filter((topic) => !/^Q\d+$/.test(topic));
  if (names.length > 0) {
    return blocked(
      deps,
      `Topics by name aren't supported yet: ${names.map((name) => `"${name}"`).join(", ")}. Pass a Wikidata item id, e.g. --topics Q333.`,
    );
  }
  const badEditions = editions.filter((edition) => !/^[a-z][a-z0-9-]*$/.test(edition));
  if (badEditions.length > 0) {
    return blocked(deps, `not an Edition code: ${badEditions.join(", ")}. Use codes like en, uk, pl or zh-min-nan.`);
  }

  const now = deps.now();
  const resolved = resolveWindow(options, now);
  if ("error" in resolved) return blocked(deps, resolved.error);
  const { window } = resolved;

  const lookups = new Map<string, WikidataItem | RequestFailed>();
  for (const topic of topics) {
    const item = await settle(fetchItem(deps.fetch, topic, editions), "Wikidata lookup failed");
    if (!item) return blocked(deps, `Wikidata item ${topic} doesn't exist.`);
    if (!(item instanceof RequestFailed)) {
      const missing = editions.filter((edition) => item.articles[edition] === undefined);
      if (missing.length > 0) {
        return blocked(
          deps,
          `${item.label ?? topic} (${topic}) has no Article in ${missing.map((edition) => `${edition} Wikipedia`).join(", ")}. ` +
            "Analyse it in other Editions, or check the item id.",
        );
      }
    }
    lookups.set(topic, item);
  }
  const items = [...lookups.values()].filter((item): item is WikidataItem => !(item instanceof RequestFailed));

  const totals = new Map<string, Map<string, number> | RequestFailed>();
  for (const edition of editions) {
    const context = `total views of ${edition} Wikipedia`;
    totals.set(edition, await settle(fetchEditionTotals(deps.fetch, edition, window.start, window.end), context));
  }

  const months = monthRange(window.start, window.end);
  const baskets: Basket[] = [];
  for (const topic of topics) {
    const item = lookups.get(topic)!;
    for (const edition of editions) {
      if (item instanceof RequestFailed) {
        baskets.push({ topic, edition, articles: [], monthly: [], error: item.message });
        continue;
      }
      // Every Edition has an Article here: a Missing article blocked the Run above.
      const title = item.articles[edition]!;
      const basket: Basket = { topic, edition, articles: [title], monthly: [] };
      baskets.push(basket);
      const editionTotals = totals.get(edition)!;
      if (editionTotals instanceof RequestFailed) {
        basket.error = editionTotals.message;
        continue;
      }
      const request = fetchArticleViews(deps.fetch, edition, title, window.start, window.end);
      const views = await settle(request, `pageviews of ${title}`);
      if (views instanceof RequestFailed) {
        basket.error = views.message;
        continue;
      }
      const { monthly, metrics } = measureBasket(months, [{ title, daily: views }], editionTotals);
      Object.assign(basket, { monthly, metrics, verdict: judge(metrics, window) });
    }
  }

  const rerun = `analyze --topics ${topics.join(",")} --editions ${editions.join(",")} --months ${window.months} --end ${window.end}`;
  const folder = createRunFolder(deps.outputDir, now, rerun);
  const runFile = writeRunJson(folder.path, {
    id: folder.id,
    createdAt: now.toISOString(),
    rerun,
    request: { topics, editions, window },
    resolution: items,
    baskets,
  });

  const lines = [
    `rerun: node ${shellQuote(ENTRY_SCRIPT)} ${rerun}`,
    `window: ${window.start} to ${window.end} (${window.months} months)`,
    "",
    ...items.flatMap((item) => [
      `${item.id} ${item.label ?? ""}${item.description ? ` (${item.description})` : ""}`,
      ...editions.map((edition) => `  ${edition}: ${item.articles[edition]}`),
    ]),
    "",
    "| Topic | Edition | Direction | Confidence | Growth | Raw change | Median monthly views | Views per million |",
    "|---|---|---|---|---|---|---|---|",
    ...baskets.map((basket) => resultRow(basket, items)),
    "",
    ...reasonLines(baskets, items),
    "",
    `run file: ${runFile}`,
  ];
  deps.stdout.write(`${lines.join("\n")}\n`);
  return baskets.some((basket) => basket.error) ? EXIT_CODES.partialFailure : EXIT_CODES.success;
}

/** Waits for a request; a RequestFailed comes back as the value, its message prefixed with what was asked for. */
async function settle<T>(request: Promise<T>, context: string): Promise<T | RequestFailed> {
  try {
    return await request;
  } catch (error) {
    if (!(error instanceof RequestFailed)) throw error;
    return new RequestFailed(`${context}: ${error.message}`);
  }
}

function resultRow(basket: Basket, items: WikidataItem[]): string {
  const topic = topicName(basket, items);
  const { metrics, verdict } = basket;
  if (basket.error || !metrics || !verdict) return `| ${topic} | ${basket.edition} | error: ${basket.error} | | | | | |`;
  const cells = [
    topic,
    basket.edition,
    verdict.direction ?? "none",
    verdict.confidence,
    percent(metrics.growth),
    percent(metrics.rawChange),
    metrics.medianMonthlyViews === null ? "n/a" : String(Math.round(metrics.medianMonthlyViews)),
    metrics.viewsPerMillion === null ? "n/a" : metrics.viewsPerMillion.toFixed(2),
  ];
  return `| ${cells.join(" | ")} |`;
}

/** The Reason of every failed Check, grouped under its Basket. */
function reasonLines(baskets: Basket[], items: WikidataItem[]): string[] {
  const lines = baskets.flatMap((basket) =>
    basket.verdict?.failedChecks.length
      ? [
          `${topicName(basket, items)} in ${basket.edition}, ${basket.verdict.confidence} Confidence:`,
          ...basket.verdict.failedChecks.map((failed) => `  - ${failed.reason}`),
        ]
      : [],
  );
  return lines.length === 0 ? ["reasons: none, every Check passed"] : ["reasons:", ...lines];
}

function topicName(basket: { topic: string }, items: WikidataItem[]): string {
  const item = items.find((candidate) => candidate.id === basket.topic);
  return item?.label ? `${item.label} (${basket.topic})` : basket.topic;
}

function percent(value: number | null): string {
  return value === null ? "n/a" : signedPercent(value);
}

function blocked(deps: Dependencies, message: string): ExitCode {
  deps.stdout.write(`blocked: ${message}\n`);
  return EXIT_CODES.blocked;
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part, index, parts) => part !== "" && parts.indexOf(part) === index);
}

// Same rule as shellQuote in scripts/wiki-interest.js, which can't import TypeScript.
function shellQuote(text: string): string {
  return /^[\w./-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}
