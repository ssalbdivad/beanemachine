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

**Three whole entries have been cut since that walk, fixed outright, and are named here so the
next walker knows they were looked at rather than missed.** The setup box refusing six surnames
and then offering five of the men back as buttons (a one-word line whose surname exactly one man
in baseball carries is now accepted, «Soto» is still refused and says why, and an accepted
suggestion's line leaves the box with him). The landscape sheet cutting its own headings off the
top of the screen (the height cap belongs on the dock, not the sheet — a fixed element anchored
at the bottom grows upward). And one team's projected points reading 1523.92 on My league and
33.17 on Tonight with neither number naming its window (both name it now).

---

## Back: two of three cases FIXED at 03:42, the drill-down still eats two gestures

The oldest entry here, and it moved during the walk. On the **03:35** build all three cases
failed identically — `history.length` was 2 before and after every gesture, the two entries
being the walker's own `goto` calls, and Back landed on `about:blank` from the open setup
sheet, from Pickups, and from an open drill-down. A reader arriving from a link has one
entry, so Back took him off the site.

Re-measured against the **03:42** build, empty profile each time:

| gesture | `history.length` | Back lands on |
|---|---|---|
| open the setup sheet, type three names | 2 → **3** | Tonight, sheet closed, **the three names still in the box** |
| Tonight → Pickups | 2 → **3** | Tonight, Pickups deselected |
| Pickups → open a row's drill-down | **3, unchanged** | Tonight, with BOTH the drill-down and the Pickups tab undone |

So the first two are fixed and their entries are retired. What is still open is the third:
**opening a drill-down pushes nothing**, so the one Back a reader presses to close a row he
opened by mistake also throws away the tab he was on and returns him to Tonight. That is one
gesture undoing two actions, and it is the gesture a phone reader uses most.

One more Back from any of the three still exits to `about:blank`, which is correct — that is
the entry the page was loaded on.

NO LONGER TRUE: **the URL never changes.** It does now — `#tonight`, `#pickups`,
`#my-league`, written by the same gesture that pushes the history entry. Verified: landing
writes the hash, a tab press updates it, a reload comes back to the same screen, and a pasted
`#my-league` link lands there. `hashchange` is listened for as well as `popstate`, because a
link pasted into the same tab fires only the first. Left here rather than deleted because the
drill-down half of this entry is still open.

## Everything the ranking is built on is four days old, and the chip says one

The masthead chip reads, verbatim:

> player data **4d ago** — a day of games has happened since

84.3 hours is 3.5 days; `freshness` rounds that to "4d". The clause was hard-coded for every
stale case, so at 84 hours the app understated its own staleness by three days beside the
number that contradicted it — the most flattering possible account of how wrong it might be.
FIXED: `freshness` returns the day count, floored, and the clause reads "3 days of games
since". Floored rather than rounded because the sentence is about days of games that have
actually finished; the label rounds for its own and equally honest reason.

It is not only the chip. Tonight's schedule, tonight's posted lineups, the injured list and
last night's box scores are all read live; the projections underneath them are a static
file, and two other surfaces date themselves from it:

- Pickups' header reads `1008 players · Sep 8 → Sep 22` — a window that opens four days in
  the past. `horizonSpan` in `src/client/Board.tsx` prints `snapshot.horizon`, which is
  baked into the capture.
- Pickups' top five with no team are the same five names as the 2026-09-11 walk, to the
  decimal: #1 Grant Taylor RP CHW 35.27, #2 Sam Antonacci OF CHW 34.85, #3 Tristan Peters
  OF CHW 33.53, #4 Heriberto Hernández OF MIA 32.31, #5 JJ Bleday OF CIN 29.91. Billy's
  pick is still Grant Taylor.

## A first visit still reaches a board of nobodies, one tap in instead of zero

Partly relieved, not fixed. A first visit now lands on Tonight, so the five names above are
no longer the whole first impression — but "Everyone you can get →" and the PICKUPS tab both
land on them, and Billy's pick on that screen is a White Sox relief pitcher. The entry's
original argument stands: a free-agent board ranked by value over replacement SHOULD be full
of men nobody has rostered, which is exactly why that screen needs one sentence saying so.
There is still no such sentence. Measured 2026-09-12, empty profile, one tap from landing.

## Nine hovers became text; fifty-eight did not

The commit message for `918153a` is "Nine hovers a phone cannot reach, on the screen about
your own team", and nine is the true count. **58 `title=` attributes are still live on My
league** (`[...document.querySelectorAll("[title]").length]`, 2026-09-12). 51 are under six
words — labels on the scoring grid's inputs and its eighteen "Remove X" buttons, which is a
defensible use. Seven are whole sentences a thumb cannot open, and three of those seven are
the primary navigation:

- TONIGHT — "Who to start before first pitch, which of your seats scores nothing, and the
  one move worth making."
- PICKUPS — "Everyone you can actually get, ranked in this league's scoring, over the window
  you pick."
- MY LEAGUE — "Your league's scoring, slots and team count, and the men on your team.
  Everything the other two screens say is priced in these."
- Set up a league — "Read a league off its own settings page, or start from a preset — the
  guided setup"
- the preset button, Remove, Download and Load file each carry a sentence of their own.

The three tab sentences are the best orientation copy in the app and a phone reader never
sees one of them.

FIXED, the two that carried information nothing else said: the capture-age chip's hover
("Age of the MLB and Statcast capture the ranking is computed from" — a phone cannot open it,
and three of its words are about the software) is gone, with the part a reader needs now in
text on the stale case; and the availability chip's entire explanation, which was a hover on a
control whose visible text already says "estimated" and "make it exact", is gone too — the WHY
lives on the screen the button leads to, where My league now prints where the taken/free line
falls and in which league.

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
