// Run folders in the output directory (the user's working directory), one per Run, never overwritten.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RUNS_FOLDER = "wiki-interest-runs";

/**
 * Creates a new Run folder named by the Run's time and a short hash of its command.
 * If that name is taken (same command in the same second), a counter is appended.
 */
export function createRunFolder(outputDir: string, now: Date, command: string): { id: string; path: string } {
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const hash = createHash("sha256").update(command).digest("hex").slice(0, 6);
  const base = `${timestamp}-${hash}`;
  mkdirSync(join(outputDir, RUNS_FOLDER), { recursive: true });
  for (let attempt = 1; ; attempt++) {
    const id = attempt === 1 ? base : `${base}-${attempt}`;
    const path = join(outputDir, RUNS_FOLDER, id);
    try {
      mkdirSync(path);
      return { id, path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

export function writeRunJson(folder: string, run: unknown): string {
  const path = join(folder, "run.json");
  writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`);
  return path;
}
