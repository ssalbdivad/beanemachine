import { readFileSync } from "node:fs"
import { hydrate } from "../src/data/snapshot.ts"
import { rateAll, slotsFor } from "../src/engine/bscore.ts"
import { HITTING_MAP, PITCHING_MAP } from "../src/engine/points.ts"

const cfg = JSON.parse(readFileSync("scoring.json", "utf8"))
const snap = JSON.parse(readFileSync("data/snapshot.json", "utf8"))
const hy = hydrate(snap)

const unsourceableB = cfg.stat_keys.batting.filter(k => !(k in HITTING_MAP))
const unsourceableP = cfg.stat_keys.pitching.filter(k => !(k in PITCHING_MAP))
console.log("canonical batting keys with no getter:", unsourceableB)
console.log("canonical pitching keys with no getter:", unsourceableP)

const yl = cfg.leagues["yahoo:228947"]
const reachable = new Set(hy.players.flatMap(p => slotsFor(p)))
console.log("slots the engine can fill:", [...reachable].sort().join(","))
const active = Object.keys(yl.roster.slots).filter(s => !["BN","IL","NA","IL+"].includes(s))
console.log("yahoo active slots:", active.join(","), "unreachable:", active.filter(s => !reachable.has(s)))

const tally = {}
for (const s of yl.roster.slot_order) tally[s] = (tally[s] ?? 0) + 1
console.log("slot_order tally === slots:", JSON.stringify(tally) === JSON.stringify(yl.roster.slots), JSON.stringify(tally))

const r = rateAll({ league: yl, players: hy.players, underlying: hy.underlying,
  injuries: hy.injuries, teamGamesPlayed: hy.teamGamesPlayed, gamesByTeam: hy.gamesByTeam,
  opponentsByTeam: hy.opponentsByTeam, recentVolumeByWindow: hy.recentVolumeByWindow,
  recentStats: hy.recentStats, teams: yl.meta.max_teams })
console.log("all finite:", r.every(x => Number.isFinite(x.bscore) && Number.isFinite(x.points)))
console.log("sorted desc:", r.every((x, i) => i === 0 || r[i-1].bscore >= x.bscore))
console.log("distinct bscores:", new Set(r.map(x => x.bscore)).size)
console.log("slots actually used:", [...new Set(r.filter(x=>x.rateable).map(x => x.slot))].sort().join(","))
// which players land at a slot with replacement 0 (the silent fallback)
console.log("rows with replacement 0:", r.filter(x => x.replacement === 0).length)
// unscoreable across the real league
const uns = new Set(r.flatMap(x => x.projected.unscoreable))
console.log("unscoreable in the real league:", [...uns])
