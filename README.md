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

Source of truth: `logo/final-build.mjs`. Run it to regenerate `web/beanbot.svg`
and `logo/final.json`; `web/index.html` inlines the same body so it can pick up
theme tokens. The mark is authored against `--acc`, aliased onto the app's
`--accent` in `web/index.html`.

Exploration rounds that got here live in `logo/round*.mjs` with contact sheets in
`logo/sheet*.png`.

## Docs

- **[docs/GUIDE.md](docs/GUIDE.md)** — how to read the board and use it on draft day,
  waiver day and for daily streaming, including why a catcher outranks a better hitter.
- **[docs/METHODOLOGY.md](docs/METHODOLOGY.md)** — how a bscore is computed, worked
  through with real numbers, plus the backtest design and the negative results.

## The app

Ranks every MLB player by a **bscore** — projected points over the horizon, minus
what a freely available replacement at the same roster slot would produce, in *your
league's* scoring. Points above replacement is the honest unit: a bscore of 40 means
forty more points than the next man up, in your league's own currency.

```sh
nub run dev      # Hono API on :8000 + Vite client on :5173 (proxied) — open 5173
nub run refresh  # capture a fresh snapshot of MLB + Savant data
nub run test     # browser suites, both config editor and board
nub run check    # tsc --noEmit
nub run build    # static bundle into dist/
```

### Autonomous mode

`nub run auto` lets Billy look after the team: it reads your real roster through a
logged-in Playwright session, ranks it and the league's free agents by bscore, and
reports the swaps it would make and why.

```sh
nub run auto:login                     # sign into Yahoo by hand, once
nub run auto                           # dry run — reports, changes nothing
nub run auto --min-gain=8 --keep-floor=30 --max-moves=2
```

It is **dry-run only, on purpose.** This reasons about real and hard-to-reverse
actions — a dropped player can be claimed within seconds — so the default changes
nothing, at most `--max-moves` are proposed per run, nobody at or above
`--keep-floor` is ever offered up, and a swap must clear `--min-gain` projected
points to appear at all.

Credentials are never handled by this code. `--login` opens a real browser for you to
sign in; Playwright reuses the cookies from a gitignored file. There is nowhere for a
password to be stored, typed or logged. Wiring up actual execution is a separate,
deliberate decision — take the dry run for a few days first.

### The two dev servers

They are not interchangeable:

- **`:8000` — the Hono API only.** Serves `/api/*` — reading a league from its URL
  and its free-agent pool, the two things a browser can't do for itself — and
  hot-reloads on server-side changes. Opening it in a browser shows no UI. Your
  leagues are not kept here: they live in the browser's storage, so the hosted
  static build behaves identically for everything except those two calls.
- **`:5173` — the Vite client**, with HMR, proxying `/api` through to `:8000`.
  **This is the one to open.**

### Where the numbers come from

All verified live and unauthenticated:

| Source | What it gives |
|---|---|
| MLB StatsAPI `/stats?playerPool=All` | full 719-hitter / 834-pitcher pool and season lines |
| MLB StatsAPI `/schedule` | real games per team in the horizon window |
| MLB StatsAPI `/teams/{id}/roster` | IL and roster status |
| Baseball Savant `expected_statistics?min=1` | xwOBA, xBA, xSLG and the expected-minus-actual gap |
| Baseball Savant `statcast?min=1` | barrel %, exit velocity, hard-hit %, sweet-spot % |

Two coverage decisions matter. `playerPool=All` instead of the default, because the
qualified leaderboard is ~240 of ~720 hitters and hides exactly the waiver-wire
players this exists to surface. And Savant `min=1` instead of `q`, which lifts batter
coverage from 243 to 641.

### How the invariant survives a projection

The rule everywhere else is that nothing is inferred. A projection *is* an inference,
so the rule adapts rather than breaks: **every number carries its inputs.** Opening a
player splits them into

- **observed** — wOBA, xwOBA, barrel %, volume per team game, games in the window
- **modelled** — the λ blend toward expected wOBA, the volume projection, each stated
  with its actual parameters
- **missing** — no Statcast row, no team games, or a league category no source provides

Confidence comes from real sample size, whether Statcast data exists at all, and
health. It is never a flat default. A league category that can't be sourced is
reported as unscoreable rather than silently treated as zero.

### Is bscore actually predictive? — 100 folds, ten seasons

`nub run evaluate` builds a corpus from **2016–2026** — every season of the Statcast
era — and scores projection variants against what actually happened. It is leak-free
by construction: both the StatsAPI line and the Savant expected stats are pulled with
date ranges ending at the as-of date, so nothing from the evaluation window reaches
the projection. 2020 is skipped automatically; its 60-game season is too short to hold
a 14-day horizon after a warm-up period.

Every fetch goes through a disk cache, so the first build takes ~15 minutes and every
sweep after that runs offline in seconds. That's what makes it practical to test ideas
rather than guess.

```sh
nub run evaluate                        # 2016–2026, 5 folds/season, 14-day horizon
nub run evaluate --from=2021 --to=2025  # narrower
nub run evaluate --horizon=7 --folds=8  # different question
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
RECENT_BLEND_WEIGHT   = { hitting: 0.75, pitching: 0.60 }
RECENT_RATE_WEIGHT    = { hitting: 0,    pitching: 0.15 }
```

Three findings, two of them negative:

1. **Recent playing time is the whole game**, the right window **differs by side**, and
   **the most recent series carries extra signal**. Hitters use 3/7/21-day windows with
   the shortest weighted double; pitchers use 5/21. The reason the sides differ is
   structural, not statistical: a hitter's role can change in a week, so a 3-day window
   tracks it, while a starter works every fifth day, so three days of his data is
   usually zero appearances and a week is one or two starts of noise.
2. **The Statcast blend does not earn its place.** Across ten seasons every sweep
   ranked `qualityWeight: 0` first. It is **off by default**. xwOBA and barrel rate are
   still displayed, because they genuinely inform a human, but they do not silently
   move a recommendation on evidence that failed — and the drill-down says so.
3. **A light recent-RATE blend helps pitchers and not hitters.** Blending 15% of the
   21-day rate beat the previous configuration in **41 of 50** pitching folds. The same
   idea for hitters won **29 of 50** — a coin flip — so it isn't applied there. The mean
   difference for hitters was +0.0009, which is exactly the kind of number that looks
   like an improvement and is actually noise; the paired fold count is what exposed it.
4. **Rate shrinkage made things worse.** The naive line already carries the selection
   effect that good players accumulate more plate appearances, so shrinking the rate on
   top of a volume model double-penalises exactly the players it shouldn't.

**Window tuning is now exhausted.** A further sweep — a 4-window hitter blend, a
3-window pitcher blend, exponential decay at three time constants — lands within
**±0.001 ρ** of the shipped configuration. That is inside the noise this corpus can
resolve, so nothing was changed on it. The remaining gains are not in retuning windows;
they need *different information*: probable pitchers (a two-start week is worth roughly
double a one-start week and the model currently can't tell them apart), opponent
strength over the horizon, and your league's real multi-position eligibility.

Honest limits: ρ ≈ 0.68 is a real ranking signal, not clairvoyance — fourteen days of
baseball is mostly variance, and the top-20 actual-points column barely separates the
variants, meaning the gain is in ranking the broad pool (waiver decisions) rather than
the very top (which is obvious anyway).

### Does it actually win? — a season played out

`nub run compete` plays whole seasons. Each strategy drafts from the same pool, sets a
legal roster every week, makes waiver moves on what it believed *at the time*, and is
scored on what those players actually produced. Rosters may overlap, so what is being
compared is judgement, not draft position.

The opponents are the two strategies human managers actually run: **season-to-date**
("he'll keep doing what he's been doing") and **hot-hand** (chase the last fortnight).

**2023–2025, 68 weeks, at one waiver move per week:**

| strategy | points | % of perfect | weeks won vs bscore |
|---|---|---|---|
| **bscore** | **47,590** | **50.1%** | — |
| hot-hand | 47,409 | 49.9% | 32/68 |
| season-to-date | 45,906 | 48.3% | 27/68 |
| perfect hindsight | 95,063 | 100% | ceiling |

bscore wins outright, and wins **41 of 68 weeks** against season-to-date (+24.8 points
per week) and 36 of 68 against hot-hand.

**But the edge is in selectivity, and it disappears if you churn:**

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
