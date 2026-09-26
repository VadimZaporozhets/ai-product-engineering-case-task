// Real Wikidata, Wikipedia search and pageview responses, recorded once into test/fixtures/<name>.json
// and replayed by URL, so tests see exactly what the live APIs answered.
//
// To record, run the tests with WIKI_INTEREST_RECORD=1: requests that aren't in the file yet go to the
// live APIs and are added to it. Without it, a request that isn't recorded fails the test.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { json, pageviewRequests } from "./fake-wikimedia.ts";

type Recording = { url: string; status: number; body: unknown };

export const RECORDING = process.env.WIKI_INTEREST_RECORD === "1";

export function recordedWikimedia(name: string) {
  const file = fileURLToPath(new URL(`fixtures/${name}.json`, import.meta.url));
  const recordings: Recording[] = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  const requests: URL[] = [];

  return {
    requests,

    fetch: async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input);
      requests.push(url);
      let recording = recordings.find((candidate) => candidate.url === url.href);
      if (!recording) {
        if (!RECORDING) throw new Error(`recorded-wikimedia: ${url} isn't recorded in ${name}.json`);
        const response = await globalThis.fetch(url, init);
        recording = { url: url.href, status: response.status, body: await response.json() };
        recordings.push(recording);
        // One response per line keeps the file reviewable in diffs.
        writeFileSync(file, `[\n${recordings.map((entry) => JSON.stringify(entry)).join(",\n")}\n]\n`);
      }
      return json(recording.status, recording.body);
    },

    /** Pageview requests (per-article and aggregate) made so far. */
    pageviewRequests: () => pageviewRequests(requests),
  };
}
