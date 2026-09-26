# Metrics, Checks and thresholds

Read this when the user asks why a Verdict came out as it did, or how a number was made. Explain from it in plain words. The numbers for a specific row are still the ones in the Run's output; this file only says how they were made.

Contents:

- What is counted
- Share of edition
- Growth and Raw change
- Direction
- Confidence and the 7 Checks
- Why short Windows lose Confidence
- Ranking
- How a Topic becomes Articles
- Caveats and what the method leaves out

## What is counted

- **Interest** is views by human readers: Wikimedia's `user` traffic, so bots and automated crawlers are excluded, across desktop, mobile web and the apps. The tool fetches daily views per Article and adds them up per month. A day with no data counts as zero views.
- A **Basket** is the set of Articles that stands for one Topic in one Edition: the Article linked from the Topic's Wikidata item, plus any you added with `--add-article`. Their views are summed.
- **Edition totals** are all human views of the whole Edition (e.g. all of Polish Wikipedia) per month, with the same filters.
- **Months with data** are the months from the first month with data of any Article in the Basket onward. Months before an Article existed don't count; a later month with zero views does.
- **Median monthly views** are the median over months with data. This is the size of the Audience, in views a month.

Only the Window's months are fetched, and the current, incomplete month is never used. Data begins in July 2015.

## Share of edition

Share of edition = the Basket's views ÷ the Edition's total views over the same months × 1,000,000, shown as **views per million** Edition views. It is a ratio of sums: all of the Basket's views over the months, divided by all of the Edition's views over the same months.

Why the Verdict uses it instead of raw views: a whole Edition can gain or lose readers for reasons that have nothing to do with the Topic (readers moving to other sources, changes in how search engines show Wikipedia). If Polish Wikipedia loses 30% of its traffic, raw views of nearly every Topic fall, and every Topic would look like it is declining. Share of edition asks a different question: what part of the Edition's reading goes to this Topic. It also puts large and small Editions on one scale, so 22 views per million in Ukrainian and 9 in Polish mean the Topic takes a bigger part of Ukrainian readers' attention. It does not mean more people: that is median monthly views.

## Growth and Raw change

**Growth** = Share of edition over the second half of the Window ÷ Share of edition over the first half − 1. A 24-month Window ending in 2026-08 compares 2025-09 to 2026-08 with 2024-09 to 2025-08. Each half uses only its months with data, so an Article created partway through doesn't show "growth" from zero. With an odd number of months, the middle month belongs to neither half.

**Raw change** is the same comparison on average monthly raw views. It is printed next to Growth so the user can see how much of the change comes from the Edition's own traffic.

## Direction

- **growing**: Growth above +10%
- **declining**: Growth below −10%
- **flat**: in between

The ±10% band keeps normal month-to-month noise from being read as growth or decline. Raw change gets the same band when the Agreement Check reads it.

## Confidence and the 7 Checks

Each Check is a fixed test of how far the Direction can be trusted. Enough data runs first:

- **insufficient**: Enough data failed. There is no Direction and the other Checks don't run.
- **high**: every Check passes.
- **medium**: exactly one Check fails.
- **low**: two or more fail.

Each failed Check prints one Reason with its numbers. Only high and medium are ranked.

| Check | Fails when | What it means for the decision |
|---|---|---|
| Enough data | the Topic is a Missing article; or either half of the Window has data in fewer than half of its months; or median monthly views are under 100; or the first half has no views to compare the second half with | Too little to judge at all. An Article created in month 12 of a 24-month Window has data in 1 of the first half's 12 months, so it fails. |
| Volume | median monthly views are under 1,000 | At a few hundred views a month, one class assignment or one link from a popular page moves Growth by tens of percent. |
| Consistency | growing or declining: the Mann–Kendall test on monthly Share of edition gives p ≥ 0.05, or its trend goes the other way; flat: the test finds a significant trend (p < 0.05) | The two halves differ, but the months don't rise or fall steadily, so a few months may drive the Growth. For flat, the halves match but a slow steady change is under way. |
| Spikes | the 5 highest-view days hold more than 25% of the Window's views | A burst of news, not lasting Interest, may drive the Growth. The Reason names the days; the chart marks their months with triangles. |
| Agreement | Raw change points the opposite way to Direction (one growing, the other declining) | The Edition's own traffic changed so much that the answer depends on the measure. A flat Direction never fails this Check. |
| Full history | an Article in the Basket has its first data after the Window's first month, or no data in the Window at all | The Article was likely created or renamed partway through, so the Basket's early months are missing. The Reason names the Article and its first month. |
| Seasonality | the Window isn't a multiple of 24 months | The two halves cover different times of year, so a seasonal Topic (exams, holidays, sports seasons) can look like growth or decline. The Reason suggests a Window that compares whole years. |

**The Mann–Kendall test** looks at every pair of months and counts whether the later month is higher or lower than the earlier one. If most pairs go the same way, the series rises or falls steadily. The p-value is the chance of seeing that much order in a series with no trend; under 0.05 counts as a real trend. It says nothing about how big the change is; Growth does that.

**The suggested Window** in the seasonality Reason is the nearest multiple of 24 months, at least 24. Halfway between two, it is the shorter one, so it stays inside the span the user asked about: 36 months suggests 24.

## Why short Windows lose Confidence

The tool analyses exactly the Window the user asks for, and says so when that Window is weak evidence, rather than quietly analysing a different span.

- **Seasonality.** Growth compares the second half of the Window with the first. The halves cover the same calendar months only when each half is a whole number of years, so the Window must be a multiple of 24 months. A 12-month Window ending in August compares September to February with March to August: winter against summer. Every 6-, 12- or 36-month Window fails this Check, so its Confidence is at most medium.
- **Consistency.** With 4 months or fewer, the Mann–Kendall test can't reach p < 0.05 even when every month is higher than the last (4 steadily rising months give p ≈ 0.09). So a Window of 2 to 4 months that shows growth or decline always fails Consistency too, and with Seasonality that makes it low.
- **Fewer months, more noise.** A short Window has fewer days to spread views over, so one news day is a bigger share and the Spike Check fails more easily.

A few months of data can't separate lasting growth or decline from a season or a news cycle. Offer the user the suggested length.

## Ranking

High and medium Confidence rows are ranked, best first, by the chosen criterion:

- `growth` (default): Growth.
- `interest`: median monthly views, the biggest Audience.
- `share`: Share of edition over the second half of the Window, the most recent part of the Edition's reading.

Everything else goes to the `not enough evidence` group, which is never ranked: low Confidence first, then insufficient (including Missing articles), then rows that failed to load. Weak evidence never looks like a winner.

## How a Topic becomes Articles

- The Topic name is searched on Wikidata in its language (`--name-lang`, English by default). Candidates are the items whose label or an alias matches the name exactly, ignoring case. Disambiguation pages are left out. When nothing matches exactly, the Run stops as an Ambiguous topic and lists the closest search hits.
- Each candidate counts its Articles across Wikipedia Editions only (not Commons, Wiktionary or other projects). The candidate with the most is chosen if it has at least 3 times as many as the next. Otherwise the Topic is an **Ambiguous topic** and the Run stops for the user to choose. When measured, "Mercury" stopped (planet 250, element 176) and "astronomy" didn't (252 against 9).
- In each Edition, the Basket is the Article linked from the chosen item. When there is none, the Topic is a **Missing article** in that Edition: its Confidence is insufficient, and up to 3 search results from that Edition are listed but never analysed. A plain search can return unrelated Articles: for intermittent fasting, Polish Wikipedia's top result is about oxidative stress. The gap itself is a finding: that Edition covers the Topic poorly.

## Caveats and what the method leaves out

- **Interest is not willingness to pay.** Views show what people look up, not what they would buy or use.
- **An Edition is a language, not a country.** Polish Wikipedia's readers include Poles abroad and everyone else who reads Polish. English Wikipedia's readers are worldwide.
- Growth isn't corrected for season; the seasonality Check reports the risk instead.
- The Basket is only the linked Article and those the agent adds. Redirects, related Articles and sub-topics aren't counted automatically, so a narrow Article can understate a broad Topic.
- There is no forecast. The Verdict describes the Window that was analysed.
