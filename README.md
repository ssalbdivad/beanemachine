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

### Is bscore actually predictive? — the backtest

`nub run backtest` stands at four past dates, projects the next 14 days using **only**
what was knowable then, and scores against what actually happened. It is leak-free by
construction: both the StatsAPI line and the Savant expected stats are pulled with
explicit date ranges ending at the as-of date.

The baseline to beat is *"he'll keep doing what he's been doing"* — season-to-date
points per team game, scaled to games ahead. Mean Spearman ρ across four folds:

| variant | hitting | pitching |
|---|---|---|
| naive baseline | 0.569 | 0.473 |
| + Statcast quality blend | 0.564 | 0.471 |
| + rate shrinkage | 0.561 | 0.440 |
| **+ recent playing time (shipped)** | **0.668** | **0.544** |

Three findings, including two negative ones worth stating plainly:

1. **Recent playing time is the whole game.** Blending 14-day playing time at 75%
   against season-long beats the baseline on all eight folds — about +20% relative for
   hitters, +16% for pitchers. A player who just took over an everyday job has a
   season-long rate that understates his coming volume, and that is a *volume* error,
   not a rate error.
2. **The Statcast blend did not earn its place.** Every parameter sweep ranked
   `qualityWeight: 0` first. It is therefore **off by default** — xwOBA and barrel rate
   are still shown, because they are genuinely informative to a human, but they do not
   silently move a recommendation on evidence that failed. The knob remains, and the
   hypothesis that it helps over a longer horizon is untested.
3. **Rate shrinkage made things worse**, not better. The naive line already carries the
   selection effect that good players accumulate more plate appearances, so shrinking
   the rate on top of a volume model double-penalises exactly the players it shouldn't.

`nub run tune` sweeps the recent-window length, the blend weight and the Statcast
weight, fetching each fold once and evaluating every parameter set in memory. The
shipped values — 14 days, 0.75, 0.0 — are what it chose.

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
