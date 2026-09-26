---
name: wiki-interest
description: Research how interest in topics changes across Wikipedia language editions, using Wikimedia pageview data, to help decide which product topics to build and which language audiences to launch in. Produces a ranked comparison with a growth direction and confidence for each topic and language, a chart, and a shareable one-page PDF report. Use when the user asks about interest trends, demand or audience comparisons for a topic across languages or countries, or mentions Wikipedia pageviews.
compatibility: Requires Node.js 22.18 or newer with npm, and network access to wikimedia.org and wikidata.org.
---

# wiki-interest

Measures how many human readers look up a Topic in a Wikipedia Edition (one language version), and how that changes over a Window of complete months.

All paths below are relative to this skill's folder.

## Setup (once)

Install the dependencies without dev tooling:

```sh
npm ci --omit=dev --prefix <this skill's folder>
```

If a command prints `setup error:`, do what it says: run the printed install command, or tell the user which Node.js version to install. The skill never installs anything by itself.

## Analyze

```sh
node scripts/wiki-interest.js analyze --topics astronomy --editions uk [--name-lang en] [--months 24] [--end 2026-08]
```

- `--topics`: a Topic name as the user says it (`astronomy`, `'intermittent fasting'`), or a Wikidata item id (`Q333`).
- `--name-lang`: the language the Topic name is written in, when it isn't English (`--name-lang uk` for `астрономія`).
- `--editions`: an Edition code (`uk` is Ukrainian Wikipedia).
- `--months`: Window length, at least 2; 24 when the user names no span.
- `--end`: last month of the Window as `YYYY-MM`; defaults to the last complete month.

The output starts with a `rerun:` line holding the exact command, with item ids instead of names and an explicit end month. For a follow-up ("make it 12 months"), edit that line and run it again. The `resolution:` block shows the Wikidata item chosen for each Topic, with its description, and the Article measured in each Edition; show this mapping to the user. If the description isn't what the user meant, run the `resolve` command the next steps print and re-run with the right item id. Then comes one row per Topic and Edition: Direction (growing, flat, declining, or none), Confidence (high, medium, low, insufficient), Growth and Raw change (second half of the Window against the first), median monthly views, and views per million Edition views (Share of edition). Under `reasons:` each Topic and Edition with lowered Confidence lists one Reason per failed Check. The full Run is saved as JSON; its path is on the `run file:` line.

A **Missing article** (`Missing article` in the resolution block, Confidence `insufficient`) means the Edition has no Article linked to the item. It is a finding: tell the user how little that Edition covers the Topic. The search candidates listed with it may be unrelated; never analyse one in its place.

An **Ambiguous topic** blocks the Run (exit 3) and lists candidate meanings with descriptions. Ask the user which one they mean, then re-run with its item id as the output suggests. To explore meanings before analysing:

```sh
node scripts/wiki-interest.js resolve --topic Mercury [--name-lang en] [--editions uk]
```

Quote numbers from the output only. Never compute or estimate them yourself. Always state the Confidence and its Reasons along with the Direction.

## Exit codes

| Code | Meaning | What to do |
|---|---|---|
| 0 | Run completed | Answer from the output |
| 2 | Run completed, but some requests failed (rows marked `error:`), or `resolve` couldn't reach Wikidata (`error:` line) | Answer from the other rows and name what failed, or try again later |
| 3 | Run blocked (`blocked:` line): an Ambiguous topic, an unknown Edition code, or other invalid input | Follow the printed next steps: ask the user which meaning, or fix the arguments |
| 4 | Setup error (`setup error:` line) | See Setup |
