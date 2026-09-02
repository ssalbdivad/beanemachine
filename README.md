# beanemachine

Lineup optimizer for **Mrs. Met's Harem** (Yahoo H2H-points league 228947, team 8).

## Billy

The mascot robot is called **Billy** — after Billy Beane. He's the face of
`beanemachine` and the project's favicon. Use the name in copy, commit messages,
and any future artwork.

- Head-only mark, so he survives being shrunk to 16px.
- Round green specs with **temple arms** hooking back to the head. Those arms are
  the thing that makes them read as glasses rather than big round eyes — don't
  drop them.
- A **glint** stroke across each lens, so the surface reads as glass.
- The **smile must clear the lenses**. Lens bottom sits at `EY + LR + 1.9`; keep
  `SMILE_Y` below that (currently 3.1 units of air). They collided once already.
- The cap **brim is a full half-ellipse, upside down** relative to the crown's dome,
  springing from the single point where the dome's outline meets the base line.
  It does not tuck under the crown and does not overlap it — they touch at one point.
  Angular polygons and tucked beziers both read as disjointed.
- The **NY is the official Mets cap insignia** (`logo/reference-ny.json`), placed by
  its measured bounding box. Hand-simplified monograms were tried across several
  rounds and never held up — the interlock is the recognisable part and it does not
  survive simplification. It's the real trademarked mark: fine for a personal league
  tool, not for merch.

`logo/reference-ny.json` holds that vector. Measured: the glyph is 341x499 —
markedly taller than wide, stems ~8% of its height. Getting those proportions wrong
is what made every redraw look off.

Source of truth: `logo/final-build.mjs`. Run it (`node logo/final-build.mjs`) to
regenerate `public/beanbot.svg` and `logo/final.json`. `src/client/Billy.tsx`
carries the same body as a React component so the mark picks up theme tokens; it
is authored against `--acc`, aliased onto the app's `--accent` in
`src/client/app.css`.

Exploration rounds that got here live in `logo/round*.mjs` with contact sheets in
`logo/sheet*.png`.

## Docs

- **[docs/GUIDE.md](docs/GUIDE.md)** — how to read the board and use it on draft day,
  waiver day and for daily streaming, including why a catcher outranks a better
  hitter. The app links here from "How to read this →".
- **[docs/METHODOLOGY.md](docs/METHODOLOGY.md)** — how a bscore is computed, worked
  through with real numbers, plus the backtest design, what is built on top of a
  bscore, and the negative-results ledger.

## The app

Ranks every MLB player by a **bscore** — projected points over the horizon, minus
what a freely available replacement at the same roster slot would produce, in *your
league's* scoring. Points above replacement is the honest unit: a bscore of 40 means
forty more points than the next man up, in your league's own currency.

Three tabs, which are three different questions rather than three filters:
**Streaming** ranks over the next seven days against that week's real slate,
**This fortnight** is the standing 14-day board and the default, and **Stash**
ranks over every game left in the regular season. Alongside the ranking the board
carries **Buy low** (a rolling-window contact gap that the field has not priced)
and **Where it hurts to wait** (the drop-off at each slot). A second view,
**My team & trades**, prices a deal by what it does to your starting lineup.

### Running it

```sh
node src/server.ts      # Hono API on :8000 — /api/* only, no UI
npx vite                # Vite client on :5173, proxying /api — this is the one to open
node src/refresh.ts     # capture a fresh snapshot of MLB + Savant into data/snapshot.json
npm run check           # tsc --noEmit
npm run build           # static bundle into dist/
npm test                # every suite: engine, leagues, trade, auto, ui, board, trade-ui
```

Two notes a new reader will otherwise hit. The `dev`, `start` and `import` entries
in `package.json` shell out to `nub`, a TypeScript runner this repo does not
install, so they fail; the lines above are what they were meant to do, and
`node src/cli.ts` is the `import` one. And of the seven suites `npm test`
runs, four are pure Node (`engine`, `leagues`, `trade`, `auto`) while three (`ui`,
`board`, `trade-ui`) drive a real page at `http://127.0.0.1:5173`, so **the Vite
server has to be running** or they fail on a connection rather than on a defect.
`BASE=` points them elsewhere, `BROWSER=chromium|firefox` picks the engine.

Two more suites sit outside `npm test` because each needs something built first.
`npm run test:compete` replays 2021-2025 from a warm backtest cache and passes.

`npm run test:static` checks the Pages build, and **it does not currently pass.**
Two separate things are broken and neither is in the test. First, `npm run preview`
cannot serve the build at all: `vite.config.ts` applies `base: "/beanemachine/"`
only when `command === "build"`, and preview runs as `serve`, so it mounts at `/`
while the built `index.html` asks for `/beanemachine/assets/…`. Those requests fall
through to the SPA handler and come back as `text/html`, the module never executes,
and the board never renders. `npx vite preview --base=/beanemachine/` serves it
correctly. Second, even against a correctly-based preview, two assertions still
fail — the free-agents toggle is not disabled, and the `.static-note` banner
(`getMode() === "static"` in `src/client/App.tsx`) does not render. Both are live
defects in the static build, not stale assertions.

Node strips TypeScript types natively from 22.18 on, which is why every command
here is a plain `node src/….ts`; on an older Node add `--experimental-strip-types`.

### Autonomous mode

`node src/auto/run.ts` lets Billy look after the team: it reads your real roster
through a logged-in Playwright session, ranks it and the league's free agents on
the standing fortnight board, and reports the lineup it would set and the add/drop
it would make, with the numbers behind each.

```sh
node src/auto/run.ts --login              # sign into Yahoo by hand, once
node src/auto/run.ts                      # dry run — reports, changes nothing
node src/auto/run.ts --min-gain=8 --keep-floor=30 --max-moves=2
node src/auto/run.ts --execute            # actually sets the lineup
node src/auto/run.ts --execute --allow-drops
```

**Dry run is still the default, and the two capabilities are gated separately,
because they are not equally risky.** `--execute` sets lineups: fully reversible,
one click to undo, and it cannot lose you a player. Dropping one is irreversible
within seconds — someone else claims him — so add/drop needs `--allow-drops` on
top of `--execute`, and even then **this build prints the add/drop rather than
clicking it**: the Yahoo selectors in `src/auto/execute.ts` have never been
verified against a live authenticated page, and that is not a surface to automate
an irreversible action on. Lineup-only automation is a first-class mode, not a
degraded one.

The rails hold in every mode: at most `--max-moves` per run (default 1), nobody at
or above `--keep-floor` (25) is offered up, a swap must clear `--min-gain` (5)
projected points, and nobody MLB lists on the IL is ever added or started.
`railViolations` re-audits the finished plan against all of them and the run
prints **nothing at all** if it comes back non-empty. Lineup changes have their own
bar, `--lineup-min-gain`, which is 0 on purpose — sitting your own player costs
nothing and is undone in one click, so there is no reason to require a margin.

Three exit codes, and they mean different things on purpose: **0** the plan below
is the whole picture, **1** Billy was blind (a page he needed could not be read,
and "no move clears the bar" must never look like "the roster could not be read"),
**2** the planner produced a plan that broke its own rails and it was withheld.
Every applied action is verified by re-reading the roster, and an action that
cannot be confirmed is reported as unconfirmed rather than as success.

Credentials are never handled by this code. `--login` opens a real browser for you to
sign in; Playwright reuses the cookies from a gitignored file. There is nowhere for a
password to be stored, typed or logged. Take the dry run for a few days first.

### The two dev servers

They are not interchangeable:

- **`:8000` — the Hono API only.** Serves `/api/*` — reading a league from its URL
  and its free-agent pool, the two things a browser can't do for itself. It does not
  watch for changes, so restart it after editing anything server-side. Opening it in
  a browser shows no UI. Your
  leagues are not kept here: they live in the browser's storage, so the hosted
  static build behaves identically for everything except those two calls.
- **`:5173` — the Vite client**, with HMR, proxying `/api` through to `:8000`.
  **This is the one to open.**

### Where the numbers come from

All unauthenticated, all captured server-side into `data/snapshot.json`. Row counts
are from the shipped capture (2026-09-02T05:49Z):

| Source | What it gives | Rows |
|---|---|---|
| MLB StatsAPI `/stats?stats=season&playerPool=All` | the whole pool and its season lines | 726 hitters, 841 pitchers |
| MLB StatsAPI `/stats?stats=byDateRange` | the same stats inside a window — recent form | 3/7/21d batters, 5/21d pitchers |
| MLB StatsAPI `/schedule` | real games and real opponents per team, per horizon | 30 teams |
| MLB StatsAPI `/schedule?hydrate=probablePitcher` | who is actually booked to start | 46 pitchers |
| MLB StatsAPI `/standings` | team games played to date — the per-game denominator | 30 teams |
| MLB StatsAPI `/teams/{id}/roster` | IL status, filtered to the D-prefixed IL codes | 203 players |
| Baseball Savant `statcast_search` (pitch level, a day at a time) | rolling 21-day wOBA and xwOBA | 449 batters, 509 pitchers |
| Baseball Savant `expected_statistics?min=1` | season-long xBA, xSLG | 641 batters, 834 pitchers |
| Baseball Savant `statcast?min=1` | barrel %, exit velocity, hard-hit %, sweet-spot % | joined by `player_id` |
| Yahoo public player pages | "% Ros" — the market's price | 845 of the pool priced |

Three coverage decisions matter. `playerPool=All` instead of the default, because
the qualified leaderboard is roughly a third of the real pool and hides exactly the
waiver-wire players this exists to surface. Savant `min=1` instead of `q`, which
lifts batter coverage to 641 — 1,418 of the 1,432 pooled players have an xwOBA. And
the expected-stat pair is read from the **pitch-level** endpoint over a rolling
window rather than off the season leaderboard, for the reason the Savant section
below spends a while on.

### How the invariant survives a projection

The rule everywhere else is that nothing is inferred. A projection *is* an inference,
so the rule adapts rather than breaks: **every number carries its inputs.** Opening a
player splits them into

- **observed** — wOBA, xwOBA, barrel %, volume per team game, games in the window
- **modelled** — every knob that was actually applied, with its real parameters: the
  season/recent playing-time blend, the starts-based override when probables exist,
  the schedule-strength multiplier — plus a line saying in so many words that the
  Statcast weight is 0, so the xwOBA two columns to the left is shown and not used
- **missing** — no Statcast row, no team games, or a league category no source provides

Confidence comes from real sample size, whether Statcast data exists at all, and
health. It is never a flat default. A league category that can't be sourced is
reported as unscoreable rather than silently treated as zero.

### Is bscore actually predictive? — 100 folds, ten seasons

`node src/backtest/evaluate.ts` builds a corpus from **2016–2026** — every season of the Statcast
era — and scores projection variants against what actually happened. Every stat line
it scores is pulled with a date range ending at the as-of date, so nothing from the
evaluation window reaches the projection. (The one exception is the Savant column,
which the corpus still reads from the leaderboard that ignores its own dates — no
scored variant uses it, and the sweeps that did are retracted below. That is stated
here rather than left for a reader to find.) 2020 is skipped automatically; its
60-game season is too short to hold a 14-day horizon after a warm-up period.

Every fetch goes through a disk cache, so the first build takes ~15 minutes and every
sweep after that runs offline in seconds. That's what makes it practical to test ideas
rather than guess.

```sh
node src/backtest/evaluate.ts                        # 2016–2026, 5 folds/season, 14-day horizon
node src/backtest/evaluate.ts --from=2021 --to=2025  # narrower
node src/backtest/evaluate.ts --horizon=7 --folds=8  # different question
```

**Scored result — 50 folds per side, baseline is "he'll keep doing what he's been
doing" (season-to-date rate scaled to games ahead):**

| side | model | ρ | vs naive | folds won |
|---|---|---|---|---|
| hitting | naive baseline | 0.5743 | — | — |
| hitting | single 7d window | 0.6759 | +17.7% | 48/50 |
| hitting | **weighted 3/7/21d (shipped)** | **0.6819** | **+18.7%** | **49/50** |
| pitching | naive baseline | 0.4697 | — | — |
| pitching | single 21d window + rate blend | 0.5318 | +13.2% | 49/50 |
| pitching | **weighted 5/21d (shipped)** | **0.5333** | **+13.5%** | **50/50** |

The shipped constants live in `src/engine/project.ts` and are asserted by
`test/engine.mjs`, so they can't be retuned by accident:

```ts
RECENT_WINDOW_WEIGHTS = { hitting: { 3: 2, 7: 1, 21: 1 }, pitching: { 5: 2, 21: 1 } }
RECENT_BLEND_WEIGHT   = { hitting: 0.5,  pitching: 0.5 }
RECENT_RATE_WEIGHT    = { hitting: 0,    pitching: 0.15 }
```

Five findings, three of them negative:

1. **Recent playing time is the whole game**, the right window **differs by side**, and
   **the most recent series carries extra signal**. Hitters use 3/7/21-day windows with
   the shortest weighted double; pitchers use 5/21. The reason the sides differ is
   structural, not statistical: a hitter's role can change in a week, so a 3-day window
   tracks it, while a starter works every fifth day, so three days of his data is
   usually zero appearances and a week is one or two starts of noise.
2. **The recency weight is set by seasons, not by correlation.** A 14-day ranking
   preferred 0.75; playing 2023-2025 out week by week prefers **0.5**, worth ~1,500
   points and a weekly win rate that goes from 41/68 to 48/68 — and the five-season
   run in `data/results/` has since put the same comparison at 38W-73L against 0.5,
   z −3.32. The correlation cost of 0.5 is about 0.003 ρ, inside the noise band. Heavy
   recency catches role changes, which a correlation rewards — and chases week-to-week
   noise, which a season punishes. The season is closer to how the tool is used.
3. **The Statcast blend does not earn its place** — though *this* study is not why.
   Every fold sweep ranked `qualityWeight: 0` first, but the corpus reads its expected
   stats from the leaderboard that ignores its own dates, so those sweeps are void and
   are retracted below. No variant scored here passes a non-zero quality weight any
   more, which is what keeps the ρ figures clean. The weight is 0 on the strength of
   the 111-week season test instead. xwOBA and barrel rate are still displayed, because
   they genuinely inform a human, but they do not silently move a recommendation — and
   the drill-down says so.
4. **A light recent-RATE blend helps pitchers and not hitters.** Blending 15% of the
   21-day rate beat the previous configuration in **41 of 50** pitching folds. The same
   idea for hitters won **29 of 50** — a coin flip — so it isn't applied there. The mean
   difference for hitters was +0.0009, which is exactly the kind of number that looks
   like an improvement and is actually noise; the paired fold count is what exposed it.
5. **Rate shrinkage made things worse.** The naive line already carries the selection
   effect that good players accumulate more plate appearances, so shrinking the rate on
   top of a volume model double-penalises exactly the players it shouldn't.

**Window tuning is now exhausted.** A further sweep — a 4-window hitter blend, a
3-window pitcher blend, exponential decay at three time constants — lands within
**±0.001 ρ** of the shipped configuration. That is inside the noise this corpus can
resolve, so nothing was changed on it. The remaining gains are not in retuning windows;
they need *different information*. Two of the three named here have since landed —
probable pitchers, and opponent strength over the horizon — and neither could be
credited by this harness: probables cannot be replayed leak-free at all, and matchups
were judged by playing seasons instead. The third, your league's real multi-position
eligibility, is still missing and is still the largest accuracy gap left.

Honest limits: ρ ≈ 0.68 is a real ranking signal, not clairvoyance — fourteen days of
baseball is mostly variance, and the top-20 actual-points column barely separates the
variants, meaning the gain is in ranking the broad pool (waiver decisions) rather than
the very top (which is obvious anyway).

### Does it actually win? — a season played out

`node src/backtest/compete.ts` plays whole seasons. Each strategy drafts from the same
pool, sets a legal roster every week, makes waiver moves on what it believed *at the
time*, and is scored on what those players actually produced. Rosters may overlap, so
what is being compared is judgement, not draft position.

The opponents are the two strategies human managers actually run: **season-to-date**
("he'll keep doing what he's been doing") and **hot-hand** (chase the last fortnight).

**2021–2025, 111 weeks, at one waiver move per week:**

Every row of this table is a stored run in `data/results/`. Read them from those
files directly: `verdict.ts` cannot currently re-pool them, because it double-counts
any variant that appears in more than one run — see [the verdict.ts
caveat](#a-caveat-on-verdictts) below. The paired column is from bscore's side (it
won that many of the 111 weeks); the `z` beside it is printed from the *opponent's*
side, which is why a week count bscore wins carries a negative sign.

| strategy | points | % of perfect | paired weeks bscore wins |
|---|---|---|---|
| **bscore (shipped)** | **79,208** | **51.0%** | — |
| bscore, matchups off | 79,008 | 50.9% | — |
| projected points only | 74,212 | 47.8% | **80/111** (+45.0/wk, z −4.65) |
| hot-hand | 73,883 | 47.6% | **74/111** (+48.0/wk, z −3.51) |
| season-to-date | 71,962 | 46.4% | **76/111** (+65.3/wk, z −3.89) |
| perfect hindsight | 155,213 | 100% | ceiling |

bscore wins outright on points — by **7.2%** over hot-hand and **10.1%** over
season-to-date — **and** takes a clear majority of individual weeks against both:
**76 of 111** against season-to-date and **74 of 111** against hot-hand. That second
number is the one that matters, because this league is head-to-head and you win by
winning weeks.

Three harder opponents were played in an earlier full-strategy run, before the
results ledger existed, so their rows are not re-poolable and are quoted as they
were measured: **thoughtful-human** 77,706 (50.1%, bscore wins 60/111),
**hot-hand + scarcity** 75,261 (48.5%, 69/111), **draft-and-hold** 63,949 (41.2%,
98/111). Re-run `compete` with no sweep flag to regenerate them into the ledger.

**Value over replacement is what makes the difference**, and this is the one place
the effect is large enough to be unambiguous. Paired directly against the shipped
model over the same 111 weeks, ranking waiver decisions by raw projected points —
ignoring the thing the metric exists for — loses **80 of 111 weeks (z −4.65)** and
gives up 4,996 points. Against a season-to-date manager it wins 66/111 where bscore
wins 76/111. Dropping a replaceable outfielder for a scarce catcher is right even
when the catcher scores fewer points, and only the replacement adjustment sees it.

The same run pairs the recency weight directly too, and it is the only knob in the
ledger whose result is significant on its own: **0.75 loses to the shipped 0.5 by
38W-73L, z −3.32, −22.6 points a week, −2,504 over five seasons.** The ranking
correlation preferred 0.75 by 0.003 ρ. The season did not.

**But the edge is in selectivity, and it disappears if you churn** (2023-2025, 68
weeks — a narrower run than the table above, which is why the totals are smaller):

| waiver moves/week | bscore total | weeks won vs season-to-date |
|---|---|---|
| 0 (draft and hold) | 39,353 | 16/68 |
| **1** | **47,590 (winner)** | **41/68** |
| 2 | 48,030 | 34/68 |
| 3 | 48,313 (hot-hand wins) | 33/68 |

More moves raise everyone's raw total — you are simply picking up more hot players —
but they destroy bscore's *relative* edge, and by three moves a week naive
streak-chasing beats it outright. The model is worth using for **one high-conviction
move a week**, not for constant churn. Autonomous mode defaults to exactly that, which
was originally a safety choice and turns out to be the optimal one too.

### The approach, end to end

A bscore is built in four passes, and each pass is only allowed to add what a source
actually says.

**1. Observe.** Season lines; the last 3/7/21 days for batters and 5/21 for pitchers;
real games and real opponents scheduled in the horizon; published probable starters;
IL status; Yahoo's "% Ros"; and the Savant underlying record over a rolling three
weeks. Nothing here is modelled, and anything a source doesn't cover stays absent
rather than becoming a default.

**2. Project volume.** Playing time is the largest edge available and the part most
managers get wrong: a season rate understates a player who took over an everyday job
last week. The recent windows are blended (the last series counts double), then
blended again against the season line. This one pass is worth roughly 20% relative
Spearman over a season-only estimate. A starter whose turns MLB has already published
skips it entirely and is projected from his own starts instead.

**3. Project rate.** Each stat's rate per unit of volume, scaled to the projected
volume, with 15% of a pitcher's rate taken from his last 21 days and none of a
hitter's — an asymmetry that exists only because the evidence was asymmetric. Then
the context multipliers, each weighted and clamped: schedule strength at 0.5,
Statcast contact quality at 0, park at 0 and never supplied.

Rate *shrinkage* is the notable absence. The mechanism and its stat-specific
constants are here — 60 batters faced for strikeouts, 1,200 plate appearances for
triples, following the published stabilisation work — but `rateAll` does not pass
league rates, so **no shrinkage is applied in the shipped app**. It was measured and
it lost: the naive line already carries the selection effect that good players
accumulate more plate appearances, so shrinking on top of a volume model
double-penalises exactly the players it shouldn't.

**4. Value it.** Score the projection in *your* league's table, then subtract what a
freely available player at the same slot would produce. That subtraction is the whole
metric: it is why a scarce catcher outranks a better outfielder, and removing it
collapses the model to a coin flip against a naive manager.

### What the board opens on

The default ranking is **market edge**, not bscore. A bare bscore ranking answers
"who is best", which on a waiver wire is half a question — the best players are
already rostered. Market edge answers "who is the field wrong about": it compares
each player's bscore against the *median bscore of the players the field prices the
same way he is priced*, using Yahoo's "% Ros" as the price.

It is a residual, so it stays denominated in league points — an edge of +18 means
eighteen points more than the typical player rostered in about as many leagues. A
percentile difference would have crowned every unrostered replacement-level body.

Ownership is read from Yahoo's own player pages. They cap an anonymous reader at 24
rows and ignore the paging offset, but `count=` shifts the window — `count=50`
returns the next two dozen — so sweeping it per position exposes the whole priced
universe without an account. In the shipped capture 1,115 rows came back and 845 of
the pooled players carry a price. Anyone Yahoo does not list has **no** market edge
and shows a dash: unknown is not the same as unowned, and the board will not rank a
player on a price it never read.

### Tuning it — `model.json`

Every weight lives in [`model.json`](model.json), not in code:

```jsonc
"recentForm": { "volumeWeight": 0.75, "blend": { "hitting": 0.5, "pitching": 0.5 },
                "rate": { "hitting": 0, "pitching": 0.15 },
                "windows": { "hitting": { "3": 2, "7": 1, "21": 1 }, "pitching": { "5": 2, "21": 1 } } }
"statcast":   { "weight": 0, "windowDays": 21, "lambda": { "mode": "rising", "prior": 300, "cap": 0.7 }, ... }
"probables":  { "use": true, ... }
"matchup":    { "weight": 0.5, "clamp": { "min": 0.88, "max": 1.12 }, ... }
"park":       { "weight": 0, ... }
"shrinkage":  { "default": 400, "perStat": { "homeRuns": 170, ... } }
```

It is validated by ArkType at import (`src/engine/weights.ts`), so a typo fails loudly
instead of silently producing a plausible recommendation built on a number nobody
chose. Every block carries a `why` array recording the evidence that set it — a weight
without provenance is a guess, and this project does not ship guesses.

Change a number, then re-measure:

```sh
node src/backtest/compete.ts --seasons=2021,2022,2023,2024,2025 --moves=1  # the decisive test
node src/backtest/compete.ts --quality --statcast-real --control=qw0.00    # the Statcast sweep
node src/backtest/compete.ts --matchup --control=mu0.00                    # schedule strength
node src/backtest/compete.ts --relief  --control=rel-off                   # reliever rate weight
node src/backtest/run.ts                                                   # ranking correlation (advisory)
node src/backtest/verdict.ts --statcast=point-in-time                      # pool every stored run
```

`--quality` without `--statcast-real` measures nothing: the simulator returns no
Statcast at all rather than the leaked leaderboard, which is the honest default and
makes every quality variant identical. Each `compete` run writes itself to
`data/results/` — configuration, weekly points per strategy, the lot — because these
measurements cost half an hour of pitch-level fetching each and the conclusions they
support get revised as more seasons land. Keeping only console output would leave the
evidence for a shipped weight in a terminal scrollback that no longer exists.
`verdict.ts` pools them, matched on configuration so a leaked run can never be
averaged into a clean one, and prints a sign test with ties excluded.

#### A caveat on verdict.ts

**Its pooled output is currently wrong for any variant that appears in more than one
run, and every baseline does.** Pooling concatenates each variant's weekly series
across runs and then pairs position-by-position against the control's, filling a
missing control week with zero (`base[i] ?? 0` in `src/backtest/verdict.ts`). A
baseline stored in N runs therefore gets N×111 week-entries paired against a control
that has 111, and every unmatched one is scored as a win against a control of
nothing. That is the one thing this project says it never does — substitute a
plausible default for a value that isn't there — and it inverts the conclusion
rather than blurring it. Measured against the twelve runs stored on 2 September,
bare `node src/backtest/verdict.ts` ranked hot-hand *first* at 588,575 points and
called it significant at z +24.77, where the same weeks paired honestly have it
losing 37-74 to the shipped model. The exact figures move as runs are added; the
direction of the error does not.

Rows within a single sweep family are unaffected — the Statcast, matchup, reliever
and recency tables below all reproduce exactly — because those variants live in one
run each. Only the cross-run baselines are corrupted. Until the fallback is fixed,
read `data/results/*.json` directly for anything involving hot-hand, season-to-date
or `bscore` across families. This is an engine defect, not a documentation one.

**Paired weekly win counts decide. Ranking correlation is advisory.** They have
already disagreed once — the recent-form blend — and the season was right.

### Savant: a retraction, and what replaced it

This section has been wrong twice, so it records both errors and both corrections.

**The bug.** Baseball Savant's `custom` leaderboard accepts `start_dt` and `end_dt`
and ignores them. Three disjoint 2023 ranges return byte-identical responses — 656
rows, 184,104 plate appearances, every time; `month=` is ignored the same way.
Nothing errors and the numbers look reasonable. They are simply the finished season,
including the games being predicted. Every Statcast measurement this project made
before that was found ran on it, and the fold corpus still does — which is why the
sweeps there are void rather than merely noisy.

**The correction.** `src/data/statcast-window.ts` aggregates the pitch-level
`statcast_search` endpoint, which does honour dates, a day at a time — the only
route to a real point-in-time xwOBA, at about 16 MB of pitch data per day of history.
Re-measured over 2024, 23 weeks, 5,151 player-weeks, 21-day prior windows
(`node src/backtest/xwoba.ts --real --prior-days=21 --seasons=2024 --min=30`, which
reproduces every number below from the warm cache):

| predictor of the next 7 days | Spearman rho |
|---|---|
| **xwOBA** | **0.1019** |
| blend, 0.7 toward xwOBA | 0.0903 |
| blend, 0.5 | 0.0810 |
| blend, 0.3 | 0.0716 |
| wOBA (what a manager sees) | 0.0581 |

**xwOBA is the better predictor, and the ordering is monotone in how much of it you
use.** The incremental test agrees: partial rho of the gap against future production,
controlling for wOBA, is **+0.0944 with z = 6.79** — not a marginal call.

The earlier null was an artifact of the bug, and an especially treacherous one. With
the full season leaked into the "prior" wOBA, that wOBA already contained the outcomes
being predicted, so any residual signal was arithmetically forced toward zero. The
bug did not add noise; it manufactured a confident wrong answer.

Note what the leak also explains: gap~wOBA is **−0.61** on clean data versus −0.36 on
leaked data. Contact quality and results diverge far more within a real three-week
window than a full season lets them, which is exactly the room the signal lives in.

**And then the season settled it the other way.** Re-run on real point-in-time data
across 2021-2025 — 111 paired weeks, every strategy playing the same pool — and paired
directly against weight 0. Every one of these runs is in `data/results/`;
`node src/backtest/verdict.ts --statcast=point-in-time` prints these rows exactly as
they stand here. It also prints a hot-hand and a season-to-date row above them that
are wrong for the reason given in [the verdict.ts
caveat](#a-caveat-on-verdictts) — ignore those two; the honest versions of that
comparison are three paragraphs down.

| formulation | record vs weight 0 | points/wk | ties | z |
|---|---|---|---|---|
| **no Statcast multiplier (shipped)** | — | **best total, 79,208** | — | — |
| xwOBA ratio 0.25 | 31W-31L | −0.7 | 49 | +0.00 |
| xwOBA ratio 0.5 | 38W-42L | −1.3 | 31 | −0.45 |
| batted-ball only, 1.0 | 52W-50L | −1.7 | 9 | +0.20 |
| batted-ball + falling λ | 52W-59L | −5.4 | 0 | −0.66 |
| xwOBA ratio 1.0 | 43W-59L | −9.6 | 9 | −1.58 |
| λ falling, 1.0 | 48W-63L | −17.9 | 0 | −1.42 |

Every formulation loses on points. The least-bad one ties 49 of 111 weeks, which means
it changed almost no roster at all. And the per-season winner wanders — four different
configurations win the five seasons, and each of them is badly wrong in another one:

| | 2021 | 2022 | 2023 | 2024 | 2025 |
|---|---|---|---|---|---|
| batted-ball only, 1.0 | **+13.3** | +0.2 | **+12.2** | −24.7 | −8.1 |
| λ falling, 1.0 | −23.7 | **+7.2** | −24.5 | −31.4 | −15.4 |
| batted-ball + falling λ | −10.2 | +2.8 | −27.8 | **+3.0** | **+4.9** |

A winner that changes every season is noise wearing a result's clothes. And this is not
a test too blunt to see anything: over the same 111 weeks the same paired count has the
shipped model beating hot-hand by 48.0 points a week (z −3.51) and a season-to-date
manager by 65.3 (z −3.89), both significant. It detects real effects. There isn't one here.

**Both things are true, and the tension is the interesting part.** On the same clean
data, xwOBA out-predicts actual wOBA for next-week production and its gap carries
significant incremental signal (z 6.79). The signal is real. It still does not improve a
roster decision, because that decision is dominated by playing time and slot scarcity —
a ±5-10% rate multiplier almost never changes which 27 players you hold. A metric can be
genuinely predictive and still be the wrong lever.

So the weight is 0, and this time that is a measured result rather than a stale one. What
Savant earns instead is everything below.

### How Savant is actually used

Three places, and the window matters in all of them.

**The rolling window is the product decision.** Expected stats are aggregated from
the pitch-level endpoint over the last 21 days, not read off the season leaderboard.
Across a season, contact quality and results converge — gap-to-wOBA correlation
−0.36 — and the gap collapses toward nothing. Over three weeks they diverge, −0.61,
and that divergence is the entire signal. A season-long xwOBA has already regressed
most of the way to the wOBA it exists to disagree with. Barrel rate, exit velocity,
xBA and xSLG have no point-in-time equivalent, so they stay season-long and are
labelled as such on every card rather than passed off as recent.

**Buy low** is where the two independent signals meet: a player hitting the ball
better than his line says *and* still rostered in under 70% of leagues. Either one
alone is a trap — an unlucky player everyone owns is not an opportunity, and a free
player making weak contact is free for a reason. Scored as a product so a candidate
has to clear both bars.

**Ranking and provenance.** "Best contact vs results" sorts the board on the raw
21-day gap with the pitcher sign flipped, the luck column ranks it as a percentile
within each side, a missing Statcast row explicitly lowers confidence, and the
drill-down reads the gap back in a sentence so a human can overrule the model with
the underlying record in front of them.

### Matchups

The engine knows who each team is actually booked against over the horizon, from the
real schedule, and rates every team's offence and staff by linear-weights wOBA over
the same leak-free prior window. A hitter facing generous staffs is scaled up; a
pitcher facing strong lineups has his allowed hits and earned runs scaled up, which
costs him points. Both directions come out of one multiplier because both mean the
same thing — more events than a league-average week.

**Shipped at weight 0.5, and the honest reading is "positive but unproven".** Paired
directly against the same model with matchups off, over 111 weeks:

| weight | direct record vs off | margin | five-season total | z |
|---|---|---|---|---|
| 0.25 | 25W-29L-57T | +1.1/wk | +125 | −0.54 |
| **0.5 (shipped)** | **51W-44L-16T** | **+1.8/wk** | **+200** | **+0.72** |
| 0.75 | 52W-49L-10T | +2.4/wk | +265 | +0.30 |
| 1.0 | 59W-49L-3T | +4.9/wk | +549 | +0.96 |

The effect is positive at every dose and monotone in the total, which is what a real
mechanism looks like rather than a lucky draw — but 59W-49L on 108 decided weeks is
z +0.96, not significant, and neither is anything below it. When a dose-response is
monotone and no single dose clears the bar, the smallest dose that shows the effect
risks the least, so 0.5 ships. `"matchup": { "weight": 1 }` in `model.json` buys the
measured maximum for anyone who wants it. The run is
`data/results/matchup-5s_2021-2022-2023-2024-2025_moves1.json`.

Park factors are the same shape of idea and are left at 0 — largely subsumed by the
opponent index, since who you play and where you play it are the same schedule. Be
precise about their state: `fetchParkFactors` exists in `src/data/savant.ts` and the
multiplier exists in `project.ts`, but **nothing calls the fetcher**, no capture
carries a park index, and no caller ever passes one. They are implemented and
unwired, not fetched and ignored.

### Scheduled starts

MLB publishes probable pitchers, and `src/data/statsapi.ts` reads them from the
schedule feed. When a starter's next turns are known, his volume comes from **his
own starts** — `outs per start × starts scheduled` — instead of from his team's
games. Averaging a two-start week and a one-start week into one number is the
largest documented hole in the pitching projection, and in a points league those
weeks are worth roughly double one another.

**It cannot be backtested, and that is stated rather than hidden.** Probables are
announced and then overwritten, and no archive of what was announced at the time
exists, so there is no leak-free way to replay them. `"probables": { "use": true }`
is set because it replaces an average with an observation, not because a fold count
said so.

Read the coverage honestly before trusting it. Probables reach only a few days out,
so in the shipped capture **46 pitchers** carry a published start over the next
fortnight and every one of them carries exactly **one** — which means the fortnight
board projects those 46 from a single announced start while every other starter is
still projected from a fortnight of team games. That is what a starts-based number
means today: starts *announced*, not starts he will make. The board's two-start
badge and its "Two-start SP only" filter are driven by the same counts, so in this
capture neither has anything to show; they light up as the week's probables fill in.

### A reliever's recent rate — measured, rejected

The hypothesis was a good one. A reliever's fantasy value is almost entirely a
**role** — whether he is getting the ninth inning — and a role changes overnight,
while saves shrink toward the league rate with a heavy constant (400). If that
shrinkage mispriced newly installed closers, a heavier recent-rate weight for
mostly-relieving pitchers only should have shown up. `reliefRateWeight` exists in
`project.ts` for exactly this test.

It loses at every dose, over the same 111 weeks:

| relief rate weight | five-season total | vs off |
|---|---|---|
| **off (shipped)** | **79,208** | — |
| 0.30 | 79,074 | −1.2/wk |
| 0.50 | 78,964 | −2.2/wk |
| 0.70 | 78,552 | −5.9/wk |

So the heavy shrinkage is apparently correct: a reliever's recent save rate is mostly
noise. The knob stays in the code, set to null, and `model.json` records why.

Worth recording how this nearly went wrong. The first run of the sweep returned four
*identical* totals — every weight scoring exactly the same as off — which is not a
result, it is a no-op. The wiring was fixed and the sweep re-run, and both runs are in
`data/results/`; the later one supersedes the earlier on the same configuration key.
Four identical numbers should always be read as a broken measurement rather than as a
knob that does nothing.

### Architecture

The engine (`src/engine/`) is pure, so ranking runs **in the browser** against a
snapshot of observed data. That collapses the server/static split — GitHub Pages gets
the same live board — and means re-scoring your league re-ranks it instantly.

`src/data/` fetches and normalises sources; `src/refresh.ts` writes the snapshot.
Browsers can't call MLB or Savant directly (neither sends CORS headers), so the
snapshot is how real data reaches the page.

**Why a snapshot rather than live calls, and why CSV.** Savant serves these
leaderboards as HTML; `csv=true` is its actual data interface, and there is no JSON
equivalent — scraping their internals would be more fragile, not less. But the format
is beside the point: a browser can't call either source directly, so the data has to
be captured server-side either way. What matters is *cadence*. CI recaptures on every
push **and on a schedule — 11:00 and 23:00 UTC** — so the board never quietly serves
numbers from whenever someone last pushed code. The UI states the capture age next to
the heading and flags it once it passes 36 hours.

`src/schema.ts` is the shared contract: the same ArkType `League` type validates the
form on every keystroke, guards each Hono route via `@hono/arktype-validator`, and
drives the scoring conversion.
