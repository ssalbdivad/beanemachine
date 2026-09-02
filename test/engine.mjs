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
t("blend weight is 0.75 hitting / 0.6 pitching (measured)",
  RECENT_BLEND_WEIGHT.hitting === 0.75 && RECENT_BLEND_WEIGHT.pitching === 0.6,
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

console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
