# Open findings

Defects and rough edges that are measured, reproducible, and NOT yet fixed. Each one says
how it was found and what it costs, so the next pass starts from evidence rather than from
a fresh walk. Fixing one means deleting its entry here; if a walk shows it is no longer
true, say so in the entry rather than removing it silently.

Everything below was found on 2026-09-11, on the published build at 390x844 with an empty
profile unless stated, against the capture stamped 2026-09-08.

---

## Back leaves the site from anywhere

Nothing in this app pushes a history entry. With the setup sheet open, Back goes to
about:blank; after Tonight → Pickups, Back does not return to Tonight, it exits. On a phone
Back is how people dismiss a keyboard and undo a tap — the most-pressed control on the
device.

Half of the cost is gone: the sheet is mounted and `hidden` while closed, so what was typed
survives any way of closing it. The navigation is not fixed. **`src/client/Dock.tsx` carries
a long note on the shape that does not work** — an effect keyed on `open` whose cleanup
calls `history.back()` passes against the production build and fails against the dev server,
because StrictMode double-invokes effects and a cleanup that navigates cannot be idempotent.
The shape that would work is pushing in the gesture, with a permanently mounted `popstate`
listener that only ever closes, and `App`'s own "Set up a league" button routed through the
same pair.

## The landing board's first five rows are nobodies

Measured before any setup: #1 Grant Taylor RP CHW, #2 Sam Antonacci 3B CHW, #3 Tristan
Peters OF CHW, #4 Heriberto Hernández MIA, #5 JJ Bleday CIN. Billy's pick is Grant Taylor.
Whatever the model believes, this is the entire first impression, and to a Yahoo player it
reads as a list of names he has never heard of from two of the worst teams in baseball.

It is not obviously a bug — a free-agent board ranked by value over replacement SHOULD be
full of men nobody has rostered — which is exactly why it needs a sentence on that screen
saying so. Either say why the top of a gettable board looks like this, or do not lead with
it.

## The management toolbar is a database panel on a stranger's path

My league opens with "START A LEAGUE FROM / a blank league (nothing filled in) / New /
Remove / Download / Load file / IMPORT A LEAGUE FROM ITS URL" above anything about his team
— on the screen a reader reaches when he wants to fix his scoring.

## Software talk that survives on user-facing surfaces

- NO LONGER TRUE, both halves of it. This said the "values to check" drawer, which a
  first visit cannot avoid, read "every BSCORE on the board is wrong" and "Replacement
  level is teams x slots" — the house rule being no coined words outside the drill-down
  and Methodology. Neither string is in the app any more. `grep -rn BSCORE src/` returns
  nothing and the built bundle in `dist/` contains the phrase zero times; the team-count
  card in `src/client/App.tsx` now says the more teams the thinner the pool and that every
  player is measured against whoever is left at his position, and carries a comment
  recording that the old version "named the arithmetic ... and a screen that no longer
  exists, to somebody filling in a number." Left here rather than deleted because the
  other two bullets in this entry are still live and a half-deleted entry reads as a
  half-measured one.
- POSITION ELIGIBILITY says "as they were read from league 228947's own eligibility grid —
  see that league's provenance for when": the author's own league id shown to a stranger,
  pointing at a "provenance" that exists on no screen he can reach.
- The league he lands in is named "Yahoo H2H points (preset)". He never chose it, and
  "(preset)" is not a word about baseball.

## Landscape is worse than portrait

Rotated to 844x390 with the sheet open: a 288px box holding 776px of content. Both chip
questions, the confirmation list and the privacy line are all below the fold; only the
heading and two buttons are on screen. No horizontal scroll.

## Smaller, all measured

Five entries that were here have been fixed and are gone: `needs_review` lines that named
`scoring.unmapped`, `roster.slots` and "endpoint" to a reader; "vs your seats as read"
printed about a team that was typed; a paste note still sending readers to a tab called
"Recommendations"; a two-way player stored as two roster entries and reported as one; and
short lines of a TYPED list dropped from `unmatched` by a floor meant for a pasted page.

- A line of pure punctuation ("???") is still dropped from `unmatched` on both routes. The
  length floor now applies only to a paste, so "asdfgh" and "12345" are quoted back, but a
  line with no word character in it is treated as furniture either way. Defensible; noted
  so the decision is visible rather than accidental.
- A man on the 60-day injured list gets two different explanations on one card: "Injured
  60-Day — no source states a return date" at the top, and "could not be priced" at the foot.
- NEVER AN ENTRY HERE, and recorded so the next walk does not report them as new. Two
  claims on the hero card — the largest number on the first screen — were found and fixed
  in `83650dd` without ever being written down in this file: it said "more points than the
  best {slot} you could add off waivers" where `bscore.ts` prices against the man AT
  (teams × seats) depth rather than the best man still free, and the schedule clause
  branched on any multiplier at all, so a 0.3% adjustment was reported as a schedule that
  "is hard (×0.997)". Both are gone from the code. They are mentioned here rather than
  entered because this file tracks what is OPEN, and an entry for a fixed defect is the
  one thing its own rule forbids — but a walker who finds the hero card interesting should
  know it has already been walked.
- RETRACTED on inspection: "next lock 7:05pm" and "locks 7:10pm" were reported as carrying
  no timezone. `clock` in src/data/today.ts calls `toLocaleTimeString(undefined, …)`, so
  every one of those times is already in the READER's own zone, which is the zone he wants
  and which needs no label. Left here rather than deleted so the next walk does not
  re-report it.
