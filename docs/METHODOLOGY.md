# Methodology — how a bscore is computed

This is the technical account, written so you can check the work rather than take
it on faith. Every constant named here is a constant in the code, every number is
either a measured result from the backtest or a value produced by the shipped
engine against the shipped snapshot, and every claim points at the file that makes
it true.

**A bscore is a player's projected fantasy points over the next 14 days, in your
league's own scoring, minus what a freely available replacement at the same roster
slot would score over the same 14 days.** A bscore of 40 means forty more points
than the next man up. It is denominated in your league's points, so it is not
comparable across leagues, and that is the point: the same player is worth
different amounts in different leagues, and the board shows you which.

The engine is pure (`src/engine/`) and runs in the browser against a snapshot of
observed data. Nothing about the ranking happens on a server, so anything below can
be reproduced by loading `public/snapshot.json` and calling `rateAll`.

The worked examples throughout come from one capture — the snapshot of
**2026-09-02T00:23Z**, horizon 2026-09-02 → 2026-09-16 — scored in the reference
league (`yahoo:228947`, 10 teams, H2H points).

---

## 1. Data sources, and exactly what each provides

Five endpoints, all unauthenticated, all fetched server-side into a snapshot
(`src/data/`). Browsers cannot call MLB or Savant directly — neither sends CORS
headers — so a capture step is unavoidable, and having one lets the whole board
state its own age.

| Source | Endpoint | What it provides | Rows in the reference capture |
|---|---|---|---|
| MLB StatsAPI — season lines | `/stats?stats=season&group=…&playerPool=All` | every counting stat, season to date, per player, plus team, primary position, MLBAM id | 731 hitters, 836 pitchers |
| MLB StatsAPI — window lines | `/stats?stats=byDateRange&startDate=…&endDate=…` | the same counting stats accumulated strictly inside a date window; this is the recent-form input | one pull per window per side |
| MLB StatsAPI — schedule | `/schedule?startDate=…&endDate=…` | real games each team has scheduled in the horizon, and real games played in each lookback window | 30 teams |
| MLB StatsAPI — roster status | `/teams/{id}/roster?rosterType=fullSeason` | injured-list status | 203 players |
| Baseball Savant — expected stats | `/leaderboard/expected_statistics?min=1&csv=true` | xwOBA, wOBA, xBA, xSLG, PA, and the `est_woba − woba` gap | 641 batters, 834 pitchers |
| Baseball Savant — Statcast | `/leaderboard/statcast?min=1&csv=true` | barrel rate, hard-hit rate, average exit velocity, sweet-spot rate | joined onto the above by `player_id` |
| MLB StatsAPI — standings | `/standings?standingsTypes=regularSeason` | team games played to date, the denominator for a per-team-game rate | 30 teams |
| Yahoo (local server only) | public league player pages | who is actually still available in your league | optional; see §8 |

Everything above is **observed**. The snapshot stores no projections and no
bscores, because those depend on a league's scoring and have to be recomputed
whenever it changes.

### Coverage decisions that materially change the answer

- **`playerPool=All`, not the default.** The qualified leaderboard is roughly a
  third of the real pool and excludes precisely the part-time and recently
  promoted players a waiver recommender exists to surface.
- **Savant `min=1`, not `min=q`.** Qualified covers ~240 of ~720 batters; `min=1`
  lifts batter coverage to 641. In the reference capture, 1,418 of 1,423 pooled
  players have an xwOBA.
- **Expected stats are keyed by side, never merged.** 133 players appear in both
  the batter and pitcher leaderboards. A flat merge let pitcher rows overwrite
  batter rows, and 37 real hitters were briefly being described by their
  xwOBA-*against*. A batter's xwOBA and a pitcher's xwOBA-against are opposite
  quantities and are stored in separate maps.
- **Injury status is filtered to the D-prefixed IL codes.** The roster feed
  reports every non-active status; of 709 such entries in one sample, 513 were
  Reassigned to Minors, Traded, Released, Claimed or DFA. Showing "Traded" under
  an injury flag would be simply wrong.
- **Pool hygiene by position, not workload.** A pitcher who took three plate
  appearances is not a fantasy hitter; a first baseman who mopped up an inning is
  not a fantasy pitcher. Both directions are filtered on position, with `TWP`
  (two-way) players legitimately appearing on both sides. Without this, zero-PA
  pitchers appeared as Util bats and dragged the Util replacement level down.

### What no source gives us, and is therefore never assumed

Multi-position eligibility as *your* league defines it, probable starters,
lineup order, platoon splits, weather, and bullpen roles. Park factors *are*
fetched (`fetchParkFactors`) and are currently **not** applied anywhere in the
projection — they are available and unused, which is stated here rather than
implied by their presence in the codebase.

### Cadence

CI recaptures on every push and on a schedule at 11:00 and 23:00 UTC. The UI
prints the capture age next to the heading and flags it past 36 hours, so the
board can never quietly serve numbers from whenever someone last pushed code.

---

## 2. From a stat line to points

`src/engine/points.ts` converts a stat line into the points a specific league
awards. It is a documented correspondence between StatsAPI field names and the
stat codes leagues use — a lookup table, not an inference.

```
points = Σ over each scored code c:  value_c(statline) × pointsPerUnit_c
```

Two properties matter:

- **Singles are derived, not estimated.** `1B = hits − doubles − triples − homeRuns`,
  from observed values only. If `hits` is missing the result is `null`, not zero.
- **A category we cannot source is reported, never zeroed.** If a league scores a
  code with no mapping, or the mapping returns `undefined`, the code goes into
  `unscoreable` and is surfaced in the UI. Silently dropping it would understate
  every player who accrues it, and would do so invisibly.

Every total keeps its per-category `breakdown`, so any number on the board can be
taken apart.

### Worked example — Pete Crow-Armstrong

The reference league's batting table:

```
R 1.9 · 1B 2.6 · 2B 5.2 · 3B 7.8 · HR 10.4 · RBI 1.9 · SB 4.2 · BB 2.6 · HBP 2.6
```

His projected 14-day line scores out as:

| code | projected | × | = |
|---|---|---|---|
| R | 7.995 | 1.9 | 15.19 |
| 1B | 6.235 | 2.6 | 16.21 |
| 2B | 2.159 | 5.2 | 11.23 |
| 3B | 0.560 | 7.8 | 4.37 |
| HR | 3.038 | 10.4 | 31.60 |
| RBI | 7.275 | 1.9 | 13.82 |
| SB | 2.558 | 4.2 | 10.74 |
| BB | 5.676 | 2.6 | 14.76 |
| HBP | 0.879 | 2.6 | 2.29 |
| | | | **120.20** |

`unscoreable: []` — this league scores nothing we can't source.

### Worked example — Dylan Cease

The pitching table is mostly negative: `W 8 · SV 8 · OUT 1 · H −1.3 · ER −3 ·
BB −1.3 · HBP −1.3 · K 3`.

```
W  1.190 ×  8   =   9.52
SV 0     ×  8   =   0
OUT 53.6 ×  1   =  53.60
H  10.514 × −1.3 = −13.67
ER  4.500 × −3   = −13.50
BB  7.829 × −1.3 = −10.18
HBP 0.303 × −1.3 =  −0.39
K  25.566 ×  3   =  76.70
                  ───────
                   102.08
```

Note what this does to the model's incentives: in a league that charges −3 per
earned run, projecting a pitcher's *workload* correctly matters as much as
projecting his *quality*, because outs and strikeouts both scale with volume and
so do the penalties. That is why the projection is built as a volume model with a
rate attached, rather than the other way round.

---

## 3. The projection

`src/engine/project.ts`. This is the only modelled layer in the app, and it is
deliberately small.

### 3.1 The unit

- Hitters: **plate appearances**.
- Pitchers: **outs recorded**.

Both are expressed *per team game*, because the denominator that matters is how
many games the player's team actually plays, and that is read from the real
schedule rather than assumed to be uniform. In the reference horizon teams have between 12 and 15 games; the projection uses
each team's own count.

### 3.2 Season rate and recent rate

```
seasonPerTeamGame = volume / teamGamesPlayed
```

The recent estimate is a weighted blend of several lookback windows, each divided
by the games that team actually played inside that window (`blendWindows`):

| side | windows (days: weight) | rationale |
|---|---|---|
| hitting | `3: 2, 7: 1, 21: 1` | the last series carries extra signal about the current role |
| pitching | `5: 2, 21: 1` | a starter's turn is five days, so five days is the shortest window that contains a start |

### 3.3 The blend, and why the windows differ by side

```
volumePerTeamGame = (1 − w) × seasonPerTeamGame + w × recentPerTeamGame
projectedVolume   = volumePerTeamGame × horizonGames
```

with `w` = **0.75 for hitters, 0.60 for pitchers** (`RECENT_BLEND_WEIGHT`).

The reason the windows differ is **structural, not statistical**. A hitter's role
can change inside a week: he gets the everyday job, or he loses it, and a 7-day
window sees that immediately while a season-long rate takes a month to catch up.
A starter works every fifth day, so seven days of his data is one or two starts —
pure noise about his workload, not information about it. Twenty-one days is the
shortest window in which a starter's actual turn is even visible. The measurement
agreed with the structure: 7 days won for hitters, 21 for pitchers, and no
single window won for both.

This is also the single largest source of accuracy in the whole model — worth
roughly 20% relative Spearman over the naive baseline, more than every other idea
combined.

### 3.4 The rate

The projected line is the player's own per-unit rate scaled to the projected
volume:

```
stats[k] = (value_k / volume) × projectedVolume
```

Rate stats and identifiers (`avg`, `obp`, `slg`, `ops`, `era`, `whip`, `babip`,
`age`) are skipped, because they do not scale with playing time.

**Pitchers only** get a light blend of their recent rate into the season rate:

```
perUnit = 0.85 × seasonRate + 0.15 × recentRate(21d)
```

`RECENT_RATE_WEIGHT = { hitting: 0, pitching: 0.15 }`. The hitting value is zero
because the same idea failed to beat a coin flip for hitters; see §7.

### 3.5 The Statcast quality multiplier — present, off

The mechanism exists: blend observed wOBA toward expected wOBA with
`λ = min(0.7, PA / (PA + 300))`, take the ratio, clamp it to [0.75, 1.35], and
apply it only to batted-ball outcomes and the run production that tracks them.
The default is `qualityWeight: 0` and `rateAll` never passes anything else, so
**the multiplier is always exactly 1 in the shipped app.** The xwOBA is still
displayed, and the drill-down says in so many words that it is shown and not used.
Why, in §7.

### 3.6 Worked example — the two arithmetic chains

**Pete Crow-Armstrong** (hitter, Cubs, 138 team games played, 14 in the horizon):

```
season:  619 PA / 138 games                       = 4.4855 PA per team game
recent:  3d 2.5000, 7d 3.5714, 21d 4.3000
         (2×2.5 + 1×3.5714 + 1×4.3) / 4          = 3.2179 PA per team game
blend:   0.25 × 4.4855 + 0.75 × 3.2179           = 3.535
volume:  3.535 × 14 games                        = 49.5 PA
```

His season HR rate is 38/619 = 0.06139 per PA, so 0.06139 × 49.5 = 3.04 home runs,
× 10.4 points = 31.60 — the largest line in the table above. Note that the blend
projects him *below* his season rate: he has been playing less over the last three
days than over the season, and the model says so rather than smoothing it away.

**Dylan Cease** (pitcher, Blue Jays, 138 team games played, 14 in the horizon):

```
season:  451 outs / 138 games                    = 3.268 outs per team game
recent:  5d 4.4000, 21d 3.7895
         (2×4.4 + 1×3.7895) / 3                  = 4.1965 outs per team game
blend:   0.40 × 3.268 + 0.60 × 4.1965            = 3.825
volume:  3.825 × 14 games                        = 53.6 outs  (17.9 innings)
```

53.6 outs across 14 team games is about three starts — which is what a healthy
starter on turn actually gets in a fortnight, and is the number the whole
projection rests on.

### 3.7 What the projection admits it doesn't have

`missing` is populated, not inferred around: no plate appearances or outs on
record, no team games played, no Statcast expected stats. `modelled` names each
knob that was actually applied, with its real parameters. A player with no
projectable volume is marked `rateable: false` and is excluded from the board
rather than ranked at zero alongside real players — 2 of 1,423 in the reference
capture.

---

## 4. Replacement level

`src/engine/bscore.ts`. This is the half of the product that turns a projection
into a recommendation.

### 4.1 The depth is the league's own arithmetic

For each roster slot, replacement level is the projected points of the
**(teams × slots-at-that-position)-th best eligible player**. That is literally
the best player still on waivers once every team in the league has filled that
slot. `BN`, `IL` and `NA` are excluded, because a bench spot doesn't create demand
for a specific position.

```
depth_slot       = teams × count_slot
replacement_slot = points of the depth-th best eligible player at that slot
bscore           = max over the player's slots of (points − replacement_slot)
```

A player eligible at several slots is credited at the slot where he is worth
most, and the board shows which one won.

**`teams` is required, never defaulted.** If a league's settings don't state a
team count, `useBoard` returns an empty board rather than picking a number.
Defaulting it would silently move every replacement level and therefore every
bscore on the page — exactly the kind of quiet assumption the product exists to
refuse.

### 4.2 The reference league, computed

10 teams, roster `C 1 · 1B 1 · 2B 1 · 3B 1 · SS 1 · OF 3 · Util 2 · SP 2 · RP 2 · P 4`:

| slot | slots × teams = depth | eligible players | replacement (proj. pts / 14d) | best available at the slot |
|---|---|---|---|---|
| Util | 20 | 639 | **84.15** | 120.2 |
| 1B | 10 | 52 | 76.31 | 93.2 |
| SP | 20 | 350 | 68.51 | 102.1 |
| OF | 30 | 231 | 66.61 | 120.2 |
| SS | 10 | 56 | 65.79 | 85.2 |
| 2B | 10 | 74 | 65.29 | 75.4 |
| 3B | 10 | 64 | 63.44 | 96.3 |
| P | 40 | 782 | 56.18 | 102.1 |
| C | 10 | 100 | **53.71** | 82.8 |
| RP | 20 | 432 | 34.81 | 75.8 |

Util's bar is the highest in the league, and correctly so: it draws from every
batter in baseball, so the 20th-best option is very good. Catcher's is the lowest
of the batting slots, because the 10th-best catcher is not.

### 4.3 Why this makes catchers rank higher than their raw points

In the reference capture, **Drake Baldwin projects for 82.80 points** over the
horizon. That is **30th** among all rateable players by raw projected points — a
useful bat, nothing more.

His bscore is `82.80 − 53.71 = 29.09`, which is **10th on the board**.

The twenty players he passes are ones you can replace almost for free. If you drop
the 30th-best outfielder you can pick up a 66.6-point outfielder off waivers; if
you drop Baldwin you can pick up a 53.7-point catcher. Twenty-nine points of that
gap belongs to him and not to the position, and points-above-replacement is what
puts it there. Note also that the slot choice does real work: valued at Util
instead, the same 82.80 points would be `82.80 − 84.15 = −1.35`, i.e. worthless.
Catchers are worth having *because* they are catchers.

The same arithmetic explains the other direction. **141 of 1,421 rateable players
have a positive bscore** in a 10-team league. Most of MLB is below replacement,
which is true and is the reason the board's numbers go deeply negative rather
than bottoming out at zero.

---

## 5. Confidence

`confidenceOf` in `src/engine/project.ts`. Confidence is how much real data stands
behind a projection. It is explicitly **not** the odds the player plays well.

```
sample   = min(1, volume / fullSeason(role))
statcast = 1 if xwOBA exists, else 0.6
health   = 1 if not on the IL, else 0.5

confidence = sample × statcast × health
```

Each factor that is below 1 pushes a human-readable reason into `reasons`, and the
drill-down lists them. It is never a flat default: a player with no data gets a
low number and is told why.

### 5.1 The denominator is the player's own workload

`volume` is plate appearances for a hitter and batters faced for a pitcher, and a
full season of those is a different number in every role. A rotation starter faces
about 2.6× what a full-time reliever does. Scoring both against one figure does not
measure sample size — it measures role, and then reports the answer as though it
were a statement about reliability.

So the denominator is per role, and it is read off the capture rather than chosen.
Each figure is the **median season volume among the players who fill that role's
league-wide jobs** — the population is the league's own roster arithmetic, and the
median of it is what holding one of those jobs actually looks like:

| role | jobs in the league | denominator | per team game |
|---|---|---|---|
| hitting | 270 — nine lineup spots × 30 teams | 434 PA | 3.14 |
| starting | 150 — a five-man rotation × 30 teams | 540 BF | 3.91 |
| relieving | 240 — an eight-man bullpen × 30 teams | 209 BF | 1.51 |

The hitting figure lands on 3.14 PA per team game. MLB's own qualification rule for
a batting title is 3.1 PA per team game, set independently and decades earlier — the
derivation reproduces a threshold it was not aimed at, which is the closest thing to
external validation available here.

A pitcher is not sorted into one bucket. His denominator is interpolated on the
share of his appearances that were starts:

```
fullSeason = 209 + (gamesStarted / gamesPitched) × (540 − 209)
```

A bucketing rule would put a swingman on a cliff — 12 starts in 25 games scored as a
reliever, 13 as a starter, and his confidence halved by one game. The interpolation
is also the more honest reading: a pitcher who starts 60% of the time really does
have a workload 60% of the way between the two. A pitcher whose appearances the
source does not report has no role, so he gets no sample credit and the drill-down
says which field was missing, rather than being scored against a role we picked
for him.

### 5.2 Distribution, before and after

Over the 1,423 rateable players in the reference capture, with the old single
400-unit floor on the left and the role denominators on the right:

| bucket | before | after |
|---|---|---|
| 1.0 | 258 | 309 |
| 0.8–0.99 | 80 | 139 |
| 0.6–0.79 | 117 | 115 |
| 0.4–0.59 | 232 | 188 |
| 0.2–0.39 | 245 | 262 |
| 0.0–0.19 | 491 | 410 |
| **≥ 0.70** | **379** | **501** |

with 5 players missing Statcast entirely and 203 flagged on the IL.

Split by role — pitchers classified by whether most of their appearances were
starts — the change is almost entirely where the defect was:

| bucket | hitters (641) | starters (226) | relievers (556) |
|---|---|---|---|
| 1.0 | 147 → 126 | 104 → 79 | 7 → 104 |
| 0.8–0.99 | 55 → 57 | 14 → 22 | 11 → 60 |
| 0.6–0.79 | 54 → 56 | 13 → 22 | 50 → 37 |
| 0.4–0.59 | 92 → 94 | 34 → 28 | 106 → 66 |
| 0.2–0.39 | 103 → 106 | 33 → 36 | 109 → 120 |
| 0.0–0.19 | 190 → 202 | 28 → 39 | 273 → 169 |
| **≥ 0.70** | **223 → 209** | **125 → 113** | **31 → 179** |

Hitters barely move: 434 is close to the 400 it replaced, and it should be, because
400 was a hitter's number and was never wrong for hitters. Starters tighten — 540 is
a real full season of starting work, so a pitcher who missed two months no longer
reads 1.0 on 400 batters faced. Relievers are the fix: on the 432 pitchers who never
started a game, **5** cleared 0.70 before and **112** do now, and 60 of them read 1.0.

The busiest closers are the specific case the old number got backwards:

| | saves | BF | before | after |
|---|---|---|---|---|
| Bryan Baker | 39 | 210 | 0.53 | 1.00 |
| Cade Smith | 35 | 251 | 0.63 | 1.00 |
| Mason Miller | 32 | 219 | 0.55 | 1.00 |
| Jhoan Duran | 29 | 203 | 0.51 | 0.97 |
| Aroldis Chapman | 30 | 189 | 0.47 | 0.90 |

The median confidence of the 30 busiest closers, the 30 busiest starters and the 30
busiest hitters is now 1.0 in all three — which is the property being asserted, and
`test/engine.mjs` asserts it. A "minimum confidence 70%" filter is now a filter on
sample size in every role rather than a filter on relievers.

What it still does, correctly, is mark a reliever who has *not* worked a full season
as thin: Josh Hader reads 0.64 on 134 batters faced, because 134 batters faced is
half a season of relief work and that is a real sample limitation rather than a unit
error.

---

## 6. The backtest

`src/backtest/`. Run with `nub run evaluate`.

### 6.1 Design

A **fold** is a triple `(season, as-of date, side)`. For each fold the harness
builds:

- `prior` — every counting stat accumulated from opening day through the as-of
  date;
- `recent` — the same, over each lookback window ending at the as-of date
  (3, 5, 7, 10, 14, 21, 30 days);
- `underlying` — Savant expected stats computed **only from batted balls inside
  the prior window**;
- `priorGames` / `recentGames` — real games played per team in those windows;
- `futureGames` — real games each team plays in the horizon;
- `actual` — what every player actually did over the horizon.

Then: project forward from `prior` alone, score both the projection and the truth
through the reference league's scoring table, and correlate.

As-of dates are spread evenly through each season by `foldsFor`, always leaving a
21-day warm-up at the front (so nobody is projected off four April at-bats) and a
full horizon at the back. Default: **5 folds per season, 14-day horizon**.

### 6.2 Why it is leak-free

By construction, not by convention. Every fetch carries an explicit date range
ending at the as-of date:

- StatsAPI: `stats=byDateRange&startDate=<season start>&endDate=<asOf>`;
- Savant: the custom leaderboard with `start_dt` / `end_dt` bounding the same
  window, so xwOBA is computed from batted balls that had already happened;
- schedule counts: `gamesPlayed(seasonStart, asOf)` for the denominator,
  `gamesPlayed(asOf+1, asOf+horizon)` for the numerator, with only `Final` games
  counted.

There is no season-total endpoint anywhere in the harness, so there is no path by
which a full-season figure could reach a projection. The evaluation window starts
at `asOf + 1` day, so the as-of date itself is never in both halves.

**2020 is excluded automatically**, by arithmetic rather than by a special case:
its regular season ran 23 July – 27 September, 66 days; `foldsFor` requires
`span − horizon − 21 ≥ 40`, and `66 − 14 − 21 = 31`. It produces no folds and the
run says so. That leaves **10 usable seasons, 2016–2026, 5 folds each, 2 sides =
100 folds, 50 per side**.

### 6.3 Population and metrics

Each fold's population: at least **80 PA** (hitters) or **60 batters faced**
(pitchers) in the prior window, a known team, the right side of the ball, and a
non-zero game count both behind and ahead. Folds with fewer than 20 qualifying
players are dropped.

Metrics, per fold:

- **Spearman ρ** between projected points and actual points, with tie-averaged
  ranks. Rank correlation, not RMSE, because the product is a ranking.
- **Top-20 actual points** — the mean points actually delivered by the 20 players
  the model ranked highest. This is what a manager actually gets.
- **Folds won** — how many of the 50 folds the variant beat the baseline in,
  paired fold by fold.

The paired count is the one that decides anything. A mean ρ difference of 0.001
across 50 noisy folds is not evidence, and the fold count is what exposes that.

### 6.4 The baseline

"He'll keep doing what he's been doing": season-to-date points divided by games
played, times games ahead.

```
naive = (seasonPoints / gamesBehind) × gamesAhead
```

This is a genuinely hard baseline. It already carries the selection effect that
good players accumulate more playing time, and it needs no model at all. Anything
that cannot beat it is not earning its complexity.

### 6.5 Results

50 folds per side, 14-day horizon, 2016–2026:

| side | model | mean ρ | vs naive | folds won |
|---|---|---|---|---|
| hitting | naive baseline | 0.5743 | — | — |
| hitting | `d7_w0.75_q0` | **0.6759** | **+17.7%** | **48 / 50** |
| pitching | naive baseline | 0.4697 | — | — |
| pitching | `d21_w0.75_q0_rate0.15` | **0.5318** | **+13.2%** | **49 / 50** |

Two refinements landed after that table was scored, both judged by paired fold
count against the configuration above rather than re-reported as an absolute ρ:

- **Multi-window playing time.** Weighting the most recent ~3 days double against
  7- and 21-day windows beat the single-window model in **40 of 50 hitting folds**.
  Pitchers use 5 days rather than 3, for the turn-length reason in §3.3.
- **A lighter recent weight for pitchers**, `w = 0.60` rather than 0.75.

The shipped constants today are therefore `RECENT_WINDOW_WEIGHTS`,
`RECENT_BLEND_WEIGHT` and `RECENT_RATE_WEIGHT` in `src/engine/project.ts`, and the
headline ρ figures belong to the single-window ancestor of that configuration.
Saying so is more useful than quoting a number against a config that has moved.

### 6.6 Cost

Every fetch goes through a disk cache (`src/backtest/cache.ts`). The first corpus
build takes ~15 minutes; every sweep after that runs offline in seconds. That is
the whole reason it was practical to test the ideas in §7 instead of guessing at
them.

```sh
nub run evaluate                        # 2016–2026, 5 folds/season, 14-day horizon
nub run evaluate --from=2021 --to=2025  # narrower
nub run evaluate --horizon=7 --folds=8  # a different question
```

---

## 7. The negative results

Two of the model's more interesting ideas were measured and rejected. Both are
still in the codebase, both are off, and both say so in the UI.

### 7.1 The Statcast blend does not earn its place

The hypothesis: a player whose expected wOBA exceeds his actual has been unlucky,
so his projected batted-ball outcomes should be pushed up.

The result: across ten seasons, every parameter sweep ranked `qualityWeight: 0`
first. At a 14-day horizon the blend was consistently neutral-to-slightly-negative
against the naive baseline. It is **off by default**, and `rateAll` never passes a
non-zero weight, so it is off in fact and not merely by default.

Why it is still visible: xwOBA and barrel rate genuinely inform a human reading a
player's page, and hiding them would be its own kind of dishonesty. So they are
shown, and the drill-down states in plain words that the adjustment was evaluated
and not applied. The product's rule is that nothing moves a recommendation
silently — a mechanism that failed its test is exactly the thing that must not
move one.

One thing did survive from that work: the sign. An earlier version inverted the
pitcher case and pushed *unlucky* pitchers' earned runs up, which is backwards. A
pitcher whose expected wOBA-against is below his actual has been unlucky, so the
ratio is < 1 and his projected hits and earned runs come *down*. The bug is fixed;
the mechanism it lived in is still switched off.

### 7.2 Rate shrinkage made things worse

The hypothesis: shrink each observed rate toward the league rate in proportion to
how little volume backs it, with stat-specific stabilisation constants
(`SHRINK_K` — 170 PA for home runs, 60 for strikeouts, 700 for doubles, and so
on, following the published Carleton / Tango stabilisation work).

The result: it lost. The reason is that the naive line *already* carries the
selection effect — good players accumulate more plate appearances — so shrinking
the rate on top of a volume model double-penalises exactly the players it
shouldn't. A part-time hitter with a real skill gets docked twice: once for
playing less, once for having a small sample.

`leagueRatesFrom` and `SHRINK_K` still exist, and `rateAll` **does not pass
`rates`**, so no shrinkage is applied anywhere in the shipped app. The mechanism
is reachable from the backtest only.

### 7.3 The recent-rate blend for hitters is a coin flip

Blending 15% of the 21-day rate beat the previous configuration in **41 of 50**
pitching folds — clear enough to ship. The identical idea for hitters won **29 of
50**, with a mean ρ difference of **+0.0009**.

That is exactly the kind of number that looks like an improvement and is noise. A
mean-difference table would have shipped it. The paired fold count is what caught
it, which is why the harness reports fold counts at all. `RECENT_RATE_WEIGHT`
is `{ hitting: 0, pitching: 0.15 }` — an asymmetry that exists solely because the
evidence was asymmetric.

### 7.4 Why these are reported rather than buried

The product's core principle is that nothing is inferred or silently defaulted. A
projection is an inference, so the rule adapts: every number exposes what it is
made of. A knob that was tried and failed is part of what a number is made of. If
the drill-down said only "playing time × games", a reader would have no way to
know that the xwOBA sitting two columns to the left is decorative — and would
reasonably assume it wasn't. Reporting a failure costs a line of copy; concealing
one costs the reader's ability to check anything.

It is also the honest reading of the headline number. ρ ≈ 0.68 is a real ranking
signal, not clairvoyance. Fourteen days of baseball is mostly variance.

---

## 8. Known limitations, and what would improve it next

Ordered roughly by how much they cost.

**The top-20 column barely separates the variants.** Whatever the ranking
improvement is worth, it is concentrated in the broad middle of the pool — which
is where waiver decisions live — and not at the very top, where the answer was
obvious anyway. Reported plainly rather than folded into the headline.

**The confidence denominators are frozen to one capture.** §5.1 derives 434 / 540 /
209 from the roster arithmetic in the reference snapshot and ships them as
constants. They are not recomputed per capture, so if bullpen size or rotation
usage moves — as both have over the last decade — the numbers go stale silently.
Recomputing them from the pool being ranked would fix that, at the cost of a
confidence scale that shifts underneath you between captures.

**Multi-position eligibility is not real.** `slotsFor` derives slots from
StatsAPI's single primary position. A player your league lists at 2B/OF is treated
as one or the other, which under- or over-states his bscore depending on which
replacement bar he should have been measured against. No source we read exposes
your league's eligibility rules, so it is not guessed at — but it is a real gap,
and it is the largest single accuracy improvement still available.

**Starters are projected per team game, not per turn.** A starter's outs are
averaged across his team's schedule, so a two-start week and a one-start week are
the same number to the model. Wiring in probable-pitcher data would separate them,
and for a 14-day horizon that difference is roughly a factor of two in the biggest
input the pitching model has.

**Injuries are binary.** On the IL or not, a flat 0.5 confidence multiplier, and
no projection-side adjustment for a player expected back mid-horizon. A 60-day IL
player and a day-to-day one are treated identically.

**Park factors are fetched and unused.** The data is there; nothing consumes it.

**No opponent adjustment.** Strength of schedule over the horizon — a two-week
stretch against the best pitching staffs in the league versus the worst — is not
modelled at all, and the schedule data needed to model it is already in the
snapshot.

**Confidence and the projection use different pitcher units.** The projection
counts outs; confidence counts batters faced. They correlate, but they are not the
same denominator, and the inconsistency is untidy.

**The available-players filter needs the local server and a public league.**
`fetchAvailable` reads Yahoo's public player pages, which requires the app running
on your own machine; private leagues need OAuth and are unsupported. On the static
demo the whole board is a ranking of MLB rather than of your waiver wire, which is
half a recommendation.

**The horizon is fixed at capture time.** 14 days, set when the snapshot is built.
A shorter horizon (a weekend, a two-day streaming decision) would need a different
capture, and the schedule denominator would change with it.

---

## Reproducing any of this

```sh
nub run refresh    # capture a fresh snapshot of MLB + Savant into data/snapshot.json
nub run evaluate   # rebuild the corpus and re-score every variant, 2016–2026
nub run backtest   # the smaller single-season fold runner
nub run tune       # sweep window length × blend weight × Statcast weight
nub run test       # engine + UI suites
```

The ranking itself needs no server: load `public/snapshot.json` and a league from
`public/scoring.json`, call `hydrate` then `rateAll`, and every number in this
document falls out. That is the point of keeping `src/engine/` pure.
