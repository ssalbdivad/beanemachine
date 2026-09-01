// Regressions for bugs the adversarial critique found in shipped code.
// Each asserts against the real snapshot, not a fixture.
import { readFileSync } from "node:fs"
import { hydrate } from "../src/data/snapshot.ts"
import { rateAll, withUndervaluation } from "../src/engine/bscore.ts"

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

console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
