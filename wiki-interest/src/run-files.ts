// Run folders in the output directory (the user's working directory), one per Run, never overwritten.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

export const RUN_FILE = "run.json";

export function writeRunJson(folder: string, run: unknown): string {
  return writeRunFile(folder, RUN_FILE, `${JSON.stringify(run, null, 2)}\n`);
}

/** The Run file in a Run folder, as written, or why it can't be read. */
export function readRunJson<T>(folder: string): { run: T } | { error: string } {
  const path = join(folder, RUN_FILE);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { error: `no Run file at ${path}. Give the Run folder printed on analyze's run file: line.` };
  }
  try {
    return { run: JSON.parse(text) as T };
  } catch (error) {
    return { error: `the Run file at ${path} isn't valid JSON (${(error as Error).message}). Run analyze again for a new Run.` };
  }
}

export function writeChartSvg(folder: string, svg: string): string {
  return writeRunFile(folder, "chart.svg", svg);
}

/** Writes the Report, replacing an earlier one, e.g. after the agent reworded the Narrative. */
export function writeReportPdf(folder: string, pdf: Buffer): string {
  return writeRunFile(folder, "report.pdf", pdf);
}

function writeRunFile(folder: string, name: string, content: string | Buffer): string {
  const path = join(folder, name);
  writeFileSync(path, content);
  return path;
}
