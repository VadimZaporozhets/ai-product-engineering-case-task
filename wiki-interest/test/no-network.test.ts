import { describe, expect, test } from "vitest";
import { RECORDING } from "./recorded-wikimedia.ts";

describe("network", () => {
  test.skipIf(RECORDING)("a request that no fake or recording answers fails instead of reaching Wikimedia", async () => {
    await expect(globalThis.fetch("https://wikimedia.org/api/rest_v1/")).rejects.toThrow(
      "tests run without network access",
    );
  });
});
