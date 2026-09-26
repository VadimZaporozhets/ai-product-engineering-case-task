// Exit codes of the CLI. 1 is left to Node for unexpected crashes.
// scripts/wiki-interest.js repeats `setupError`, because it runs before any TypeScript loads.
export const EXIT_CODES = {
  /** The Run completed. Missing articles and insufficient Confidence are findings, not failures. */
  success: 0,
  /** The Run completed, but requests for some Baskets failed; they are shown as error rows. */
  partialFailure: 2,
  /** No Run was made: invalid input, or a Topic that can't be analysed as asked. */
  blocked: 3,
  /** Node is too old or dependencies aren't installed. */
  setupError: 4,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
