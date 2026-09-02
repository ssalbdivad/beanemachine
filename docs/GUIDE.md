# beanemachine user guide

## What am I looking at?

The board is every MLB player, ranked by how much he would add to *your* team over the next 14 days, in *your* league's scoring. The top card is Billy's pick — the number one row, with the reasons spelled out. Under it, one row per player: his value over replacement (**bscore**), his raw projected points, what a replacement at his slot projects, how confident the projection is, and how far his expected contact quality sits from his actual results. Click any row to open the drill-down, which takes that projection apart into what was measured, what was modelled, and what is missing. The heading states how old the underlying data is and the exact date window being projected. Only the top 120 rows render; narrow the filters to see further down.

## What is a bscore?

A bscore is **points above the guy you could have for free.**

Everything on the board is denominated in your league's own points, not in some abstract rating. The projection says what a player will score over the 14-day horizon. The bscore subtracts what a freely available player at the same roster slot would score over the same 14 days.

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

The practical rule: **the "proj" column tells you who is better at baseball, the "bscore" column tells you who is worth more to your team.** They disagree at scarce positions, and that disagreement is the entire point of the board.

If a player is eligible at more than one slot, he is scored at whichever slot makes him most valuable, and that slot is shown next to his name.

## How do I use it?

### Draft day

Rank by bscore, leave the filters wide, and read down. The board is already telling you when to take the scarce position — you do not need a separate "positional tier" exercise, because scarcity is priced into the number.

Two things to watch. First, the projection horizon is 14 days from the last data capture, so early in a season the sample behind every row is thin and confidence will be low across the board. Second, the board does not know who has already been drafted — cross off names yourself as they go.

### Weekly waivers

This is what the model was tuned for and where it measured best. Set **Free agents only** if it is available to you (see the limitations below), or filter by the slot you are trying to fill. Then compare the bscore of the best free agent against the bscore of the player you would drop. The difference between those two numbers is the actual gain from the move, in points, over two weeks.

Set **Min confidence** to 40%+ before acting. Low-confidence rows are usually small samples, and small samples are how you end up adding a player on the strength of nine good games.

### Daily streaming

Filter to **SP** and sort by bscore. The projection already multiplies each player's per-game rate by the number of games his team actually has scheduled in the window, so a team with a heavy week rises without you doing the arithmetic. Open the drill-down and check **team games in window** — that is the schedule advantage, stated plainly.

For pitchers specifically, the model blends the last 21 days rather than the last 7. A starter works every fifth day, so a week of his data is one or two starts of noise. Do not expect the board to react to a single good outing; it is not supposed to.

## What do the columns mean?

| Column | What it is | How to read it |
|---|---|---|
| **#** | Rank under the current sort | Changes with the filters — it is a position in this list, not a global rating |
| **Player** | Name, then his best slot, his team, and an injury tag if he has one | The slot code is the one the bscore was computed against |
| **bscore** | Projected points minus the replacement at that slot | The ranking number. Points you gain over a free pickup |
| **proj** | Projected points over the 14-day horizon | Raw production. Not comparable across positions |
| **repl** | What a freely available player at that slot projects | Your baseline. Higher at deep positions, lower at scarce ones |
| **conf** | How much sample and data stand behind the projection, 0–100% | Hover for the specific reasons |
| **x−a** | Expected wOBA minus actual wOBA | For a batter, positive means his results trail his contact — he has been unlucky. For a pitcher the sign reads the opposite way |

Every header sorts; clicking the active one flips direction. The **Rank by** control adds one sort the columns do not: *most undervalued*, which ranks by where a player's x−a gap falls within his own side of the pool, in percentiles.

The x−a column is displayed for your judgment only. It does **not** move the projection — see the validation section.

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

One thing that is *not* a reason to distrust a row: a modest projection for a player who has been hot. Rates are shrunk toward league average in proportion to how little volume backs them, using per-stat sample weights. A .400 month over 90 PA does not project forward at face value, deliberately.

Players with no projectable playing time never appear on the board at all. They are excluded, not ranked at zero next to real players.

## How do I set up my own league?

1. Open **League setup**.
2. Paste your league URL — Yahoo, ESPN, or Sleeper — into "Import a league from its URL" and hit **Import**. Everything that can be read from the league's own settings pages is read: scoring values, roster slots, team count, eligibility rules. Anything the source did not actually state stays blank and is listed under **Needs review** rather than being guessed at.
3. Fill in whatever landed in Needs review. In particular, **team count must be set** — replacement level is derived from teams × slots, and without a real number there is no honest bscore, so the board stays empty rather than assuming a league size.
4. Check the **Batting** and **Pitching** tables against your league's settings page. Negative values are penalties. Add any missing stat with its code and point value.
5. Check **Roster slots**. These drive replacement level directly. Getting the OF or SP count wrong moves every bscore at that position.
6. **Save.** Your league is stored in this browser; **Download** takes it out as a file. The board re-ranks immediately — the engine runs in your browser, so you can watch a scoring change reprice the league.

Your leagues live in the browser you set them up in — **Save** writes them there, and they are still there next time you open the page. **Download** takes the lot out as a `scoring.json` you can keep or move to another browser, and **Load file** reads one back in, replacing what that browser holds. Nothing is stored on a server, and the first visit starts from a real league rather than an empty screen by seeding itself from the copy committed to the repo.

One note on the hosted site: importing needs the local server (`nub run dev`), because Yahoo and ESPN send no CORS headers and a browser cannot read them directly. Editing, saving, downloading and loading all work on the hosted build exactly as they do locally. You can also start from a blank or platform template with **New** and enter the values by hand.

## What this tool does not know

Be clear-eyed about the edges. It:

- **Does not know your opponent, or the pitchers your hitters will face.** Every projection is context-free. Streaming a hitter into a weekend at Coors is a decision the board cannot help with.
- **Does not know your roster.** It never accounts for who you already have, so it will happily rank three catchers at the top when you need one. It ranks players, you make the swap.
- **Does not model trades, keeper values, or anything past 14 days.** There is no rest-of-season number here.
- **Does not know multi-position eligibility.** The data source reports one primary position, and your league's real eligibility rules are not exposed by any source read here, so they are never assumed. A catcher who also qualifies at first base is scored only as a catcher — which understates him.
- **Does not use park factors, weather, or lineup slot.** Not modelled, not adjusted for.
- **Ranks all of MLB, not just who is available to you.** The names at the top are usually rostered. The **Free agents only** toggle fixes this by reading your league's actual free agent list, but it works only for Yahoo leagues that are publicly viewable, and only when you are running locally — the hosted build has no server to fetch the pool through. Otherwise, filter by slot and skip the names you know are taken.
- **Does not know the Statcast adjustment is right, so it does not use it.** xwOBA and barrel rate are shown because they inform a human. They do not move a recommendation.

## How the model was validated

The evaluation harness builds a corpus from every season of the Statcast era, **2016–2026** (2020 excluded — a 60-game season cannot hold a 14-day horizon after warm-up), and scores projection variants against what actually happened over the following two weeks. It is leak-free by construction: every stat line is pulled with a date range ending at the as-of date, so nothing from the evaluation window reaches the projection. 100 folds total, 50 per side. The baseline is the honest naive one — "he'll keep doing what he's been doing," his season rate scaled to the games ahead.

| Side | Model | Spearman ρ | vs naive | Folds won |
|---|---|---|---|---|
| Hitting | naive baseline | 0.574 | — | — |
| Hitting | shipped | **0.676** | +17.7% | 48 / 50 |
| Pitching | naive baseline | 0.470 | — | — |
| Pitching | shipped | **0.532** | +13.2% | 49 / 50 |

What survived the sweeps:

- **Recent playing time is nearly the whole gain**, and the right window differs by side — a batter's role can change in a week; a starter needs three weeks before his workload is even visible. Several windows are blended (3, 7 and 21 days for batters with the shortest weighted double; 5 and 21 for pitchers), and the recent estimate then carries most of the weight against the season line: 75% for batters, 60% for pitchers.
- **A light recent-rate blend helps pitchers only** — 15% of the 21-day rate, which won 41 of 50 pitching folds. The identical idea for batters won 29 of 50, a coin flip, so it is not applied. The mean difference there was +0.0009: exactly the kind of number that looks like an improvement and is noise.
- **The Statcast blend was measured and rejected.** Every sweep across ten seasons ranked it best at zero weight. It is off.
- **Extra rate shrinkage made things worse.** The naive line already carries the fact that good players accumulate more plate appearances; shrinking on top of a volume model double-penalises the players it shouldn't.

### What ρ ≈ 0.68 does and does not mean

It means the ordering is real. Across ten seasons, ranking players this way lands substantially closer to the true 14-day order than assuming everyone keeps doing what they have been doing, and it did so in 48 of 50 folds — the consistency matters more than the size of the gap.

It does not mean the numbers are predictions. A rank correlation of 0.68 leaves a great deal of disagreement between the projected order and the real one. Fourteen days of baseball is mostly variance, and no model removes that. A bscore of 55 is not a forecast that you will gain 55 points; it is a statement that this player currently grades well above his replacement given what is known.

It also does not mean the top of the board is where the value is. In backtest, the top-20-by-actual-points measure barely separated the model variants — the elite players are obvious to everyone. The gain is concentrated in ranking the broad middle of the pool correctly, which is to say: **in waiver decisions, not in telling you to start your first-round pick.**
