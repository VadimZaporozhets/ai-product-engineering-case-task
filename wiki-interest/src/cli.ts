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
import {
  candidateOf,
  DOMINANCE_RATIO,
  descriptionOf,
  isItemId,
  labelOf,
  missingArticleCandidates,
  searchName,
  type Candidate,
  type NameSearch,
} from "./resolve.ts";
import { createRunFolder, writeRunJson } from "./run-files.ts";
import { judge, missingArticleVerdict, type Verdict } from "./verdict.ts";
import { resolveWindow, type Window } from "./window.ts";
import {
  fetchArticleViews,
  fetchEditionTotals,
  fetchItems,
  project,
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
const COMMAND = `node ${shellQuote(ENTRY_SCRIPT)}`;
const DEFAULT_NAME_LANGUAGE = "en";

export async function main(argv: string[], deps: Dependencies): Promise<ExitCode> {
  const [command, ...rest] = argv;
  if (command === "analyze") return analyze(rest, deps);
  if (command === "resolve") return resolve(rest, deps);
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

const ANALYZE_USAGE =
  "analyze --topics <Topic names or Wikidata item ids> --editions <edition codes> [--name-lang <language code>] " +
  "[--months <count>] [--end <YYYY-MM>]";
const RESOLVE_USAGE = "resolve --topic <Topic name> [--name-lang <language code>] [--editions <edition codes>]";
const USAGE = `${ANALYZE_USAGE}, or ${RESOLVE_USAGE}`;

type Basket = {
  /** The Wikidata item id, or the Topic as given when it couldn't be resolved. */
  topic: string;
  edition: string;
  articles: string[];
  /** Set when the Edition has no Article linked to the item: what its search found instead, never analysed. */
  missingArticle?: { candidates: string[] } | { searchError: string };
  monthly: MonthRow[];
  metrics?: Metrics;
  verdict?: Verdict;
  error?: string;
};

/** A Topic turned into a Wikidata item, with the name search behind it when it was given by name. */
type Resolved = { topic: string; item: WikidataItem; search?: NameSearch };

async function analyze(argv: string[], deps: Dependencies): Promise<ExitCode> {
  const parsed = parseOptions(argv, ["topics", "editions", "name-lang", "months", "end"], ANALYZE_USAGE);
  if ("error" in parsed) return blocked(deps, parsed.error);
  const options = parsed.options;
  const topics = splitList(options.topics);
  const editions = splitList(options.editions);
  if (topics.length === 0 || editions.length === 0) {
    return blocked(deps, `give at least one Topic and one Edition. Usage: ${ANALYZE_USAGE}`);
  }
  const languages = languagesFor(editions, options["name-lang"]);
  if ("error" in languages) return blocked(deps, languages.error);
  const { nameLanguage, labelLanguages } = languages;

  const now = deps.now();
  const resolvedWindow = resolveWindow(options, now);
  if ("error" in resolvedWindow) return blocked(deps, resolvedWindow.error);
  const { window } = resolvedWindow;

  // Edition totals come first: an Edition without any is an unknown code, refused before any other request.
  const totals = new Map<string, Map<string, number> | RequestFailed>();
  const unknownEditions = [];
  for (const edition of editions) {
    const context = `total views of ${edition} Wikipedia`;
    const editionTotals = await settle(fetchEditionTotals(deps.fetch, edition, window.start, window.end), context);
    if (editionTotals === undefined) unknownEditions.push(edition);
    else totals.set(edition, editionTotals);
  }
  if (unknownEditions.length > 0) {
    return blocked(
      deps,
      `unknown Edition code: ${unknownEditions.join(", ")}. Wikimedia has no pageviews for ` +
        `${unknownEditions.map(project).join(", ")} in the Window. ` +
        "Use Wikipedia language codes such as en, uk, pl or zh-min-nan.",
    );
  }

  // Topics given as item ids are looked up together, in one request.
  const itemIds = topics.filter(isItemId);
  const items = await lookupItems(deps, itemIds, labelLanguages);
  const unknownItem = items instanceof RequestFailed ? undefined : itemIds.find((id) => !items.has(id));
  if (unknownItem) return blocked(deps, noSuchItem(unknownItem));
  const resolutions = new Map<string, Resolved | RequestFailed>();
  const ambiguous: NameSearch[] = [];
  for (const topic of topics) {
    if (isItemId(topic)) {
      resolutions.set(topic, items instanceof RequestFailed ? items : { topic, item: items.get(topic)! });
      continue;
    }
    const search = await settle(
      searchName(deps.fetch, topic, { language: nameLanguage, labelLanguages }),
      `Wikidata search for "${topic}" failed`,
    );
    if (search instanceof RequestFailed) resolutions.set(topic, search);
    else if (search.accepted) resolutions.set(topic, { topic, item: search.accepted.item, search });
    else ambiguous.push(search);
  }
  if (ambiguous.length > 0) {
    // A placeholder rather than the first candidate, so the command can't run until someone picks a meaning.
    // A Topic whose search failed keeps its name, so the re-run searches it again.
    const suggested = topics.map((topic) => {
      const resolution = resolutions.get(topic);
      if (resolution instanceof RequestFailed) return topic;
      return resolvedId(resolution) ?? "<item id>";
    });
    const searchErrors = [...resolutions.values()].filter((resolution) => resolution instanceof RequestFailed);
    const pickable = ambiguous.every((search) => search.candidates.length > 0);
    const command = pickable ? analyzeCommand(suggested, editions, window, nameLanguage) : undefined;
    return blockedAmbiguous(deps, ambiguous, searchErrors, command);
  }

  const months = monthRange(window.start, window.end);
  const baskets: Basket[] = [];
  const analysedItems = new Set<string>();
  for (const topic of topics) {
    const resolution = resolutions.get(topic)!;
    // Two Topics that resolve to the same item (a name and its item id) share one set of Baskets.
    if (!(resolution instanceof RequestFailed)) {
      if (analysedItems.has(resolution.item.id)) continue;
      analysedItems.add(resolution.item.id);
    }
    for (const edition of editions) {
      if (resolution instanceof RequestFailed) {
        baskets.push({ topic, edition, articles: [], monthly: [], error: resolution.message });
        continue;
      }
      const { item } = resolution;
      const title = item.articles[edition];
      if (title === undefined) {
        // A Missing article is a finding: it's reported with what the Edition's search finds, never substituted.
        const term = item.labels[edition] ?? (isItemId(topic) ? (labelOf(item, nameLanguage) ?? topic) : topic);
        const found = await settle(missingArticleCandidates(deps.fetch, edition, term), `search of ${edition} Wikipedia`);
        baskets.push({
          topic: item.id,
          edition,
          articles: [],
          missingArticle: found instanceof RequestFailed ? { searchError: found.message } : { candidates: found },
          monthly: [],
          verdict: missingArticleVerdict(edition),
        });
        continue;
      }
      const basket: Basket = { topic: item.id, edition, articles: [title], monthly: [] };
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

  const resolvedTopics = [...resolutions.values()].filter(
    (resolution): resolution is Resolved => !(resolution instanceof RequestFailed),
  );
  // One entry per item, when Topics resolved to the same one.
  const resolved = resolvedTopics.filter(
    (resolution, index) => resolvedTopics.findIndex((other) => other.item.id === resolution.item.id) === index,
  );
  const names = new Map(resolved.map(({ item }) => [item.id, labelOf(item, nameLanguage)]));
  const rerun = analyzeCommand(
    unique(topics.map((topic) => resolvedId(resolutions.get(topic)) ?? topic)),
    editions,
    window,
    nameLanguage,
  );
  const folder = createRunFolder(deps.outputDir, now, rerun);
  const runFile = writeRunJson(folder.path, {
    id: folder.id,
    createdAt: now.toISOString(),
    rerun,
    request: { topics, nameLanguage, editions, window },
    resolution: resolvedTopics.map(({ topic, item, search }) => ({
      topic,
      id: item.id,
      label: labelOf(item, nameLanguage),
      description: descriptionOf(item, nameLanguage),
      wikipediaArticles: candidateOf(item).articleCount,
      articles: Object.fromEntries(editions.map((edition) => [edition, item.articles[edition] ?? null])),
      search: search && {
        name: search.name,
        language: search.language,
        matches: search.matches,
        candidates: search.candidates.map(({ item, articleCount }) => ({ id: item.id, wikipediaArticles: articleCount })),
      },
    })),
    baskets,
  });

  const lines = [
    `rerun: ${COMMAND} ${rerun}`,
    `window: ${window.start} to ${window.end} (${window.months} months)`,
    "",
    "resolution:",
    ...resolved.flatMap((resolution) => resolutionLines(resolution, editions, baskets, nameLanguage)),
    "",
    "| Topic | Edition | Direction | Confidence | Growth | Raw change | Median monthly views | Views per million |",
    "|---|---|---|---|---|---|---|---|",
    ...baskets.map((basket) => resultRow(basket, names)),
    "",
    ...reasonLines(baskets, names),
    ...nextStepLines(resolvedTopics, baskets, editions, names, nameLanguage),
    "",
    `run file: ${runFile}`,
  ];
  deps.stdout.write(`${lines.join("\n")}\n`);
  const failures = baskets.some(
    ({ error, missingArticle }) => error || (missingArticle && "searchError" in missingArticle),
  );
  return failures ? EXIT_CODES.partialFailure : EXIT_CODES.success;
}

/** Lists the candidate meanings of a Topic name and the Article each links in the given Editions. */
async function resolve(argv: string[], deps: Dependencies): Promise<ExitCode> {
  const parsed = parseOptions(argv, ["topic", "editions", "name-lang"], RESOLVE_USAGE);
  if ("error" in parsed) return blocked(deps, parsed.error);
  const { options } = parsed;
  const topic = options.topic?.trim();
  if (!topic) return blocked(deps, `give a Topic name. Usage: ${RESOLVE_USAGE}`);
  const editions = splitList(options.editions);
  const languages = languagesFor(editions, options["name-lang"]);
  if ("error" in languages) return blocked(deps, languages.error);
  const { nameLanguage, labelLanguages } = languages;

  const itemLines = (candidate: Candidate) => [
    `  ${candidateLine(candidate, nameLanguage)}`,
    ...editions.map(
      (edition) => `    ${edition}: ${candidate.item.articles[edition] ?? "no linked Article (Missing article)"}`,
    ),
  ];

  if (isItemId(topic)) {
    const items = await lookupItems(deps, [topic], labelLanguages);
    if (items instanceof RequestFailed) return failed(deps, items);
    const item = items.get(topic);
    if (!item) return blocked(deps, noSuchItem(topic));
    deps.stdout.write(`${itemLines(candidateOf(item)).join("\n")}\n`);
    return EXIT_CODES.success;
  }

  const search = await settle(
    searchName(deps.fetch, topic, { language: nameLanguage, labelLanguages, listAll: true }),
    `Wikidata search for "${topic}" failed`,
  );
  if (search instanceof RequestFailed) return failed(deps, search);
  const { matches } = search;
  const heading = search.exact
    ? `resolve: "${topic}" (${nameLanguage}) matches ${matches} Wikidata items by exact label or alias, ` +
      "most Wikipedia Articles first:"
    : `resolve: no Wikidata item has "${topic}" (${nameLanguage}) as its exact label or alias. Closest search hits:`;
  const outcome = search.accepted
    ? `analyze accepts ${search.accepted.item.id} for "${topic}": it has at least ${DOMINANCE_RATIO} times ` +
      "as many Wikipedia Articles as the next match."
    : search.candidates.length === 0
      ? "Ambiguous topic: nothing found. Check the spelling, give the name's language with --name-lang, " +
        "or give a Wikidata item id."
      : `Ambiguous topic: analyze won't pick one. Ask the user which meaning they mean, then run analyze ` +
        "with --topics <item id>.";
  const lines = [
    heading,
    ...search.candidates.flatMap(itemLines),
    ...moreLine(search),
    `result: ${outcome}`,
  ];
  deps.stdout.write(`${lines.join("\n")}\n`);
  return EXIT_CODES.success;
}

function blockedAmbiguous(
  deps: Dependencies,
  searches: NameSearch[],
  searchErrors: RequestFailed[],
  suggested: string | undefined,
): ExitCode {
  const lines = searches.flatMap((search) => {
    const topic = `Ambiguous topic "${search.name}" (${search.language})`;
    if (search.candidates.length === 0) return [`blocked: ${topic}: Wikidata search found no items.`];
    const problem = search.exact
      ? `no exact label or alias match has at least ${DOMINANCE_RATIO} times as many Wikipedia Articles as the next. ` +
        "Candidates, most Wikipedia Articles first:"
      : "no Wikidata item has this exact label or alias. Closest search hits:";
    return [
      `blocked: ${topic}: ${problem}`,
      ...search.candidates.map((candidate) => `  ${candidateLine(candidate, search.language)}`),
      ...moreLine(search),
    ];
  });
  lines.push(...searchErrors.map((error) => `error: ${error.message}; the re-run searches it again.`));
  lines.push("next steps:");
  if (suggested) {
    lines.push(
      "  - Ask the user which meaning they mean, showing the descriptions above, " +
        "then re-run with its Wikidata item id in place of <item id>:",
      `    ${COMMAND} ${suggested}`,
    );
  }
  lines.push(
    "  - If none fits, check the spelling, give the name's language with --name-lang (e.g. --name-lang uk), " +
      "or list more meanings with the resolve command.",
  );
  deps.stdout.write(`${lines.join("\n")}\n`);
  return EXIT_CODES.blocked;
}

function candidateLine({ item, articleCount }: Candidate, language: string): string {
  return `${itemName(item, language)} (${articleCount} Wikipedia ${articleCount === 1 ? "Article" : "Articles"})`;
}

/** The item's id, label and description. */
function itemName(item: WikidataItem, language: string): string {
  const description = descriptionOf(item, language);
  return `${item.id} ${labelOf(item, language) ?? "(no label)"}${description ? `: ${description}` : ""}`;
}

function moreLine(search: NameSearch): string[] {
  return search.more > 0 ? [`  +${search.more} more with fewer Wikipedia Articles`] : [];
}

function resolutionLines(resolution: Resolved, editions: string[], baskets: Basket[], language: string): string[] {
  const { item, search } = resolution;
  const lines = [`  ${candidateLine(candidateOf(item), language)}`];
  if (search) {
    const { matches } = search;
    const next = search.candidates.find((candidate) => candidate.item !== item);
    lines.push(
      `    chosen for "${search.name}" (${search.language}) from ${matches} exact ${matches === 1 ? "match" : "matches"}` +
        (next ? `; the next is ${itemName(next.item, language)} (${next.articleCount})` : ""),
    );
  }
  for (const edition of editions) {
    const basket = baskets.find((candidate) => candidate.topic === item.id && candidate.edition === edition);
    const missing = basket?.missingArticle;
    if (!missing) {
      lines.push(`    ${edition}: ${item.articles[edition]}`);
    } else if ("searchError" in missing) {
      lines.push(`    ${edition}: Missing article; the search for candidates failed: ${missing.searchError}`);
    } else {
      const found = missing.candidates.length
        ? `search candidates, not analysed: ${missing.candidates.map((title) => `"${title}"`).join(", ")}`
        : `the ${edition} Wikipedia search found no candidates`;
      lines.push(`    ${edition}: Missing article, no Article is linked to ${item.id}; ${found}`);
    }
  }
  return lines;
}

function nextStepLines(
  resolved: Resolved[],
  baskets: Basket[],
  editions: string[],
  names: Map<string, string | undefined>,
  nameLanguage: string,
): string[] {
  const steps = [];
  for (const { topic, item, search } of resolved) {
    if (!search) continue;
    steps.push(
      `  - ${item.id} was chosen for "${topic}". If its description isn't what the user meant, list the other meanings ` +
        `with \`${COMMAND} resolve --topic ${shellQuote(topic)}${nameLangOption(nameLanguage)} ` +
        `--editions ${editions.join(",")}\` ` +
        "and re-run with the right item id.",
    );
  }
  for (const basket of baskets) {
    if (!basket.missingArticle) continue;
    steps.push(
      `  - ${topicName(basket, names)} has no Article in ${basket.edition} Wikipedia. Tell the user: this is a finding ` +
        `about how little ${basket.edition} Wikipedia covers the Topic. The search candidates may be unrelated; ` +
        "never analyse one in its place unless the user picks it.",
    );
  }
  return steps.length === 0 ? [] : ["", "next steps:", ...steps];
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

function resultRow(basket: Basket, names: Map<string, string | undefined>): string {
  const topic = topicName(basket, names);
  const { metrics, verdict } = basket;
  if (basket.error || !verdict) return `| ${topic} | ${basket.edition} | error: ${basket.error} | | | | | |`;
  // A Basket judged without views (a Missing article) has no metrics: every figure is n/a.
  const median = metrics?.medianMonthlyViews ?? null;
  const perMillion = metrics?.viewsPerMillion ?? null;
  const cells = [
    topic,
    basket.edition,
    verdict.direction ?? "none",
    verdict.confidence,
    percent(metrics?.growth ?? null),
    percent(metrics?.rawChange ?? null),
    median === null ? "n/a" : String(Math.round(median)),
    perMillion === null ? "n/a" : perMillion.toFixed(2),
  ];
  return `| ${cells.join(" | ")} |`;
}

/** The Reason of every failed Check, grouped under its Basket. */
function reasonLines(baskets: Basket[], names: Map<string, string | undefined>): string[] {
  const lines = baskets.flatMap((basket) =>
    basket.verdict?.failedChecks.length
      ? [
          `${topicName(basket, names)} in ${basket.edition}, ${basket.verdict.confidence} Confidence:`,
          ...basket.verdict.failedChecks.map((failed) => `  - ${failed.reason}`),
        ]
      : [],
  );
  return lines.length === 0 ? ["reasons: none, every Check passed"] : ["reasons:", ...lines];
}

function topicName(basket: { topic: string }, names: Map<string, string | undefined>): string {
  const label = names.get(basket.topic);
  return label ? `${label} (${basket.topic})` : basket.topic;
}

function resolvedId(resolution: Resolved | RequestFailed | undefined): string | undefined {
  return resolution && !(resolution instanceof RequestFailed) ? resolution.item.id : undefined;
}

/** The analyze command for these Topics, with the Window spelled out so a re-run covers the same months. */
function analyzeCommand(topics: string[], editions: string[], window: Window, nameLanguage: string): string {
  const hasNames = topics.some((topic) => !isItemId(topic));
  return [
    `analyze --topics ${hasNames ? shellQuote(topics.join(",")) : topics.join(",")} --editions ${editions.join(",")}`,
    hasNames ? nameLangOption(nameLanguage) : "",
    ` --months ${window.months} --end ${window.end}`,
  ].join("");
}

/** The --name-lang option of a command, left out for the default name language. */
function nameLangOption(nameLanguage: string): string {
  return nameLanguage === DEFAULT_NAME_LANGUAGE ? "" : ` --name-lang ${nameLanguage}`;
}

/** Looks up Topics given as Wikidata item ids; ids that don't exist are absent from the result. */
function lookupItems(
  deps: Dependencies,
  ids: string[],
  labelLanguages: string[],
): Promise<Map<string, WikidataItem> | RequestFailed> {
  return settle(fetchItems(deps.fetch, ids, labelLanguages), "Wikidata lookup failed");
}

function noSuchItem(id: string): string {
  return `Wikidata item ${id} doesn't exist.`;
}

function percent(value: number | null): string {
  return value === null ? "n/a" : signedPercent(value);
}

function blocked(deps: Dependencies, message: string): ExitCode {
  deps.stdout.write(`blocked: ${message}\n`);
  return EXIT_CODES.blocked;
}

function failed(deps: Dependencies, error: RequestFailed): ExitCode {
  deps.stdout.write(`error: ${error.message}. Try again later.\n`);
  return EXIT_CODES.partialFailure;
}

/** Parses options that each take a string value. */
function parseOptions<Name extends string>(
  argv: string[],
  names: Name[],
  usage: string,
): { options: Partial<Record<Name, string>> } | { error: string } {
  try {
    const options = Object.fromEntries(names.map((name) => [name, { type: "string" as const }]));
    return { options: parseArgs({ args: argv, options }).values as Partial<Record<Name, string>> };
  } catch (error) {
    return { error: `${(error as Error).message}. Usage: ${usage}` };
  }
}

/**
 * Checks the Edition codes and --name-lang. Labels and descriptions are fetched in the name language, then English,
 * then each Edition's language.
 */
function languagesFor(
  editions: string[],
  nameLang: string | undefined,
): { nameLanguage: string; labelLanguages: string[] } | { error: string } {
  const badEditions = editions.filter((edition) => !isCode(edition));
  if (badEditions.length > 0) {
    return { error: `not an Edition code: ${badEditions.join(", ")}. Use codes like en, uk, pl or zh-min-nan.` };
  }
  if (nameLang !== undefined && !isCode(nameLang)) {
    return { error: `--name-lang must be a language code such as en or uk, not "${nameLang}".` };
  }
  const nameLanguage = nameLang ?? DEFAULT_NAME_LANGUAGE;
  return { nameLanguage, labelLanguages: unique([nameLanguage, DEFAULT_NAME_LANGUAGE, ...editions]) };
}

function isCode(text: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(text);
}

function splitList(value: string | undefined): string[] {
  return unique(
    (value ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== ""),
  );
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

// Same rule as shellQuote in scripts/wiki-interest.js, which can't import TypeScript.
function shellQuote(text: string): string {
  return /^[\w./-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}
