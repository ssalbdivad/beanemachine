/**
 * MEASUREMENT ONLY — writes nothing into the repo.
 *
 * WHICH OF test/engine.mjs's WIRE ASSERTIONS SURVIVE THE PROPOSED DEPTH.
 *
 * The proposal is one expression in src/engine/bscore.ts: when the pool the bar is drawn
 * from IS the wire, walk `count` (this reader's own seats at the slot) instead of
 * `teams x count` (the whole league's). The fallback pools — a slot the sweep never read,
 * a slot that came back empty — are untouched and keep `teams x count`, because there the
 * pool is the whole of baseball and the league's depletion has NOT already been taken out.
 *
 * Every assertion below is re-evaluated here on the same capture, under today's rule and
 * under the proposal, so the cost of the change is a list rather than a guess. This file
 * reimplements rateAll's replacement loop; `bars.ts` in this directory proves that
 * reimplementation reproduces rateAll's own bars to the cent.
 */
import { readFileSync } from "node:fs"
import { rateAll, ownershipCut, slotsCoveredBy, isReserveSlot } from "../../engine/bscore.ts"
import { hydrate } from "../../data/snapshot.ts"
import { normalizeName } from "../../data/names.ts"
import type { League } from "../../schema.ts"

const league: League = JSON.parse(readFileSync("scoring.json", "utf8")).leagues["yahoo:228947"]
const snap = JSON.parse(readFileSync("data/snapshot.json", "utf8"))
const contact = JSON.parse(readFileSync("data/contact.json", "utf8"))
const hy = hydrate(snap, contact)
const teams = league.meta.max_teams!
const cut = ownershipCut(league, hy.ownership)!

const rated = rateAll({
	league, players: hy.players, underlying: hy.underlying, injuries: hy.injuries,
	teamGamesPlayed: hy.teamGamesPlayed, gamesByTeam: hy.gamesByTeam,
	opponentsByTeam: hy.opponentsByTeam, recentVolumeByWindow: hy.recentVolumeByWindow,
	recentStats: hy.recentStats, ownership: hy.ownership, eligibility: hy.eligibility,
	probableStarts: hy.probableStarts, probableCoverage: hy.probableCoverage,
	opposingStarters: hy.opposingStarters, startOpponents: hy.startOpponents, teams
})

const ALL9 = ["C", "1B", "2B", "3B", "SS", "OF", "Util", "SP", "RP"]
const READ = ["C", "1B", "2B", "3B"]
const wireNames = new Set<string>()
for (const p of hy.players) {
	const pct = hy.ownership.get(p.id)
	if (pct !== undefined && pct <= cut.cut) wireNames.add(normalizeName(p.name))
}
const wire = (r: any) => wireNames.has(normalizeName(r.player.name))
const estimate = (r: any) => {
	const pct = hy.ownership.get(r.player.id)
	return pct === undefined || pct <= cut.cut
}
const partialNames = new Set(
	rated.flatMap(r => (wire(r) && r.slots.some(s => READ.includes(s)) ? [normalizeName(r.player.name)] : []))
)
const partial = (r: any) => partialNames.has(normalizeName(r.player.name))

/** rateAll's replacement loop, with the depth as a parameter. */
const board = (
	available: ((r: any) => boolean) | undefined,
	positions: string[] | undefined,
	rule: "ships" | "own"
) => {
	const covered = available ? slotsCoveredBy(league, positions) : null
	const bars = new Map<string, number>()
	for (const [slot, count] of Object.entries(league.roster.slots)) {
		if (isReserveSlot(slot)) continue
		const all = rated.filter(r => r.rateable && r.slots.includes(slot)).sort((a, b) => b.points - a.points)
		const speaks = available !== undefined && (covered === null || covered.has(slot))
		const onWire = speaks ? all.filter(available) : []
		const eligible = onWire.length ? onWire : all
		if (!eligible.length) { bars.set(slot, 0); continue }
		// the proposal, and the ONLY line that differs: a wire has already had the other
		// rosters taken out of it, a whole-pool fallback has not
		const want = rule === "own" && onWire.length ? count : teams * count
		bars.set(slot, eligible[Math.min(want, Math.max(eligible.length - 1, 0))]?.points ?? 0)
	}
	const rows = rated
		.map(r => {
			let best = { slot: r.slots[0] ?? "Util", value: -Infinity, replacement: 0 }
			for (const s of r.slots) {
				const repl = bars.get(s)
				if (repl === undefined) continue
				if (r.points - repl > best.value) best = { slot: s, value: r.points - repl, replacement: repl }
			}
			return {
				name: r.player.name, group: r.player.group, rateable: r.rateable, points: r.points,
				slot: best.slot, replacement: Number(best.replacement.toFixed(2)),
				bscore: Number((best.value === -Infinity ? 0 : best.value).toFixed(2))
			}
		})
		.sort((a, b) => b.bscore - a.bscore)
	// engine.mjs reads each bar off the rows, not off the table
	const barsOf = new Map<string, number>()
	for (const r of rows) if (!barsOf.has(r.slot)) barsOf.set(r.slot, r.replacement)
	return { rows, bars: barsOf }
}

let pass = 0, fail = 0
const t = (rule: string, name: string, ok: boolean, detail = "") => {
	ok ? pass++ : fail++
	console.log(`  ${ok ? "holds " : "BREAKS"}  [${rule}] ${name}${detail ? `  — ${detail}` : ""}`)
}

for (const rule of ["ships", "own"] as const) {
	console.log(`\n${rule === "ships" ? "TODAY: teams x count down the wire" : "PROPOSED: count down the wire"}`)
	const none = board(undefined, undefined, rule)
	const est = board(estimate, undefined, rule)
	const real = board(wire, undefined, rule)
	const realDeclared = board(wire, ALL9, rule)
	const undeclared = board(partial, undefined, rule)
	const declared = board(partial, READ, rule)

	const slots = [...new Set([...est.bars.keys(), ...real.bars.keys()])]
	const moved = slots.filter(s => est.bars.get(s) !== real.bars.get(s))
	const worst = Math.max(...slots.map(s => Math.abs((est.bars.get(s) ?? 0) - (real.bars.get(s) ?? 0))))
	t(rule, "the ownership estimate and a real list set most replacement bars identically",
		moved.length <= slots.length / 2, `${moved.length} of ${slots.length} moved`)
	t(rule, "none of the bars that do move moves far (< 5)", worst < 5, `largest ${worst.toFixed(2)}`)
	const top = (rs: typeof est.rows) => rs.filter(r => r.rateable).slice(0, 20).map(r => r.name)
	const shared = top(est.rows).filter(n => top(real.rows).includes(n)).length
	t(rule, "the top of the board is the same 20 men either way", shared === 20, `${shared} of 20`)

	const same = real.rows.length === realDeclared.rows.length &&
		real.rows.every((r, i) => r.name === realDeclared.rows[i]!.name && r.bscore === realDeclared.rows[i]!.bscore &&
			r.replacement === realDeclared.rows[i]!.replacement && r.slot === realDeclared.rows[i]!.slot)
	t(rule, "declaring a complete read changes nothing", same)

	for (const s of ["C", "1B", "3B"])
		t(rule, `${s} was read, so it keeps the bar the wire sets`,
			declared.bars.get(s) === realDeclared.bars.get(s), `${declared.bars.get(s)} vs ${realDeclared.bars.get(s)}`)
	for (const s of ["SS", "OF", "Util", "P"])
		t(rule, `${s} was never read, so it falls back to the no-wire bar`,
			declared.bars.get(s) === none.bars.get(s), `${declared.bars.get(s)} vs ${none.bars.get(s)}`)
	for (const s of ["SS", "OF", "Util"])
		t(rule, `${s} came back with men on it, so only declaring coverage catches its bar`,
			undeclared.bars.get(s) !== declared.bars.get(s), `${undeclared.bars.get(s)} vs ${declared.bars.get(s)}`)
	t(rule, "P came back with nobody, so the empty-slot guard had already caught it",
		undeclared.bars.get("P") === declared.bars.get("P") && undeclared.bars.get("P") === none.bars.get("P"),
		`${undeclared.bars.get("P")} vs ${declared.bars.get("P")} vs ${none.bars.get("P")}`)
	const pitchers = undeclared.rows.filter(r => r.rateable && r.group === "pitching")
	t(rule, "no pitcher is priced against a bar of zero", pitchers.every(r => r.replacement > 0))
	t(rule, "and no pitcher's bscore is simply his whole projected total",
		pitchers.every(r => Math.abs(r.bscore - r.points) > 0.001))
}
console.log(`\n${pass} hold, ${fail} break`)
