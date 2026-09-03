/**
 * The ownership feed, checked for the failure that made it useless.
 *
 * "% Ros" is the only thing in this project that claims to know what the FIELD
 * thinks, and market edge — for a long time the board's default ranking — is
 * bscore minus the median at the same ownership decile. So a wrong ownership
 * number does not degrade one column; it reorders the whole board.
 *
 * Yahoo nests a weather forecast inside each outdoor game's tooltip, and
 * `parsePage` reads "the first percentage left in the row block" after stripping
 * the three labelled forecast lines it knew about. It did not know about all of
 * them. The result was that a per-GAME number reached the field: on the capture
 * committed as data/snapshot.json, every Yankee and every Angel read 47%, every
 * Dodger and Cardinal 54%, every Oriole and Rockie 20%, and 225 players across
 * four games read 51% — those are the day's matchups, not roster shares.
 *
 * The invariant below is what makes that shape impossible to ship again, and it
 * needs no fixture and no network: real roster shares vary within a club. A star
 * and his team's fifth starter are not owned in the same fraction of leagues.
 * Whenever most of a club's players agree to the percent, the number being read
 * belongs to the game rather than to the player.
 */
import { readFileSync } from "node:fs"
import { leakedByTeam } from "../src/data/yahoo-pool.ts"

let pass = 0, fail = 0
const t = (n, ok, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : "  " + x}`) }

// --- the invariant itself, on constructed input ------------------------------

// A whole club on one number is the signature of the leak.
const leaked = leakedByTeam(
  Array.from({ length: 26 }, (_, i) => ({ team: "NYY", rosteredPct: 47, id: i }))
)
t("a club whose players all share one percentage is flagged", leaked.has("NYY"), [...leaked].join(","))
t("and the flagged value is the shared one", leaked.get("NYY") === 47, String(leaked.get("NYY")))

// Real shares vary, so a club with a spread is left alone.
const spread = leakedByTeam(
  Array.from({ length: 26 }, (_, i) => ({ team: "NYM", rosteredPct: i * 3, id: i }))
)
t("a club with genuinely varied shares is not flagged", !spread.has("NYM"), [...spread].join(","))

// Two players agreeing is a coincidence, not a leak — the check must not fire on
// a club Yahoo listed only a couple of players from.
const thin = leakedByTeam([
  { team: "ATH", rosteredPct: 51, id: 1 },
  { team: "ATH", rosteredPct: 51, id: 2 }
])
t("two players on one value is too thin to call a leak", !thin.has("ATH"), [...thin].join(","))

// The genuine reads inside a leaked club survive: the leak nulls a VALUE, not a club.
const mixed = leakedByTeam([
  ...Array.from({ length: 24 }, (_, i) => ({ team: "LAD", rosteredPct: 54, id: i })),
  { team: "LAD", rosteredPct: 99, id: 100 },
  { team: "LAD", rosteredPct: 96, id: 101 }
])
t("a leaked club still flags only the one shared value", mixed.get("LAD") === 54, String(mixed.get("LAD")))

// --- the committed capture, which is where this was found --------------------

const snap = JSON.parse(readFileSync(new URL("../data/snapshot.json", import.meta.url), "utf8"))
const team = new Map(snap.players.map(p => [String(p.id), p.teamId]))
const own = snap.ownership ?? {}
t("the committed snapshot has an ownership map at all", Object.keys(own).length > 0)

// Regrouped by club, exactly as the check does — asserted on real data so the
// number in the comment above can always be re-derived rather than believed.
const byTeam = new Map()
for (const [id, pct] of Object.entries(own)) {
  const tm = team.get(id)
  if (tm === undefined) continue
  if (!byTeam.has(tm)) byTeam.set(tm, [])
  byTeam.get(tm).push(pct)
}
const constant = [...byTeam.values()].filter(vals => {
  if (vals.length < 10) return false
  const counts = new Map()
  for (const v of vals) counts.set(v, (counts.get(v) ?? 0) + 1)
  return Math.max(...counts.values()) / vals.length > 0.5
})
// This capture is the diseased one. The assertion records that, so the day a
// clean capture is committed this line fails and has to be updated deliberately
// rather than the evidence quietly evaporating.
t("the committed capture is the known-bad one this check was written for",
  constant.length >= 15, `${constant.length} of ${byTeam.size} clubs sit on one value`)

console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
