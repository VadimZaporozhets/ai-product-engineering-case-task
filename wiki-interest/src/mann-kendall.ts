// The Mann–Kendall trend test, two-sided, with the normal approximation corrected for ties and continuity.
// Implemented here rather than taken from a statistics package, to keep the skill's dependencies small.

export type MannKendall = {
  /** Sum of the signs of every later-minus-earlier pair; positive means an upward trend. */
  s: number;
  /** Two-sided p-value; under the significance threshold, the months rise or fall steadily. */
  p: number;
};

export function mannKendall(values: number[]): MannKendall {
  const n = values.length;
  let s = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) s += Math.sign(values[j]! - values[i]!);
  }
  const tieSizes = [...countBy(values).values()];
  const variance = (n * (n - 1) * (2 * n + 5) - tieSizes.reduce((sum, t) => sum + t * (t - 1) * (2 * t + 5), 0)) / 18;
  // A constant series (or one too short to compare) has no trend.
  if (s === 0 || variance === 0) return { s, p: 1 };
  const z = (s - Math.sign(s)) / Math.sqrt(variance);
  return { s, p: Math.min(1, erfc(Math.abs(z) / Math.SQRT2)) };
}

function countBy(values: number[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

/** Complementary error function for x ≥ 0 (Numerical Recipes' erfcc, relative error under 1.2e-7). */
function erfc(x: number): number {
  const t = 1 / (1 + 0.5 * x);
  const polynomial = [
    -1.26551223, 1.00002368, 0.37409196, 0.09678418, -0.18628806, 0.27886807, -1.13520398, 1.48851587, -0.82215223,
    0.17087277,
  ].reduceRight((acc, coefficient) => coefficient + t * acc, 0);
  return t * Math.exp(-x * x + polynomial);
}
