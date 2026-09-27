// The Window: the span of complete months a Run analyses, exactly as asked.

import { addMonths, isMonth, monthOf, monthsFrom } from "./months.ts";

const DEFAULT_WINDOW_MONTHS = 24;
const MIN_WINDOW_MONTHS = 2;
/** Pageview data from the current API begins in July 2015. */
const FIRST_DATA_MONTH = "2015-07";

export type Window = { months: number; start: string; end: string };

export function resolveWindow(input: { months?: string; end?: string }, now: Date): { window: Window } | { error: string } {
  if (input.months !== undefined && !/^\d+$/.test(input.months)) {
    return { error: `--months must be a whole number of months, e.g. --months ${DEFAULT_WINDOW_MONTHS}` };
  }
  if (input.end !== undefined && !isMonth(input.end)) {
    return { error: "--end must be a month written as YYYY-MM, e.g. --end 2026-08" };
  }

  const lastComplete = addMonths(monthOf(now), -1);
  const months = input.months === undefined ? DEFAULT_WINDOW_MONTHS : Number(input.months);
  const end = input.end ?? lastComplete;
  const start = addMonths(end, -(months - 1));

  const problems = [];
  if (months < MIN_WINDOW_MONTHS) problems.push(`a Window needs at least ${MIN_WINDOW_MONTHS} months`);
  if (end > lastComplete) problems.push(`${end} is not complete yet; the last complete month is ${lastComplete}`);
  if (start < FIRST_DATA_MONTH) problems.push(`the Window would start in ${start}, but pageview data begins in July 2015`);
  if (problems.length > 0) {
    const nearest = nearestValid(months, end, lastComplete);
    return {
      error: `invalid Window: ${problems.join("; ")}. Nearest valid Window: --months ${nearest.months} --end ${nearest.end}`,
    };
  }
  return { window: { months, start, end } };
}

function nearestValid(months: number, end: string, lastComplete: string): { months: number; end: string } {
  let validEnd = end > lastComplete ? lastComplete : end;
  let validMonths = Math.max(months, MIN_WINDOW_MONTHS);
  if (addMonths(validEnd, -(validMonths - 1)) < FIRST_DATA_MONTH) {
    validMonths = monthsFrom(FIRST_DATA_MONTH, validEnd) + 1;
  }
  if (validMonths < MIN_WINDOW_MONTHS) {
    validMonths = MIN_WINDOW_MONTHS;
    validEnd = addMonths(FIRST_DATA_MONTH, MIN_WINDOW_MONTHS - 1);
  }
  return { months: validMonths, end: validEnd };
}
