/**
 * MEASUREMENT ONLY — writes nothing into the repo.
 *
 * WHAT EACH SEMANTICS DOES TO A THIN WIRE, which is not a hypothetical: Yahoo answers a
 * throttled sweep with a SHORT page rather than an error (bscore.ts records 150 players,
 * then 25, then 0), and a reader's own free-agent list is ordered by Yahoo's rank, so a
 * short read is the TOP of the wire and nothing else.
 *
 * The three bars degrade differently, and that is the practical half of the question:
 *   A (ships)  walks teams x count, and CLAMPS to the last man — so the thinner the read,
 *              the deeper the bar sits, which is backwards.
 *   B          the wire's best man — unmoved by truncation, because truncation only ever
 *              removes men below him.
 *   own        walks count, so it stops moving as soon as the read is one roster deep.
 */
import { readFileSync } from "node:fs"
import { rateAll, ownershipCut, isReserveSlot } from "../../engine/bscore.ts"
import { hydrate } from "../../data/snapshot.ts"
import type { League } from "../../schema.ts"

const league: League = JSON.parse(readFileSync("scoring.json", "utf8")).leagues["yahoo:228947"]
const snap = JSON.parse(readFileSync("data/snapshot.json", "utf8"))
const contact = JSON.parse(readFileSync("data/contact.json", "utf8"))
const h = hydrate(snap, contact)
const owned = new Map<number, number>(
	Object.entries(snap.ownership ?? {}).map(([k, v]) => [Number(k), Number(v)])
)
const cut = ownershipCut(league, owned)!
const onWireId = (id: number) => {
	const pct = owned.get(id)
	return pct !== undefined && pct <= cut.cut
}
const rated = rateAll({
	league, players: h.players, underlying: h.underlying, injuries: h.injuries,
	teamGamesPlayed: h.teamGamesPlayed, gamesByTeam: h.gamesByTeam,
	opponentsByTeam: h.opponentsByTeam, recentVolumeByWindow: h.recentVolumeByWindow,
	recentStats: h.recentStats, ownership: h.ownership, eligibility: h.eligibility,
	probableStarts: h.probableStarts, probableCoverage: h.probableCoverage,
	opposingStarters: h.opposingStarters, startOpponents: h.startOpponents,
	injuryPolicy: "exclude", teams: league.meta.max_teams!
})
const teams = league.meta.max_teams!
const slots = Object.keys(league.roster.slots).filter(s => !isReserveSlot(s))

const bar = (slot: string, mode: "A" | "B" | "own", keep: number) => {
	const count = league.roster.slots[slot]!
	const all = rated.filter(r => r.rateable && r.slots.includes(slot)).sort((a, b) => b.points - a.points)
	// a throttled read is the TOP of the list, because Yahoo orders by its own rank
	const wire = all.filter(r => onWireId(r.player.id)).slice(0, keep)
	const pool = wire.length ? wire : all
	const want = mode === "B" ? 0 : mode === "own" ? count : teams * count
	return pool[Math.min(want, Math.max(pool.length - 1, 0))]?.points ?? 0
}

console.log("Bars as the wire is truncated to its top K men at each slot (committed capture, fortnight)")
for (const mode of ["A", "own", "B"] as const) {
	console.log(`\n  ${mode === "A" ? "A — teams x count, clamped (ships)" : mode === "own" ? "own — count deep" : "B — the wire's best man"}`)
	console.log("    slot     K=3      K=5     K=10     K=25     K=50   full wire")
	for (const slot of slots)
		console.log(
			`    ${slot.padEnd(6)} ` +
				[3, 5, 10, 25, 50, 10_000]
					.map(k => bar(slot, mode, k).toFixed(2).padStart(8))
					.join(" ")
		)
}
