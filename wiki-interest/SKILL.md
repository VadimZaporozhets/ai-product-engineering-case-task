---
name: wiki-interest
description: Research how interest in topics changes across Wikipedia language editions, using Wikimedia pageview data, to help decide which product topics to build and which language audiences to launch in. Produces a ranked comparison with a growth direction and confidence for each topic and language, a chart, and a shareable one-page PDF report. Use when the user asks about interest trends, demand or audience comparisons for a topic across languages or countries, or mentions Wikipedia pageviews.
compatibility: Requires Node.js 22.18 or newer with npm, and network access to wikimedia.org and wikidata.org.
---

# wiki-interest

Measures how many human readers look up a Topic in a Wikipedia Edition (one language version), and how that changes over a Window of complete months. The code computes every number and every Verdict. Your job is to choose the arguments, check the mapping, and explain the output in the user's language.

`<skill>` below stands for this skill's folder, the base directory this file was loaded from. Run every command from the user's working directory: each Run is saved there, in its own folder under `wiki-interest-runs/`.

## Setup (once)

Install the dependencies without dev tooling:

```sh
npm ci --omit=dev --prefix <skill>
```

A command that prints `setup error:` (exit 4) names its own fix:

- Dependencies not installed: run the `npm ci --omit=dev --prefix ...` line it prints, then your command again.
- Node.js too old: tell the user to install Node.js 22.18 or newer (the message suggests `nvm install 24`). Installing Node is the user's step.

## Workflow

1. **Turn the question into arguments** (next section).
2. **Run `analyze`** with every Topic and Edition of the question in one call:
   ```sh
   node <skill>/scripts/wiki-interest.js analyze --topics astronomy --editions uk,pl
   ```
   - Exit 0, or exit 2 (some requests failed: `error:` rows, or a Missing article whose candidate search failed): go to step 3.
   - Exit 3, `blocked: Ambiguous topic`: show the user the candidate meanings with their descriptions, ask which one they mean, and stop until they answer. If Wikidata found no items, ask the user to check the name or its language instead.
   - Exit 3, any other `blocked:` (unknown Edition code, invalid Window, too many Topics or Editions): fix the arguments as the message says and run again. Ask the user only when the fix depends on what they meant.
   - Exit 4: see Setup.
3. **Check the mapping**, the `resolution:` block. It names the Wikidata item chosen for each Topic, with its description. If the description doesn't fit the user's context (a music app asking about "Mercury" got the planet), run the `resolve` command printed under `next steps:`, pick the item that fits, and run the `rerun:` line again with that item id in `--topics`. Ask the user only if no candidate clearly fits.
4. **Answer from the output**, in the user's language, filling in this template in order. Show the mapping and carry on without waiting; the user doesn't need to confirm it first.
   ```
   Measured: <item id> <label> (<description>); <edition>: <Article>, <edition>: <Article>, <edition>: Missing article
   Window: <first month> to <last month> (<n> months)
   <one line per row, in the printed order: Topic, Edition, the Verdict wording, Growth and Raw change worded as in "Reading the output", median monthly views>
     Reasons: <each Reason of that row, in plain words>
   Caveats: Interest is not willingness to pay. An Edition is a language, not a country.
   Chart: <path from the chart: line>
   ```
   Repeat the `Measured:` line for each Topic. Add your own conclusion after the template only if the user asked for a recommendation, and word it to match the Confidence.
5. **Make a Report if the user asks for a PDF** (see Report).

Budget: a common question takes at most 2 skill commands (`analyze`, plus `report` for a PDF) and at most 4 tool calls including the PDF, not counting Setup. Use `resolve` only when step 2 or 3 sends you there.

## Rules

- **Never compute or estimate numbers.** Copy every number from the output exactly as printed. If the user wants a figure the output doesn't have (a total, a difference between rows, a forecast), say the tool doesn't give it.
- **Never substitute Articles.** Analyse only the Articles in `resolution:`. Add another with `--add-article` only when the user picks it.
- **Name only what the Run analysed.** Call each Edition by its language as its code says (`uk` is Ukrainian Wikipedia, read by the Ukrainian-speaking audience; `pl` is Polish Wikipedia). Never mention an Edition, language, audience or country the Run didn't analyse, in the answer or in the Narrative. Suggest follow-up checks in general terms (search trends, user interviews), without naming services the user didn't mention.
- **Always state the Confidence and its Reasons** next to every Direction.
- **Always include both Caveats**: Interest is not willingness to pay, and an Edition is a language, not a country.
- **When the user's idea of "promising" isn't a `--rank` option**, keep the default ranking, reason over the ranked table in prose, and say that this judgement is yours, not the tool's.
- **When the user asks "why?"** about a Verdict, a metric or a Check, read [references/metrics.md](references/metrics.md) and explain from it.

## Turning words into arguments

### Topics: `--topics`

Comma-separated Topic names as the user says them, quoted when they contain spaces: `--topics 'intermittent fasting,yoga'`. At most 5.

- Names in another language: add that language's code, `--topics астрономія --name-lang uk`. One Run has one `--name-lang`, so when the user mixes languages, write the names in English.
- A Wikidata item id (`Q333`) skips the name search. Ids and names can be mixed: `--topics Q333,yoga`.
- A broad Topic can take more Articles when the user wants them: `--add-article '<Topic as in --topics>:<edition>:<Article title>'`, once per Article. Views are summed.

### Editions: `--editions`

Comma-separated Wikipedia language codes, at most 10. Most are ISO 639-1 codes. These are the ones that are easy to get wrong:

| Language | Code | Language | Code |
|---|---|---|---|
| Ukrainian | `uk` (not ua) | Czech | `cs` (not cz) |
| Greek | `el` (not gr) | Danish | `da` (not dk) |
| Swedish | `sv` (not se) | Estonian | `et` (not ee) |
| Japanese | `ja` (not jp) | Korean | `ko` (not kr) |
| Chinese | `zh` (not cn) | Hebrew | `he` (not il) |
| Norwegian (Bokmål) | `no` (not nb) | Slovenian | `sl` (not si) |
| Serbian | `sr` (not rs) | Georgian | `ka` (not ge) |
| Kazakh | `kk` (not kz) | Persian | `fa` (not ir) |
| Vietnamese | `vi` (not vn) | Hindi | `hi` (not in) |

**Country names** map to the Edition of the country's main language, or one Edition per main language: Poland `pl`, Ukraine `uk`, Czechia `cs`, Switzerland `de,fr,it`, Belgium `nl,fr`, Canada `en,fr`, Brazil `pt`. Every time you map a country, tell the user that an Edition is a language, not a country: `pt` counts readers in Portugal, Brazil and everywhere else, and `en` can't single out any one English-speaking country.

### Window: `--months` and `--end`

The Window is exactly the span the user names, in complete months. The current month is never included.

| The user says | Arguments |
|---|---|
| nothing about time | none (the last 24 complete months) |
| "the last 6 months" | `--months 6` |
| "the last year", "the past 12 months" | `--months 12` |
| "the last 2 years" | `--months 24` |
| "the last 3 years" | `--months 36` |
| "in 2025" | `--months 12 --end 2025-12` |
| "since March 2025" | `--months <count of months from 2025-03 to the last complete month, both included>` |

Counting the months of a Window is the one number you work out yourself. Check that the `window:` line in the output shows the months the user meant.

**Windows that aren't a multiple of 24 months** (6, 12 or 36 months, e.g. "the last 3 years") always fail the seasonality Check, because the two halves of the Window cover different times of year. So their Confidence is at most medium. Run the Window the user asked for, then explain the lower Confidence and offer the length the Reason suggests (`Re-run with --months 24 to compare whole years`). Windows of 4 months or fewer also fail the consistency Check whenever they show growth or decline, so they come out low.

### Ranking: `--rank`

| What "promising" means to the user | Option |
|---|---|
| fastest growing, rising, gaining momentum | `growth` (the default; leave it out) |
| biggest audience, most readers, most views | `interest` |
| most popular for the size of its Edition | `share` |
| anything else (least competition, cheapest to localise, steadiest) | the default, then reason in prose and say so |

## Reading the output

In order:

- `rerun:` the exact command, with Wikidata item ids instead of names and an explicit end month. Follow-ups edit this line.
- `window:` the months analysed.
- `resolution:` per Topic, the item chosen and why, then the Basket in each Edition. Articles you added are marked `(chosen by the agent)`. A `Missing article` line lists search candidates that were **not** analysed.
- `ranked by ...:` rows with high or medium Confidence, best first by the ranking criterion.
- `not enough evidence ...:` rows with low or insufficient Confidence, Missing articles and `error:` rows. These are never winners: word their Direction as low Confidence, or say there is too little data.
- Table columns: Direction (growing, flat, declining, or none), Confidence (high, medium, low, insufficient), Growth and Raw change (second half of the Window against the first), median monthly views, and views per million Edition views (Share of edition). With `--rank share` the last column is the second half of the Window only.
  - **Growth is the change in Share of edition, not in views.** Say "its share of Ukrainian Wikipedia's views fell 46.4%" (or rose), never "views fell 46.4%".
  - **Raw change is the change in views.** Say "the number of views fell 59.6%".
  - When the two differ, Growth is the one the Verdict is judged on: the whole Edition's traffic changed too.
- `reasons:` one Reason per failed Check, under each row with lowered Confidence.
- `caveats:` pass both on.
- `next steps:` what to do next for this Run. Follow them.
- `run file:` the full Run as JSON. `chart:` an SVG chart of monthly Share of edition, one line per row in table order, at most 8. Ranked rows are solid lines. `not enough evidence` rows with views are dashed and labelled `(low confidence)` or `(insufficient)`; don't read a Direction from their shape. Triangles mark the months holding a row's 5 highest-view days when its Spike Check failed. To draw a row the chart leaves out, add `--highlight '<Topic as in --topics>:<edition>'` to the `rerun:` line (at most 8). Give the user the path, or show the chart if you can.

## Verdict wording

Give the meaning in the user's language. Put the Reasons right after the wording.

| Direction | Confidence | Say |
|---|---|---|
| growing | high | Interest is growing. |
| growing | medium | Interest is probably growing, with one reservation: (the Reason). |
| growing | low | An early signal of growth, not evidence. |
| flat | high | Interest is steady. |
| flat | medium | Interest looks steady, with one reservation: (the Reason). |
| flat | low | No clear change; an early signal, not evidence. |
| declining | high | Interest is declining. |
| declining | medium | Interest is probably declining, with one reservation: (the Reason). |
| declining | low | An early signal of decline, not evidence. |
| none | insufficient | Too little data to judge a direction. |
| none | insufficient, Missing article | Can't be measured: this Edition has no Article on the Topic. That itself says the Edition covers the Topic poorly. |
| `error:` row | none | Couldn't be loaded: (the reason printed). |

## Follow-ups

Copy the `rerun:` line, edit it, and run it. Months already fetched come from the cache, and every Run gets a new folder, so earlier Runs stay on disk.

| The user says | Edit |
|---|---|
| "add Slovak" | append `,sk` to `--editions` |
| "make it 48 months" | change `--months`, keep `--end` |
| "add yoga" | append `,yoga` to `--topics` (names and ids can be mixed) |
| "rank by audience size" | add `--rank interest` |
| "use Głodówka lecznicza for Polish" | add `--add-article 'Q1666254:pl:Głodówka lecznicza'` |
| "show astronomy in Polish on the chart" | add `--highlight 'Q333:pl'` |

## Blocked Runs, Missing articles and errors

**Ambiguous topic** (exit 3). The Run stops and lists meanings, most Wikipedia Articles first:

```
blocked: Ambiguous topic "Mercury" (en): no exact label or alias match has at least 3 times as many Wikipedia Articles as the next. Candidates, most Wikipedia Articles first:
  Q308 Mercury: first planet from the Solar System and smallest among all, tellurian and with extreme temperatures (250 Wikipedia Articles)
  Q925 mercury: chemical element with symbol Hg and atomic number 80 (176 Wikipedia Articles)
  Q1150 Mercury: Roman god of trade, merchants, thieves and travel (84 Wikipedia Articles)
  Q1231263 Mercury: commune in Savoie, France (35 Wikipedia Articles)
  Q613883 Mercury: automobile marque of the Ford Motor Company (27 Wikipedia Articles)
  +34 more with fewer Wikipedia Articles
next steps:
  - Ask the user which meaning they mean, showing the descriptions above, then re-run with its Wikidata item id in place of <item id>:
    node .../wiki-interest.js analyze --topics '<item id>' --editions uk --months 24 --end 2026-08
  - If none fits, check the spelling, give the name's language with --name-lang (e.g. --name-lang uk), or list more meanings with the resolve command.
```

Ask the user, then run the printed command with their item id. `node <skill>/scripts/wiki-interest.js resolve --topic Mercury --editions uk` lists the same top meanings with the Article each links in every Edition; it doesn't list the `+N more`. If the user wants a meaning that isn't listed, ask for a more specific name or its Wikidata item id.

**Missing article** (a finding, not an error; exit 0 unless its candidate search failed). The Edition has no Article linked to the item:

```
    pl: Missing article, no Article is linked to Q1666254; search candidates, not analysed: "Stres oksydacyjny", "Głodówka lecznicza", "Paleolityczny styl życia"
```

Word it as in the Verdict wording table: Polish interest can't be measured this way, and the gap says Polish Wikipedia covers the Topic poorly. The candidates may be unrelated (here none is intermittent fasting). Analyse one only if the user picks it, with `--add-article`. When the line says the search for candidates failed (exit 2), the Article is still missing; only the candidates are unknown.

**Other blocked Runs** (exit 3) say what to change:

```
blocked: unknown Edition code: ukk. Wikimedia has no pageviews for ukk.wikipedia.org in the Window. Use Wikipedia language codes such as en, uk, pl or zh-min-nan.
blocked: invalid Window: 2026-09 is not complete yet; the last complete month is 2026-08. Nearest valid Window: --months 24 --end 2026-08
blocked: a Run analyses at most 5 Topics and 10 Editions, and this one asks for 6 Topics. Ask the user which matter most, or split the question into these Runs, which share one Window, and answer from all of their tables:
  node .../wiki-interest.js analyze --topics 'a,b,c' --editions uk --months 24 --end 2026-08
  node .../wiki-interest.js analyze --topics 'd,e,f' --editions uk --months 24 --end 2026-08
```

Fix the Edition code, use the nearest valid Window and tell the user, or run each printed smaller Run and answer from all of their tables.

**Failed requests** (exit 2). The row reads `error: <reason>` and the Run keeps every other row. Answer from the other rows and name what failed. If the reason is about an `--add-article` (not an Article, only a redirect), correct or drop that option in the `rerun:` line; otherwise run the `rerun:` line again later. `resolve` also exits 2, with an `error:` line, when it can't reach Wikidata; try it again later.

## Report

1. Write a Narrative file, a JSON object, into the Run folder (the folder of the `run file:` path), e.g. `<Run folder>/narrative.json`.
2. Run:
   ```sh
   node <skill>/scripts/wiki-interest.js report --run <Run folder> --narrative <Run folder>/narrative.json
   ```
3. Give the user the path from the `report:` line.

The Report's table, chart, Basket definitions, method and Caveats come from the Run. You write only the Narrative:

| Field | Content | Limit |
|---|---|---|
| `language` | the user's language code, e.g. `"uk"` or `"en"` | a language code |
| `headline` | the answer in one line | 90 characters |
| `findings` | a list of 1 to 3 findings, each with its Direction, Confidence and the numbers behind it, Growth and Raw change worded as in "Reading the output" | 200 characters each |
| `recommendation` | what to do, worded to match the Confidence | 200 characters |
| `nextStep` | the next check or decision | 160 characters |

Write the Narrative in the user's language. Every number in it is copied from the output, and every Edition and audience it names is one the Run analysed. The Report's fixed labels exist in English and Ukrainian; any other language gets English labels around your Narrative.

```json
{
  "language": "en",
  "headline": "Intermittent fasting: small, falling interest in Czech; no Polish article",
  "findings": [
    "Czech Wikipedia: probably declining (its share of Czech Wikipedia's views fell 47.0%), medium Confidence: median monthly views are only 232.",
    "Polish Wikipedia has no Article on intermittent fasting, so Polish interest can't be measured this way."
  ],
  "recommendation": "Don't build a Czech or Polish intermittent fasting course on this evidence alone.",
  "nextStep": "Check search data for the Topic in Czech and Polish before deciding."
}
```

If the command prints `blocked: the Narrative file needs fixing`, it lists every problem. Fix them all in one edit and run it again.
