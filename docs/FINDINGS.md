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

- The "values to check" drawer, which a first visit cannot avoid, says "every BSCORE on the
  board is wrong" and "Replacement level is teams x slots". The house rule is no coined
  words outside the drill-down and Methodology.
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

- Junk lines of three characters or fewer are dropped silently (`l.length > 3` in
  `src/data/paste.ts`): pasting "asdfgh / 12345 / ???" reports only «asdfgh» while saying
  "Nothing in THEM is counted anywhere". Deliberate for page furniture, invisible for a
  hand-typed list.
- Shohei Ohtani is two rows in the capture (DH hitting, TWP pitching). Typing his name
  silently takes one of them and raises no ambiguity note, unlike the documented
  two-men-one-name path.
- Listing the same man three times dedupes correctly and says nothing about it.
- A man on the 60-day injured list gets two different explanations on one card: "Injured
  60-Day — no source states a return date" at the top, and "could not be priced" at the foot.
- "vs your seats as read in the last hour" is printed about a team he typed forty seconds
  ago, and nothing was "read".
- "next lock 7:05pm" and "locks 7:10pm" carry no timezone.
