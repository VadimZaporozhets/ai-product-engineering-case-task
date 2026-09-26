// The CLI entry function. scripts/wiki-interest.js calls runFromProcess() after its setup checks;
// tests call main() directly with injected dependencies.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { EXIT_CODES, type ExitCode } from "./exit-codes.ts";
import { createHttp, RequestFailed, type Fetch, type Http } from "./http.ts";
import { ENGLISH_LABELS, labelsFor } from "./labels.ts";
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
import { pageviewCache } from "./pageview-cache.ts";
import {
  DEFAULT_RANKING,
  isRankingCriterion,
  rank,
  RANKING_CRITERIA,
  rankingHeading,
  type RankingCriterion,
} from "./ranking.ts";
import { fieldList, parseNarrative } from "./narrative.ts";
import { createRunFolder, readRunJson, RUN_FILE, writeChartSvg, writeReportPdf, writeRunJson } from "./run-files.ts";
import { chartLines, chooseLines, hasViews, MAX_CHART_LINES, renderChart, topicName } from "./chart.ts";
import { tableColumns, tableRow } from "./table.ts";
import { judge, missingArticleVerdict, type Verdict } from "./verdict.ts";
import { resolveWindow, type Window } from "./window.ts";
import { fetchItems, lookupArticle, project, type WikidataItem } from "./wikimedia.ts";

export { EXIT_CODES } from "./exit-codes.ts";

export type Dependencies = {
  fetch: Fetch;
  now: () => Date;
  /** Waits between attempts of a failed request. */
  sleep: (ms: number) => Promise<void>;
  /** Where fetched pageviews are cached between Runs. */
  cacheDir: string;
  /** Replaces the default User-Agent, which names the skill, its version and the repository URL. */
  userAgent?: string;
  /** Where Run folders are created; the user's working directory in production. */
  outputDir: string;
  stdout: { write(chunk: string): unknown };
};

const ENTRY_SCRIPT = fileURLToPath(new URL("../scripts/wiki-interest.js", import.meta.url));
const COMMAND = `node ${shellQuote(ENTRY_SCRIPT)}`;
const DEFAULT_NAME_LANGUAGE = "en";
/** Run size limit: larger questions are split into several Runs, so the output stays small enough to read. */
const MAX_TOPICS = 5;
const MAX_EDITIONS = 10;

export async function main(argv: string[], deps: Dependencies): Promise<ExitCode> {
  const [command, ...rest] = argv;
  const http = createHttp(deps);
  if (command === "analyze") return analyze(rest, deps, http);
  if (command === "resolve") return resolve(rest, deps, http);
  if (command === "report") return report(rest, deps);
  return blocked(deps, `unknown command "${command ?? ""}". Usage: ${USAGE}`);
}

export async function runFromProcess(): Promise<void> {
  process.exitCode = await main(process.argv.slice(2), {
    fetch: globalThis.fetch,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    cacheDir: join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "wiki-interest"),
    outputDir: process.cwd(),
    userAgent: process.env.WIKI_INTEREST_USER_AGENT || undefined,
    stdout: process.stdout,
  });
}

const ANALYZE_USAGE =
  "analyze --topics <Topic names or Wikidata item ids> --editions <edition codes> [--name-lang <language code>] " +
  "[--months <count>] [--end <YYYY-MM>] [--rank growth|interest|share] " +
  "[--add-article <Topic>:<edition code>:<Article title>]... [--highlight <Topic>:<edition code>]...";
const RESOLVE_USAGE = "resolve --topic <Topic name> [--name-lang <language code>] [--editions <edition codes>]";
const REPORT_USAGE = "report --run <Run folder> --narrative <Narrative file>";
const USAGE = `${ANALYZE_USAGE}, or ${RESOLVE_USAGE}, or ${REPORT_USAGE}`;

export type Basket = {
  /** The Wikidata item id, or the Topic as given when it couldn't be resolved. */
  topic: string;
  edition: string;
  /** Every Article measured: the one linked from the Wikidata item, if any, then those chosen by the agent. */
  articles: string[];
  /** The Articles the agent added with --add-article, rather than linked from the Wikidata item. */
  chosenByAgent: string[];
  /** Set when the Edition has no Article linked to the item: what its search found instead, never analysed. */
  missingArticle?: { candidates: string[] } | { searchError: string };
  monthly: MonthRow[];
  metrics?: Metrics;
  verdict?: Verdict;
  error?: string;
};

/** A Topic turned into a Wikidata item, with the name search behind it when it was given by name. */
type Resolved = { topic: string; item: WikidataItem; search?: NameSearch };

/** What an analyze command asks for, once its arguments are checked. */
type Request = {
  topics: string[];
  editions: string[];
  nameLanguage: string;
  window: Window;
  ranking: RankingCriterion;
  extraArticles: ExtraArticle[];
  /** Baskets the chart always draws, whatever their row in the tables. */
  highlights: BasketKey[];
};

/** A Basket named by its Topic, written as in --topics or as its item id, and its Edition. */
export type BasketKey = { topic: string; edition: string };

/** What a Run file holds. The report command reads it back, so a Report needs nothing else from the Run. */
export type RunRecord = {
  id: string;
  createdAt: string;
  rerun: string;
  request: Request;
  resolution: {
    topic: string;
    id: string;
    label: string | undefined;
    description: string | undefined;
    wikipediaArticles: number;
    articles: Record<string, string | null>;
    /** The name search behind the item, when the Topic was given by name. */
    search:
      | {
          name: string;
          language: string;
          matches: number;
          candidates: { id: string; wikipediaArticles: number }[];
        }
      | undefined;
  }[];
  baskets: Basket[];
  ranking: { by: RankingCriterion; ranked: BasketKey[]; notEnoughEvidence: BasketKey[] };
  /** The Baskets the chart draws, in legend order. */
  chart: BasketKey[];
};

/** An Article the agent adds to the Basket of one Topic in one Edition. */
type ExtraArticle = BasketKey & { title: string };

async function analyze(argv: string[], deps: Dependencies, http: Http): Promise<ExitCode> {
  const parsed = parseOptions(
    argv,
    ["topics", "editions", "name-lang", "months", "end", "rank"],
    ANALYZE_USAGE,
    ["add-article", "highlight"],
  );
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
  const ranking = options.rank ?? DEFAULT_RANKING;
  if (!isRankingCriterion(ranking)) {
    return blocked(deps, `--rank must be ${orList(RANKING_CRITERIA)}, not "${ranking}".`);
  }
  const extras = parseExtraArticles(options["add-article"] ?? [], topics, editions);
  if ("error" in extras) return blocked(deps, extras.error);
  const highlights = parseHighlights(options.highlight ?? [], topics, editions);
  if ("error" in highlights) return blocked(deps, highlights.error);
  const request: Request = {
    topics,
    editions,
    nameLanguage,
    window,
    ranking,
    extraArticles: extras.extraArticles,
    highlights: highlights.highlights,
  };
  if (topics.length > MAX_TOPICS || editions.length > MAX_EDITIONS) return blockedTooLarge(deps, request);
  const pageviews = pageviewCache(http, deps.cacheDir, now);

  // Edition totals come first: an Edition without any is an unknown code, refused before any other request.
  const fetchedTotals = await Promise.all(
    editions.map(async (edition) => {
      const context = `total views of ${edition} Wikipedia`;
      return [edition, await settle(pageviews.editionTotals(edition, window.start, window.end), context)] as const;
    }),
  );
  const totals = new Map<string, Map<string, number> | RequestFailed>();
  const unknownEditions = [];
  for (const [edition, editionTotals] of fetchedTotals) {
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
  const items = await lookupItems(http, itemIds, labelLanguages);
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
      searchName(http, topic, { language: nameLanguage, labelLanguages }),
      `Wikidata search for "${topic}" failed`,
    );
    if (search instanceof RequestFailed) resolutions.set(topic, search);
    else if (search.accepted) resolutions.set(topic, { topic, item: search.accepted.item, search });
    else ambiguous.push(search);
  }
  if (ambiguous.length > 0) {
    // A placeholder rather than the first candidate, so the command can't run until someone picks a meaning.
    // A Topic whose search failed keeps its name, so the re-run searches it again.
    const suggested = (topic: string) => {
      const resolution = resolutions.get(topic);
      if (resolution instanceof RequestFailed) return topic;
      return resolvedId(resolution) ?? "<item id>";
    };
    const searchErrors = [...resolutions.values()].filter((resolution) => resolution instanceof RequestFailed);
    const pickable = ambiguous.every((search) => search.candidates.length > 0);
    const command = pickable ? analyzeCommand(request, suggested) : undefined;
    return blockedAmbiguous(deps, ambiguous, searchErrors, command);
  }

  const idOf = (topic: string) => resolvedId(resolutions.get(topic)) ?? topic;
  const months = monthRange(window.start, window.end);
  const basketFor = async (topic: string, resolution: Resolved | RequestFailed, edition: string): Promise<Basket> => {
    if (resolution instanceof RequestFailed) {
      return { topic, edition, articles: [], chosenByAgent: [], monthly: [], error: resolution.message };
    }
    const { item } = resolution;
    const linked = item.articles[edition];
    const basketOf = (chosen: string[]): Basket => {
      // Titles written differently can name the same Article ("foo" and "Foo").
      const chosenByAgent = unique(chosen).filter((title) => title !== linked);
      const articles = linked === undefined ? chosenByAgent : [linked, ...chosenByAgent];
      return { topic: item.id, edition, articles, chosenByAgent, monthly: [] };
    };
    // Every Topic that resolved to this item, by name or by id, adds to its Baskets.
    const added = unique(
      request.extraArticles
        .filter((extra) => extra.edition === edition && idOf(extra.topic) === item.id)
        .map((extra) => extra.title),
    );
    if (linked === undefined && added.length === 0) {
      // A Missing article is a finding: it's reported with what the Edition's search finds, never substituted.
      const term = item.labels[edition] ?? (isItemId(topic) ? (labelOf(item, nameLanguage) ?? topic) : topic);
      const found = await settle(missingArticleCandidates(http, edition, term), `search of ${edition} Wikipedia`);
      return {
        ...basketOf([]),
        missingArticle: found instanceof RequestFailed ? { searchError: found.message } : { candidates: found },
        verdict: missingArticleVerdict(edition),
      };
    }
    const editionTotals = totals.get(edition)!;
    if (editionTotals instanceof RequestFailed) return { ...basketOf(added), error: editionTotals.message };
    const checked = await checkAddedArticles(http, edition, added);
    if ("error" in checked) return { ...basketOf(added), error: checked.error };
    const basket = basketOf(checked.titles);
    const fetched = await Promise.all(
      basket.articles.map((title) =>
        settle(pageviews.articleViews(edition, title, window.start, window.end), `pageviews of ${title}`),
      ),
    );
    const articles = [];
    for (const [index, daily] of fetched.entries()) {
      if (daily instanceof RequestFailed) return { ...basket, error: daily.message };
      articles.push({ title: basket.articles[index]!, daily });
    }
    const { monthly, metrics } = measureBasket(months, articles, editionTotals);
    return { ...basket, monthly, metrics, verdict: judge(metrics, window) };
  };
  // Every Basket's requests are started together; the HTTP client keeps them within Wikimedia's limits.
  const pending: Promise<Basket>[] = [];
  const analysedItems = new Set<string>();
  for (const topic of topics) {
    const resolution = resolutions.get(topic)!;
    // Two Topics that resolve to the same item (a name and its item id) share one set of Baskets.
    if (!(resolution instanceof RequestFailed)) {
      if (analysedItems.has(resolution.item.id)) continue;
      analysedItems.add(resolution.item.id);
    }
    for (const edition of editions) pending.push(basketFor(topic, resolution, edition));
  }
  const baskets = await Promise.all(pending);

  const resolvedTopics = [...resolutions.values()].filter(
    (resolution): resolution is Resolved => !(resolution instanceof RequestFailed),
  );
  // One entry per item, when Topics resolved to the same one.
  const resolved = resolvedTopics.filter(
    (resolution, index) => resolvedTopics.findIndex((other) => other.item.id === resolution.item.id) === index,
  );
  const names = new Map(resolved.map(({ item }) => [item.id, labelOf(item, nameLanguage)]));
  const rerun = analyzeCommand(request, idOf);
  const { ranked, notEnoughEvidence } = rank(baskets, ranking);
  // Reasons and next steps follow the tables' order.
  const inTableOrder = [...ranked, ...notEnoughEvidence];
  const keyOf = ({ topic, edition }: Basket) => ({ topic, edition });
  const isHighlighted = (basket: Basket) =>
    request.highlights.some(({ topic, edition }) => idOf(topic) === basket.topic && edition === basket.edition);
  const withViews = inTableOrder.filter(hasViews);
  const charted = chooseLines(withViews, isHighlighted);
  const folder = createRunFolder(deps.outputDir, now, rerun);
  const run: RunRecord = {
    id: folder.id,
    createdAt: now.toISOString(),
    rerun,
    request,
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
    ranking: {
      by: ranking,
      ranked: ranked.map(keyOf),
      notEnoughEvidence: notEnoughEvidence.map(keyOf),
    },
    chart: charted.map(keyOf),
  };
  const runFile = writeRunJson(folder.path, run);
  const chartFile =
    charted.length === 0
      ? undefined
      : writeChartSvg(folder.path, await renderChart(chartLines(charted, (basket) => ranked.includes(basket), names)));
  const chartSteps = chartStepLines(inTableOrder, charted, withViews, isHighlighted, names);

  const lines = [
    `rerun: ${COMMAND} ${rerun}`,
    `window: ${window.start} to ${window.end} (${window.months} months)`,
    "",
    "resolution:",
    ...resolved.flatMap((resolution) => resolutionLines(resolution, editions, baskets, nameLanguage)),
    "",
    ...tableLines(rankingHeading(ranking), ranked, names, ranking),
    "",
    ...tableLines(
      "not enough evidence (low or insufficient Confidence, Missing articles and errors; not ranked)",
      notEnoughEvidence,
      names,
      ranking,
    ),
    "",
    ...reasonLines(inTableOrder, names),
    "",
    ...CAVEAT_LINES,
    "",
    ...nextStepLines(resolvedTopics, inTableOrder, editions, names, nameLanguage, chartSteps, folder.path),
    "",
    `run file: ${runFile}`,
    `chart: ${chartFile ?? "none, no Basket has views to draw"}`,
  ];
  deps.stdout.write(`${lines.join("\n")}\n`);
  const failures = baskets.some(
    ({ error, missingArticle }) => error || (missingArticle && "searchError" in missingArticle),
  );
  return failures ? EXIT_CODES.partialFailure : EXIT_CODES.success;
}

/** Lists the candidate meanings of a Topic name and the Article each links in the given Editions. */
async function resolve(argv: string[], deps: Dependencies, http: Http): Promise<ExitCode> {
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
    const items = await lookupItems(http, [topic], labelLanguages);
    if (items instanceof RequestFailed) return failed(deps, items);
    const item = items.get(topic);
    if (!item) return blocked(deps, noSuchItem(topic));
    deps.stdout.write(`${itemLines(candidateOf(item)).join("\n")}\n`);
    return EXIT_CODES.success;
  }

  const search = await settle(
    searchName(http, topic, { language: nameLanguage, labelLanguages, listAll: true }),
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

/** Writes a Run's one-page PDF Report from its Run file and the agent's Narrative; it makes no requests. */
async function report(argv: string[], deps: Dependencies): Promise<ExitCode> {
  const parsed = parseOptions(argv, ["run", "narrative"], REPORT_USAGE);
  if ("error" in parsed) return blocked(deps, parsed.error);
  const { run: runOption, narrative: narrativeFile } = parsed.options;
  if (!runOption || !narrativeFile) {
    return blocked(deps, `give the Run folder with --run and the Narrative file with --narrative. Usage: ${REPORT_USAGE}`);
  }
  // The run file's own path, as analyze prints it, names its folder too.
  const folder = basename(runOption) === RUN_FILE ? dirname(runOption) : runOption;
  const read = readRunJson<RunRecord>(folder);
  if ("error" in read) return blocked(deps, read.error);
  const { run } = read;
  if (!Array.isArray(run.chart)) {
    return blocked(deps, `the Run file at ${join(folder, RUN_FILE)} predates Reports. Run its rerun: line, then report on the new Run.`);
  }

  let text;
  try {
    text = readFileSync(narrativeFile, "utf8");
  } catch {
    return blocked(deps, `no Narrative file at ${narrativeFile}.`);
  }
  const parsedNarrative = parseNarrative(text);
  if ("notJson" in parsedNarrative) {
    return blocked(
      deps,
      `the Narrative file ${narrativeFile} isn't valid JSON (${parsedNarrative.notJson}). Write one JSON object ` +
        `with ${fieldList()}.`,
    );
  }
  if ("problems" in parsedNarrative) {
    const problems = parsedNarrative.problems.map((problem) => `  - ${problem}`);
    return blocked(deps, ["the Narrative file needs fixing; no Report was made:", ...problems].join("\n"));
  }
  const { narrative } = parsedNarrative;
  const { labels, fallback } = labelsFor(narrative.language);
  // Loaded here, so analyze and resolve don't load the PDF libraries.
  const { makeReport } = await import("./report.ts");
  const path = writeReportPdf(folder, await makeReport(run, narrative, labels, deps.now()));
  const lines = [
    `report: ${path}`,
    `labels: ${fallback ? `English (no labels for ${narrative.language}; the Narrative stays as written)` : labels.name}`,
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

/** Refuses a Run over the size limit, printing the smaller Runs it splits into, which share its Window. */
function blockedTooLarge(deps: Dependencies, request: Request): ExitCode {
  const over = [
    request.topics.length > MAX_TOPICS ? `${request.topics.length} Topics` : undefined,
    request.editions.length > MAX_EDITIONS ? `${request.editions.length} Editions` : undefined,
  ].filter((part) => part !== undefined);
  const commands = chunks(request.topics, MAX_TOPICS).flatMap((topics) =>
    chunks(request.editions, MAX_EDITIONS).map((editions) => {
      const inRun = ({ topic, edition }: BasketKey) => topics.includes(topic) && editions.includes(edition);
      return analyzeCommand({
        ...request,
        topics,
        editions,
        extraArticles: request.extraArticles.filter(inRun),
        highlights: request.highlights.filter(inRun),
      });
    }),
  );
  const lines = [
    `blocked: a Run analyses at most ${MAX_TOPICS} Topics and ${MAX_EDITIONS} Editions, and this one asks for ` +
      `${over.join(" and ")}. Ask the user which matter most, or split the question into these Runs, ` +
      "which share one Window, and answer from all of their tables:",
    ...commands.map((command) => `  ${COMMAND} ${command}`),
  ];
  deps.stdout.write(`${lines.join("\n")}\n`);
  return EXIT_CODES.blocked;
}

/** Splits values into as few chunks of at most `size` as possible, as even in size as they can be. */
function chunks<T>(values: T[], size: number): T[][] {
  const count = Math.ceil(values.length / size);
  const chunkSize = Math.ceil(values.length / count);
  return Array.from({ length: count }, (_, i) => values.slice(i * chunkSize, (i + 1) * chunkSize));
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
    const linked = item.articles[edition];
    const chosen = (basket?.chosenByAgent ?? []).map((title) => `${title} (chosen by the agent)`);
    if (!missing) {
      lines.push(
        linked === undefined
          ? `    ${edition}: no Article is linked to ${item.id}; the Basket is ${chosen.join(" + ")}`
          : `    ${edition}: ${[linked, ...chosen].join(" + ")}`,
      );
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
  chartSteps: string[],
  runFolder: string,
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
    if (basket.error) {
      steps.push(
        `  - ${topicName(basket, names)} in ${basket.edition} failed: ${basket.error}. Answer from the other rows and ` +
          "tell the user what failed. If the reason is about an --add-article, correct or drop that option in the " +
          "rerun: line; otherwise run the rerun: line again later (months already fetched come from the cache).",
      );
    } else if (basket.missingArticle) {
      steps.push(
        `  - ${topicName(basket, names)} has no Article in ${basket.edition} Wikipedia. Tell the user: this is a finding ` +
          `about how little ${basket.edition} Wikipedia covers the Topic. The search candidates may be unrelated; ` +
          "never analyse one in its place unless the user picks it. If they do, add it to the rerun: line as " +
          `--add-article '${basket.topic}:${basket.edition}:<Article title>'.`,
      );
    }
  }
  steps.push(...chartSteps);
  steps.push(
    "  - For a one-page PDF Report, write a Narrative file (a JSON object: language, headline, 1 to 3 findings, " +
      `recommendation, nextStep) and run \`${COMMAND} report --run ${shellQuote(runFolder)} --narrative <file>\`.`,
  );
  steps.push(
    "  - For a follow-up (another Edition or Topic, a longer Window, another ranking), edit the rerun: line and run it " +
      "again; months already fetched come from the cache.",
  );
  return ["next steps:", ...steps];
}

/** Limitations of the method that apply to every Run; the Report states the same ones. */
const CAVEAT_LINES = ["caveats:", ...ENGLISH_LABELS.caveats.map((caveat) => `  - ${caveat}`)];

/** Waits for a request; a RequestFailed comes back as the value, its message prefixed with what was asked for. */
async function settle<T>(request: Promise<T>, context: string): Promise<T | RequestFailed> {
  try {
    return await request;
  } catch (error) {
    if (!(error instanceof RequestFailed)) throw error;
    return new RequestFailed(`${context}: ${error.message}`);
  }
}

/** A heading, then a result table of the Baskets, or "none" on the heading's line when there are none. */
function tableLines(
  heading: string,
  baskets: Basket[],
  names: Map<string, string | undefined>,
  ranking: RankingCriterion,
): string[] {
  if (baskets.length === 0) return [`${heading}: none`];
  const columns = tableColumns(ENGLISH_LABELS, ranking);
  const row = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [
    `${heading}:`,
    row(columns),
    `|${"---|".repeat(columns.length)}`,
    ...baskets.map((basket) => {
      const cells = tableRow(basket, topicName(basket, names), ENGLISH_LABELS, ranking);
      // A failed Basket's reason fills its cell; the columns after it stay empty.
      return row(cells) + " |".repeat(columns.length - cells.length);
    }),
  ];
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
  if (lines.length > 0) return ["reasons:", ...lines];
  // An error row was never judged, so "every Check passed" would claim more than the Run knows.
  return baskets.some((basket) => !basket.verdict)
    ? ["reasons: none; error rows have no Checks, and next steps say what failed"]
    : ["reasons: none, every Check passed"];
}

/** Next steps about the chart: highlighted Baskets it can't draw, and Baskets it leaves out. */
function chartStepLines(
  baskets: Basket[],
  charted: Basket[],
  withViews: Basket[],
  isHighlighted: (basket: Basket) => boolean,
  names: Map<string, string | undefined>,
): string[] {
  const steps = baskets
    .filter((basket) => isHighlighted(basket) && !withViews.includes(basket))
    .map(
      (basket) =>
        `  - ${topicName(basket, names)} in ${basket.edition} is highlighted, but it has no views to draw on the chart.`,
    );
  if (charted.length < withViews.length) {
    // Every highlighted Basket with views is charted, since --highlight allows no more than the chart has lines.
    const which = charted.some(isHighlighted)
      ? "the highlighted ones and the first rows of the tables"
      : "the first rows of the tables";
    steps.push(
      `  - The chart shows ${charted.length} of the ${withViews.length} Baskets with views, ${which}. ` +
        `To chart another, add --highlight '<Topic>:<edition>' to the rerun: line (at most ${MAX_CHART_LINES}) and run it again.`,
    );
  }
  return steps;
}

function resolvedId(resolution: Resolved | RequestFailed | undefined): string | undefined {
  return resolution && !(resolution instanceof RequestFailed) ? resolution.item.id : undefined;
}

/**
 * An analyze command, with the Window spelled out so a re-run covers the same months. `topicAs` rewrites each Topic,
 * e.g. into its Wikidata item id, in --topics, --add-article and --highlight.
 */
function analyzeCommand(request: Request, topicAs: (topic: string) => string = (topic) => topic): string {
  const { editions, window, nameLanguage, ranking } = request;
  // Topics that resolved to the same item are listed once; each "<item id>" placeholder stays, one per Topic to pick.
  const topics = request.topics.map(topicAs).filter((topic, i, all) => !isItemId(topic) || all.indexOf(topic) === i);
  const hasNames = topics.some((topic) => !isItemId(topic));
  const added = unique(request.extraArticles.map(({ topic, edition, title }) => `${topicAs(topic)}:${edition}:${title}`));
  const highlighted = unique(request.highlights.map(({ topic, edition }) => `${topicAs(topic)}:${edition}`));
  return [
    `analyze --topics ${hasNames ? shellQuote(topics.join(",")) : topics.join(",")} --editions ${editions.join(",")}`,
    hasNames ? nameLangOption(nameLanguage) : "",
    ` --months ${window.months} --end ${window.end}`,
    ranking === DEFAULT_RANKING ? "" : ` --rank ${ranking}`,
    ...added.map((extra) => ` --add-article ${shellQuote(extra)}`),
    ...highlighted.map((highlight) => ` --highlight ${shellQuote(highlight)}`),
  ].join("");
}

/** Reads each --add-article as <Topic>:<edition>:<Article title>; the title keeps any colons after the edition. */
function parseExtraArticles(
  values: string[],
  topics: string[],
  editions: string[],
): { extraArticles: ExtraArticle[] } | { error: string } {
  const extraArticles: ExtraArticle[] = [];
  for (const value of values) {
    const read = readBasket("--add-article", value, topics, editions, "<Article title>");
    if ("error" in read) return read;
    extraArticles.push({ topic: read.topic, edition: read.edition, title: read.rest });
  }
  return { extraArticles };
}

/** Reads each --highlight as <Topic>:<edition>, at most as many as the chart has lines. */
function parseHighlights(
  values: string[],
  topics: string[],
  editions: string[],
): { highlights: BasketKey[] } | { error: string } {
  const distinct = unique(values);
  if (distinct.length > MAX_CHART_LINES) {
    return {
      error:
        `the chart draws at most ${MAX_CHART_LINES} lines, so highlight at most ${MAX_CHART_LINES} Baskets, ` +
        `not ${distinct.length}.`,
    };
  }
  const highlights: BasketKey[] = [];
  for (const value of distinct) {
    const read = readBasket("--highlight", value, topics, editions);
    if ("error" in read) return read;
    highlights.push({ topic: read.topic, edition: read.edition });
  }
  return { highlights };
}

/**
 * Reads an option value written as <Topic>:<edition>, followed by :<more> when `more` names a further part, which
 * keeps any colons. The Topic is written as in --topics, which is how it's told apart from a colon in a Topic name.
 */
function readBasket(
  option: string,
  value: string,
  topics: string[],
  editions: string[],
  more?: string,
): { topic: string; edition: string; rest: string } | { error: string } {
  const formatError = { error: basketFormatError(option, value, topics, editions, more) };
  // The longest Topic first, so a Topic whose name starts with another Topic's is matched whole.
  const topic = [...topics].sort((a, b) => b.length - a.length).find((candidate) => value.startsWith(`${candidate}:`));
  if (topic === undefined) return formatError;
  const [edition = "", ...parts] = value.slice(topic.length + 1).split(":");
  if (!editions.includes(edition)) {
    return { error: `${option} "${value}": "${edition}" isn't one of --editions (${editions.join(",")}).` };
  }
  const rest = parts.join(":").trim();
  if (more ? rest === "" : parts.length > 0) return formatError;
  return { topic, edition, rest };
}

function basketFormatError(option: string, value: string, topics: string[], editions: string[], more?: string): string {
  const tail = more ? [more] : [];
  const shape = ["<Topic>", "<edition code>", ...tail].join(":");
  const example = [topics[0], editions[0], ...tail].join(":");
  return (
    `${option} "${value}" must be ${shape}, with the Topic written as in --topics (${topics.join(", ")}), ` +
    `e.g. ${option} '${example}'.`
  );
}

/**
 * The titles of the Articles the agent added, as the Edition writes them, or why one of them can't be measured.
 * Each is looked up, because the pageviews API answers a title that isn't an Article as one without views.
 */
async function checkAddedArticles(
  http: Http,
  edition: string,
  titles: string[],
): Promise<{ titles: string[] } | { error: string }> {
  const checked = [];
  for (const title of titles) {
    const found = await settle(lookupArticle(http, edition, title), `lookup of "${title}" in ${edition} Wikipedia`);
    if (found instanceof RequestFailed) return { error: found.message };
    const added = `"${title}", added with --add-article,`;
    if (found.kind === "missing") return { error: `${added} is not an Article of ${edition} Wikipedia` };
    if (found.kind === "invalid") return { error: `${added} is not an Article title: ${found.reason}` };
    if (found.kind === "redirect") {
      return {
        error: `${added} only redirects to "${found.target}" in ${edition} Wikipedia; add "${found.target}" instead`,
      };
    }
    checked.push(found.title);
  }
  return { titles: checked };
}

/** "a, b or c". */
function orList(values: readonly string[]): string {
  return values.length === 1 ? values[0]! : `${values.slice(0, -1).join(", ")} or ${values.at(-1)}`;
}

/** The --name-lang option of a command, left out for the default name language. */
function nameLangOption(nameLanguage: string): string {
  return nameLanguage === DEFAULT_NAME_LANGUAGE ? "" : ` --name-lang ${nameLanguage}`;
}

/** Looks up Topics given as Wikidata item ids; ids that don't exist are absent from the result. */
function lookupItems(
  http: Http,
  ids: string[],
  labelLanguages: string[],
): Promise<Map<string, WikidataItem> | RequestFailed> {
  return settle(fetchItems(http, ids, labelLanguages), "Wikidata lookup failed");
}

function noSuchItem(id: string): string {
  return `Wikidata item ${id} doesn't exist.`;
}

function blocked(deps: Dependencies, message: string): ExitCode {
  deps.stdout.write(`blocked: ${message}\n`);
  return EXIT_CODES.blocked;
}

function failed(deps: Dependencies, error: RequestFailed): ExitCode {
  deps.stdout.write(`error: ${error.message}. Try again later.\n`);
  return EXIT_CODES.partialFailure;
}

/** Parses options that each take a string value, and those in `multiple` that can be given more than once. */
function parseOptions<Name extends string, Multiple extends string = never>(
  argv: string[],
  names: Name[],
  usage: string,
  multiple: Multiple[] = [],
): { options: Partial<Record<Name, string> & Record<Multiple, string[]>> } | { error: string } {
  try {
    const options = Object.fromEntries([
      ...names.map((name) => [name, { type: "string" as const }]),
      ...multiple.map((name) => [name, { type: "string" as const, multiple: true }]),
    ]);
    return {
      options: parseArgs({ args: argv, options }).values as Partial<Record<Name, string> & Record<Multiple, string[]>>,
    };
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
