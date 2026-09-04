# beanemachine user guide

## Start here — the board you are looking at is not yours yet

The first time you open beanemachine with nothing stored, it seeds itself from the
league committed to this repo: **Mrs. Met's Harem**, Yahoo head-to-head points league
228947. That is deliberate — a bscore has no meaning without a league's scoring
behind it, so an empty first screen would teach you nothing. The page says so, in the
band above the board, and offers the one button that ends it.

Until you replace it, every number on the page is denominated in *that* league's
points. A home run is worth 10.4 there (`test/ui.mjs` pins that value against the
committed `scoring.json`); in a league that scores it differently the same players
rank differently. [Set up your own league](#how-do-i-set-up-my-own-league) is three
inputs — what each stat is worth, how many teams, and the roster slots — and the band
disappears the moment your league is the active one.

Two sentences of vocabulary, and the rest of this page is elaboration on them:

- A **bscore** is *points above a free replacement* — what your league scores with a
  player in a roster slot, minus what it scores with the best free agent at the same
  slot, over the horizon you picked. It is the column the board is ranked on.
- A **uscore** is that same figure discounted by how widely he is already rostered:
  bscore asks who is best, uscore asks who is the best you can actually get.

Every column on the board carries its own definition in its header tooltip, and all
of them together sit under the table in *How this ranking was built*. The measured
results behind them — what was validated, what was measured and rejected, and what
cannot be measured at all — are in
[METHODOLOGY.md](METHODOLOGY.md), summarised in the footer of the app itself.

## Which view you want

The board opens on three tabs, and they are three different questions rather than
three filters.

**Streaming** ranks over whatever is left of your league's own scoring period, using
that period's real slate. In a Monday-to-Sunday matchup league opened on a Wednesday
that is Wednesday through Sunday — not seven days from Wednesday, which would count
games from a matchup you are not being scored on. In a daily league it is today. Where
lineups lock for the whole of the current period it is the *next* period, because
that is the only one you can still act on. This is the daily/weekly view: it rewards
a pitcher with two starts booked and a hitter whose team plays six games instead of
four, and it is the one to use on waiver day. The exact dates, and where those edges
came from, are printed under the heading every time.

**This fortnight** is the standing board, fourteen days out. It is the default
because it is long enough that a single bad week doesn't dominate and short enough to
still be a decision you act on now.

**Stash** ranks over every game left in the regular season. Playing time and role
matter far more here than the last fortnight, so it surfaces the young player who
just took an everyday job rather than whoever is hot. This is who to *hold*, not who
to start. Two things this view does not have: probable starters (MLB publishes them
only days ahead, so a rest-of-season horizon has none, and the two-start filter is
hidden here rather than left as a control that silently does nothing), and any
measured claim about the Statcast numbers on each card. They have been measured at a
one-week horizon and rejected as a multiplier; nobody has measured what they are
worth over a rest-of-season hold. Read them as a human, not as a number the model used.

## Billy's pick, and what "available" means

The card answers availability from whichever source you actually have, and it says
which, because they are three different claims:

1. **Your league's own free-agent list.** Exact, and about your league specifically.
   It needs a publicly viewable Yahoo league *and* the local server, so it is what you
   get running `npm run dev`, and not what you get on the hosted build.
2. **How widely he is rostered across leagues** — under 70%, the same bar the Buy low
   card uses. Weaker and global, but it comes off the snapshot with no server at all,
   which is the situation everybody reading the hosted build is in. Only figures that
   survived the forecast check are used (see the edge column below), so a player with
   no figure is skipped rather than assumed free.
3. **Neither.** Then it is the top of the board and the card says so, rather than
   implying an availability nothing checked.

Whichever tier answered, the pick is drawn from the board *as you have filtered it* —
narrow to catchers and Billy names the best catcher you can get.

## The edge column, and why it is no longer the default

Edge compares a player's bscore against the median bscore of the players the field
prices the same way he is priced, using Yahoo's "% Ros". An edge of +18 means
eighteen points more than the typical player rostered about as widely. A dash means
Yahoo doesn't list the player, so there is no market price to compare against —
unknown, which is not the same as unowned.

**The board used to open on edge and no longer does, because the price it divides by
is mostly wrong.** Yahoo nests a weather forecast inside each outdoor game's tooltip,
and the sweep that reads "% Ros" was taking the first percentage left in a player's
row after stripping the three forecast lines it knew the labels of. It did not know
all of them, so a per-*game* number reached the field — and being per-game, every
player in both clubs carries it. On the committed capture all thirty Yankees and all
twenty-eight Angels read 47%, Dodgers and Cardinals 54%, Orioles and Rockies 20%, and
225 players across four games read 51%. Those are the day's matchups, not roster
shares: twenty of thirty clubs sat on a single value, most of them at 93–100% of the
club. Fewer than a hundred of the 848 values look like genuine per-player reads.

That is not a cosmetic column when it is the default sort. Market edge is bscore
minus the median at the same ownership decile, so a wrong percentage does not degrade
one cell — it reorders the whole board by the precipitation forecast.

Captures taken from now on discard those values (`leakedByTeam` in
`src/data/yahoo-pool.ts` drops any percentage most of a club shares to the point, on
the ground that real roster share varies within a club), and `test/ownership.mjs`
pins the shape so it cannot ship again. The committed snapshot predates the check.
Until a capture passes it, treat edge as unreliable: it is still selectable, it now
warns you rather than silently handing back a different ranking, and **bscore** is the
honest column. The original reasoning for the edge default — that a bare bscore
ranking opens on players already rostered everywhere — is still right, and **Free
agents only** is the control that answers it in the meantime.

## What am I looking at?

The board is every MLB player, ranked by how much he would add to *your* team over the horizon you picked, in *your* league's scoring. The top card is Billy's pick, and it is deliberately **not** the number one row: the top of a bscore board is the best player in baseball, who is rostered in every league, and naming him is a fact rather than a recommendation. Billy names the best player on the board you can actually *get*, with the reasons spelled out as clauses assembled from numbers actually on the row. Under it, one row per player: how far he beats the field's price for him (**edge**), his value over replacement (**bscore**), his raw projected points, what a replacement at his slot projects, how confident the projection is, how many games his team actually plays in the window, and how unlucky he has been. Click any row to open the drill-down, which takes that projection apart into what was measured, what was modelled, and what is missing. The heading states how old the underlying data is and the exact date window being projected. Only the top 120 rows render; narrow the filters to see further down.

Below the ranking sit two supporting reads, deliberately *below* it rather than above: **Buy low**, the handful of players hitting the ball better than their line says who are still cheap, and **Where it hurts to wait**, the drop-off at each slot. Both answer "where should I spend attention", which is a second question.

## What is a bscore?

A bscore is **points above the guy you could have for free.**

Everything on the board is denominated in your league's own points, not in some abstract rating. The projection says what a player will score over the horizon the tab you are on asks about — the rest of your league's scoring period, fourteen days, or the rest of the season. The bscore subtracts what a freely available player at the same roster slot would score over that same window. The worked example below uses the 14-day default.

Worked example:

| | |
|---|---|
| Outfielder projects | **129 points** |
| Best OF still on waivers projects | **74 points** |
| **bscore** | **55** |

Fifty-five is the number that matters. Starting that outfielder instead of the best free agent outfielder is worth 55 points to you over two weeks. His 129 is not, on its own, a useful number — you were always going to get *someone's* 74 out of that slot.

This is also why bscores compress as you go down the board. A player with a bscore of 3 projects for three more points than a free pickup. That is a rounding error, not an edge.

## Why is a catcher with fewer points ranked above an outfielder with more?

Because they are not competing for the same slot, and the players they replace are not the same quality.

The replacement level for a slot is computed from your league's actual roster settings: it is the best player at that slot who is *still unrostered* once every team has filled it. In a 12-team league with one catcher slot, 12 catchers are spoken for, so replacement is roughly the 13th-best catcher. With three OF slots, 36 outfielders are spoken for, so replacement is roughly the 37th-best outfielder — and the 37th-best outfielder is a real major leaguer.

That difference is positional scarcity, and it is where the ranking comes from:

| Player | Projected | Replacement at his slot | bscore |
|---|---|---|---|
| Catcher | 101 | 58 | **43** |
| Outfielder | 112 | 74 | **38** |

The outfielder scores 11 more points. The catcher is still the better roster move, because rostering him upgrades his slot by 43 points while the outfielder upgrades his by 38. The 11 points the outfielder has are already available to you from the waiver wire; the catcher's are not.

The practical rule: **the "proj pts" column tells you who is better at baseball, the "bscore" column tells you who is worth more to your team.** They disagree at scarce positions, and that disagreement is the entire point of the board.

If a player is eligible at more than one slot, he is scored at whichever slot makes him most valuable, and that slot is shown next to his name.

## How do I use it?

### Draft day

Leave **Rank by** on bscore — which is what the board opens on — leave the filters wide, and read down. The board is already telling you when to take the scarce position, so you do not need a separate "positional tier" exercise, because scarcity is priced into the number. **Where it hurts to wait**, under the board, is the same information as a shape: long bars are the slots you pay for early.

Better still, use the **Draft** tab, which is built for exactly this. It knows what you
have already taken, so it ranks by how much a pick improves *your* projected starting
lineup rather than by raw value — once you hold three outfielders and no catcher, another
outfielder is worth very little to you and the recommendation says so. Mark players as
they go and the remaining pool, and the per-slot cliff, update as you draft.

One thing to watch: the Draft tab prices every pick over the rest of the season, and
the board's default tab over fourteen days from the last data capture — either way,
early in a season the sample behind every row is thin and confidence will be low
across the board.

### Weekly waivers

This is what the model was tuned for and where it measured best. Set **Free agents only** if it is available to you (see the limitations below), or filter by the slot you are trying to fill. Then compare the bscore of the best free agent against the bscore of the player you would drop. The difference between those two numbers is the actual gain from the move, in points, over two weeks.

Set **Min confidence** to 40%+ before acting. Low-confidence rows are usually small samples, and small samples are how you end up adding a player on the strength of nine good games.

### Daily streaming

Open the **Streaming** tab, filter to **SP**, and read the **GP** column while you do. The projection multiplies each player's per-game rate by the games his team actually has scheduled in the window the tab resolved — the rest of your scoring period, not a flat seven days — so a heavy slate rises without you doing the arithmetic; the drill-down states the same number as *team games in window*.

Two starts in a scoring period is roughly double the innings, and it is the single biggest thing that separates one streaming pick from another. Where MLB has published a pitcher's turns, the board projects him from **his own starts** rather than from his team's games, marks a two-start pitcher with a `×2` badge next to his bscore, and offers a **Two-start SP only** filter. Read the coverage honestly: probables reach only a few days out, so at any moment most starters have none published and the ones who do may have only their next turn announced — a starts-based projection is starts *announced*, not starts he will make. Early in a scoring period the filter will be empty and that is the data, not a bug.

For pitchers generally, recent form is read over 5 and 21 days with the 5 weighted double, rather than the 3/7/21 a batter gets. A starter works every fifth day, so five days is the shortest window that contains a start at all and a week of his data is one or two starts of noise. Do not expect the board to react to a single good outing; it is not supposed to.

### Buying low

The **Buy low** card under the board is the one place two independent signals are combined, and it only shows a player who clears both bars. He has to be hitting the ball better than his results say over the last three weeks — an expected-minus-actual wOBA gap above 0.035, with the sign flipped for pitchers — *and* still be rostered in under 70% of leagues. Either one alone is a trap: an unlucky player everyone already owns is not an opportunity, and a free player making weak contact is free for a reason. The score is the product of the two terms, not the sum, so being cheap cannot compensate for weak contact. At most three names appear, and often none do.

### Where it hurts to wait

The scarcity card shows, per slot, how far the best player you can still get sits above the next man up at that slot. A short bar is a slot you can punt; a long one is a slot worth paying for, because waiting costs you the whole gap. It is the same replacement level that sits under every bscore, drawn side by side — which is the only way to see it, since on any single row it is one number with nothing to compare against.

## My team and trades

The second view, **My team & trades**, is the one place the app knows what you hold. Add the players you own by name; they are stored in this browser under *this league's* key, so switching leagues switches teams and a roster never travels between them. Only ids are stored, so your team stays correct as the snapshot behind it is recaptured — and an id the current capture has no row for is named on screen rather than quietly dropped.

From that it fills your league's real startable spots, best legal lineup first, and shows every spot accounted for out loud: filled by one of yours, covered at the waiver bar because nobody you own is worth it there — either nobody left unseated is eligible, or the best one who is projects below the freely available body — or a hole nothing in the pool can fill. A hole is reported as a hole, not priced at zero.

Then the deal. Pick who leaves and who arrives, and the verdict is **what your starting lineup projects afterwards, minus what it projects now**. That is deliberately not "who has the higher bscore": bench depth is worth nothing until it starts, so a player who arrives and doesn't crack your lineup adds nothing to the number, and a player you give up who wasn't starting costs nothing. Both cases are stated on screen rather than left as an unexplained zero, alongside the spot-by-spot changes and anything the engine could not read.

## Injured players

Over the **Streaming** and **fortnight** horizons an injured player is not ranked at
all — he is dropped from the board rather than shown with a caveat. This is not
squeamishness: a man placed on the 10-day IL yesterday
was healthy for most of the window the playing-time blend reads, so he projects at a
full-time rate and lands near the top of the board while being unable to play. No source
states a return date, so instead of inventing a discount the board says it cannot honestly
project him over this window.

**Stash** ranks him anyway, because over the rest of a season an injured man is a
perfectly good hold. Same player, same data, different question.

## What do the columns mean?

| Column | What it is | How to read it |
|---|---|---|
| **#** | Rank under the current sort | Changes with the filters — it is a position in this list, not a global rating |
| **Player** | Name, then his best slot, his team, and an injury tag if he has one | The slot code is the one the bscore was computed against |
| **edge** | bscore minus what a player rostered about as widely typically produces | Currently unreliable and not the default — the "% Ros" sweep mostly returns the game's weather line. A dash means Yahoo doesn't list him: unknown, not unowned |
| **bscore** | Projected points minus the replacement at that slot | Points you gain over a free pickup. An `×N` badge here means N starts are scheduled for him in this window; it only appears at two or more |
| **proj pts** | Projected points over the horizon | Raw production. Not comparable across positions |
| **waiver pts** | What a freely available player at that slot projects | Your baseline. Higher at deep positions, lower at scarce ones |
| **confidence** | How much sample and data stand behind the projection, 0–100% | Hover for the specific reasons |
| **GP** | Games his team actually has scheduled in the window | Six-game weeks are worth chasing; four-game weeks are why a good hitter can be the wrong start |
| **luck** | Where his expected-minus-actual wOBA over the last three weeks falls among his own side of the ball, as a percentile | 90 means only 10% of batters (or pitchers) have been unluckier. A dash means no Statcast row |

Every header sorts except **GP**; clicking the active one flips direction. The **Rank by** control adds one sort the columns do not: *best contact vs results*, which orders on the raw 21-day expected-minus-actual gap rather than on its percentile.

The luck column is displayed for your judgment only. It does **not** move the projection — see the validation section.

The filters above the board: position chips, a name search, **Side**, **Rank by**, **Min confidence** (any / 40%+ / 70%+), **Free agents only** (Yahoo public leagues, local server only), **Two-start SP only** (hidden on Stash, where no probables exist), and **Hide injured**.

## What does confidence mean, and when should I distrust a row?

Confidence is not a vibe and not a default. It is three real measurements multiplied together:

| Factor | Effect |
|---|---|
| Sample size | Playing time so far against a full season of work in that player's own role — 434 PA for a hitter, 540 batters faced for a starter, 209 for a reliever — capped at 1. 100 PA is a 0.23 multiplier |
| Statcast data | Present: no penalty. Absent: ×0.6 |
| Health | Healthy: no penalty. Carrying an injury designation: ×0.5 |

So a healthy full-season regular with Statcast data reads near 100%, and that holds for a closer as much as for an everyday bat — the yardstick is his role's workload, not a hitter's. A hot rookie with 90 PA reads about 21%.

**Distrust a row when:**

- **Confidence is under 40%.** The projection is mostly extrapolation from a short sample.
- **The injury tag is showing.** The model reduces confidence but does not know when he plays again, and it does not model a rehab timeline at all.
- **The data-age chip is orange.** It flags at 36 hours. A stale capture misses call-ups, demotions, and the past two days of playing time. Captures run at 11:00 and 23:00 UTC.
- **The drill-down lists things under "Missing."** No Statcast row, no team games in the window, or a category your league scores that no source provides. An unscoreable category is reported rather than treated as zero, which means the projected points for that player are genuinely incomplete.
- **The bscore is in single digits.** Below the noise floor of two weeks of baseball.

One thing that is *not* a reason to distrust a row: a modest projection for a player who has been hot. **A batter's projected rate is his season rate**, full stop — recent form moves his *playing time* and nothing else, and even that is only half-weighted against the season. A pitcher gets 15% of his rate from his last 21 days, which is the most any measurement supported. So a .400 month over 90 PA does not project forward at face value, deliberately.

Be precise about how that restraint works, because the honest version is not the one you would guess. Shrinking each rate toward the league average — the textbook fix, with per-stat stabilisation constants — is implemented in this codebase and **is not applied**: it was measured and it lost, because the volume model already docks a part-time player for playing part-time and shrinking on top of that penalises him twice. What holds a hot streak down here is the season rate and the volume blend, not a shrinkage step.

Players with no projectable playing time never appear on the board at all. They are excluded, not ranked at zero next to real players.

## How do I set up my own league?

1. Open **League setup**.
2. Paste your league URL — Yahoo, ESPN, or Sleeper — into "Import a league from its URL" and hit **Import**. Everything that can be read from the league's own settings pages is read: scoring values, roster slots, team count, eligibility rules. Anything the source did not actually state stays blank and is listed under **Needs review** rather than being guessed at.
3. Fill in whatever landed in Needs review. In particular, **team count must be set** — replacement level is derived from teams × slots, and without a real number there is no honest bscore, so the board stays empty rather than assuming a league size.
4. Check the **Batting** and **Pitching** tables against your league's settings page. Negative values are penalties. Add any missing stat with its code and point value.
5. Check **Roster slots**. These drive replacement level directly. Getting the OF or SP count wrong moves every bscore at that position.
6. **Save.** Your league is stored in this browser; **Download** takes it out as a file. The board re-ranks immediately — the engine runs in your browser, so you can watch a scoring change reprice the league.

Your leagues live in the browser you set them up in — **Save** writes them there, and they are still there next time you open the page. **Download** takes the lot out as a `scoring.json` you can keep or move to another browser, and **Load file** reads one back in, replacing what that browser holds. Nothing is stored on a server, and the first visit starts from a real league rather than an empty screen by seeding itself from the copy committed to the repo.

One note on the hosted site: importing needs the local server (`node src/server.ts` with `npx vite` in front of it), because Yahoo and ESPN send no CORS headers and a browser cannot read them directly. Editing, saving, downloading and loading all work on the hosted build exactly as they do locally. You can also start from a blank or platform template with **New** and enter the values by hand.

## What this tool does not know

Be clear-eyed about the edges. It:

- **Knows which pitcher your hitters face, but only about a week out.** MLB publishes probable starters roughly a week ahead, and where it has them the board rates a hitter against the men actually on the mound, blended with the opponent staff by innings share — a starter throws about 58% of *one game*, so his own quality carries that share of that game and the bullpen behind him carries the rest. Over a fortnight only a game or two is usually published, so in practice the named starters carry about 6% of the board's matchup number; the rest is the opponent staff. On Streaming the same names cover a shorter window, so they carry a larger share of it — how much larger depends on how much of your scoring period is left, which is why the number is scaled per team rather than fixed. Where no probable is published it falls back to the team-level number entirely. This one cannot be validated the way the rest can: probables are announced and then overwritten, and nothing archives what was announced at the time.
- **Does not know your roster, on the board.** The ranking never accounts for who you already have, so it will happily rank three catchers at the top when you need one. **My team & trades** is the view that does know, and it is a separate view for that reason.
- **Rates the Stash horizon against the right opponents now, at a weight nothing has measured over that horizon.** This entry used to say the **Stash** tab applied a fortnight of schedule strength over months, because the only opponent list any capture carried was the next two weeks. The snapshot now stores the whole slate to the end of the season, so Stash reads a genuine rest-of-season opponent list and the window mismatch is gone. What is left is the weight: the adjustment is still clamped to ±12% and still carried at half, and that half was set by playing five seasons of weekly waiver decisions out. Nothing here has measured what it should be over a months-long hold.
- **Does not know your scoring period unless the league stated one.** Streaming ranks over the remainder of your league's period, and that period comes from the league's own `scoring_period` settings. Not every platform states it and not every import can derive it, and the platform templates a new league starts from carry none — so where it is missing the board falls back to a rolling seven days from today and says on the page that that is the assumption it made, rather than presenting it to you as your week. Where a league says it runs matchup periods but not which weekday they open on, the board assumes a Monday start — a Monday-to-Sunday week, unless the league gave a period length — and says that too. A printed assumption is not the same as a quiet one, and neither is the same as knowing. Anything an import could not read is listed under **Needs review** in League setup.
- **Does not model keeper or dynasty value, and does not know your budget.** The **Stash** tab ranks over the rest of the season, which is the longest horizon here; nothing looks past this season at all.
- **Knows multi-position eligibility for the players your platform prints it for.** This was the largest known accuracy gap and is now mostly closed: Yahoo prints real eligibility beside every name ("MIN - 1B,3B"), the same sweep that reads ownership captures it, and a player is valued at his *scarcest* eligible slot — so a catcher who also qualifies at first is finally worth what he is worth. Roughly 430 players come back with a genuine multi-position line. For anyone the platform did not list, the board still has only the one primary position StatsAPI reports, and it does not guess.
- **Does not use park factors, weather, or lineup slot.** There was a park fetcher; Savant's park-factor endpoint returns HTML and ignores `csv=true`, so it produced rows of nulls that nothing consumed. It and the park term have been removed rather than left looking like a feature. No readable source has been found, so this is "not modelled", not "modelled quietly".
- **Ranks all of MLB, not just who is available to you.** The names at the top are usually rostered. The **Free agents only** toggle narrows it properly by reading your league's actual free agent list, but it works only for Yahoo leagues that are publicly viewable, and only when you are running locally, because the hosted build has no server to fetch the pool through.
- **Does not move a recommendation on Statcast.** xwOBA and barrel rate are shown, ranked and used to find buy-low candidates, because they genuinely inform a human. They are not multiplied into any projection: as a multiplier they were measured over 111 weeks and lost at every setting. The drill-down says so on every player.

## How the model was validated

Two harnesses, and they answer different questions. The first ranks; the second plays.

**The ranking harness** builds a corpus from every season of the Statcast era, **2016–2026** (2020 excluded — a 60-game season cannot hold a 14-day horizon after warm-up), and scores projection variants against what actually happened over the following two weeks. Every stat line it scores is pulled with a date range ending at the as-of date, so nothing from the evaluation window reaches the projection. 100 folds total, 50 per side. The baseline is the honest naive one — "he'll keep doing what he's been doing," his season rate scaled to the games ahead.

| Side | Model | Spearman ρ | vs naive | Folds won |
|---|---|---|---|---|
| Hitting | naive baseline | 0.574 | — | — |
| Hitting | shipped windows (3/7/21d) | **0.682** | +18.7% | 49 / 50 |
| Pitching | naive baseline | 0.470 | — | — |
| Pitching | shipped windows (5/21d) | **0.533** | +13.5% | 50 / 50 |

What survived the sweeps:

- **Recent playing time is nearly the whole gain**, and the right window differs by side — a batter's role can change in a week; a starter needs three weeks before his workload is even visible. Several windows are blended (3, 7 and 21 days for batters with the shortest weighted double; 5 and 21 for pitchers), and the recent estimate then carries **half** the weight against the season line. That 0.5 was chosen by playing whole seasons rather than by ranking correlation — a 14-day ranking mildly preferred heavier recency, but across five seasons of real weekly decisions 0.5 wins by roughly 1,500 points and seven weekly wins.
- **A light recent-rate blend helps pitchers only** — 15% of the 21-day rate, which won 41 of 50 pitching folds. The identical idea for batters won 29 of 50, a coin flip, so it is not applied. The mean difference there was +0.0009: exactly the kind of number that looks like an improvement and is noise.
- **Extra rate shrinkage made things worse.** The naive line already carries the fact that good players accumulate more plate appearances; shrinking on top of a volume model double-penalises the players it shouldn't. It is implemented and switched off.

**The season harness** plays whole seasons out week by week: each strategy drafts from the same pool, sets a legal roster, makes waiver moves on what it believed at the time, and is scored on what those players actually produced. This is the harness that decides anything, because paired weekly wins are how a head-to-head league is actually won, and it has already overruled the correlation once — on the recency weight. Over 2021-2025, 111 weeks, one waiver move a week, the model beats a season-to-date manager by 65 points a week and a hot-hand manager by 48, both significant.

It is also the harness that settled the two questions people ask about most:

- **The Statcast multiplier was measured and rejected.** Every formulation — five weights, two λ shapes, two scopes — loses points over those 111 weeks, and the per-season winner is a different configuration nearly every year, which is what noise looks like. It is off. Note what this does *not* say: on clean point-in-time data xwOBA out-predicts actual wOBA for next-week production, and the gap carries real incremental signal. The metric is predictive; multiplying a projection by it still doesn't change which 27 players you roster, because that decision is dominated by playing time and slot scarcity.
- **Schedule strength ships at half weight.** Positive at every dose and monotone in the total, significant at none, so the smallest dose that shows the effect is the one that risks least.

An earlier version of this page said the Statcast blend had been ruled out by the ranking harness. That measurement ran on a Savant endpoint which accepts date parameters and ignores them, so its "prior" numbers contained the future it was predicting. It was void and has been retracted; the paragraph above replaces it.

### What ρ ≈ 0.68 does and does not mean

It means the ordering is real. Across ten seasons, ranking players this way lands substantially closer to the true 14-day order than assuming everyone keeps doing what they have been doing, and it did so in 49 of 50 folds — the consistency matters more than the size of the gap.

It does not mean the numbers are predictions. A rank correlation of 0.68 leaves a great deal of disagreement between the projected order and the real one. Fourteen days of baseball is mostly variance, and no model removes that. A bscore of 55 is not a forecast that you will gain 55 points; it is a statement that this player currently grades well above his replacement given what is known.

It also does not mean the top of the board is where the value is. In backtest, the top-20-by-actual-points measure barely separated the model variants — the elite players are obvious to everyone. The gain is concentrated in ranking the broad middle of the pool correctly, which is to say: **in waiver decisions, not in telling you to start your first-round pick.**
