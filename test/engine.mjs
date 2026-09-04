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

/**
 * A partial window is now SPLIT rather than refused.
 *
 * The old rule was all-or-nothing: unless MLB had named a starter for every game of
 * a club's window, the count was discarded entirely. Measured on this capture from
 * the snapshot's own horizon start, that gate opens for 26 of 30 clubs over three
 * days, 8 over five, and NONE over seven — so on a normal weekly scoring period the
 * starts basis never fired at all, and a pitcher confirmed for two starts was
 * projected off the same team-games average as everyone else. Two starts is roughly
 * double the innings and is the largest edge in streaming, so that was the wrong
 * side to fail on.
 *
 * The count is now `published(him) + unnamed(his club) × (his GS / his club's GP)`:
 * what MLB has said is used as the observation it is, and the games it has not yet
 * named are credited at his own rate of starting — which is exactly what the
 * team-games fallback was doing for the whole window anyway. The failure the old
 * gate existed to prevent (a man named for today carrying ONE start across a
 * fortnight, ~350 places of damage) cannot happen, because the unnamed tail is
 * credited rather than zeroed.
 */
const startersOf = rs => rs.filter(r => {
  const st = hyd.players.find(p => p.id === r.player.id)?.stats ?? {}
  return r.player.group === "pitching" && (st.gamesPitched ?? 0) > 0 &&
    (st.gamesStarted ?? 0) / st.gamesPitched >= 0.8
})
const rotation = startersOf(withStarts)
t("rotation starters are rated at all, so the rest is not vacuous", rotation.length > 20, `${rotation.length}`)
t("a partly published window still yields a starts count",
  rotation.some(r => r.scheduledStarts !== null && r.scheduledStarts > 0),
  `${complete}/${coverage.length} clubs complete`)
// the observation is a floor: he cannot be credited with fewer starts than MLB named
t("a published start is never discounted below what MLB published",
  rotation.every(r => {
    const pub = hyd.probableStarts.get(r.player.id) ?? 0
    return r.scheduledStarts === null || r.scheduledStarts >= pub - 1e-9
  }))
// and a fully covered club keeps meaning what it meant: unnamed means he does not pitch
t("on a fully covered club an unnamed starter still projects no starts",
  rotation.every(r => {
    const c = hyd.probableCoverage.get(r.player.teamId)
    if (!c || c.published < c.games) return true
    return (hyd.probableStarts.get(r.player.id) ?? 0) > 0 || r.scheduledStarts === 0
  }))
// nobody is credited with more turns than his club has games
t("no pitcher is given more starts than his club has games",
  rotation.every(r => r.scheduledStarts === null ||
    r.scheduledStarts <= (hyd.probableCoverage.get(r.player.teamId)?.games ?? 0) + 1e-9))

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

// --- probables: two ways the starts-based projection lied ---------------------
//
// Both are about the same question — are this pitcher's outs START outs — asked in
// two places, so they share one constant (`MODEL.probables.minStartShare`).
// A window short enough that MLB has actually published it. Probables thin out
// fast — measured on this capture, 29 clubs are fully covered one day out, 11 at
// four days, and ZERO at seven, which is why the engine asks about coverage per
// club rather than assuming a horizon is knowable. `weekWin` above is seven days
// and therefore covers nobody, so these assertions would be vacuous against it.
const coveredWin = windowFrom(hyd.slate, snap.horizon.start,
  new Date(Date.parse(snap.horizon.start) + 4 * 86400000).toISOString().slice(0, 10))
t("the short window really is covered for some clubs, or the rest is vacuous",
  [...coveredWin.coverage.values()].filter(c => c.games > 0 && c.published >= c.games).length > 5,
  `${[...coveredWin.coverage.values()].filter(c => c.games > 0 && c.published >= c.games).length} clubs`)
const covered = rateAll({
  ...base,
  gamesByTeam: coveredWin.games,
  opponentsByTeam: coveredWin.opponents,
  probableStarts: coveredWin.probableStarts,
  probableCoverage: coveredWin.coverage,
  opposingStarters: coveredWin.opposingStarters,
  injuryPolicy: "exclude"
})
const line = new Map(hyd.players.map(p2 => [p2.id, p2.stats]))
const share = r => {
  const st = line.get(r.player.id) ?? {}
  return st.gamesPitched ? (st.gamesStarted ?? 0) / st.gamesPitched : 0
}

/**
 * `s.outs` counts every out a pitcher recorded, relief included; `s.gamesStarted`
 * counts starts only. For a swingman that ratio is a numerator and denominator over
 * different populations, inflated by exactly the relief work it does not divide by.
 * Measured on this capture: a reliever with 63 appearances and one spot start
 * projected 192 outs — 64 innings — for one scheduled start and ranked FIRST on the
 * streaming board at five times second place, with the drill-down printing the
 * impossible number verbatim.
 */
const oneStart = covered.filter(r => r.player.group === "pitching" && r.scheduledStarts === 1)
t("some pitchers do have exactly one published start, so this is not vacuous",
  oneStart.length > 5, `${oneStart.length}`)
t("no single scheduled start projects more than a complete game",
  oneStart.every(r => (r.projection.projectedVolume ?? 0) <= 27),
  oneStart.filter(r => (r.projection.projectedVolume ?? 0) > 27)
    .map(r => `${r.player.name} ${r.projection.projectedVolume?.toFixed(0)} outs`).join(", "))
t("a pitcher who also relieves is not projected off outs-per-start at all",
  covered.filter(r => share(r) > 0 && share(r) < 0.8)
    .every(r => !r.projection.modelled.some(m => /^starts:/.test(m))))
t("and he is told why, rather than a number being invented for him",
  covered.filter(r => share(r) > 0 && share(r) < 0.8 && r.scheduledStarts !== null)
    .every(r => r.projection.missing.some(m => /he relieves too/.test(m))))

/**
 * Where MLB has published a starter for every game of a club's window, a starter who
 * is not among them provably does not pitch in it. That absence used to read as
 * "unknown" and fall back to outs-per-team-game, so a 28-start pitcher whose club had
 * named all of its starters — none of them him — was ranked on the streaming board.
 */
const absent = covered.filter(r => /published a starter for every game/.test(r.unrateable ?? ""))
t("a covered window with no start for him is treated as an observation",
  absent.length > 0, `${absent.length}`)
t("and none of them is ranked anyway", absent.every(r => !r.rateable))
t("every excluded man is a pitcher who is predominantly a starter",
  absent.every(r => r.player.group === "pitching" && share(r) >= 0.8),
  absent.filter(r => share(r) < 0.8).map(r => r.player.name).join(", "))
// relievers must keep the fallback: a covered window says nothing about when a
// reliever appears, so excluding them would be inventing an observation
t("relievers are not excluded by a covered window",
  covered.filter(r => r.player.group === "pitching" && share(r) > 0 && share(r) < 0.8)
    .every(r => !/published a starter for every game/.test(r.unrateable ?? "")))
t("injury still wins the reason, because it is the more informative one",
  covered.filter(r => r.injury && !r.rateable).every(r => /return date/.test(r.unrateable ?? "")))

/**
 * --- the shape of the bscore scale, and the floor that is printed instead ---
 *
 * A board row read -111 while the best player in baseball read +60, which looks
 * broken. Measured on this capture it is arithmetic: points are bounded below by
 * zero, the Util bar is 111.06, so a man projected for 0 points is exactly the whole
 * bar below replacement. 89.3% of rateable players are below it. These pin both
 * halves of the answer — the raw scale keeps its full negative range because
 * `src/auto/plan.ts` sorts on it to choose which of your own players to drop, and
 * `addValue` is the floored number a view prints against an ADD.
 */
const boardOpts = {
  ...base,
  eligibility: hyd.eligibility,
  probableStarts: hyd.probableStarts,
  probableCoverage: hyd.probableCoverage,
  opposingStarters: hyd.opposingStarters,
  injuryPolicy: "exclude"
}
const board = rateAll(boardOpts)
const boardLive = board.filter(r => r.rateable)
const boardNeg = boardLive.filter(r => r.bscore < 0)
const deepest = boardLive[boardLive.length - 1]

t("the deepest bscore is exactly minus the bar, because he projects for zero points",
  deepest.points === 0 && Math.abs(deepest.bscore + deepest.replacement) < 0.02,
  `${deepest.player.name}: ${deepest.points} − ${deepest.replacement} = ${deepest.bscore}`)
t("most of the pool sits below replacement, which is the metric working",
  boardNeg.length / boardLive.length > 0.8,
  `${boardNeg.length} of ${boardLive.length} rateable below 0`)

// A clamp inside the engine would tie the whole tail together and make the
// drop-the-worst-man choice in src/auto/plan.ts arbitrary. The raw scale stays
// strictly ordered on both sides of zero.
t("the sub-replacement tail is still strictly ordered, not clamped",
  new Set(boardNeg.map(r => r.bscore)).size > boardNeg.length * 0.9,
  `${new Set(boardNeg.map(r => r.bscore)).size} distinct values over ${boardNeg.length} negatives`)
t("rateAll still returns raw bscore order, negatives and all",
  board.every((r, i) => i === 0 || board[i - 1].bscore >= r.bscore) && deepest.bscore < -50,
  `last row ${deepest.bscore}`)

// addValue is the display floor, defined once in the engine so the board and the
// trade panel cannot invent two different ones.
t("addValue is never negative", board.every(r => r.addValue >= 0))
t("addValue is the bscore wherever adding him gains anything",
  board.every(r => r.bscore <= 0 || r.addValue === r.bscore))
t("addValue is zero for everyone at or below the bar",
  board.every(r => r.bscore > 0 || r.addValue === 0),
  `${board.filter(r => r.addValue === 0).length} rows floored`)
t("addValue never reorders anyone it does not tie",
  board.every((r, i) => i === 0 || board[i - 1].addValue >= r.addValue))
t("and something survives the floor, so the board is not a column of zeros",
  boardLive.filter(r => r.addValue > 0).length > 100,
  `${boardLive.filter(r => r.addValue > 0).length} of ${boardLive.length} rateable are worth adding`)

// The extreme end of the scale is a confidence artifact, not a value claim: below
// -80 the median confidence is 0.07, i.e. these are men with almost no sample.
const veryDeep = boardLive.filter(r => r.bscore < -80).map(r => r.confidence.value).sort((a, b) => a - b)
t("the deepest rows are men with no sample rather than rated players",
  veryDeep.length > 50 && veryDeep[Math.floor(veryDeep.length / 2)] < 0.15,
  `${veryDeep.length} below −80, median confidence ${veryDeep[Math.floor(veryDeep.length / 2)].toFixed(3)}`)
// ...while the negative region as a whole is populated by real, well-sampled
// players, which is why flooring the RAW number would destroy information.
const confident = boardLive.filter(r => r.confidence.value >= 0.7).map(r => r.bscore).sort((a, b) => a - b)
t("players with full confidence are negative too, so negative is not noise",
  confident.filter(x => x < 0).length > confident.length / 2,
  `${confident.filter(x => x < 0).length} of ${confident.length} at confidence ≥ 0.70 are below 0, worst ${confident[0]}`)


// ---------------------------------------------------------------------------
// 11. The start rate for the games MLB has not named yet.
//
// It was `gamesStarted ÷ his club's games played` — a numerator accrued only over
// the part of the season the pitcher was actually in a rotation, over a
// denominator counting the whole of it. Every starter who missed time read as a
// man who rarely starts, and the split-start formula then credited him with almost
// no turns. METHODOLOGY 3.5.0.
// ---------------------------------------------------------------------------
const { resolvePeriod } = await import("../src/engine/period.ts")
const { MODEL: M } = await import("../src/engine/weights.ts")
const seasonEnd = hyd.slate.reduce((a, g) => (g.date > a ? g.date : a), snap.horizon.end)
const per = resolvePeriod(league, snap.horizon.start, seasonEnd)
const wk = windowFrom(hyd.slate, per.start, per.end)
const weekBoard = rateAll({
  ...base, eligibility: hyd.eligibility, gamesByTeam: wk.games, opponentsByTeam: wk.opponents,
  probableStarts: wk.probableStarts, probableCoverage: wk.coverage,
  opposingStarters: wk.opposingStarters, startOpponents: wk.startOpponents,
  injuryPolicy: "exclude"
})
const mostlyStarter = r => {
  const gp = r.player.stats.gamesPitched ?? 0
  return r.player.group === "pitching" && gp > 0 &&
    (r.player.stats.gamesStarted ?? 0) / gp >= M.probables.minStartShare
}
const starters = weekBoard.filter(mostlyStarter)
t("the streaming window has partly-published clubs, or the rest of this is vacuous",
  [...wk.coverage.values()].some(c => c.published > 0 && c.published < c.games) && starters.length > 50,
  `${starters.length} mostly-starting pitchers, ` +
  `${[...wk.coverage.values()].filter(c => c.published > 0 && c.published < c.games).length} partly-published clubs`)

// The new rate GENERALISES the old one rather than replacing it: with no recent
// window the blend is the season rate, and (outs÷teamGP)÷(outs÷GS) = GS÷teamGP.
// Every such pitcher must still land on exactly the old number.
const noRecent = starters.filter(r => !hyd.recentVolumeByWindow[`${r.player.id}:pitching`])
const reproduced = noRecent.filter(r => {
  const cov = wk.coverage.get(r.player.teamId)
  const teamGP = hyd.teamGamesPlayed.get(r.player.teamId)
  if (!cov || !teamGP || cov.games === 0) return r.scheduledStarts === null
  const published = wk.probableStarts.get(r.player.id) ?? 0
  const unnamed = Math.max(cov.games - cov.published, 0)
  const old = Number((published + unnamed * Math.min((r.player.stats.gamesStarted ?? 0) / teamGP, 1)).toFixed(2))
  return r.scheduledStarts === old
})
t("a pitcher with no recent window still gets exactly the season-rate answer",
  noRecent.length > 20 && reproduced.length === noRecent.length,
  `${reproduced.length}/${noRecent.length} reproduce the old formula to the digit`)

// ...and where a recent window exists, the credited rate is a rotation's rate.
// Pure starters with nothing of their own published are the clean population:
// whatever the model believes about them comes entirely from this term.
const clean = starters.filter(r => {
  const gs = r.player.stats.gamesStarted ?? 0
  const cov = wk.coverage.get(r.player.teamId)
  return gs === (r.player.stats.gamesPitched ?? 0) && gs >= 4 && cov &&
    (wk.probableStarts.get(r.player.id) ?? 0) === 0 &&
    Math.max(cov.games - cov.published, 0) >= 2 &&
    !!hyd.recentVolumeByWindow[`${r.player.id}:pitching`]
})
const perGame = clean.map(r => {
  const cov = wk.coverage.get(r.player.teamId)
  return r.scheduledStarts / Math.max(cov.games - cov.published, 0)
}).sort((a, b) => a - b)
const med = perGame[Math.floor(perGame.length / 2)]
t("an unnamed game is credited at roughly a five-man rotation's rate",
  clean.length >= 20 && med > 0.16 && med < 0.26,
  `${clean.length} pure starters, median ${med.toFixed(3)} starts per unnamed game (a rotation is 0.20)`)
// the specific failure: the season-only rate put 9 of these 40 below 0.10 — a
// starter credited with one turn in ten or worse. Blake Snell read 0.037.
const oldPerGame = clean.map(r =>
  Math.min((r.player.stats.gamesStarted ?? 0) / hyd.teamGamesPlayed.get(r.player.teamId), 1))
t("and no longer at one turn in ten, which is what a missed month used to buy",
  oldPerGame.filter(x => x < 0.10).length > perGame.filter(x => x < 0.10).length,
  `${oldPerGame.filter(x => x < 0.10).length} were below 0.10 on the season-only rate, ` +
  `${perGame.filter(x => x < 0.10).length} are now`)

// ---------------------------------------------------------------------------
// 12. Every unrateable player owes a reason. `unrateable: null` means rateable —
// that is the field's stated contract, and three of the four ways to become
// unrateable did not honour it.
// ---------------------------------------------------------------------------
for (const [label, rows] of [["the streaming week", weekBoard], ["the fortnight", board]]) {
  const silent = rows.filter(r => !r.rateable && (r.unrateable === null || r.unrateable === undefined))
  t(`no unrateable player is refused without a reason (${label})`,
    silent.length === 0,
    `${silent.length} of ${rows.filter(r => !r.rateable).length}: ` +
    silent.slice(0, 3).map(r => r.player.name).join(", "))
  t(`and a rateable player carries no reason (${label})`,
    rows.filter(r => r.rateable).every(r => r.unrateable === null))
}

// ---------------------------------------------------------------------------
// 13. Speed. The fast rounding path must be the same function as the decimal
// round-trip it replaces, and the memoised scoring table must not collapse two
// different leagues into one. METHODOLOGY 13.
// ---------------------------------------------------------------------------
const { roundTo, scoreStats: score } = await import("../src/engine/points.ts")
const adversarial = [
  0, -0, 1, -1, 0.5, -0.5, 0.0005, -0.0005, 0.0015, -0.0015, 1.0005, 8.575, 1.005,
  0.1 + 0.2, 1 / 3, 2 / 3, 1e-9, -1e-9, 999999.9995, 0.4445, 0.4455, 123.4565,
  Number.MIN_VALUE, Number.EPSILON, 1e9, -1e9, 1e15, -1e15, Infinity, -Infinity, NaN
]
let mism = 0, firstBad = ""
const checkRound = x => {
  for (const d of [1, 2, 3]) {
    const a = Number(x.toFixed(d)), b = roundTo(x, d)
    if (!Object.is(a, b) && !(Number.isNaN(a) && Number.isNaN(b))) {
      mism++
      if (!firstBad) firstBad = `${x} @${d}: toFixed ${a} vs roundTo ${b}`
    }
  }
}
for (const x of adversarial) checkRound(x)
// and a wide random sweep across the magnitudes a projected line actually reaches,
// plus values deliberately parked on a rounding tie
for (let i = 0; i < 200000; i++) {
  checkRound((Math.random() - 0.4) * Math.pow(10, Math.floor(Math.random() * 8) - 3))
  checkRound((Math.floor(Math.random() * 200000) + 0.5) / 1000)
  checkRound(-(Math.floor(Math.random() * 200000) + 0.5) / 100)
}
t("the fast rounding path is the same function as Number(x.toFixed(d))",
  mism === 0, firstBad)

// the scoring table is memoised on the object; two different tables must not share
const tableA = { HR: 10, R: 2 }
const tableB = { HR: 1, R: 1 }
const scoredLine = { homeRuns: 3, runs: 4 }
t("the memoised scoring table is keyed per league, not shared",
  score(scoredLine, tableA, "hitting").points === 38 && score(scoredLine, tableB, "hitting").points === 7 &&
  score(scoredLine, tableA, "hitting").points === 38,
  `${score(scoredLine, tableA, "hitting").points} / ${score(scoredLine, tableB, "hitting").points}`)

// teamStrength now sums only the six fields wobaish reads. The indices are ratios
// to the league mean, so they must still centre on 1 across all 30 clubs.
const { teamStrength: ts } = await import("../src/engine/matchup.ts")
const strength = ts(hyd.players)
const mean = m => [...m.values()].reduce((a, c) => a + c, 0) / m.size
t("team strength indices still centre on the league, on both sides",
  strength.offense.size === 30 && strength.defense.size === 30 &&
  Math.abs(mean(strength.offense) - 1) < 1e-9 && Math.abs(mean(strength.defense) - 1) < 1e-9,
  `${strength.offense.size}/${strength.defense.size} clubs, means ` +
  `${mean(strength.offense).toFixed(6)} / ${mean(strength.defense).toFixed(6)}`)

// ---------------------------------------------------------------------------
// 14. model.json must not carry a knob that steers nothing.
// ---------------------------------------------------------------------------
const modelJson = JSON.parse(readFileSync("model.json", "utf8"))
t("the retracted volumeWeight knob is gone from model.json",
  !("volumeWeight" in modelJson.recentForm),
  Object.keys(modelJson.recentForm).join(","))
// and project's own default is now the shipped value, so the file and the code
// cannot disagree about what an unspecified weight means
const withDefault = proj(
  { id: 2, name: "y", team: null, teamId: 1, position: "OF", group: "hitting",
    stats: { plateAppearances: 400, hits: 100, homeRuns: 20, runs: 50 } },
  undefined, 100, 14, { recentVolumePerGame: 8 })
const withExplicit = proj(
  { id: 2, name: "y", team: null, teamId: 1, position: "OF", group: "hitting",
    stats: { plateAppearances: 400, hits: 100, homeRuns: 20, runs: 50 } },
  undefined, 100, 14, { recentVolumePerGame: 8, recentWeight: RECENT_BLEND_WEIGHT.hitting })
t("an unspecified recent weight means the shipped blend, not a retracted 0.75",
  withDefault.volumePerTeamGame === withExplicit.volumePerTeamGame &&
  withDefault.volumePerTeamGame === 6,
  `${withDefault.volumePerTeamGame} vs ${withExplicit.volumePerTeamGame}`)

// the drill-down must report the verdict METHODOLOGY 7.1 actually reached
t("the Statcast note states the finished verdict, not an open question",
  probe.modelled.some(m => /111 paired weeks/.test(m) && !/not yet settled/.test(m)),
  probe.modelled.find(m => /Statcast/.test(m)))

console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
