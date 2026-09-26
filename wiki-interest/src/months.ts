// Calendar months as "YYYY-MM" strings, which sort and compare correctly as text.

export function monthOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

export function addMonths(month: string, count: number): string {
  const index = toIndex(month) + count;
  const year = Math.floor(index / 12);
  return `${year}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** Number of months from `from` to `to`; 0 when they are the same month. */
export function monthsFrom(from: string, to: string): number {
  return toIndex(to) - toIndex(from);
}

/** Every month from `start` to `end`, inclusive. */
export function monthRange(start: string, end: string): string[] {
  return Array.from({ length: monthsFrom(start, end) + 1 }, (_, i) => addMonths(start, i));
}

export function daysInMonth(month: string): number {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year!, monthNumber!, 0)).getUTCDate();
}

export function isMonth(text: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(text);
}

function toIndex(month: string): number {
  const [year, monthNumber] = month.split("-").map(Number);
  return year! * 12 + monthNumber! - 1;
}
