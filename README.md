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

React 19 + TanStack Form on the client, Hono on the server, Vite for the build —
and one set of ArkType schemas shared by both sides.

```sh
nub run dev      # Hono API on :8000 + Vite on :5173 (proxied)
nub run import <league-url>
nub run test     # browser suite against the dev server
nub run check    # tsc --noEmit
nub run build    # static bundle into dist/
```

`src/schema.ts` is the single contract. The same `League` type validates TanStack
Form on every keystroke, guards each Hono route through `@hono/arktype-validator`,
and gates writes to `scoring.json` — so an invalid edit is refused in three places
and can never reach disk.

`scoring.json` holds one entry per league. **Nothing in it is ever inferred**: every
value is read from the league's own pages or API, and anything a source doesn't
state stays `null` and is named in that league's `needs_review`. A missing setting
must never be able to pass for a real one — a wrong point value silently corrupts
every lineup decision downstream.

Importers: Yahoo (scrapes the public settings + position-eligibility pages), ESPN
and Sleeper (public APIs). ESPN reports stats as numeric ids; those are kept raw
under `scoring.unmapped` rather than guessed at.

### The two run modes

The client detects whether an API answers and adapts:

- **server** — `nub run dev`. Imports scrape live leagues; Save writes `scoring.json`.
- **static** — the GitHub Pages build. The committed `scoring.json` loads as an
  asset, edits stay in the browser, and Save downloads the file. Importing is
  impossible in a browser regardless of hosting: Yahoo and ESPN send no CORS
  headers, so the page cannot read them. The UI says so rather than failing quietly.

`.github/workflows/pages.yml` typechecks, builds and deploys `dist/` on every push
to `main`. Vite sets `base` to `/beanemachine/` for that build, since Pages serves a
project repo from a subpath.
