# How deep replacement sits on a real wire

The evidence behind the change to `src/engine/bscore.ts` on 2026-09-17, kept runnable
because this project's rule is that a measurement nobody can re-derive is an opinion.

The question was one the engine had carried as an open comment: given a list of the men
who are actually free in a league, is replacement the BEST of them — the rosters having
already run out — or a man some distance down the list?

Both candidates lost. What won was neither: walk the READER'S OWN seats at that slot down
the wire rather than the league's `teams x seats`, because a wire is the whole pool with
the other nine rosters already removed and walking the old distance takes them out twice.

| file | what it holds |
| --- | --- |
| `snapshot.txt`, `snapshot_bars.txt` | the four bars per slot on the committed capture, and the boards they produce |
| `grid.txt` | 20 configurations of field composition and move budget, 111 paired weeks each, 2021-2025 |
| `thin.txt` | what a throttled sweep does to each rule — the top-K-only wire |
| `check.txt` | the cost to `test/engine.mjs`'s wire assertions under each rule |
| `runs/` | the per-configuration weekly records the grid is summarised from |

Re-derive with `node --experimental-strip-types src/backtest/wire/<bars|wire|thin|check>.ts`
from the repository root. `bars.ts` cross-checks its own reconstruction against what
`rateAll` actually did and says so if the engine has moved again.

## What this does NOT establish

Neither wire here was read off Yahoo. One is the committed capture's own ownership column,
the other is a simulated field — so the comparison isolates how each rule treats the list
it is given, and says nothing about a list Yahoo would actually serve. The caveat already
in `bscore.ts` stands.

One league, one scoring table, one roster shape, five seasons. The 111 weekly comparisons
inside a configuration are not 111 independent tests, because a divergence early in a
season persists; season-level counts are quoted beside every pooled figure for that reason
and they are thin.

And the trap, recorded because it nearly became the headline: letting each variant draft
its own roster made one comparison look decisive (+25.0/wk, p 0.004) and it reversed sign
(-7.8/wk) when both started from the same roster. That is one decision, made once,
persisting for a season — not a weekly edge. Every figure quoted above holds the starting
roster fixed.
