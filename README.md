# beanemachine

> How can you not be robotic about baseball?

Tells you what to do with your fantasy baseball team today. Give it a Yahoo or ESPN
league — one paste of its settings page is enough, and on ESPN the URL alone is — and it
reads that league's own scoring, roster slots, team count and scoring period, then
answers the two questions you actually face: **who do I start tonight**, and **which add
is worth one of this week's moves**.

Every recommendation names both sides and can be carried out without reading
anything else — "bench Nolan McLean, he is not projected to play today", "add TJ
Rumfield for your 1B or Util seat, drop Roman Anthony, +21.4 points". A ranked list
is not a decision, and an add that does not say who leaves cannot be made.

Underneath it there is a ranking, in *those* points, because the same player is
genuinely worth different amounts in different leagues and a ranking denominated in
somebody else's scoring is a ranking of somebody else's team. It is the second
screen, not the first.

And it tells you **what happened**. Every other number here is a projection and says so;
last night's is a fact, read from MLB's own day-by-day record and priced in your league's
scoring. What your lineup scored, what sat on your bench, and the one seat that explains
most of the gap. Over time it also keeps score of *itself* — what following its lineup
would have been worth against the lineup you already had, counted only over the days it
asked you to change something, and allowed to come back negative. A recommendation engine
that cannot be held to its recommendations is asking for trust it has not earned.

The one thing it cannot do is read your league's scoreboard, and it says so rather than
guessing: paste your opponent's roster and it will price both sides the same way over the
same week, which is the gap and not the score.

## Deploying the API (the one thing that makes Yahoo automatic)

Yahoo sends no CORS headers — measured 2026-09-09, HTTP 200 with no
`access-control-allow-origin` — so **no browser can ever read a Yahoo league**. The
site works without a server: you enter your team by hand and availability is
estimated from how widely each player is rostered, calibrated to your league's size
and labelled an estimate everywhere it appears. What a server adds is the exact
free-agent list and a one-click roster read.

`src/api.ts` has nothing node-specific in it, so it deploys as-is:

```sh
vercel login          # once
pnpm deploy:api       # prints a URL
```

Then rebuild the site with that URL baked in:

```sh
VITE_API_BASE=https://<what-vercel-printed> pnpm build
```

or set `VITE_API_BASE` as a repository variable so
`.github/workflows/pages.yml` picks it up on every deploy. The API's own CORS list
(`ALLOWED_ORIGINS` in `src/api.ts`) must name the site, and already names
`beanemachine.com`.

It is rate-limited, because an endpoint that scrapes somebody else's site on request is
an invitation to be used as one, and that cost lands on Yahoo and then on this app's own
access. The budget counts **only the requests that actually reach Yahoo** — 20 a minute
per address, and 400 for the shared "no usable address" bucket. The first version counted
every request, health probes and cache hits included, and a user got 429s for navigating
the site normally; `test/journey.mjs` failing intermittently is what caught it, which is
the shape a rate limit that is too tight always takes. The unknown-address bucket is
deliberately far larger because behind no proxy everyone shares it, and a per-user limit
applied globally is an outage.

Which platform you are on decides how you get in, and the honest answer differs — see
**[Getting your league in](#getting-your-league-in)** before anything else.

Nothing is assumed on your behalf: a value it could not read stays missing and is
listed as missing, and the board refuses to rank rather than fill a gap with a
plausible number. It is developed against **Mrs. Met's Harem** (Yahoo H2H-points
league 228947), which is why that league appears throughout the tests and the
committed capture, but nothing in the engine is specific to it.

That league is **not** what a first visit opens on, and for a while it was. The
build seeded `public/scoring.json` into any browser with nothing stored, so a
stranger's first screen was a fully ranked board denominated in somebody else's
points, under a notice explaining that it was — which is the tell: a product that
has to explain that its main screen is not about you is showing the wrong screen.

`publishSnapshot` in `vite.config.ts` now empties `leagues` on the way into the
published asset, alongside the roster, lineup and pool it already stripped. What
still ships is nobody's: the presets, the canonical stat list, the schema version.

A first visit gets a **ranked board** — on the shipped preset, standard head-to-head
points values, nobody's team — with Billy's pick above it and the setup hovering at
the foot of the page in `src/client/Dock.tsx`. The board says whose scoring it is on,
on its own face. That shape is the answer to two failures, not one: seeding a real
person's league passed somebody else's team off as yours, and showing a form first
asks two minutes of typing from a stranger who has not yet seen a single number —
and the numbers are the entire argument for typing. `src/client/Onboard.tsx` is the
sheet the dock opens: where do you play, what does your league score, who is on your
team, with the first two out of one paste of the league's own settings page.

Running this repo is the deliberate exception. `npx vite` serves the `scoring.json`
that `src/cli.ts` just wrote, roster and free-agent list included, because that file
is *yours*: the dev server has a middleware that shadows the published asset with the
one at the repo root. That is why the browser suites still open on a real league and
`test/static.mjs`, which runs against the build, opens on the preset board with the
dock at its foot.

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
  tool, not for merch. The tagline is borrowed on the same terms: it adapts the
  *Moneyball* line "How can you not be romantic about baseball?".

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
  hitter. The app links here from "How to read this" in the footer (`Colophon` in
  `src/client/App.tsx`), and from there only. The same link used to sit in the nav
  beside the three tabs as well; on a 390px phone it pushed them into a horizontal
  scroll and cut itself off mid-word, so the duplicate went and the navigation stayed.
- **[docs/METHODOLOGY.md](docs/METHODOLOGY.md)** — how a bscore is computed, worked
  through with real numbers, plus the backtest design, what is built on top of a
  bscore, and the negative-results ledger. The app's footer (`Colophon` in
  `src/client/App.tsx`) links here, and carries the one caveat a reader's decision
  actually turns on — a bscore is not a promise of points — rather than the four
  paragraphs of fold counts it used to render under every tab.
- **[docs/FINDINGS.md](docs/FINDINGS.md)** — the open defects and rough edges found by
  walking the published build, each with how it was found and what it costs, so the next
  pass starts from evidence rather than from a fresh walk. Nothing in the app links to it
  and nothing should: it is a working file for whoever picks this up next, it goes out of
  date by being fixed, and its own rule is that a fixed entry is deleted while an entry a
  later walk disproves says so in place rather than vanishing. It was linked from nowhere
  in this repo until this line existed, which is most of why two of its entries stayed
  open in the file for a while after the code had fixed them.

## The app

Ranks every MLB player by a **bscore** — projected points over the horizon, minus
what a freely available replacement at the same roster slot would produce, in *your
league's* scoring. Points above replacement is the honest unit: a bscore of 40 means
forty more points than the next man up, in your league's own currency.

Three screens, one job each. Their names are written in exactly one place —
`VIEWS` in `src/client/panels.tsx` — and nothing else is allowed to retype them,
because they have been renamed three times and every rename left a card pointing at a
screen with no such name.

**Tonight** is the one you open before first pitch. It is the daily lineup as a *diff*
— start these, bench these, and why — plus the seats that will score nothing tonight
and the best gettable man who is actually on a card for each of them, plus at most a
couple of add/drops with both sides named and the point gain. Nothing on it is a
leaderboard. Where the schedule is knowable it is read live from MLB rather than from
the shipped capture, so "no game today", "not in today's lineup" and "lineup not
posted" are three different sentences instead of one guess (`src/data/today.ts`). That
third one read "lineup not posted yet" here for a while, carrying a "yet" the code has
never printed — which is the cost of retyping a string the code owns, incurred in the
very sentence that names the module it was retyped from.

**Pickups** is everyone you can actually get, ranked. It opens on three horizons, which
are three questions rather than three filters: **Streaming** ranks over whatever is
left of *your league's own* scoring period, against that period's real slate — the
rest of this matchup in a weekly league, today in a daily one, the next period where
lineups lock for the whole of the current one, and a rolling seven days only where the
league scores no periods at all or has not said which it runs (`src/engine/period.ts`).
The board prints which of those it used and where the window's edges came from,
because there is no neutral default to fall back on silently. **This fortnight** is
the standing 14-day board and the default, and **Stash** ranks over every game left in
the regular season. Streaming and the fortnight open filtered to players you can add —
on the committed capture 38 of the first 50 rows of an unfiltered board are rostered in
90% of leagues or more and three are under 50%, which is a leaderboard wearing a
recommendation engine's name. Stash opens unfiltered, because it is about players you
already hold.

**My league** is your team and your league, in that order, and it is a screen you visit
once a season. Everything the other two say is priced in the values on it.

There used to be a fourth tab, **Draft**, and a trade evaluator standing open beside the
roster. They were demoted for the same measured reason: the published decompositions of
what wins a points league put pre-draft ranking quality near zero and trades close to
it, while volume accumulation — never leaving an allowed slot unused — is roughly the
magnitude of all in-season move quality combined. In this league's own scoring an empty
hitter seat costs about 6.9 points a night; a realistic within-roster upgrade is worth
0.7 to 1.5. So the app leads with the seats. **Draft** is deleted outright, screen and
`src/engine/draft.ts` both. The evaluator is not deleted — it is folded behind a **Price
a trade** button on **My league** (`dealOpen` in `src/client/Trade.tsx`), because it
still answers a real question for anyone holding a real offer; what it lost was 718px of
standing height between the reader's lineup and his league's scoring.

### Getting your league in

Nothing on any tab means anything until the app knows four things: your league's
**batting scoring**, its **pitching scoring**, its **roster slots** and its **team
count**. Everything else is refinement. How you supply those depends on the platform,
and the difference is real rather than cosmetic:

There are four reads in total, and only the first is needed to rank anything. The
other three are what turn a ranking into advice about *your* team: which seats you
have filled, and who you can actually add.

| | scoring, slots, period | your roster | your league's free agents |
| --- | --- | --- | --- |
| **ESPN** | in the browser, or paste | in the browser, or paste | **in the browser, or paste** |
| **Yahoo** | **paste**, preset, or carry a file | paste, or carry a file | paste, or carry a file |
| **anywhere else** | paste | paste | paste |
| **Sleeper** | not supported — Sleeper runs no fantasy baseball | — | — |

So an **ESPN** league is entirely self-service on beanemachine.com: paste the league
URL (with `&teamId=` for your own team) and nothing else is installed, configured or
carried. A **Yahoo** league gets a working board immediately from the preset, and
everything about *your* team by running the importer once and dropping the file it
writes on the page.

**Why Yahoo cannot work in a browser.** Measured 2026-09-04 with `Origin:
https://beanemachine.com` on the exact pages `src/import.ts` reads: ESPN's
`lm-api-reads.fantasy.espn.com` reflects the origin back in
`access-control-allow-origin`, so a page may read it. Yahoo's
`*.fantasysports.yahoo.com` sends no access-control headers at all, so the browser
never hands the response body to the script, whatever it contains. That is not a bug
in this app and no amount of client code fixes it. Yahoo is also an HTML scrape rather
than an API, which is why `/api/available` exists at all.

ESPN's free-agent list **does** have a browser-direct counterpart, measured the same
day. Its player endpoint needs the query as a custom `x-fantasy-filter` header, which
forces a CORS preflight, and ESPN answers that preflight with
`access-control-allow-headers: x-fantasy-filter`. So the one read Yahoo can never do
from a page — who is actually available in *your* league — an ESPN user gets with no
server at all.

**Why Sleeper is refused rather than attempted.** Sleeper does not host fantasy
baseball. Its support site lists the sports its leagues play and baseball is absent;
its API documents one sport value, `nfl`; and `/v1/state/mlb` carries no
`league_create_season` — the field `/v1/state/nfl` and `/v1/state/nba` both have — so
there is no season in which a Sleeper MLB league can be created. `/v1/players/mlb`
*does* return 6,379 real players, because Sleeper tracks baseball for news and props,
which makes it a trap rather than an absence: player ids are per-sport namespaces that
collide (id `1352` is Robert Woods in NFL and Jordan Hicks in MLB). Importing
Sleeper's own documented example league used to succeed and produced a league with 0
batting stats, 0 pitching stats and slots `QB, RB, WR, TE, FLEX, DEF, BN` — unusable
and unrepairable. A pasted Sleeper URL now gets that explanation instead of a league.
The evidence is kept in `test/ownership.mjs`; the reader that produced it was deleted.

**The Yahoo route, end to end.** There are two, and the first needs nothing
installed.

**Paste the page.** Yahoo's settings page prints the batting and pitching stat
tables, `Roster Positions`, `Max Teams` and `League ID#`, so selecting the whole page
and pasting it yields the scoring, the slots, the team count and the league id in one
gesture. `src/data/paste-settings.ts` reads it and hands it to the same
`deriveScoringPeriod` and `deriveSlotAccepts` that `src/import.ts` uses on a fetched
page, so the two routes cannot disagree about what a league is —
`test/settings.mjs` proves it by reconstructing that page from the league this repo
fetched while the importer still worked, pasting it, and asserting the league that
comes out is identical. Your team page and free-agent page paste the same way.

This is the only route that works on a **private** league, which is most leagues, and
the only one no platform can revoke: the browser doing the reading is the reader's
own, already signed in, and not rate-limited as a scraper because it is not one.

**Or one local run, then a file that goes anywhere:**

```sh
npx --yes github:ssalbdivad/beanemachine \
  https://baseball.fantasysports.yahoo.com/b1/<league-id>/<team-id>
```

It reads the league's settings and position-eligibility pages, writes the league into
`scoring.json`, makes it active, and prints a four-line readiness table saying whether
each of the four required inputs actually arrived — plus everything the source did not
state, verbatim. `--help` lists the URL shapes. The league must be publicly viewable;
a private one needs a signed-in session the importer cannot hold.

It also makes two reads no browser can: **your league's free agents** and **your own
roster**, seat by seat. The first is the one that matters. "Which starters should I
stream over the next three days" is a question about the players you can *add*, and
Yahoo's free-agent page sends no CORS headers — so beanemachine.com will never be
handed one, and until the list travelled in this file the hosted board answered a
streaming question with a ranking of everyone in baseball. Measured against league
228947 on 2026-09-04: over a three-day window, all 20 rows at the head of the
Streaming tab were on somebody's roster; with the file's 150-player wire loaded, the
list was 9 starters, all of them actually free, and the two top-20s had nothing in
common. Both reads are stamped with the instant they happened, and the masthead says
how old they are rather than showing them as live — a pool is only true until the next
person in the league clicks Add. `--settings-only` skips them. The path to the file is
the last line the command prints.

From there the league is a file:

- `npx vite` seeds a browser that has nothing stored from `scoring.json`, so a local
  run opens straight on your league.
- **My league → Download** in the app writes the leagues in your browser to a JSON
  file; **Load file** on any other machine or browser reads it back, and so does
  dropping it anywhere on the page (`leagues.download` / `leagues.replace` in
  `src/client/leagues.ts`). That is how a Yahoo league gets onto the hosted site: read
  it once locally, carry the file. The file carries four things under four optional,
  plain-JSON keys — `leagues`, `rosters`, `lineups` and `pools` — and each of the last
  three has its own store in the browser (`roster.ts`, `lineup.ts`, `pool.ts`) rather
  than a second copy inside the config. A file written before any of them existed
  still loads: every one is optional and omitted when empty.

Leagues live in browser storage, never on a server. The API process reads leagues off
their own pages and hands the result straight back; it stores nothing.

### Running it

```sh
node src/server.ts                      # Hono API on :8000 — /api/* only, no UI
npm run dev:web                         # the client on :5299, proxying /api — this is the one to open
node src/refresh.ts                     # capture a fresh snapshot of MLB + Savant into data/snapshot.json
npm run check                           # tsc --noEmit
npm run build                           # static bundle into dist/
npm test                                # every suite
npm run test:node                       # just the pure-Node ones — no browser, no server. This is what CI runs.
```

**The port is 5299, and it is the config's own, with `strictPort` so it cannot slide.**
Vite's default is 5173, which on the author's machine belongs to a different application
that answers 200 and serves a working site — so every browser suite here defaults to
`http://127.0.0.1:5299` and reads the wordmark before its first assertion rather than
trusting a status code (`test/ui.mjs`, `board.mjs`, `trade-ui.mjs`, `decide.mjs`,
`journey.mjs`). `test/static.mjs` runs against `npm run preview` on `:4173`.

Two notes a new reader will otherwise hit. The `dev`, `start` and `import` entries
in `package.json` shell out to `nub`, a TypeScript runner this repo does not
install, so they fail; the lines above are what they were meant to do, and
`node --experimental-strip-types src/cli.ts <league-url>` is the `import` one. (On
Node 23.6 and later the flag is a no-op — type stripping is on by default — but it is
required on 22.x and harmless everywhere, so it is what gets printed.) And `npm test`
runs seventeen suites in two groups: twelve are pure Node (`api`, `paste`, `settings`,
`today`, `injuries`, `engine`, `leagues`, `trade`, `auto`, `period`, `ownership`,
`compete` — the `test:node` script, which is also the CI gate) while five (`ui`, `board`,
`trade-ui`, `decide`, `journey`) drive a real page, so **the dev server has to be
running** or they fail on a connection rather than on a defect. A live server on that
port that is not this app is the same trap without the connection error, so each of the
five reads the `<h1>` wordmark before its first assertion and stops there if `BASE` is
serving somebody else. Two of them — `ui` and `board` — reach
`/api` as well, so **`node src/server.ts` has to be up beside it** or Vite proxies
into nothing and the page logs a 502 that reads like a client bug. Both lines
above, both running, is the state every suite expects. `BASE=` points them
elsewhere, `BROWSER=chromium|firefox` picks the engine.

One more, and it costs an afternoon if you meet it cold. **Refreshing the snapshot
while Vite is running does not change what the browser is served.** `vite.config.ts`'s
`publishSnapshot` plugin copies `data/snapshot.json` to `public/snapshot.json` in
`buildStart`, which fires when Vite *starts* and never again; `node src/refresh.ts`
writes `data/` and nothing re-copies it, and `public/snapshot.json` is gitignored, so
git will not tell you either. Nothing errors, because a stale snapshot is still a
valid one. If the stale copy predates the slate the board renders **zero rows** and
the console stays clean: `hydrate` reads `s.slate ?? []`, every club's game count
comes back empty, `projectedVolume` is 0, `rateable` is false for every player, and
the row filter drops all of them. Restart Vite after a refresh, or copy the file
across by hand.

`npm run test:static` sits outside `npm test`, because it needs a build rather than a
dev server: `npm run build`, then `npm run preview` in one shell and `npm run test:static`
in another. It is the only suite that asserts what a *stranger* sees — the preset board
with the dock at its foot, and no league — which is the one thing the dev server
deliberately cannot show, because it shadows the published asset with the `scoring.json`
at the repo root.

`npm run test:compete` replays 2021-2025 from the backtest cache in
`data/backtest-cache/`, which is gitignored, so a fresh clone has nothing to replay
until `node src/backtest/compete.ts` has run once. It is in `test:node` and will fail
loudly on a cold cache rather than quietly pass.

The build's base is **`./`**, not `/beanemachine/`. A repo-name base bakes the
deployment path into every asset URL, so the same artifact 404s anywhere else — which
is exactly what pointing `beanemachine.com` at it would have done, serving an
index.html that asks for `beanemachine.com/beanemachine/assets/…`. A relative base
resolves against the document, so one build works at the project-pages path and at a
custom domain's apex with no rebuild and no window where either is broken. It is safe
here specifically because the app has no client-side router — the tabs are state, not
paths — so there is no nested URL for a relative reference to resolve wrongly against.
`src/client/api.ts` resolves `/api/*` against `BASE_URL` for the same reason, which is
why the static-mode probe correctly asks `<wherever-it-is>/api/health`.

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

The rails hold in every mode: at most `--max-moves` per run (default 2, the measured optimum), nobody at
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
  a browser shows no UI, unless you have run `npm run build`, in which case it also
  serves what is in `dist/`. Your leagues are not kept here: they live in the
  browser's storage, so the hosted static build behaves identically for everything
  except those two calls.
- **`:5299` — the Vite client**, with HMR, proxying `/api` through to `:8000`.
  **This is the one to open.** It is `vite.config.ts`'s own port with `strictPort`, so
  Vite cannot quietly increment onto a neighbour — Vite's 5173 default belongs to another
  application on the author's machine.

### Where the numbers come from

All unauthenticated, all captured server-side into `data/snapshot.json`. Row counts
are from the shipped capture (**2026-09-08T19:17Z**, horizon 2026-09-08 → 2026-09-22):

| Source | What it gives | Rows |
|---|---|---|
| MLB StatsAPI `/stats?stats=season&playerPool=All` | the whole pool and its season lines | 736 hitting rows, 851 pitching rows → 651 + 795 after the position filters |
| MLB StatsAPI `/stats?stats=byDateRange` | the same stats inside a window — recent form | 3/7/21d batters, 5/21d pitchers |
| MLB StatsAPI `/schedule?hydrate=probablePitcher` | one read: every regular-season game from the capture to the end of the season, one row per game, carrying both clubs and each side's probable starter. No counts are stored — every window's games, opponents and probables are counted from these rows at read time, because which window matters is a property of the reader's league | 265 games over 30 teams; 35 carry a published starter, and 60 pitchers have one inside the 14-day horizon |
| MLB StatsAPI `/standings` | team games played to date — the per-game denominator | 30 teams |
| MLB StatsAPI `/teams/{id}/roster` | IL status, filtered to the D-prefixed IL codes | 198 players |
| Baseball Savant `statcast_search` (pitch level, a day at a time) | rolling 21-day wOBA and xwOBA | 468 batters, 535 pitchers |
| Baseball Savant `expected_statistics?min=1` | season-long xBA, xSLG | 654 batters, 851 pitchers |
| Baseball Savant `statcast?min=1` | barrel %, exit velocity, hard-hit %, sweet-spot % | joined by `player_id` |
| Yahoo public player pages | "% Ros" — the market's price, and the eligibility Yahoo prints beside each name | 1,110 rows read, 880 of the pool priced; 411 multi-position lines, 328 matched into the pool |

Three coverage decisions matter. `playerPool=All` instead of the default, because
the qualified leaderboard is roughly a third of the real pool and hides exactly the
waiver-wire players this exists to surface. Savant `min=1` instead of `q`, which
lifts batter coverage to 654 — on this capture **all 1,446** pooled players have an
xwOBA, and 983 of them have one from the rolling window rather than the season. And
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

### Is any of it measured? — yes, and the evidence lives in one place

**[docs/METHODOLOGY.md](docs/METHODOLOGY.md) is the measurement document.** It is long
on purpose and it is the only copy: every fold, every paired week count, every z, every
retraction, and the three things that could not be measured at all are there and are
not restated here.

This section used to *be* a second methodology paper — 605 lines of it, running from the
backtest design through the Savant retraction, matchups, scheduled starts and model
tuning, while `docs/METHODOLOGY.md` covered the same ground in 2,055 lines of its own.
They were not a copy and a paste. Measured as 8-word shingles over normalised text,
**12.2% of that span appeared anywhere in METHODOLOGY** (761 of 6,262); at 20-word
shingles it was 3.5%, and only **22 of 434** substantial lines matched a METHODOLOGY line
exactly. Two documents written independently about the same measurements, in other words,
which is the arrangement that guarantees they eventually disagree — and they did, on the
headline correlation figures, in a way a reader had no way to adjudicate. A README is the
wrong home for a number that gets re-measured: it is the first thing anybody reads and
the last thing anybody re-derives.

What the span is now is a map. Each line is a question and the section that answers it:

| the question | where it is answered |
|---|---|
| How does a stat line become points, with real players worked through? | [§2](docs/METHODOLOGY.md#2-from-a-stat-line-to-points) |
| How is playing time projected, and why do the windows differ by side? | [§3.3](docs/METHODOLOGY.md#33-the-blend-and-why-the-windows-differ-by-side) |
| What happens when MLB has published only part of the window's starts? | [§3.5](docs/METHODOLOGY.md#35-scheduled-starts-override-the-team-games-estimate) |
| What is replacement level, and why does it move catchers up? | [§4](docs/METHODOLOGY.md#4-replacement-level) |
| Where does the confidence percentage come from? | [§5](docs/METHODOLOGY.md#5-confidence) |
| How is the backtest built, and why is it leak-free? | [§6](docs/METHODOLOGY.md#6-the-backtest) |
| **The ranking results — the one correlation table in this project** | [**§6.5**](docs/METHODOLOGY.md#65-results) |
| The five ideas that were implemented, measured and switched off | [§7](docs/METHODOLOGY.md#7-the-negative-results) |
| The Statcast retraction, and the clean re-measurement that replaced it | [§7.1](docs/METHODOLOGY.md#71-the-statcast-multiplier--retracted-re-measured-still-off) |
| What it does not know, and what would improve it next | [§8](docs/METHODOLOGY.md#8-known-limitations-and-what-would-improve-it-next) |
| **Does it beat a human? — five seasons played out, with the honest p-value** | [**§9**](docs/METHODOLOGY.md#9-does-it-actually-win--five-seasons-played-out) |
| Why schedule strength ships at half weight | [§9.1](docs/METHODOLOGY.md#91-the-same-harness-sets-the-matchup-weight) |
| Every idea, shipped or rejected, in one table | [§10](docs/METHODOLOGY.md#10-the-negative-results-ledger) |
| What is built on top of a bscore — edge, luck, trades, autonomous mode | [§12](docs/METHODOLOGY.md#12-what-is-built-on-top-of-a-bscore) |
| How the lineup is assigned, and the two wrong ways that were tried first | [§13](docs/METHODOLOGY.md#13-the-lineup-assignment-and-the-two-wrong-ways-to-fix-it) |
| How fast it is, and how that was measured on this box | [§14](docs/METHODOLOGY.md#14-speed-and-how-it-was-measured) |
| Every command that reproduces any of the above | [Reproducing any of this](docs/METHODOLOGY.md#reproducing-any-of-this) |

**The four results worth knowing before you read any of that.** These are the headlines,
each one stated with its strength, because a win count quoted without its significance
reads as a stronger claim than it is:

1. **Value over replacement is the whole metric, and that is the unambiguous result.**
   Ranking waiver decisions by raw projected points instead — ignoring the thing the
   metric exists for — loses **80 of 111 paired weeks (z −4.65)** and 4,996 points over
   five seasons. Dropping a replaceable outfielder for a scarce catcher is right even
   when the catcher scores fewer points, and nothing else in the model sees it.
2. **Recent playing time is the next largest edge.** Re-measured on the shipped corpus
   on **2026-09-11**: the shipped blend ranks hitters at **ρ 0.676** against a naive
   baseline's 0.574 (**+17.7%**) and pitchers at **ρ 0.535** against 0.470 (**+13.9%**).
   That pair, and only that pair, is what this file publishes about correlation — the
   table it belongs to is [§6.5](docs/METHODOLOGY.md#65-results).
3. **It beats an inactive or streak-chasing manager beyond argument, and a thoughtful
   one only suggestively.** Draft-and-hold loses 98 of 111 weeks (z 8.74) and hot-hand
   74 of 111 (z 3.51). A manager who blends season and recent form loses **63W-47L,
   z 1.53, one-sided p 0.064** at two moves a week and 60W-50L, z 0.95, p 0.17 at one.
   Directional, not significant, and [§9](docs/METHODOLOGY.md#9-does-it-actually-win--five-seasons-played-out)
   spends several paragraphs on why — including a week-grid choice that moves the number
   more than the p-value does.
4. **Statcast contact quality is measured, real, and deliberately not used.** xwOBA
   out-predicts actual wOBA for next-week production (ρ 0.102 against 0.058, incremental
   partial ρ +0.094 at z 6.79, n 5,151) and three separate ways of acting on it — scale
   the projection, reshape the adjustment, veto the player — all lose over 111 weeks. A
   metric can be genuinely predictive and still be the wrong lever. The drill-down says
   so on every player's card. [§7.1](docs/METHODOLOGY.md#71-the-statcast-multiplier--retracted-re-measured-still-off)

**Paired weekly win counts decide; ranking correlation is advisory.** They have
disagreed once already — over the recency weight — and the played seasons were right.

### The weights, and re-measuring after you change one

Every tunable weight lives in [`model.json`](model.json) rather than in code, so a
change to the recommendation is a change to a file a human can read:

```jsonc
"recentForm": { "blend": { "hitting": 0.5, "pitching": 0.5 },
                "rate": { "hitting": 0, "pitching": 0.15 },
                "windows": { "hitting": { "3": 2, "7": 1, "21": 1 }, "pitching": { "5": 2, "21": 1 } } }
"statcast":   { "weight": 0, "windowDays": 21, ... }
"probables":  { "use": true, ... }
"matchup":    { "weight": 0.5, "clamp": { "min": 0.88, "max": 1.12 }, ... }
"shrinkage":  { "default": 400, "perStat": { "homeRuns": 170, ... } }
```

ArkType validates it at import (`src/engine/weights.ts`), so a typo fails loudly instead
of silently producing a plausible recommendation built on a number nobody chose. Every
block carries a `why` array recording the evidence that set it, and those arrays are the
shortest honest summary of the measurement record in this repo — read them before
`docs/METHODOLOGY.md` if you only have five minutes.

```sh
node src/backtest/compete.ts --seasons=2021,2022,2023,2024,2025 --moves=2  # the decisive test
node src/backtest/evaluate.ts                                             # ranking correlation (advisory)
```

Each `compete` run appends its configuration and its weekly points per strategy to
`data/results/`, where twenty-three of them now sit. They are kept because each costs
about half an hour of pitch-level fetching and because the conclusions they support get
revised as seasons land — a shipped weight whose evidence lives only in a terminal
scrollback has no evidence. Every other command, the flag that silently measures
nothing, and the one known defect in the pooling tool are in
[Reproducing any of this](docs/METHODOLOGY.md#reproducing-any-of-this).
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
