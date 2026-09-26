// Every threshold of the Verdict, in one place (spec "Metrics and Verdict").
// references/metrics.md states these numbers for the agent, and SKILL.md's Window section relies on seasonMonths and
// significance (Windows not a multiple of 24 months, Windows of 4 months or fewer); change both with them.

export const THRESHOLDS = {
  /** Growth above +10% is growing and below −10% declining; flat in between. Raw change uses the same band. */
  flatBand: 0.1,
  /** Enough data: each half of the Window needs data in at least this fraction of its months. */
  minHalfCoverage: 0.5,
  /** Enough data: median monthly views under this give Confidence `insufficient`. */
  minMedianViews: 100,
  /** Volume: median monthly views under this fail the Check. */
  lowVolumeViews: 1_000,
  /** Consistency: the Mann–Kendall p-value under which a trend counts as significant. */
  significance: 0.05,
  /** Spikes: how many of the highest-view days are summed. */
  spikeDays: 5,
  /** Spikes: the Check fails when those days hold more than this share of the Window's views. */
  maxSpikeShare: 0.25,
  /** Seasonality: both halves cover the same calendar months only when the Window is a multiple of this. */
  seasonMonths: 24,
} as const;
