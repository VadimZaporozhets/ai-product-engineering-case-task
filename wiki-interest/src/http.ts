// Every request to Wikimedia goes through here, following its API etiquette: a User-Agent
// with contact information, which Wikimedia rate-limits 20 times less than an anonymous one; MediaWiki API calls
// (Wikidata and each Edition's search) one at a time; at most 4 pageview requests in flight; and retries of
// answers that may change on their own (HTTP 429 and 5xx).

import packageJson from "../package.json" with { type: "json" };

export type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_USER_AGENT = `wiki-interest/${packageJson.version} (${packageJson.homepage})`;

/** The pageviews REST API's host; every other request goes to a MediaWiki API. */
const PAGEVIEWS_HOST = "wikimedia.org";
const PAGEVIEW_REQUESTS_IN_FLIGHT = 4;
/** Attempts per request, the first one included. */
const ATTEMPTS = 3;
/** The wait before the second attempt when the answer has no Retry-After; it doubles for each attempt after. */
const FIRST_BACKOFF_MS = 2_000;
/** A longer Retry-After fails the request at once: an agent shouldn't sit waiting on one command. */
const MAX_WAIT_MS = 60_000;

export class RequestFailed extends Error {}

export type Http = {
  /** The JSON body of a GET request; `notFoundIsEmpty` turns a 404 into an empty object. */
  getJson(url: string | URL, options?: { notFoundIsEmpty?: boolean }): Promise<unknown>;
};

export function createHttp(options: {
  fetch: Fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  userAgent?: string;
}): Http {
  const headers = { "user-agent": options.userAgent ?? DEFAULT_USER_AGENT, accept: "application/json" };
  // A request keeps its place while it waits to retry, so backing off also holds back the requests queued behind it.
  const pageviewLimit = limiter(PAGEVIEW_REQUESTS_IN_FLIGHT);
  const mediaWikiLimit = limiter(1);

  /** Answers 429 and 5xx are tried again; any other answer is returned. */
  async function getWithRetries(url: string | URL, host: string): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await options.fetch(url, { headers });
      } catch (error) {
        throw new RequestFailed(`request to ${host} failed: ${(error as Error).message}`);
      }
      if (!isRetryable(response.status)) return response;
      await response.body?.cancel();
      if (attempt === ATTEMPTS) {
        throw new RequestFailed(`${host} answered HTTP ${response.status} after ${ATTEMPTS} attempts`);
      }
      const wait = retryAfter(response, options.now()) ?? FIRST_BACKOFF_MS * 2 ** (attempt - 1);
      if (wait > MAX_WAIT_MS) {
        throw new RequestFailed(
          `${host} answered HTTP ${response.status} and asked to wait ${Math.ceil(wait / 1000)} seconds`,
        );
      }
      await options.sleep(wait);
    }
  }

  async function readJson(url: string | URL, host: string, notFoundIsEmpty: boolean): Promise<unknown> {
    const response = await getWithRetries(url, host);
    if (response.status === 404 && notFoundIsEmpty) return {};
    if (!response.ok) throw new RequestFailed(`${host} answered HTTP ${response.status}`);
    try {
      return await response.json();
    } catch (error) {
      throw new RequestFailed(`${host} sent an unreadable answer: ${(error as Error).message}`);
    }
  }

  return {
    getJson(url, { notFoundIsEmpty = false } = {}) {
      const host = new URL(url).hostname;
      const limit = host === PAGEVIEWS_HOST ? pageviewLimit : mediaWikiLimit;
      return limit(() => readJson(url, host, notFoundIsEmpty));
    },
  };
}

/** Runs tasks with at most `size` of them running at once; the others wait their turn in order. */
function limiter(size: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running < size) running++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      // The slot passes straight to the next waiting task, if any.
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/** The wait a Retry-After header asks for, in milliseconds: given in seconds or as a date. */
function retryAfter(response: Response, now: Date): number | undefined {
  const header = response.headers.get("retry-after")?.trim();
  if (!header) return undefined;
  if (/^\d+$/.test(header)) return Number(header) * 1000;
  // An HTTP date names its weekday and month; without letters, Date.parse would read "1.5" as a day in 2001.
  if (!/[a-z]/i.test(header)) return undefined;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now.getTime());
}
