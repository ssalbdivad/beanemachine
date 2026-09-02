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

### The two dev servers

They are not interchangeable:

- **`:8000` — the Hono API only.** Serves `/api/*` (league import, save, templates)
  and hot-reloads on server-side changes. Opening it in a browser shows no UI.
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
| hitting | **`d7_w0.75_q0` (shipped)** | **0.6759** | **+17.7%** | **48/50** |
| pitching | naive baseline | 0.4697 | — | — |
| pitching | **`d21_w0.75_q0_rate0.15` (shipped)** | **0.5318** | **+13.2%** | **49/50** |

Three findings, two of them negative:

1. **Recent playing time is the whole game**, and the right window **differs by side** —
   7 days for hitters, 21 for pitchers. The reason is structural, not statistical: a
   hitter's role can change in a week, so a 7-day window tracks it; a starter works
   every fifth day, so a week of his data is one or two starts of pure noise.
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

Honest limits: ρ ≈ 0.68 is a real ranking signal, not clairvoyance — fourteen days of
baseball is mostly variance, and the top-20 actual-points column barely separates the
variants, meaning the gain is in ranking the broad pool (waiver decisions) rather than
the very top (which is obvious anyway).

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
