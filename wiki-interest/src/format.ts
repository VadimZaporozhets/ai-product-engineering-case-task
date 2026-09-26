// Number formats shared by the result table and the Reasons, so one figure prints the same way in both.

export function percent(share: number, digits = 1): string {
  return `${(share * 100).toFixed(digits)}%`;
}

/** A change such as Growth, with its sign: 0.25 is "+25.0%". */
export function signedPercent(change: number): string {
  return `${change >= 0 ? "+" : ""}${percent(change)}`;
}
