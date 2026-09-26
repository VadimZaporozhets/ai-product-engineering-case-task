// Loaded before every test file: replaces the real fetch so no test can reach Wikimedia or Wikidata,
// on a developer machine or in CI. Recording fixtures (see recorded-wikimedia.ts) is the one time tests
// are meant to go to the live APIs, so it keeps the real fetch. Processes a test spawns get their own
// fetch; the setup-guard tests only spawn the entry script for runs that stop before any request.

import { RECORDING } from "./recorded-wikimedia.ts";

if (!RECORDING) {
  globalThis.fetch = async (input) => {
    throw new Error(`tests run without network access; answer ${String(input)} with a fake or a recording`);
  };
}
