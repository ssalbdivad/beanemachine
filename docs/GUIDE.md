# beanemachine user guide

## Start here — the board is the first thing on the page

The first time you open beanemachine you get a **ranked board**, not a form. It runs
the shipped preset — one real league's point values, nobody's team — and a line across
the top of the board says exactly that, and that setting your own league up will move
every number under it. You land on **Pickups**, which is the screen that ranks.

Read "one real league's" literally: the preset is **not** Yahoo's own default points
table, and the difference is large enough to matter on the first screen. A home run
pays **10.4** in the preset against **4** in Yahoo's head-to-head-points default, so a
reader who opens his own settings page to check the preset against it finds nothing
that lines up. This guide used to describe the preset as "standard" scoring and quote
that banner as saying so; the app has said the true thing for longer than this guide
has, and the banner was rewritten to match while the sentence here was not.

> **Why this guide stops quoting the screen.** From here on it paraphrases what the app
> says rather than reproducing it word for word, and names only the things you have to
> find to use it — buttons, tabs, column heads, filter labels. A sentence of prose on
> screen belongs to the code, which revises it freely and without telling this file;
> every verbatim copy of one is a second, unversioned original that goes stale the
> first time somebody improves the wording. The banner above is the case in point: it
> was copied here accurately, the code changed it, and for some number of commits this
> guide was the only place the old sentence still existed — contradicting the app about
> the one fact that decides whether any number on the board applies to the reader. A
> paraphrase cannot drift, because it was never a copy. Short labels are quoted anyway,
> because a guide that will not name the button cannot tell you which one to press, and
> those are checked against `src/` — every one in this file was, on 2026-09-12.

It used to ask first. Before that it did something worse: it shipped one real league
— Mrs. Met's Harem, Yahoo head-to-head points 228947, which is the author's own — and
seeded it into any browser with nothing stored, so your first screen was somebody
else's team under a notice explaining that it was. Both are gone. The published build
stores no league and no team: what it ships is a table of point values with nobody's
roster attached, which is why the board can rank before you have typed anything and why
nothing on it is about you until you do.

The setup is a bar across the foot of the page instead, and its button asks the
question rather than naming the chore: **Who's on my team**. Press it and the sheet
opens over the board, which you can still see behind it. Escape closes it.

The sheet asks **one** question: *Who's on your team?* Type the names, one to a line,
first and last — a position in front is welcome and not required. It reads ordinary
pasted text too, so a copied roster page works whatever else is on it. Then it names
every player it matched back to you, quotes verbatim any line it could not place, and
asks the two things no preset can know about your league:

- **How many teams are in your league?** The bar every player is measured against is
  the man left at his position once every team has filled it, so the team count moves
  every row on the board.
- **Can you change your lineup every day?** Most Yahoo and ESPN points leagues let you.
  If yours does, tonight's lineup is a decision you get to make, and **Tonight** becomes
  a list of changes rather than a plan for the period.

That is the whole required path: type a team, tap two chips, press **Show me tonight**.
Six gestures on a phone, and nothing about platforms, settings pages or file formats
appears unless you ask for it.

Everything else lives behind **My league scores differently**, which is shut until you
open it: pasting your league's own settings page (which carries the scoring, the roster
slots, the team count and the league's id in one gesture, and works on a private
league), reading an ESPN league from its URL, typing the values in yourself, or loading
a league you saved earlier. If a paste comes up short it says exactly what it did not
find rather than filling it in.

Already have a league and want the guided setup back? **Set up a league** in the
toolbar on **My league** reopens it.

Why the board comes first: a bscore is denominated in *your* league's points — a home
run worth 10.4 in one league and 4 in another reorders the whole ranking — so a board
with no league behind it really is somebody else's answer, and the banner says so. But
nobody can tell whether this is worth two minutes of typing before seeing what it
produces, and the numbers are the entire argument for typing.

## The three screens

The tab bar is the vocabulary for the rest of this page:

- **Tonight** — who to start before first pitch, which of your seats scores nothing,
  and the one move worth making.
- **Pickups** — everyone you can actually get, ranked in this league's scoring, over
  the window you pick.
- **My league** — your league's scoring, slots and team count, and the men on your
  team. Everything the other two screens say is priced in these.

### Tonight is the answer

Under the heading **What should I do?**, for your league's own scoring period:

- **Today** — the men who can score today, and how many games there are.
- **Empty seats** — the seats that will score nothing tonight, and the best gettable
  man who is actually on a card for each. A seat with nobody worth starting says to
  leave it empty; a hole is reported as a hole, not priced at zero.
- **Set your lineup** — not the whole lineup: the difference between the lineup you
  have on your platform and the one you should have, with the points it gains. It is
  ordered by when each seat locks.
- **Make these moves** — the adds worth one of this week's moves, each naming the man
  who leaves, priced in what your starting lineup projects afterwards. An add that
  does not say who goes cannot be made. The card stops at the two a week that measured
  best and says so beside the cap your league actually allows, because those are two
  different kinds of number.
- **Watch** — your league's innings floor against what your pitchers project over what
  is *left* of the period, both as they stand and as the moves above would leave them.

Where the schedule is knowable it is read live from MLB rather than from the shipped
capture, so "no game today", "not in today's lineup" and "lineup not posted yet" are
three different sentences instead of one guess. A live read that failed says so.

It needs to know your team, and with no roster it says one sentence and offers one
button: **Add your players**. It does not print a command. On ESPN the page can read
your roster for itself; on Yahoo nothing can, and the exact route for a reader who
wants one is folded away on **My league** under *I'm comfortable with a terminal*.

### Pickups is the ranking

Two sentences of vocabulary, and most of this page is elaboration on them:

- A **bscore** is *points above a free replacement* — what your league scores with a
  player in a roster slot, minus what it scores with a man you could still pick up
  at that slot, over the horizon you picked. On the board this column is headed
  **ahead by**, because "bscore" is a word this app invented and nobody else uses.
  "Could still pick up" is your league's own free-agent list where that has been
  read, and an ownership cut calibrated to your league's size where it has not — and
  the bar is the *(teams × seats)*-th of those men, not the first, because
  replacement level is who is left once every team has filled the slot.
- A **uscore** is that same figure discounted by how widely he is already rostered:
  bscore asks who is best, uscore asks who is the best you can actually get. It is no
  longer an ordering you can pick, because on a list already filtered to men you can
  add it applies that discount twice. It survives in the drill-down.

Every column carries its own definition in its heading's tooltip, and the line under
the headings is generated from the ordering actually in force — so a board reordered
by luck or by edge is captioned with the number it is in, not with a different one. The
measured results behind all of it — what was validated, what was measured and
rejected, and what cannot be measured at all — are in
[METHODOLOGY.md](METHODOLOGY.md), summarised in the footer of the app itself.

### My league

The one place the app knows what you hold. Add the players you own by name; they are
stored in this browser under *this league's* key, so switching leagues switches teams
and a roster never travels between them. Only ids are stored, so your team stays
correct as the snapshot behind it is recaptured — and an id the current capture has no
row for is named on screen rather than quietly dropped.

From that it fills your league's real startable spots, best legal lineup first, and
shows every spot accounted for out loud: filled by one of yours, covered at the waiver
bar because nobody you own is worth it there — either nobody left unseated is
eligible, or the best one who is projects below the freely available body — or a hole
nothing in the pool can fill.

Also here: **Needs review**, which lists everything an import could not read;
**Download**, which writes the leagues in your browser to a file; and **Load file**,
which reads one back in. A league is only ever in the browser you set it up in.

## Which horizon you want

**Pickups** opens on three horizons, and they are three different questions rather
than three filters. They are a tablist inside the one screen.

**Streaming** ranks over whatever is left of your league's own scoring period, using
that period's real slate. In a Monday-to-Sunday matchup league opened on a Wednesday
that is Wednesday through Sunday — not seven days from Wednesday, which would count
games from a matchup you are not being scored on. In a daily league it is today. Where
lineups lock for the whole of the current period it is the *next* period, because
that is the only one you can still act on. This is the tab to use on waiver day: it
rewards a pitcher with two starts booked and a hitter whose team plays six games
instead of four. The exact dates, and where those edges came from, are printed under
the heading every time. A **Window** strip beside it offers the same control with a
nearer far edge — today, 2, 3, 5 or 7 days — and it stops at seven because that is
where the schedule data stops paying.

Streaming is also the one horizon that does **not** rank by bscore. It ranks by
**points**, because a streamer is filling one seat for a few days, and comparing a
reliever's surplus over relievers against a starter's surplus over starters answers
no question he has. bscore stays on the row, so the disagreement is visible.

**This fortnight** is the standing board, fourteen days out. It is the default
because it is long enough that a single bad week doesn't dominate and short enough to
still be a decision you act on now.

**Stash** ranks over every game left in the regular season. Playing time and role
matter far more here than the last fortnight, so it surfaces the young player who
just took an everyday job rather than whoever is hot. This is who to *hold*, not who
to start. Two things this view does not have: probable starters (MLB publishes them
only days ahead, so a rest-of-season horizon has none), and any measured claim about
the Statcast numbers on each card. They have been measured at a one-week horizon and
rejected as a multiplier; nobody has measured what they are worth over a
rest-of-season hold. Read them as a human, not as a number the model used.

Which horizon you were last on is remembered, along with the window. Your filters are
not: a position chip left over from last week is a board that opens narrowed for a
reason you cannot see.

## Billy's pick, and what "available" means

The card answers availability from whichever source you actually have, and it says
which, because they are three different claims:

1. **Your league's own free-agent list.** Exact, and about your league specifically.
   It needs a publicly viewable Yahoo league *and* a server, so it is what you get
   running this repo locally or with the API deployed; an ESPN league can read its own
   wire straight from the browser.
2. **How widely he is rostered across leagues**, against a bar calibrated to your
   league's size. Rank everyone the capture priced by roster share and count down to
   the *(teams × seats)*-th name: that man is the most widely rostered player your
   league still has room for, so above him is treated as taken. On the shipped capture
   and a 10-team league with 27 seats that bar lands at **35%**. A twelve-team league
   reaches further down the same list and gets a lower bar, which is the point — one
   global threshold was standing in for every league in the world. This comes off the
   snapshot with no server at all, which is the situation everybody on the hosted
   build is in. The estimate refuses itself if the capture cannot locate the boundary —
   too many players tied on the cut — and says so rather than guessing.
3. **Neither.** Then it is the top of the board and the card says so, rather than
   implying an availability nothing checked.

A player the capture never priced is counted **available** in tier 2, not unavailable:
the sweep not reaching him is the absence of a claim, and Billy's own pick is the row
most likely to have no percentage on it, which is why the card says "Yahoo lists no
rostered share for him, so this is an estimate" instead of printing "null%".

Whichever tier answered, the pick is drawn from the board *as you have filtered it* —
narrow to catchers and Billy names the best catcher you can get. It is deliberately
**not** the number one row: the top of a bscore board is the best player in baseball,
who is rostered in every league, and naming him is a fact rather than a recommendation.

## The edge column

Edge compares a player's bscore against the median bscore of the players the field
prices the same way he is priced, using Yahoo's "% Ros". An edge of +18 means eighteen
points more than the typical player rostered about as widely. A dash means the capture
has no price for him, so there is nothing to compare against — unknown, which is not
the same as unowned.

**It is not the default, and the reason is coverage rather than corruption.** On the
shipped capture edge can price **776 of the 1,248 rateable rows — 62%**; bscore ranks
all of them. Edge also cannot rank a replacement-level body nobody rosters, who beats
the par for his ownership by definition, so picking it narrows the board in a way the
board tells you about: below 35% coverage it prints a line saying how much of the
ranking it can actually speak about.

It *was* unreliable, and the reason is worth keeping because edge was the default sort
at the time. Yahoo nests a weather forecast inside each outdoor game's tooltip, and the
sweep used to take the first percentage left in a player's row after stripping the
forecast lines it knew the labels of. It did not know all of them, so a per-*game*
number reached the field — and being per-game, every player in both clubs carried it.
On the capture of 2026-09-02 all thirty Yankees read 47%, Dodgers and Cardinals 54%,
and twenty of thirty clubs sat on one value. Edge is bscore minus the median at the
same ownership decile, so that did not degrade one cell; it reordered the whole board
by the precipitation forecast.

The fix identifies ownership positively instead of ruling weather out: Yahoo's stat
cells wrap their value in a div and the forecast table's cells do not. The shipped
capture is clean on its own terms — no club has so much as 53% of its players on one
value, and the modal figure is 0%, which is what a genuinely unrostered player reads.
The original reasoning for an edge default — that a bare bscore ranking opens on
players already rostered everywhere — was answered a different way: **Only players I
can add** is now on by default.

## What am I looking at?

The board is every MLB player, ranked by how much he would add to *your* team over the
horizon you picked, in *your* league's scoring. The top card is Billy's pick. Under it,
one row per player, and there are four columns rather than nine:

| column | what it is |
|---|---|
| **#** | Rank under the current sort. A position in this list, not a global rating |
| **Player** | Name, then the slot the bscore was computed against, his team, and an injury tag if he has one |
| **ahead by** | Projected points minus the replacement at that slot — the points you gain over a free pickup |
| **games** | What he gets out of the window. For a starting pitcher whose turns MLB has published it is **his own scheduled starts (GS)**; for everyone else it is the **games his team plays (GP)**. The cell names its unit, so the two can share a column without either claiming to be the other |

Three more appear when they mean something:

- **points** on Streaming, which is the column that tab is ranked by.
- **for you** once you have entered a roster: what he gains over the man he would
  actually displace on *your* team. bscore prices every row against the
  *(teams × seats)*-th man in the league, which is the bar for the league; this is the
  bar for you. A deep outfield makes a good free-agent outfielder worth nothing to you;
  a hole at catcher makes a mediocre one worth a great deal. Blank where nobody you own
  is eligible for a seat he could take.
- **one generic cell** whenever you order the board by something that has no column of
  its own. With the orderings the screen now offers, that cell is headed `points` (off
  Streaming, where points has a column already), `edge` or `luck` — the code can head it
  `contact`, `free man`, `conf` or `gettable` as well, but nothing on the page selects
  those orderings any more. A board ordered by a number printed nowhere on it is asking
  to be taken on trust, which is the one thing this app is not for.

`proj pts`, `waiver pts`, `owned`, `confidence` and `luck` were columns and are not any
more: bscore is one of the first two minus the other, so the table stated the same fact
three times, and neither confidence nor luck was a column anyone decided on. All of
them are in the drill-down, which any row opens, and which takes that projection apart
into what was measured, what was modelled, and what is missing. The heading states how
old the underlying data is and the exact date window being projected. Rows load as you
scroll, all the way down — the ranking runs to about 1,250 players and the whole point
is being able to read down it.

Two supporting reads used to sit below the ranking — **Buy low** and **Where it hurts
to wait** — and both are gone. They answered "where should I spend attention", which is
a second question asked above the one the reader came with, and neither was ever
measured to win anything: the only assertions that ever existed about Buy low pinned
its own two thresholds, not that acting on it pays. The ranking is the screen.

## What is a bscore?

A bscore is **points above the guy you could have for free.**

Everything on the board is denominated in your league's own points, not in some
abstract rating. The projection says what a player will score over the horizon the tab
you are on asks about — the rest of your league's scoring period, fourteen days, or the
rest of the season. The bscore subtracts what a freely available player at the same
roster slot would score over that same window. The worked example below uses the
14-day default.

Worked example:

| | |
|---|---|
| Outfielder projects | **129 points** |
| Replacement OF at this slot projects | **74 points** |
| **bscore** | **55** |

Fifty-five is the number that matters. Starting that outfielder instead of the freely
available outfielder is worth 55 points to you over two weeks. His 129 is not, on its
own, a useful number — you were always going to get *someone's* 74 out of that slot.

This is also why bscores compress as you go down the board. A player with a bscore of 3
projects for three more points than a free pickup. That is a rounding error, not an
edge.

## Why is a catcher with fewer points ranked above an outfielder with more?

Because they are not competing for the same slot, and the players they replace are not
the same quality.

The replacement level for a slot is computed from your league's actual roster settings:
it is the best player at that slot who is *still unrostered* once every team has filled
it. In a 10-team league with one catcher slot, 10 catchers are spoken for, so
replacement is roughly the 11th-best catcher. With three OF slots, 30 outfielders are
spoken for, so replacement is roughly the 31st-best outfielder — and the 31st-best
outfielder is a real major leaguer.

That difference is positional scarcity, and it is where the ranking comes from. On the
shipped capture, in the reference 10-team league over the fortnight:

| | projected | replacement at his slot | ahead by |
|---|---|---|---|
| Catcher (Drake Baldwin) | 97.2 | 75.0 | **22.2** |
| Outfielder (Pete Crow-Armstrong) | 132.4 | 88.5 | **43.9** |

That pair happens to agree, because Crow-Armstrong is genuinely the better player by
more than the gap between the bars. The disagreement shows up a row or two down:
Baldwin is 43rd in baseball by raw projected points and 27th by bscore, because the
sixteen players he passes are ones you can replace almost for free. Drop the 43rd
best outfielder and you can pick up an 88.5-point outfielder; drop Baldwin and you can
pick up a 75.0-point catcher. Those thirteen points are the position rather than the
man.

Note also what the slot choice does. Valued at Util instead — a seat that draws from
every batter in baseball, so its bar is the highest in the league at 106.4 — Baldwin's
same 97.2 points would be worth **−9.2**, i.e. nothing. Catchers are worth having
*because* they are catchers.

The practical rule: **raw projected points tell you who is better at baseball; "ahead
by" tells you who is worth more to your team.** They disagree at scarce positions, and
that disagreement is the entire point of the board.

If a player is eligible at more than one slot, he is scored at whichever slot makes him
most valuable, and that slot is shown next to his name.

## How do I use it?

### Draft day

There is no draft screen, and the reason is measured rather than aesthetic: the
published decompositions of what decides a points-league season put pre-draft ranking
quality near the bottom of the list. Use **Pickups** with the filters wide, **This
fortnight**, and **Rank by** on *how far ahead of a free man he is* — scarcity is
already priced into that number, so the separate positional-tier exercise is not
needed. The screen this app is built around is the one you open in June, not in March.

### Weekly waivers

This is what the model was tuned for and where it measured best. Leave **Only players
I can add** ticked — it is on by default — or filter by the slot you are trying to
fill. Then compare the "ahead by" of the best available man against that of the player
you would drop. The difference between those two numbers is the actual gain from the
move, in points, over two weeks. With a roster entered, the **for you** column does
that subtraction for you against the man he would really displace.

There was a **Min confidence** floor here and it is gone. Re-measured on the committed
capture with the reference league: it removes 42.0% of the rateable list at 40%+ and
58.5% at 70%+, but **none of the top 60** by "ahead by" at the 40% setting and **two** at
the 70% one — 55 of those 60 sit at exactly 100%. Everything it cut was deep-bench men
who were never candidates, and it filtered on a
number the board has not drawn since the four-column pass — a filter you cannot see the
effect of. Confidence is still printed on every player's drill-down, with the reasons
behind it, which is where a small sample is worth checking.

### Daily streaming

Open **Streaming** and read the **starts** column while you do. The projection
multiplies each pitcher's per-start rate by the turns the schedule actually has for him
in the window the tab resolved — the rest of your scoring period, not a flat seven days
— so a heavy slate rises without you doing the arithmetic; the drill-down states the
same number as *his starts in window*.

Two starts in a scoring period is roughly double the innings, and it is the single
biggest thing that separates one streaming pick from another. **Only players with a
start** is on by default and is what makes this a streaming list rather than the same
board over a shorter horizon: without it, three of the top ten rows on the shipped
capture were hitters, who cannot be streamed for a start at all. Read the coverage
honestly — what MLB has published is an observation, and what it has not is credited at
the pitcher's own rate of starting, so a count of 2.6 is one announced turn plus a
share of the games his club has not named yet, or none announced at all. On the shipped
capture 60 pitchers have a published start inside the fortnight and every one of them
has exactly one.

For pitchers generally, recent form is read over 5 and 21 days with the 5 weighted
double, rather than the 3/7/21 a batter gets. A starter works every fifth day, so five
days is the shortest window that contains a start at all and a week of his data is one
or two starts of noise. Do not expect the board to react to a single good outing; it is
not supposed to.

### Buying low

**Buy low** used to combine two independent signals — a player hitting the ball better
than his results say over the last three weeks, and still rostered in under 70% of
leagues — and show at most three names. It has been removed along with the per-slot
cliff chart. Both were real analyses and neither was ever shown to win anything; what
they cost was two full-width cards between the reader and the ranking. The signal
survives as one ordering in **Rank by**: *who has been unluckiest*. There were two —
that percentile and *best contact, worst results*, the raw three-week gap — and they were
the same ordering: the percentile is monotone in the gap within a side, so the two
coincided exactly whenever **Side** was not "batters + pitchers" (measured: 60 of 60 rows
identical with Side=batters, 40 of 40 with Side=pitchers). The percentile survives because
it is the one that stays comparable with both sides on the list.

### A trade or a swap

On **My league**, under *The deal*, press **Price a trade** — it is folded away until you
do, because most visits have no deal on the table. Then pick who leaves and who arrives,
and the verdict is **what your starting lineup projects afterwards, minus what it
projects now**. (If your league's trade deadline has passed the card says so and the
button reads **Price one anyway**.) That is deliberately not "who has the higher
bscore": bench depth is worth nothing until it starts, so a
player who arrives and doesn't crack your lineup adds nothing to the number, and a
player you give up who wasn't starting costs nothing. Both cases are stated on screen
rather than left as an unexplained zero, alongside the spot-by-spot changes and
anything the engine could not read.

## Injured players

Over the **Streaming** and **This fortnight** horizons an injured player is not ranked
at all — he is dropped from the board rather than shown with a caveat. This is not
squeamishness: a man placed on the 10-day IL yesterday was healthy for most of the
window the playing-time blend reads, so he projects at a full-time rate and lands near
the top of the board while being unable to play. No source states a return date, so
instead of inventing a discount the board says it cannot honestly project him over this
window. On the shipped capture that is 198 players.

**Stash** ranks him anyway, because over the rest of a season an injured man is a
perfectly good hold. Same player, same data, different question.

## The controls

Above the ranking, in the order you meet them:

- **the horizon tabs** — Streaming / This fortnight / Stash, and on Streaming a
  **Window** strip: rest of period, today, 2 days, 3 days, 5 days or 7 days.
- **Only players I can add**, with a note beside it saying which tier answered — "N
  free" off your league's real wire, an ownership estimate, or "can't tell". The
  Streaming copy spells the estimate out ("est. over 35% is taken"); the copy in the
  general filter row is narrower and says only "estimated", so the number itself is on
  the Streaming strip and in the tooltip both of them carry. On by default on Streaming
  and the fortnight, off on Stash, which is about players you already hold. Touch it
  once and your answer follows you across tabs.
- **Only players with a start** — Streaming only.
- **position chips** and a **name box** — not on Streaming, where every row is already
  a pitcher with a start and the chips would separate P from RP and nothing else.
- **More filters**, which holds **Rank by** (how far ahead of a free man he is · the
  points he should score · how far he beats his own ownership · who has been unluckiest),
  **Side** (batters + pitchers / batters / pitchers) and **Hide injured**. **Rank by** is
  not rendered on Streaming — that horizon ranks by points by decision, and the only
  reordering offered there is the column headings themselves. The fold names any of them
  that is on, because a filter you cannot see must not be one you cannot escape — which
  is also why the confidence floor and the uscore ordering are gone.

  Whichever ordering is in force, the board **draws the number it is ordered by**: when
  the sort is not one of the standing columns, a column appears beside the name carrying
  its value, headed with its own short name, and the sentence under the headings names
  that column. Four of the six orderings the list used to carry reordered the rows by a
  figure printed nowhere on them.

Every column heading sorts except **games**; clicking the active one flips direction.

Luck and contact are displayed for your judgment only. Neither moves the
projection — see the validation section.

## What does confidence mean, and when should I distrust a row?

Confidence is not a vibe and not a default. It is three real measurements multiplied
together:

| factor | effect |
|---|---|
| Sample size | Playing time so far against a full season of work in that player's own role — 434 PA for a hitter, 540 batters faced for a starter, 209 for a reliever, interpolated for a swingman — capped at 1. 100 PA is a 0.23 multiplier |
| Statcast data | Present: no penalty. Absent: ×0.6 |
| Health | Healthy: no penalty. Carrying an injury designation: ×0.5 |

So a healthy full-season regular with Statcast data reads near 100%, and that holds for
a closer as much as for an everyday bat — the yardstick is his role's workload, not a
hitter's. A hot rookie with 90 PA reads about 21%. On the shipped capture every player
has a Statcast row, so the only two reasons in play are sample size (1,080 players) and
an injury designation (198).

**Distrust a row when:**

- **Confidence is under 40%.** The projection is mostly extrapolation from a short
  sample.
- **The injury tag is showing.** The model reduces confidence but does not know when he
  plays again, and it does not model a rehab timeline at all.
- **The data-age chip is orange.** It flags at 36 hours. A stale capture misses
  call-ups, demotions, and the past two days of playing time. Captures run at 11:00 and
  23:00 UTC.
- **The drill-down lists things under "Missing."** No Statcast row, no team games in
  the window, or a category your league scores that no source provides. An unscoreable
  category is reported rather than treated as zero, which means the projected points
  for that player are genuinely incomplete.
- **"Ahead by" is in single digits.** Below the noise floor of two weeks of baseball.

One thing that is *not* a reason to distrust a row: a modest projection for a player
who has been hot. **A batter's projected rate is his season rate**, full stop — recent
form moves his *playing time* and nothing else, and even that is only half-weighted
against the season. A pitcher gets 15% of his rate from his last 21 days, which is the
most any measurement supported. So a .400 month over 90 PA does not project forward at
face value, deliberately.

Be precise about how that restraint works, because the honest version is not the one
you would guess. Shrinking each rate toward the league average — the textbook fix, with
per-stat stabilisation constants — is implemented in this codebase and **is not
applied**: it was measured and it lost, because the volume model already docks a
part-time player for playing part-time and shrinking on top of that penalises him
twice. What holds a hot streak down here is the season rate and the volume blend, not a
shrinkage step.

Players with no projectable playing time never appear on the board at all. They are
excluded, not ranked at zero next to real players, and every refusal carries its reason
in words.

## How do I set up my own league?

Nothing on any tab means anything until the app knows four things about your league:
**batting scoring**, **pitching scoring**, **roster slots** and **team count**.
Everything else — the scoring period, eligibility rules, slot compatibility — is
refinement on top of those four.

There are four reads, and only the first is needed to rank anything. The other three
are what turn a ranking into advice about *your* team.

| | scoring, slots, period | your roster | your free agents |
| --- | --- | --- | --- |
| **ESPN** | in the browser, or paste | in the browser, or paste | in the browser, or paste |
| **Yahoo** | **paste**, preset, or carry a file | paste, or carry a file | paste, or carry a file |
| **anywhere else** | paste | paste | paste |

"Paste" means: open the page on your own fantasy site, select all of it, and paste it
into beanemachine. It is the only column that works on a **private** league, and the
only one no platform can take away — your browser is already signed in, and reading
the page you are looking at is not scraping.

**Sleeper is refused rather than attempted**, because Sleeper does not run fantasy
baseball — it tracks the sport for news and props, and importing one of its leagues
used to hand back football roster slots and no scoring at all. A pasted Sleeper URL
gets that explanation instead of a league.

### If your league is on ESPN

1. Open the setup from the bar at the foot of the page, or **My league**.
2. Paste your league URL into the URL field and hit **Import**. Include `teamId=` if
   your URL has one — without it the app cannot know which of the teams is yours and
   asks for the number rather than assuming.
3. That is the whole setup. ESPN is the one platform where everything works from the
   page: the league's scoring, its roster slots, its scoring period, **your roster**
   and **your league's own free-agent list** are all read straight from ESPN, with no
   server, nothing installed and no file to carry.

ESPN names its stats and lineup slots nowhere — they are numeric ids — so both tables
were derived by joining a public league's own rows to the real season from MLB
StatsAPI rather than assumed. An id neither table names is **not** guessed at: it keeps
its number, scores nothing, and is listed in **Needs review**, as is a stat carrying a
per-position points override, which this engine cannot express. Which weekday the
period starts on and whether lineups lock for it are two things ESPN does not state at
all, so the board says out loud that it is assuming a Monday start.

Check the point values against your league's settings page before trusting a ranking
built on them. The mapping is evidence-backed, not certified.

### If your league is on Yahoo — read this, it is the common case

Yahoo sends no CORS headers on any of the pages the importer reads, so a browser is
never handed the response body. That is a fact about Yahoo, not a limitation of this
build, and no version of the hosted site will ever be able to import a Yahoo league.
Measured 2026-09-09, it is worse than that from a server too: the sweep that had been
returning 150 free agents returned 25, then 0, then the string "Request denied".

**Paste the settings page.** This is the route, and it needs nothing installed:

1. Open your league's **Settings** page — **League** → **Settings**, or add
   `/settings` to your league's URL.
2. <kbd>Ctrl</kbd>+<kbd>A</kbd>, <kbd>Ctrl</kbd>+<kbd>C</kbd>.
3. Paste it into the setup and press **Read that**.

Yahoo prints everything needed on that one page — the batting and pitching stat
tables, "Roster Positions", "Max Teams" and "League ID#" — so one paste yields
scoring, slots, team count and the league id, and `src/data/paste-settings.ts` runs
it through the same derivations `src/import.ts` uses on a fetched page.
`test/settings.mjs` proves the two agree by reconstructing the settings page from the
league this repo fetched back when the importer still worked, pasting it, and
asserting the league that comes out is the same league. It works on a private league,
which no import ever has.

Your team page and your free-agent page paste the same way, on **My league**.

The alternative, if you would rather have the file: one local run.

```sh
npx --yes github:ssalbdivad/beanemachine \
  https://baseball.fantasysports.yahoo.com/b1/<league-id>/<team-id>
```

It reads the settings and position-eligibility pages, writes the league into
`scoring.json`, and prints a readiness table — one line per required input, saying
whether it actually arrived — followed by everything the source did not state,
verbatim. On league 228947 that run reads 9 batting stats, 8 pitching stats, 27
roster seats, 10 teams and a Monday-to-Sunday matchup period.

Then the league is a file and goes anywhere:

- Running this repo's dev server serves the `scoring.json` you just wrote — it shadows
  the published asset with the one at the repo root — so a local run opens straight on
  your league, roster and free-agent list included. The deployed build ships no league,
  which is why beanemachine.com opens on the preset board with the setup hovering at
  the foot of it.
- **My league → Download** writes the leagues in your browser to a JSON file, and
  **Load file** reads one back in on any other browser or machine — including
  beanemachine.com. Dropping the file anywhere on the page does the same thing. That is
  the supported route for a Yahoo user onto the hosted site.

Your league must be **publicly viewable** for the importer. A private one needs a
signed-in session it has no way to hold — which is why pasting the page is the route
that always works.

### Whichever route you took

1. Fill in whatever landed in **Needs review**. In particular, **team count must be
   set** — replacement level is derived from teams × slots, and without a real number
   there is no honest bscore, so the board stays empty rather than assuming a size.
2. Check the **Batting** and **Pitching** tables against your league's settings page.
   Negative values are penalties. Add any missing stat with its code and point value.
3. Check **Roster slots**. These drive replacement level directly. Getting the OF or
   SP count wrong moves every bscore at that position.
4. **Save.** The board re-ranks immediately — the engine runs in your browser, so you
   can watch a scoring change reprice the league. A write on one screen reaches the
   others without a reload.

Your leagues live in the browser you set them up in, never on a server.

You can also press **New** to start from a template and type the values in by hand. A
template that arrives with values lands you on the board, because it can already rank;
a blank one lands you on **My league**, because it cannot. Either way a template is a
**stated assumption, not a reading of your league**: it arrives with `verified: false`
and says on its face that it was not read from anywhere. Check every value against your
own settings page before you trust a number that came out of it.

## What this tool does not know

Be clear-eyed about the edges. It:

- **Knows which pitcher your hitters face, but only a few days out.** MLB publishes
  probable starters about a week ahead, and where it has them the board rates a hitter
  against the men actually on the mound, blended with the opponent staff by innings
  share — a starter throws about 58% of *one game*, so his own quality carries that
  share of that game and the staff behind him carries the rest. Over a fortnight only a
  game or two is usually published: on the shipped capture 58 rated names cover 354
  team-games, so the named starters carry about **10%** of the board's matchup number
  and the opponent staff carries the rest. On Streaming the same names cover a shorter
  window, so they carry a larger share of it — how much larger depends on how much of
  your scoring period is left, which is why the number is scaled per team rather than
  fixed. Where no probable is published it falls back to the team-level number
  entirely. This one cannot be validated the way the rest can: probables are announced
  and then overwritten, and nothing archives what was announced at the time.
- **Does not know your roster, on the board.** The ranking never accounts for who you
  already have, so it will happily rank three catchers at the top when you need one.
  **Tonight** is the screen that does know, because it prices every move against the
  seat it would actually take — and the **for you** column carries half of that answer
  onto the board once a roster exists.
- **Rates the Stash horizon against the right opponents now, at a weight nothing has
  measured over that horizon.** This entry used to say Stash applied a fortnight of
  schedule strength over months, because the only opponent list any capture carried was
  the next two weeks. The snapshot now stores the whole slate to the end of the season,
  so Stash reads a genuine rest-of-season opponent list and the window mismatch is
  gone. What is left is the weight: the adjustment is still clamped to ±12% and still
  carried at half, and that half was set by playing five seasons of weekly waiver
  decisions out. Nothing has measured what it should be over a months-long hold.
- **Does not know your scoring period unless the league stated one.** Streaming ranks
  over the remainder of your league's period, and that period comes from the league's
  own settings. Not every platform states it and not every import can derive it, and
  the platform templates a new league starts from carry none — so where it is missing
  the board falls back to a rolling seven days from today and says on the page that
  that is the assumption it made, rather than presenting it to you as your week. Where
  a league says it runs matchup periods but not which weekday they open on, the board
  assumes a Monday start and says that too. A printed assumption is not the same as a
  quiet one, and neither is the same as knowing.
- **Does not model keeper or dynasty value, and does not know your budget.** **Stash**
  ranks over the rest of the season, which is the longest horizon here; nothing looks
  past this season at all.
- **Knows multi-position eligibility for the players your platform prints it for.**
  This was the largest known accuracy gap and is now mostly closed: Yahoo prints real
  eligibility beside every name ("MIN - 1B,3B"), the same sweep that reads ownership
  captures it, and a player is valued at his *scarcest* eligible slot — so a catcher
  who also qualifies at first is finally worth what he is worth. On the shipped capture
  Yahoo returned 411 multi-position lines and 328 of them matched into the pool, and
  reading them cuts the players with a positive bscore from 139 to 106, because a man
  valued at his scarcest slot is priced against a lower bar. For anyone the platform
  did not list, the board still has only the one primary position StatsAPI reports, and
  it does not guess.
- **Does not use park factors, weather, or lineup slot.** There was a park fetcher;
  Savant's park-factor endpoint returns HTML and ignores `csv=true`, so it produced
  rows of nulls that nothing consumed. It and the park term have been removed rather
  than left looking like a feature. No readable source has been found, so this is "not
  modelled", not "modelled quietly".
- **Ranks all of MLB, not just who is available to you — unless you ask it to.** The
  names at the top of an unfiltered board are usually rostered. **Only players I can
  add** narrows it properly, and it is on by default: it reads your league's actual
  free-agent list where a server has fetched one, and falls back to the ownership
  estimate otherwise, so it answers on the hosted build too. It goes inert only where
  neither is readable, and says "can't tell" when it does.
- **Does not move a recommendation on Statcast.** xwOBA and barrel rate are shown and
  ranked, because they genuinely inform a human. They are not multiplied into any
  projection: as a multiplier they were measured over 111 weeks and lost at every
  setting, and as a veto they lost worse. The drill-down says so on every player.

## How the model was validated

Two harnesses, and they answer different questions. The first ranks; the second plays.

**The ranking harness** builds a corpus from every season of the Statcast era,
**2016–2026** (2020 excluded — a 60-game season cannot hold a 14-day horizon after
warm-up), and scores projection variants against what actually happened over the
following two weeks. Every stat line it scores is pulled with a date range ending at
the as-of date, so nothing from the evaluation window reaches the projection. 100 folds
total, 50 per side. The baseline is the honest naive one — "he'll keep doing what he's
been doing," his season rate scaled to the games ahead.

Re-measured on the shipped corpus on **2026-09-11**, against the naive baseline that
`recentWeight 0` reproduces exactly: the model ranks hitters at **ρ 0.676** against the
baseline's 0.574, **+17.7%**, and pitchers at **ρ 0.535** against 0.470, **+13.9%**.
That one pair is the whole of what this guide publishes about ranking correlation. The
full table — every variant scored, the fold counts, the naive baseline's own definition
and the reasons two of those fold counts carry a caveat — lives in
**[Methodology §6.5](METHODOLOGY.md#65-results)**, and that is now the only copy of it
in this project.

This guide used to print its own table here, and README.md a third, and the three did
not agree. The pair this one showed you — 0.682 and 0.533, +18.7% and +13.5%, winning
49 of 50 and 50 of 50 folds — was the pair no stored run supported: `data/results/`
holds twenty-three season-play runs and no ranking-fold output whatsoever, so there was
nothing to check them against and nothing to re-derive them from. **The fold counts are
dropped rather than restated** for that reason, here and in README: a "49 of 50" is the
most persuasive number in a table like this one and the least defensible in this one, and
softening it to "most folds" would keep the persuasion and lose only the precision. If
you want fold counts, Methodology has them, in the document whose job is to carry a run
that cannot currently be re-run and say so.

What survived the sweeps:

- **Recent playing time is nearly the whole gain**, and the right window differs by
  side — a batter's role can change in a week; a starter needs three weeks before his
  workload is even visible. Several windows are blended (3, 7 and 21 days for batters
  with the shortest weighted double; 5 and 21 for pitchers), and the recent estimate
  then carries **half** the weight against the season line. That 0.5 was chosen by
  playing whole seasons rather than by ranking correlation — a 14-day ranking mildly
  preferred heavier recency, but across five seasons of real weekly decisions 0.5 beats
  0.75 in **73 of 111 decided weeks (z 3.32)**, by 22.6 points a week and 2,504 points
  over the five. That one is reproducible and was re-derived on 2026-09-12 from
  `data/results/churn-5s_2021-2022-2023-2024-2025_moves1.json`, which is why it keeps
  its counts where the fold counts above lost theirs.
- **A light recent-rate blend helps pitchers only** — 15% of the 21-day rate. The
  identical idea for batters was a coin flip, with a mean difference of +0.0009:
  exactly the kind of number that looks like an improvement and is noise. Both came out
  of the same ranking harness as the ρ figures above, so their fold counts are in
  Methodology with the caveat they need (every variant in that grid was scored at a
  recency weight the project has since retracted) rather than quoted bare here.
- **Extra rate shrinkage made things worse.** The naive line already carries the fact
  that good players accumulate more plate appearances; shrinking on top of a volume
  model double-penalises the players it shouldn't. It is implemented and switched off.

**The season harness** plays whole seasons out week by week: each strategy drafts from
the same pool, sets a legal roster, makes waiver moves on what it believed at the time,
and is scored on what those players actually produced. This is the harness that decides
anything, because paired weekly wins are how a head-to-head league is actually won, and
it has already overruled the correlation once — on the recency weight. Over 2021-2025,
111 weeks, one waiver move a week, the model beats a season-to-date manager by 65 points
a week (76 of 111 weeks, z 3.89) and a hot-hand manager by 48 (74 of 111, z 3.51).

Against a manager who blends season and recent form the edge is **suggestive and not
established**: 60 of 111 weeks at one move a week, 63 at two, one-sided p 0.17 and
0.064. It is quoted here with its strength because quoting it without one makes a
marginal result read as a settled one.

It is also the harness that settled the two questions people ask about most:

- **The Statcast multiplier was measured and rejected.** Every formulation — five
  weights, two λ shapes, two scopes — loses points over those 111 weeks, and the
  per-season winner is a different configuration in four of the five years, which is
  what noise looks like. It is off. Note what this does *not* say: on clean
  point-in-time data xwOBA out-predicts actual wOBA for next-week production, and the
  gap carries real incremental signal. The metric is predictive; multiplying a
  projection by it still doesn't change which 27 players you roster, because that
  decision is dominated by playing time and slot scarcity.
- **Schedule strength ships at half weight.** Positive at every dose and monotone in
  the total, significant at none, so the smallest dose that shows the effect is the one
  that risks least.

An earlier version of this page said the Statcast blend had been ruled out by the
ranking harness. That measurement ran on a Savant endpoint which accepts date
parameters and ignores them, so its "prior" numbers contained the future it was
predicting. It was void and has been retracted; the paragraph above replaces it.

### What ρ ≈ 0.68 does and does not mean

It means the ordering is real. Across ten seasons, ranking players this way lands
substantially closer to the true 14-day order than assuming everyone keeps doing what
they have been doing — 18% closer on hitters and 14% on pitchers, as a rank
correlation. This paragraph used to add "and it did so in 49 of 50 folds", which is
the same unsupported count the table above dropped and for the same reason: nothing
stored holds it. The consistency across folds is the part that would matter most if
it could be quoted, which is exactly why it is not quoted until it can be.

It does not mean the numbers are predictions. A rank correlation of 0.68 leaves a great
deal of disagreement between the projected order and the real one. Fourteen days of
baseball is mostly variance, and no model removes that. A bscore of 55 is not a
forecast that you will gain 55 points; it is a statement that this player currently
grades well above his replacement given what is known.

It also does not mean the top of the board is where the value is. In backtest, the
top-20-by-actual-points measure barely separated the model variants — the elite players
are obvious to everyone. The gain is concentrated in ranking the broad middle of the
pool correctly, which is to say: **in waiver decisions, not in telling you to start
your first-round pick.**
