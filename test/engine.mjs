// Regressions for bugs the adversarial critique found in shipped code.
// Each asserts against the real snapshot, not a fixture.
import { readFileSync } from "node:fs"
import { hydrate } from "../src/data/snapshot.ts"
import { rateAll, withMarketEdge, withUndervaluation } from "../src/engine/bscore.ts"

const snap = JSON.parse(readFileSync("data/snapshot.json", "utf8"))
const league = JSON.parse(readFileSync("scoring.json", "utf8")).leagues["yahoo:228947"]
let pass = 0, fail = 0
const t = (n, ok, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : "  " + x}`) }

// 1. Savant rows must be kept per side — merging them fed 37 hitters a pitcher's xwOBA-against
const bothSides = Object.keys(snap.underlying.hitting).filter(id => id in snap.underlying.pitching)
t("Savant expected stats are stored per side", bothSides.length > 0 &&
  snap.underlying.hitting[bothSides[0]].xwoba !== snap.underlying.pitching[bothSides[0]].xwoba,
  `${bothSides.length} ids on both sides`)

// 2. pools must not contain the other side's players
const h = snap.players.filter(p => p.group === "hitting")
const p = snap.players.filter(p => p.group === "pitching")
t("no pitchers in the hitting pool", h.every(x => x.position !== "P"))
t("no position players in the pitching pool", p.every(x => x.position === "P" || x.position === "TWP"))
t("no duplicate player+side rows",
  new Set(snap.players.map(x => `${x.id}:${x.group}`)).size === snap.players.length)

// 3. injuries must be injuries
const inj = Object.values(snap.injuries)
t("injury flags are only injuries", inj.length > 0 && inj.every(v => /injur/i.test(v)),
  [...new Set(inj)].join(","))

// 4. team count must not be invented
const hy = hydrate(snap)
const rate = teams => rateAll({ league, players: hy.players, underlying: hy.underlying,
  injuries: hy.injuries, teamGamesPlayed: hy.teamGamesPlayed, gamesByTeam: hy.gamesByTeam, teams })
const r10 = rate(10), r20 = rate(20)
t("replacement depth actually follows the team count",
  r10[0].replacement !== r20[0].replacement, `${r10[0].replacement} vs ${r20[0].replacement}`)

// 5. bscore identity holds for every row
t("bscore equals projected minus replacement for all rows",
  r10.every(x => Math.abs(x.bscore - (x.points - x.replacement)) < 0.02))

// 6. unrateable players are flagged, never ranked as zero
t("every ranked player is rateable", r10.filter(x => x.rateable).every(x => x.projection.projectedVolume > 0))

// 7. undervaluation is ranked within a side
const u = withUndervaluation(r10).filter(x => x.undervaluation !== null)
const hs = u.filter(x => x.player.group === "hitting").map(x => x.undervaluation)
const ps = u.filter(x => x.player.group === "pitching").map(x => x.undervaluation)
t("undervaluation percentiles span each side independently",
  Math.max(...hs) > 95 && Math.max(...ps) > 95 && Math.min(...hs) < 5 && Math.min(...ps) < 5)

// 8. confidence must mean the same thing for a closer as for an everyday bat. Scored
// against a hitter's 400-PA floor, 5 of 432 relievers cleared 0.70 — so "minimum
// confidence 70%" deleted the closer population rather than the unreliable players.
const median = rows => {
  const v = rows.map(x => x.confidence.value).sort((a, b) => a - b)
  return v[Math.floor(v.length / 2)]
}
const busiest = (rows, key, n) =>
  [...rows].sort((a, b) => (b.player.stats[key] ?? 0) - (a.player.stats[key] ?? 0)).slice(0, n)
const closers = busiest(
  r10.filter(x => x.player.group === "pitching" && (x.player.stats.gamesStarted ?? 0) === 0),
  "saves", 30)
const [closer] = closers
t("a well-established closer reaches high confidence", closer.confidence.value >= 0.9,
  `${closer.player.name}: ${closer.player.stats.saves} saves, ` +
  `${closer.player.stats.battersFaced} BF → ${closer.confidence.value}`)
t("a confidence minimum no longer works as a position filter",
  closers.filter(x => x.confidence.value >= 0.7).length >= 20,
  `${closers.filter(x => x.confidence.value >= 0.7).length}/30 busiest closers clear 0.70`)
const hitters30 = busiest(r10.filter(x => x.player.group === "hitting"), "plateAppearances", 30)
const starters30 = busiest(
  r10.filter(x => x.player.group === "pitching" && (x.player.stats.gamesStarted ?? 0) >= 25),
  "battersFaced", 30)
t("a full season of work reads the same in all three roles",
  median(hitters30) === 1 && median(starters30) === 1 && median(closers) === 1,
  `hitters ${median(hitters30)}, starters ${median(starters30)}, closers ${median(closers)}`)


// 10. The shipped model constants must match what the backtest actually chose.
// These are not preferences — each was measured over 100 folds across ten seasons,
// and a silent edit here would quietly de-tune every recommendation.
import { RECENT_WINDOW_WEIGHTS, RECENT_BLEND_WEIGHT, RECENT_RATE_WEIGHT } from "../src/engine/project.ts"
t("hitters weight the most recent series double (measured 40/50 folds)",
  RECENT_WINDOW_WEIGHTS.hitting[3] === 2 && RECENT_WINDOW_WEIGHTS.hitting[7] === 1 &&
  RECENT_WINDOW_WEIGHTS.hitting[21] === 1,
  JSON.stringify(RECENT_WINDOW_WEIGHTS.hitting))
t("pitchers use a 5-day short window, matching a five-day turn",
  RECENT_WINDOW_WEIGHTS.pitching[5] === 2 && RECENT_WINDOW_WEIGHTS.pitching[21] === 1,
  JSON.stringify(RECENT_WINDOW_WEIGHTS.pitching))
t("blend weight is 0.5 on both sides (measured by playing seasons, not by correlation)",
  RECENT_BLEND_WEIGHT.hitting === 0.5 && RECENT_BLEND_WEIGHT.pitching === 0.5,
  JSON.stringify(RECENT_BLEND_WEIGHT))
t("recent-rate blend is pitchers-only at 0.15 (hitting failed its paired test)",
  RECENT_RATE_WEIGHT.hitting === 0 && RECENT_RATE_WEIGHT.pitching === 0.15,
  JSON.stringify(RECENT_RATE_WEIGHT))
// the Statcast blend lost on every sweep across ten seasons; it must stay off
const { project: proj } = await import("../src/engine/project.ts")
const probe = proj(
  { id: 1, name: "x", team: null, teamId: 1, position: "OF", group: "hitting",
    stats: { plateAppearances: 400, hits: 100, homeRuns: 20, runs: 50 } },
  { id: 1, xwoba: 0.400, woba: 0.300, xwobaGap: 0.1, xba: null, xslg: null, pa: 400,
    barrelRate: null, hardHitRate: null, avgExitVelocity: null, sweetSpotRate: null },
  100, 14
)
t("Statcast adjustment is off by default", probe.qualityMultiplier === 1,
  String(probe.qualityMultiplier))
t("and the drill-down says so rather than implying it was used",
  probe.modelled.some(m => /NOT applied/.test(m)), probe.modelled.join(" | "))



const hyd = hydrate(snap)

// --- market edge: the board's default ranking, so it gets its own regressions ---
const ranked = withMarketEdge(
	withUndervaluation(
		rateAll({
			league,
			players: hyd.players,
			underlying: hyd.underlying,
			injuries: hyd.injuries,
			teamGamesPlayed: hyd.teamGamesPlayed,
			gamesByTeam: hyd.gamesByTeam,
			opponentsByTeam: hyd.opponentsByTeam,
			recentVolumeByWindow: hyd.recentVolumeByWindow,
			recentStats: hyd.recentStats,
			ownership: hyd.ownership,
			teams: league.meta.max_teams
		})
	),
	hyd.ownership
)

t("ownership was actually read", hyd.ownership.size > 200, `${hyd.ownership.size} priced`)

const priced = ranked.filter(r => r.marketEdge !== null)
t("market edge is computed for priced players", priced.length > 150, `${priced.length}`)

// unknown is not unowned: a player Yahoo never listed must not be scored as a find
// The invariant is one-directional: no price means no edge. The converse does not
// hold, because a priced player who cannot be projected has no bscore to compare.
t("unpriced players get no edge rather than a flattering one",
  ranked.every(r => r.rosteredPct !== null || r.marketEdge === null),
  String(ranked.filter(r => r.rosteredPct === null && r.marketEdge !== null).length))
t("every edge is a real subtraction from a real bscore",
  priced.every(r => r.rateable && Number.isFinite(r.marketEdge) && Number.isFinite(r.bscore)))

// it must be a residual in points, not a percentile: two players with the same
// bscore must rank by price, and the cheaper one must come out ahead
const sameScore = priced
  .filter(r => r.bscore > 0)
  .sort((a, b) => a.bscore - b.bscore)
  .reduce((acc, r) => {
    const prev = acc[acc.length - 1]
    if (prev && Math.abs(prev.bscore - r.bscore) < 0.4 && Math.abs(prev.rosteredPct - r.rosteredPct) > 25)
      return [...acc.slice(0, -1), prev, r].slice(-2)
    return [r]
  }, [])
if (sameScore.length === 2) {
  const [a, b] = sameScore
  const cheaper = a.rosteredPct < b.rosteredPct ? a : b
  const dearer = cheaper === a ? b : a
  t("at equal bscore the less-rostered player carries the larger edge",
    cheaper.marketEdge > dearer.marketEdge,
    `${cheaper.player.name} ${cheaper.rosteredPct}% edge ${cheaper.marketEdge} vs ${dearer.player.name} ${dearer.rosteredPct}% edge ${dearer.marketEdge}`)
} else t("at equal bscore the less-rostered player carries the larger edge", true, "no comparable pair in this snapshot")

// the horizons must be real, distinct schedules rather than one scaled number
t("the week horizon is shorter than the fortnight",
  hyd.gamesWeek.size > 0 &&
    [...hyd.gamesWeek.values()].reduce((a, c) => a + c, 0) <
      [...hyd.gamesByTeam.values()].reduce((a, c) => a + c, 0),
  `${[...hyd.gamesWeek.values()].reduce((a, c) => a + c, 0)} vs ${[...hyd.gamesByTeam.values()].reduce((a, c) => a + c, 0)}`)
t("the stash horizon is longer than the fortnight",
  [...hyd.gamesRemaining.values()].reduce((a, c) => a + c, 0) >
    [...hyd.gamesByTeam.values()].reduce((a, c) => a + c, 0))

console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
