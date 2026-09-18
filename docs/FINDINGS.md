# Open findings

Defects and rough edges that are measured, reproducible, and NOT yet fixed. Each one says
how it was found and what it costs, so the next pass starts from evidence rather than from
a fresh walk. Fixing one means deleting its entry here; if a walk shows it is no longer
true, say so in the entry rather than removing it silently.

Everything below was measured on **2026-09-12** against the build in `dist/` served by the
preview on 127.0.0.1:4173, at 390x844 with an empty profile unless stated, with live MLB
requests allowed. The committed capture is stamped 2026-09-08T19:17Z, 84.3 hours old at the
time of the walk.

`dist/` was REBUILT at 03:42, in the middle of the walk, which moved three of these entries
under the walker's feet. Every entry below was re-run against the 03:42 build after that and
says which build it is measured on; anything that changed between the two is recorded as
changed rather than quietly restated.

**Six whole entries have been cut since that walk, fixed outright, and are named here so the next
walker knows they were looked at rather than missed.**

- The setup box refusing six surnames and then offering five of the men back as buttons. A
  one-word line whose surname exactly one man in baseball carries is accepted now, «Soto» is
  still refused and says why, and an accepted suggestion's line leaves the box with him.
- The landscape sheet cutting its own headings off the top of the screen. The height cap belongs
  on the dock, not the sheet — a fixed element anchored at the bottom grows upward.
- One team's projected points reading 1523.92 on My league and 33.17 on Tonight with neither
  number naming its window. Both name it.
- Back from an open drill-down undoing the tab as well as the row. It pushes in the gesture now,
  a second row replaces rather than pushes, and Back into Pickups restores the row it was on.
- The board's header dating itself from the capture — "Sep 8 → Sep 22" over rows rated Sep 12 →
  Sep 26. It prints the window the rows were actually rated over, and 14 of 30 clubs had
  different game counts in the two.
- The board of nobodies having no sentence saying why. It has one, with the rostered range
  computed off its own rows: 14% to 35%, which is what being under a ten-team league's cut looks
  like.

And one defect found by the published-build suite while it was being repaired, fixed rather than
recorded: reaching the board by the TAB set `onboarding` false, and `docked` is `onboarding ||
!league`, so the moment a league existed — the moment the preset is adopted, mid-first-visit — a
tab press UNMOUNTED the setup sheet and took the reader's typed lines with it. A tab press closes
the sheet and keeps the bar now.

---

## Hovers: the three that carried sentences are text now, and 68 remain on one screen

Closed, and the count is restated because both figures in it were wrong. The three tab sentences
— the best orientation copy in this app — were `title` attributes on the nav buttons, which is a
hover, on a product opened on a phone. All three are text on their own screens now (Pickups
renders its own through `purpose()`; Tonight and My league are composed by App, so App renders
theirs), the nav's `title` attributes are gone, and what survives is the disabled variant "— set
a league up first", which is information no screen can carry.

The counts: it is **70** `title` attributes on Pickups, not the 58 measured on My league, and 68
of them are longer than six words — because every ranked row hangs a sentence about its own game
count. That is the remaining work and it is not obviously work: a row's hover repeats what its
own drill-down says, so the question is whether to delete them rather than where to put them.
Measured 2026-09-12.

Still open on the same screen, and smaller than it looks: the two capture-age and availability
chips were the only two outside src/client/Trade.tsx carrying information rather than restating a
visible control, and both are fixed.

## Software talk: all six strings fixed, and recorded rather than deleted

Every string this section listed on 2026-09-12 is gone, and the list stays because the next
walk should know which surfaces have already been swept rather than re-reading them.

- `stopping at 2, a cap carried over from an earlier version and not re-measured since` — a
  fact about this repository in a heading about baseball. Now says it is this app's own limit
  and not a measured best, which is the same information without the changelog.
- `For this scoring period, 2026-09-12 to 2026-09-18` — raw ISO dates on a screen whose other
  date read "Friday, Sep 11". Now "Sep 12 to Sep 18", in the reader's own locale.
- `5 PLAYERS ON THIS TEAM · 1 THE MODEL CANNOT PRICE` — the software naming itself. Now "1
  with no projection", in both places the phrase appeared.
- `Anything the source didn't state is left null and listed here.` — two software words in one
  sentence. Now "Anything your league's own pages did not state is left blank and listed here."
- `1 of your men are in tonight's card` — pluralised now.
- The POSITION ELIGIBILITY sentence naming **league 228947** and a "provenance" no screen
  shows. This is the one that survived every grep of `src/`, because it is DATA:
  `scoring.json` and `public/scoring.json` hold it and `App.tsx` renders it verbatim. It now
  reads "Not read from your league. These are Yahoo's own position-eligibility thresholds,
  copied from one real Yahoo league's settings page on 2026-09-08."

  `provenance.method` in the same file is deliberately UNCHANGED. It still names the file it
  came from, and that is right: nothing renders it, it is a provenance record, naming the
  source is what provenance is for, and the UI keys on its `preset:` prefix —
  test/leagues.mjs caught the removal of that prefix within a minute of it happening.

- NO LONGER TRUE, and was already marked so: the league a reader lands in is named "Yahoo
  head-to-head points", and the "values to check" drawer no longer says "every BSCORE on the
  board is wrong" or "Replacement level is teams x slots".

## Smaller, all measured

- A line of pure punctuation ("???") is still dropped from `unmatched` on both routes.
  Re-measured: `Aaron Judge / ??? / asdfgh / 12345` quotes back «asdfgh» and «12345» and
  says nothing about «???». Defensible; noted so the decision is visible rather than
  accidental.
- FIXED: a man on the 60-day injured list got two different explanations on one card —
  "Bench him — MLB lists him Injured 60-Day" in the change rows and "could not be priced…
  Injured 60-Day — no source states a return date" at the foot. The could-not-be-priced block
  now names only men the card has not already named, and what it still exists for is asserted
  in the same breath: a man parked in a reserve seat nothing says he needs never reaches the
  change rows, and the de-duplication must not swallow him.
- FIXED by making the list SIX: neither resting scroll position showed all eight rows of the
  "best nights" list the first screen leads with. At `scrollY = 0` the dock owns the pixels where rows 7 and 8 are drawn
  (`document.elementFromPoint` at y=725–844 returns `DIV.dock-bar`, `P.dock-say` and
  `BUTTON.primary`, over Cade Cavalli 29.9 and Taj Bradley 29.5). At the bottom of the
  document (`scrollY` 778 of a 1622px page) the sticky masthead owns row 8's pixels
  (`NAV.views` and the selected `BUTTON.on`, over Taj Bradley 29.5). Intermediate positions
  clear both, and the footer links are never occluded, so the reserve `Dock.tsx` describes
  does hold for the page foot — this is two sticky bars over a list, not a broken footer.
  Listed because a screen that leads with eight rows shows six at either end of its scroll.
- NEVER AN ENTRY HERE, and recorded so the next walk does not report them as new. Two
  claims on the hero card were found and fixed in `83650dd` without being written down: it
  said "more points than the best {slot} you could add off waivers" where `bscore.ts` prices
  against the man AT (teams × seats) depth, and the schedule clause branched on any
  multiplier at all, so a 0.3% adjustment was reported as a schedule that "is hard
  (×0.997)". Both are gone from the code.
- RETRACTED on inspection, and still retracted: "next lock 1:35pm" carries no timezone
  label because it needs none. `clock` in `src/data/today.ts` calls
  `toLocaleTimeString(undefined, …)`, so every such time is already in the reader's own zone.
- FIXED AND DELETED this pass: "The management toolbar is a database panel on a stranger's
  path". My league now opens with LEAGUE AND TEAM → STRAIGHT TO → MY TEAM, and New / Remove /
  Download / Load file / Import sit at y=5844–5994 of a 6503px page, under an h2 reading
  "Other leagues, files and backups". Confirmed by offset, 2026-09-12.

## Re-verified unchanged across the 03:42 rebuild

Measured on both builds and identical on each, so the rebuild is not what to check first if
one of these is worked on: the staleness chip, the ISO scoring period, "1 of your men are",
"stopping at 2", "your lineup projects 0, or 33.17", `1523.92 projected points`, "left null",
"THE MODEL CANNOT PRICE", the 228947 eligibility sentence at y=4486, the `1008 players ·
Sep 8 → Sep 22` header, the no-league top five, the 400-row cap and its "The other 608"
line, 58 `title=` attributes on My league, the dropped "???" line, and the occlusion at both
ends of the Tonight scroll.

## Claimed but not reachable, so not verified

The Tonight card is said to state both halves of the innings floor. It cannot on the default
path: `grep -n "innings\|floor" public/scoring.json` returns nothing, so the borrowed league
states no innings requirement and `Decide.tsx:1884` never renders. Whether the sentence is
right is untested by any walk that starts from an empty profile.

---

## The refute pass of 2026-09-12, and what is still open after it

A six-lens adversarial swarm was run against the night's own work and reproduced 72 findings,
which triaged into six root causes. Five are fixed — `36ab94b` through `a256b86` — and each
commit message carries the measurement. Named here so the next walk knows they were looked at:

- The banked-innings sentence was hard-wired to zero in every league, because the read used
  `period.start` (today, on any day after the period opened) where `periodStart` exists for
  exactly that question. It prints 37.7 against the same roster now.
- A null read as a zero, in four places. A side of the ball that failed to answer looked like a
  roster of men who did not play; a date with no baseball on it printed "your lineup scored 0";
  a bench man who never took the field was named as the swap that would have beaten a starter
  who priced below zero; and an empty day graded Billy "level" and froze the verdict.
- A name used as an identity: two men called Max Muncy, and a man held on both sides of the
  ball, collapsed into one React key.
- Escape destroyed eighteen typed lines, because the sheet is `{docked && <Dock>}` and a close
  ends the onboarding state once a league exists. The TEXT is kept now, not the component.
- The Tonight header promised a total that included seats the card had already stopped offering.
- Every deep link on the PUBLISHED build landed on Tonight while the address bar said
  `#pickups` — a first-visit branch that forces the board, unreachable on the dev server
  because a dev read supplies a league.

### Still open, measured, and small

- **A pasted roster line the app cannot match to a player is silently absent from the recap.**
  `unmatchedLines` exists and the setup sheet quotes them back, but a man who was matched when
  the roster was saved and is now missing from the capture simply does not appear in the
  card's count of "N of M of your men played". The M is the count it knows about.
- **A shift's dependent swap is matched on the seat, not on a stored dependency.** `freezeShut`
  infers which swap a shift was making room for by comparing `shift.from` with `swap.startSlot`,
  which is what the data supports today. If `planLineup` ever produced two shifts out of the
  same seat, or a shift made for a reason other than freeing its seat, the inference would be
  wrong in the safe direction — it would freeze a change the reader could in fact have made.
  Recorded rather than fixed because the fix is in the planner's output shape, not in the card.
- **Billy's record can only speak about mornings the reader showed up.** The card reads ONE
  day, so a recommendation recorded on a day nobody came back to is ungradeable for ever, and
  `KEEP_DAYS` eventually drops it. The reason printed is now true of that day, which is the
  honest floor; what would actually fix it is grading the missed days on demand, at two
  requests and about 38 KB each.

---

## What the 2026-09-12 swarm surfaced and this pass did NOT do

Five lenses proposed 43 changes, each verified against the running builds by an adversarial
checker; 33 survived verification and most were implemented the same morning (see the commits
from `36ab94b` to `a256b86` and after). What is left is recorded with the measurement that
found it, so the next pass starts from evidence.

- **Let him type the real Yahoo score in.** The score is the one number he can read with his
  own eyes, and the app has never asked for it, while it does ask him to paste his opponent's
  whole roster. Verified buildable and honest, with three constraints from the checker: key it
  by league AND the period's start date, so Monday does not print Sunday's final as current;
  stamp when it was typed and say so, the way the seats stamp does; and it must not reach the
  engine — there is no per-player variance anywhere in `src/engine`, so a margin cannot steer a
  recommendation, only the reader's own decision. Adding it also makes the Tonight card's "it
  does not know your league's scoreboard" false as written.
- **In-game state is one query parameter away.** Adding `,linescore` to the schedule hydrate
  costs a measured 4,703 extra wire bytes (14,839 → 19,542) and carries `currentInning`,
  `inningState`, `outs` and the score. Nothing in `src/` reads it. The card can now say what a
  lineup has SCORED tonight, but not how much of the night is left in an individual game.
- **One pitching read is fetched twice.** Decide's innings floor and the recap's period total
  ask for the identical `byDateRange` URL — same window, same group — separately, despite the
  hook being shared for exactly that reason. Hoisting it to the page would pay for most of
  another live read.

---

## Open after the browser reader landed — 2026-09-17

The reader (`extension/`) was built, hardened and refuted in one day. Five lenses ran against
it and against the engine changes it made live; most of what they found is fixed and named in
the commits between `d81b42d` and `ec83079`. This is the remainder, with the evidence, so the
next pass starts from a measurement rather than a fresh walk.

### Parsing, and the one contaminant in ten that still gets through

A team page is not only a team, and the extension has no selection to narrow it: it hands
over the whole page's text. Men named in a matchup strip or a trending panel are now dropped
by requiring a SEAT beside the name — measured on a constructed page, 15 matched, 10 kept, 5
dropped — but **one of six contaminants survived** that test, because a seat token earlier in
the page can attach to a later name. Two paste.ts behaviours are behind it and both predate
this route:

- `slotBefore` accepts the English word **"of"** as an OF seat (`SLOT_TOKENS`, paste.ts:38).
  A sentence ending "…of" before a player's name gives him an outfield seat, and a wrong seat
  is worse than no seat, because the Tonight card diffs against it.
- The FIRST mention of a name in the text decides his seat (paste.ts:122), so a news blurb
  above the table costs a real roster man the seat he is really in.

Both are in the parser the whole product's front door runs on, with 54 assertions over it, so
neither is a one-line change. The honest framing is that the extension route made a latent
paste hazard reachable more often, not that it introduced one.

### The opponent list is unbounded and double-counts a two-way player

`readGrabs` subtracts the reader's own men from every name on the matchup page and calls the
rest his opponent. Nothing caps it, so a page that names a hundred men produces a
hundred-man opponent, and `useMatchup.theirs` then sums them against the reader's twenty-odd.
The `>= 3` length guard in the recap fires, but explains it as "lines spelled in a way this
page could not match", which is the wrong reason. A two-way player is also two keys and is
counted twice in the number the reader is shown, which is the number he uses to judge whether
the comparison is fair.

### A covered slot with `count` or fewer free men degenerates

`depth = Math.min(count, eligible.length - 1)` lands on the LAST man on the wire when the wire
at that slot is shorter than the reader's seats there — which is candidate B, the rule
`data/results/wire-depth/` measured and rejected, arriving by the back door on the thinnest
wires. Nobody has measured how often a real sweep is that thin at a slot.

### Two tests that would pass while the thing they name is broken

- `test/engine.mjs:1433` is named "a slot no rateable player is eligible for keeps the zero"
  and cannot see the bar it is named after; it is the only guard on the branch bscore.ts calls
  the most expensive number in the function.
- The integration suite's team-page fixture is a bare roster table, so its roster assertion
  passes for a page that has nothing else on it — which is not the page the extension sends.
  The contamination fix above is tested by a script in the commit, not by the suite.

### The reader cannot be published yet

Named because acquiring them is not a code change:

- **addons.mozilla.org refuses new extensions without
  `browser_specific_settings.gecko.data_collection_permissions`** (required since 2025-11-03).
  `extension/build.mjs` does not emit it, so the Firefox build cannot be submitted as it
  stands. This is the only one of these that is a code change, and it is small.
- A privacy policy at a URL (Chrome links to one; `extension/PRIVACY.md` is a file in a repo).
- At least one screenshot at 1280×800 or 640×400, and a 440×280 promo tile. Nothing emits any.
- Chrome wants 96×96 of artwork inside a 128px canvas; the build draws full bleed.
- A packaged zip: `/usr/bin/zip` is not on this machine, so the build has never produced one
  and both stores take a zip.
- A developer account and a trader/non-trader declaration for Chrome; pre-build source and
  build instructions for Mozilla's reviewers, because the shipped code is bundled by Vite.

### Smaller, all measured

- `extension/src/*.ts` has never been type-checked: `tsconfig.json` covers `src`, `api` and
  `vite.config.ts`, and `@types/chrome` is not installed. `npm run check` has never looked at
  the three files that actually run in a browser.
- The background's `open-yahoo` branch is unreachable — the bridge drops the field that would
  reach it. Left with a comment saying so, and warning that wiring it up without removing the
  page's own `window.open` gives the reader two tabs.
- The Decide card's team-count refusal still explains itself in terms of a wire depth that no
  longer applies to a reader who has read his league's own list.
- `chrome.runtime.reload()` under `--load-extension` does not bring the extension back, so the
  second half of a store update — "and then it works again" — cannot be tested in this
  harness. The orphan block is therefore last in `test/extension.mjs`, and anything needing a
  working reader has to sit above it.
- MV3 service-worker sleep is not reproducible under Playwright (the debugger keeps the worker
  alive), so the `tabs.query` fix that replaced an in-memory tab map is reasoned rather than
  reproduced.
- One run in roughly ten of `test/extension.mjs` reported two failures whose identity was not
  captured. Nine consecutive runs since have been clean at 109/0.
