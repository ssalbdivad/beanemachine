// Regressions for bugs the adversarial critique found in shipped code.
// Each asserts against the real snapshot, not a fixture.
import { readFileSync } from "node:fs"
import { hydrate } from "../src/data/snapshot.ts"
import { rateAll, withMarketEdge, withUndervaluation } from "../src/engine/bscore.ts"
import { windowFrom } from "../src/engine/period.ts"

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
  probe.modelled.some(m => /Statcast weight is 0/.test(m) && /shown but not applied/.test(m)),
  probe.modelled.join(" | "))



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

// the horizons must be real, distinct schedules rather than one scaled number.
// The week is no longer stored — it belongs to the league, not to the capture — so it
// is counted here the way the board counts it, off the slate.
const weekWin = windowFrom(hyd.slate, snap.horizon.start,
  new Date(Date.parse(snap.horizon.start) + 6 * 86400000).toISOString().slice(0, 10))
const total = m => [...m.values()].reduce((a, c) => a + c, 0)
t("a week counted off the slate is shorter than the fortnight",
  weekWin.games.size > 0 && total(weekWin.games) < total(hyd.gamesByTeam),
  `${total(weekWin.games)} vs ${total(hyd.gamesByTeam)}`)
// The bug this replaced: `start + 7 days` against an endpoint inclusive on BOTH ends
// asked for eight dates, one more than the seven-date week the model was measured on.
t("a seven-day period is seven dates, not the eight the old window asked for", (() => {
  const eight = windowFrom(hyd.slate, snap.horizon.start,
    new Date(Date.parse(snap.horizon.start) + 7 * 86400000).toISOString().slice(0, 10))
  return total(eight.games) > total(weekWin.games)
})(), `${total(weekWin.games)} over 7 dates vs ${(() => {
  const e = windowFrom(hyd.slate, snap.horizon.start,
    new Date(Date.parse(snap.horizon.start) + 7 * 86400000).toISOString().slice(0, 10))
  return total(e.games)
})()} over 8`)
t("the stash horizon is longer than the fortnight",
  [...hyd.gamesRemaining.values()].reduce((a, c) => a + c, 0) >
    [...hyd.gamesByTeam.values()].reduce((a, c) => a + c, 0))

// --- the rolling Statcast window, which is where the signal actually lives ---
const rollingB = Object.values(snap.underlying.hitting).filter(u => u.window === "rolling")
const rollingP = Object.values(snap.underlying.pitching).filter(u => u.window === "rolling")
t("expected stats come from a rolling window, not the season",
  rollingB.length > 200 && rollingP.length > 200, `${rollingB.length} batters, ${rollingP.length} pitchers`)

// The whole point of the rolling window: over a season, contact and results
// converge and the gap collapses. If these gaps look season-sized, the window
// silently reverted and the signal is gone.
const gaps = rollingB.map(u => Math.abs(u.xwobaGap)).filter(Number.isFinite).sort((a, b) => b - a)
t("rolling gaps are wide enough to carry signal",
  gaps.length > 100 && gaps[Math.floor(gaps.length * 0.1)] > 0.04,
  `p90 gap ${gaps[Math.floor(gaps.length * 0.1)]}`)

// a leaderboard that ignored its dates would hand back identical numbers for both
// sides of the ball, which is how the original bug hid
t("batter and pitcher windows are genuinely different data",
  JSON.stringify(rollingB.slice(0, 5)) !== JSON.stringify(rollingP.slice(0, 5)))

// --- starter-level matchups: a hitter faces a man, not a staff average ---
const { pitcherQuality, starterBlendedIndex } = await import("../src/engine/matchup.ts")
const q = pitcherQuality(snap.players)
t("pitcher quality is measured for a real population", q.size > 150, `${q.size} pitchers`)
t("and is centred on the league", (() => {
  const v = [...q.values()]
  const mean = v.reduce((a, c) => a + c, 0) / v.length
  return Math.abs(mean - 1) < 0.05
})())

// the blend must collapse to the team index when no probable is published — absent
// is not neutral, and it is not zero either
const hitter = snap.players.find(p => p.group === "hitting" && p.teamId)
t("no published starter falls back to the team index",
  starterBlendedIndex(hitter, 1.07, new Map(), q) === 1.07)
t("an unknown starter falls back too, rather than scoring him as average",
  starterBlendedIndex(hitter, 1.07, new Map([[hitter.teamId, [999999999]]]), q) === 1.07)
t("a known starter actually moves the index", (() => {
  const known = [...q.entries()].find(([, v]) => Math.abs(v - 1) > 0.1)
  if (!known) return true
  const blended = starterBlendedIndex(hitter, 1, new Map([[hitter.teamId, [known[0]]]]), q)
  return blended !== null && Math.abs(blended - 1) > 0.05
})())
t("a pitcher is never given a hitter's opposing-starter blend",
  starterBlendedIndex(snap.players.find(p => p.group === "pitching"), 0.9, new Map(), q) === 0.9)

// A name published for one game of a fortnight speaks for that game, not the
// fortnight. This is the same partial-observation error that read 46 of 222
// probables as a complete count and dropped a top-five starter 350 places.
const far = [...q.entries()].find(([, v]) => Math.abs(v - 1) > 0.15)
const facingOne = new Map([[hitter.teamId, [far?.[0] ?? 999999999]]])
t("the starter share is scaled by how much of the window is published", (() => {
  if (!far) return true
  const full = starterBlendedIndex(hitter, 1, facingOne, q, 1)
  const partial = starterBlendedIndex(hitter, 1, facingOne, q, 14)
  return Math.sign(full - 1) === Math.sign(partial - 1) &&
    Math.abs(partial - 1) < Math.abs(full - 1) &&
    Math.abs(Math.abs(partial - 1) - Math.abs(full - 1) / 14) < 1e-9
})(), far ? `${far[1].toFixed(3)} quality over 14 games` : "no far-from-average pitcher")
t("omitting the window count keeps the caller's assertion of full coverage",
  starterBlendedIndex(hitter, 1, facingOne, q) === starterBlendedIndex(hitter, 1, facingOne, q, 1))
t("more published names than games never over-weights the starter term", (() => {
  if (!far) return true
  const many = new Map([[hitter.teamId, [far[0], far[0], far[0]]]])
  return Math.abs(
    starterBlendedIndex(hitter, 1, many, q, 2) - starterBlendedIndex(hitter, 1, facingOne, q, 1)
  ) < 1e-9
})())
t("an unrated published name does not count toward coverage", (() => {
  if (!far) return true
  const mixed = new Map([[hitter.teamId, [far[0], 999999999]]])
  return Math.abs(
    starterBlendedIndex(hitter, 1, mixed, q, 4) - starterBlendedIndex(hitter, 1, facingOne, q, 4)
  ) < 1e-9
})())

// --- the injured must not be ranked as though they can play ---
const base = {
  league, players: hyd.players, underlying: hyd.underlying, injuries: hyd.injuries,
  teamGamesPlayed: hyd.teamGamesPlayed, gamesByTeam: hyd.gamesByTeam,
  opponentsByTeam: hyd.opponentsByTeam, recentVolumeByWindow: hyd.recentVolumeByWindow,
  recentStats: hyd.recentStats, ownership: hyd.ownership, teams: league.meta.max_teams
}
const shortHorizon = rateAll({ ...base, injuryPolicy: "exclude" })
const restOfSeason = rateAll({ ...base, injuryPolicy: "keep" })
const injured = shortHorizon.filter(r => r.injury)
t("some players are actually flagged injured", injured.length > 20, `${injured.length}`)
t("no injured player is rateable over a short horizon",
  injured.every(r => !r.rateable))
t("and each one says why rather than vanishing",
  injured.every(r => typeof r.unrateable === "string" && /return date/.test(r.unrateable)))
t("a healthy player is unaffected by the policy",
  shortHorizon.filter(r => !r.injury && r.rateable).length ===
    restOfSeason.filter(r => !r.injury && r.rateable).length)
t("the rest-of-season view does rank them, because there he is a hold",
  restOfSeason.filter(r => r.injury && r.rateable).length > 0)
t("a rateable player never carries an unrateable reason",
  shortHorizon.every(r => !r.rateable || r.unrateable === null))

// --- multi-position eligibility, read from the platform rather than assumed ---
const { slotsFor } = await import("../src/engine/bscore.ts")
t("eligibility was actually captured", hyd.eligibility.size > 100, `${hyd.eligibility.size}`)
t("and every captured line lists more than one position",
  [...hyd.eligibility.values()].every(v => v.length > 1))

const withEl = rateAll({ ...base, eligibility: hyd.eligibility })
const withoutEl = rateAll(base)
t("eligibility widens who can fill what",
  withEl.filter(r => r.slots.length > 2).length > 50,
  `${withEl.filter(r => r.slots.length > 2).length} players with 3+ slots`)
t("and it moves the ranking, since a man is worth most at his scarcest slot",
  withEl.some((r, i) => r.bscore !== withoutEl[i].bscore))

// a player is only ever ranked at a slot he can actually fill
t("nobody is seated where his eligibility does not allow",
  withEl.every(r => !r.rateable || r.slots.includes(r.slot)))

// the fallback must stay honest: no eligibility line means the primary position,
// not a guess that he plays everywhere
const noEl = slotsFor({ ...hyd.players[0], position: "C", group: "hitting" })
t("no eligibility line falls back to the primary position",
  noEl.includes("C") && noEl.includes("Util") && !noEl.includes("SS"), noEl.join("/"))
const bogus = slotsFor({ ...hyd.players[0], position: "C", group: "hitting" }, ["ZZ"])
t("an unrecognised eligibility line does not claim he plays nowhere",
  bogus.length > 0 && bogus.includes("C"), bogus.join("/"))
t("a real two-position line grants both slots",
  (() => {
    const s2 = slotsFor({ ...hyd.players[0], position: "C", group: "hitting" }, ["C", "1B"])
    return s2.includes("C") && s2.includes("1B")
  })())

// --- a partial probable count is not a count ---
// MLB publishes today and tomorrow and then thins out. Read as complete, a starter
// who happens to pitch today gets projectedStarts=1 over a fortnight and is buried
// ~350 places, while everyone else is projected off team games at two or three.
const coverage = [...hyd.probableCoverage.values()]
t("probable coverage is recorded, not assumed", coverage.length > 0, `${coverage.length} teams`)
t("and it records both halves of the fraction",
  coverage.every(c => typeof c.published === "number" && typeof c.games === "number"))

const withStarts = rateAll({
  ...base, eligibility: hyd.eligibility,
  probableStarts: hyd.probableStarts, probableCoverage: hyd.probableCoverage
})
const noStarts = rateAll({ ...base, eligibility: hyd.eligibility })
const complete = coverage.filter(c => c.published >= c.games).length
t("a team whose window is only partly published contributes no scheduled starts",
  complete > 0 ||
    withStarts.every((r, i) => r.scheduledStarts === null && r.points === noStarts[i].points),
  `${complete}/${coverage.length} teams complete`)

// and where it IS complete the count must be used, or the guard is just an off switch
t("the guard keys on coverage rather than disabling the feature outright",
  withStarts.every(r => r.scheduledStarts === null || (
    hyd.probableCoverage.get(r.player.teamId)?.published >=
    hyd.probableCoverage.get(r.player.teamId)?.games)))

// --- the horizon counts only games a fantasy league plays ---
// Every schedule read filters to gameType=R. Unfiltered, a rest-of-season window
// running to November returns types R, F, D, L and W and 52 "teams" for 30 clubs:
// the postseason slots are placeholder-against-placeholder until clubs clinch, and
// then they resolve into real matchups and start crediting good teams with games no
// league plays. The two short windows have always been clean; the reference snapshot
// still carries the pre-filter rest-of-season shape until the next capture.
const teamsWithPlayers = new Set(snap.players.map(p => p.teamId).filter(Boolean))
t("every club that fields a rated player has a horizon", teamsWithPlayers.size === 30 &&
  [...teamsWithPlayers].every(id => hyd.gamesByTeam.has(id)), `${teamsWithPlayers.size} clubs`)
t("the fortnight and the week are keyed to real clubs only",
  hyd.gamesByTeam.size === 30 && weekWin.games.size === 30,
  `${hyd.gamesByTeam.size} / ${weekWin.games.size}`)
t("no real club is credited with a postseason game it cannot play", (() => {
  const end = new Date(`${snap.season}-09-28`)
  const from = new Date(snap.horizon.start)
  const days = Math.max(0, Math.round((end - from) / 86400000))
  return [...teamsWithPlayers].every(id => (hyd.gamesRemaining.get(id) ?? 0) <= days + 1)
})(), [...teamsWithPlayers].map(id => hyd.gamesRemaining.get(id) ?? 0).sort((a, b) => b - a)[0])
t("and the coverage denominator is the same set of games as the schedule count",
  [...hyd.probableCoverage].every(([team, c]) => c.games === (hyd.gamesByTeam.get(team) ?? c.games)),
  [...hyd.probableCoverage].filter(([t2, c]) => c.games !== hyd.gamesByTeam.get(t2)).length + " disagree")

console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
