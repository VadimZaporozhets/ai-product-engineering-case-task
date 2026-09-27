// Topic resolution: a Topic given by name or as a Wikidata item id becomes one Wikidata item, whose linked
// Articles are the default Baskets. Nothing here ever guesses: a name
// without one clearly dominant meaning is an Ambiguous topic, and an Edition without a linked Article is a
// Missing article. An item with no Wikipedia Article at all (a scientific article, a book) can never be measured,
// so, like a disambiguation page, it isn't a meaning of a Topic.

import {
  fetchItems,
  isDisambiguationPage,
  searchArticles,
  searchItems,
  type SearchHit,
  type WikidataItem,
} from "./wikimedia.ts";
import type { Http } from "./http.ts";

/**
 * A name's best exact match is accepted only when it has at least this many times as many Wikipedia Articles as
 * the next one. Measured: astronomy 252 vs 9 (accepted), Mercury 250 (planet) vs 176 (element) (ambiguous).
 * references/metrics.md states this ratio for the agent; change it with it.
 */
export const DOMINANCE_RATIO = 3;
/** How many candidates an Ambiguous topic or the resolve command lists. */
const LISTED_CANDIDATES = 5;
/** How many search candidates a Missing article lists. */
const MISSING_ARTICLE_CANDIDATES = 3;

export type Candidate = { item: WikidataItem; articleCount: number };

export type NameSearch = {
  name: string;
  language: string;
  /** Whether the candidates match the name exactly, or are only the closest search hits. */
  exact: boolean;
  /** Most Wikipedia Articles first, disambiguation pages and items without a Wikipedia Article left out. */
  candidates: Candidate[];
  /** Further matches with fewer Wikipedia Articles, not listed. */
  more: number;
  /**
   * Every exact match, or every closest hit, with a Wikipedia Article; disambiguation pages are only left out of
   * `candidates`.
   */
  matches: number;
  /** The candidate the name resolves to, if one dominates. */
  accepted: Candidate | undefined;
};

export function isItemId(topic: string): boolean {
  return /^Q\d+$/.test(topic);
}

/**
 * Searches Wikidata for a name and applies the resolution rule: the exact match with the most Wikipedia Articles
 * wins only with at least DOMINANCE_RATIO times the next. Lists enough candidates to decide, or LISTED_CANDIDATES
 * when none is accepted or `listAll` is set.
 */
export async function searchName(
  http: Http,
  name: string,
  options: { language: string; labelLanguages: string[]; listAll?: boolean },
): Promise<NameSearch> {
  const hits = await searchItems(http, name, options.language);
  const wanted = name.toLocaleLowerCase();
  const exactHits = hits.filter((hit) => hit.texts.some((text) => text.toLocaleLowerCase() === wanted));
  const measurable = async (pool: SearchHit[]) => {
    const items = await fetchItems(
      http,
      pool.map((hit) => hit.id),
      options.labelLanguages,
    );
    return [...items.values()].map(candidateOf).filter((candidate) => candidate.articleCount > 0);
  };
  const exactMatches = await measurable(exactHits);
  const exact = exactMatches.length > 0;
  const pool = exact ? exactMatches : await measurable(hits.slice(0, LISTED_CANDIDATES));
  // Sorting is stable, so equal counts keep the search's order.
  const ranked = pool.sort((a, b) => b.articleCount - a.articleCount);

  // Disambiguation pages are looked up one at a time, and only for the candidates that are decided on or listed.
  const candidates: Candidate[] = [];
  let checked = 0;
  const listUpTo = async (count: number) => {
    while (candidates.length < count && checked < ranked.length) {
      const candidate = ranked[checked++]!;
      if (!(await isDisambiguationPage(http, candidate.item.id))) candidates.push(candidate);
    }
  };

  await listUpTo(2);
  const [best, next] = candidates;
  const accepted = exact && best && dominates(best, next) ? best : undefined;
  if (!accepted || options.listAll) await listUpTo(LISTED_CANDIDATES);
  return {
    name,
    language: options.language,
    exact,
    candidates,
    more: ranked.length - checked,
    matches: ranked.length,
    accepted,
  };
}

export function candidateOf(item: WikidataItem): Candidate {
  return { item, articleCount: Object.keys(item.articles).length };
}

function dominates(best: Candidate, next: Candidate | undefined): boolean {
  if (!next) return true;
  return best.articleCount > next.articleCount && best.articleCount >= DOMINANCE_RATIO * next.articleCount;
}

/** Up to three Articles an Edition's search finds, shown for a Missing article and never analysed on their own. */
export function missingArticleCandidates(http: Http, edition: string, term: string): Promise<string[]> {
  return searchArticles(http, edition, term, MISSING_ARTICLE_CANDIDATES);
}

/** The item's label in a language, falling back to English. */
export function labelOf(item: WikidataItem, language: string): string | undefined {
  return item.labels[language] ?? item.labels.en;
}

export function descriptionOf(item: WikidataItem, language: string): string | undefined {
  return item.descriptions[language] ?? item.descriptions.en;
}
