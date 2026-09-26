// The Narrative: the only text of a Report the agent writes (spec "Report", ADR 0003). The report command
// checks it here and lists every problem, so the agent can fix them all in one edit.

/** Character limits that keep the Report on one page, at its longest Run and in Ukrainian. */
// SKILL.md's Report section states these limits for the agent; change it with them.
const NARRATIVE_LIMITS = { headline: 90, finding: 200, recommendation: 200, nextStep: 160 } as const;
const MAX_FINDINGS = 3;

export type Narrative = {
  /** The Report language, e.g. "uk"; it picks the fixed labels. */
  language: string;
  headline: string;
  findings: string[];
  recommendation: string;
  nextStep: string;
};

const FIELDS = ["language", "headline", "findings", "recommendation", "nextStep"] as const;

/** The Narrative in a Narrative file's text, or every problem to fix, each naming its field. */
export function parseNarrative(text: string): { narrative: Narrative } | { problems: string[] } | { notJson: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { notJson: (error as Error).message };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { problems: [`the file must hold one JSON object with the fields ${fieldList()}.`] };
  }
  const fields = value as Record<string, unknown>;
  const problems: string[] = [];
  const language = fields.language;
  if (language === undefined) {
    problems.push(`language: missing. Give the Report language as a code, e.g. "en" or "uk".`);
  } else if (typeof language !== "string" || !/^[a-z]{2,3}(-[a-z0-9]+)*$/i.test(language.trim())) {
    problems.push(`language: ${JSON.stringify(language)} isn't a language code; use one like "en" or "uk".`);
  }
  const headline = textField(fields, "headline", NARRATIVE_LIMITS.headline, problems);
  const findings = findingsField(fields.findings, problems);
  const recommendation = textField(fields, "recommendation", NARRATIVE_LIMITS.recommendation, problems);
  const nextStep = textField(fields, "nextStep", NARRATIVE_LIMITS.nextStep, problems);
  for (const name of Object.keys(fields)) {
    if (!(FIELDS as readonly string[]).includes(name)) {
      problems.push(`${name}: not a Narrative field. The fields are ${fieldList()}.`);
    }
  }
  if (problems.length > 0) return { problems };
  return {
    narrative: {
      language: (language as string).trim(),
      headline: headline!,
      findings: findings!,
      recommendation: recommendation!,
      nextStep: nextStep!,
    },
  };
}

function textField(
  fields: Record<string, unknown>,
  name: string,
  limit: number,
  problems: string[],
): string | undefined {
  if (fields[name] === undefined) {
    problems.push(`${name}: missing. Give it as text of at most ${limit} characters.`);
    return undefined;
  }
  return checkText(name, fields[name], limit, problems);
}

function findingsField(value: unknown, problems: string[]): string[] | undefined {
  if (value === undefined) {
    problems.push(`findings: missing. Give a list of 1 to ${MAX_FINDINGS} texts.`);
    return undefined;
  }
  if (!Array.isArray(value)) {
    problems.push(`findings: must be a list of 1 to ${MAX_FINDINGS} texts.`);
    return undefined;
  }
  if (value.length < 1 || value.length > MAX_FINDINGS) {
    problems.push(`findings: give 1 to ${MAX_FINDINGS} findings, not ${value.length}.`);
    return undefined;
  }
  const findings = value.map((finding, i) =>
    checkText(`findings[${i + 1}]`, finding, NARRATIVE_LIMITS.finding, problems),
  );
  return findings.every((finding) => finding !== undefined) ? findings : undefined;
}

/** The text, trimmed and on one line, or undefined after adding its problem. */
function checkText(name: string, value: unknown, limit: number, problems: string[]): string | undefined {
  if (typeof value !== "string") {
    problems.push(`${name}: must be text.`);
    return undefined;
  }
  const text = value.replace(/\s+/g, " ").trim();
  // Counted in characters as a reader sees them, so a Cyrillic letter counts once.
  const length = [...text].length;
  if (length === 0) {
    problems.push(`${name}: empty. Give it as text of at most ${limit} characters.`);
    return undefined;
  }
  if (length > limit) {
    problems.push(`${name}: ${length} characters, over the limit of ${limit}. Shorten it.`);
    return undefined;
  }
  return text;
}

/** The Narrative's fields, as "language, headline, … and nextStep". */
export function fieldList(): string {
  return `${FIELDS.slice(0, -1).join(", ")} and ${FIELDS.at(-1)}`;
}
