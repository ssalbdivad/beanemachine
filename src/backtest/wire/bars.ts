/**
 * MEASUREMENT ONLY — writes nothing into the repo.
 *
 * Three replacement-bar semantics on the committed capture, all three computed from ONE
 * rateAll pass so that `points` (the projection) is provably identical across them and
 * the only thing that varies is the bar:
 *
 *   NOWIRE  the (teams x seats)-th man walked down the WHOLE POOL — the simulation the
 *           app uses when it cannot see your league.
 *   A       given a wire, the same depth walked down the WIRE, clamped to its last man.
 *           This is what src/engine/bscore.ts ships today.
 *   B       given a wire, the wire's BEST man. The open question.
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
console.log(`ownership cut: usable=${cut.usable} cut=${cut.cut}% depth=${cut.depth} priced=${cut.priced} tied=${cut.tied}`)

/** The wire the bscore.ts docblock measured against: listed AND at or below the cut. */
const onWireId = (id: number) => {
	const pct = owned.get(id)
	return pct !== undefined && pct <= cut.cut
}
console.log(`wire (listed and <= cut): ${[...owned.values()].filter(v => v <= cut.cut).length} men priced there`)

const base = {
	league,
	players: h.players,
	underlying: h.underlying,
	injuries: h.injuries,
	teamGamesPlayed: h.teamGamesPlayed,
	gamesByTeam: h.gamesByTeam,
	opponentsByTeam: h.opponentsByTeam,
	recentVolumeByWindow: h.recentVolumeByWindow,
	recentStats: h.recentStats,
	ownership: h.ownership,
	eligibility: h.eligibility,
	probableStarts: h.probableStarts,
	probableCoverage: h.probableCoverage,
	opposingStarters: h.opposingStarters,
	startOpponents: h.startOpponents,
	injuryPolicy: "exclude" as const,
	teams: league.meta.max_teams!
}

// ONE pass. Its own bars are semantics A; the rows carry `points`, which no bar touches.
const rated = rateAll({ ...base, available: r => onWireId(r.player.id) })
const noWire = rateAll(base)
// proof that the projection is bar-independent: same men, same points, either call
const pointsSame = rated.every((r, i) => r.player.id === noWire[i]?.player.id ? true : true)
const byId = new Map(noWire.map(r => [`${r.player.id}:${r.player.group}`, r]))
let pointMismatch = 0
for (const r of rated) {
	const o = byId.get(`${r.player.id}:${r.player.group}`)
	if (!o || Math.abs(o.points - r.points) > 1e-9) pointMismatch++
}
console.log(`points identical with and without the wire: ${pointMismatch === 0 ? "yes" : `NO (${pointMismatch} differ)`}\n`)

const slots = Object.keys(league.roster.slots).filter(s => !isReserveSlot(s))

/** Rebuild each bar from the rated rows, exactly as rateAll's loop does. */
const barsFor = (mode: "nowire" | "A" | "B" | "own") => {
	const out = new Map<string, number>()
	for (const slot of slots) {
		const count = league.roster.slots[slot]!
		const all = rated.filter(r => r.rateable && r.slots.includes(slot)).sort((a, b) => b.points - a.points)
		const wire = all.filter(r => onWireId(r.player.id))
		const pool = mode === "nowire" ? all : wire.length ? wire : all
		if (!pool.length) { out.set(slot, 0); continue }
		if (mode === "B") { out.set(slot, pool[0]!.points); continue }
		// "own": the wire has already had the other nine rosters taken out of it, so the
		// only depletion left to walk is this reader's OWN seats at the slot
		const want = mode === "own" ? count : base.teams * count
		const depth = Math.min(want, Math.max(pool.length - 1, 0))
		out.set(slot, pool[depth]?.points ?? 0)
	}
	return out
}

const bars = { nowire: barsFor("nowire"), A: barsFor("A"), B: barsFor("B"), own: barsFor("own") }

/*
 * CROSS-CHECK AGAINST WHAT THE ENGINE ACTUALLY DID, and the variant it is checked against
 * changed on 2026-09-17.
 *
 * This harness was written while `src/engine/bscore.ts` walked `teams x count` down a wire —
 * variant A below. It measured that rule losing to `own` (walk the reader's own seats) in 19
 * of 20 configurations at a mean of +28.0 points a week, the engine was changed on that
 * evidence, and A is now the OLD rule rather than the shipped one.
 *
 * The check therefore runs against `own`, and A is kept because the evidence is only
 * reproducible while both rules are computable. A mismatch here means the engine has moved
 * again and this harness has not been told — which is exactly what it should say out loud,
 * rather than printing a NO that a later reader has to work out the meaning of.
 */
const SHIPPED: keyof typeof bars = "own"
let barMismatch = 0
for (const r of rated) {
	const mine = bars[SHIPPED].get(r.slot)
	if (mine === undefined) continue
	if (Math.abs(Number(mine.toFixed(2)) - r.replacement) > 0.011) barMismatch++
}
console.log(
	`rebuilt bars match rateAll's own (checked against "${SHIPPED}"): ` +
		(barMismatch === 0 ?
			"yes"
		:	`NO (${barMismatch} rows) — the engine's wire depth has changed again and this ` +
			`harness still assumes "${SHIPPED}"`)
)

console.log("\nREPLACEMENT BARS (projected points over the committed fortnight)")
console.log("  slot   depth   pool@slot  wire@slot     NOWIRE         A (ships)      B (best free)    OWN (count deep)")
for (const slot of slots) {
	const count = league.roster.slots[slot]!
	const all = rated.filter(r => r.rateable && r.slots.includes(slot))
	const wire = all.filter(r => onWireId(r.player.id))
	console.log(
		`  ${slot.padEnd(5)} ${String(base.teams * count).padStart(5)} ${String(all.length).padStart(10)} ` +
			`${String(wire.length).padStart(10)}  ${bars.nowire.get(slot)!.toFixed(2).padStart(10)} ` +
			`${bars.A.get(slot)!.toFixed(2).padStart(15)} ${bars.B.get(slot)!.toFixed(2).padStart(18)} ${bars.own.get(slot)!.toFixed(2).padStart(18)}`
	)
}

/**
 * WHERE THE NO-WIRE BAR LANDS ON THIS CAPTURE'S OWN WIRE.
 *
 * Same measurement as the season simulator's, on the other kind of wire this project can
 * produce: the ownership estimate. If the no-wire simulation is a stand-in for the top of
 * a wire, the count below is how deep into a real one it actually lands — and it is the
 * number the depth walk should be using, against the `teams x count` it uses today.
 */
console.log("\nWHERE THE NO-WIRE BAR LANDS ON THIS WIRE (men on the wire who out-project it)")
console.log("  slot   teams x count   count   measured")
for (const slot of slots) {
	const count = league.roster.slots[slot]!
	const above = rated.filter(
		r => r.rateable && r.slots.includes(slot) && onWireId(r.player.id) && r.points > bars.nowire.get(slot)!
	).length
	console.log(
		`  ${slot.padEnd(6)} ${String(base.teams * count).padStart(11)} ${String(count).padStart(7)} ${String(above).padStart(10)}`
	)
}

/** Re-derive slot and bscore under a bar table, the same max-over-slots rateAll does. */
const board = (b: Map<string, number>) =>
	rated
		.map(r => {
			let best = { slot: r.slots[0] ?? "Util", value: -Infinity, replacement: 0 }
			for (const slot of r.slots) {
				const repl = b.get(slot)
				if (repl === undefined) continue
				const value = r.points - repl
				if (value > best.value) best = { slot, value, replacement: repl }
			}
			return {
				id: r.player.id,
				name: r.player.name,
				group: r.player.group,
				rateable: r.rateable,
				points: r.points,
				slot: best.slot,
				bscore: Number((best.value === -Infinity ? 0 : best.value).toFixed(2)),
				wire: onWireId(r.player.id)
			}
		})
		.sort((a, b2) => b2.bscore - a.bscore)

const boards = { nowire: board(bars.nowire), A: board(bars.A), B: board(bars.B), own: board(bars.own) }

const spearman = (x: number[], y: number[]) => {
	const rank = (v: number[]) => {
		const idx = v.map((val, i) => [val, i] as const).sort((a, b) => a[0] - b[0])
		const r = new Array(v.length).fill(0)
		for (let i = 0; i < idx.length; ) {
			let j = i
			while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++
			const avg = (i + j) / 2 + 1
			for (let k = i; k <= j; k++) r[idx[k]![1]] = avg
			i = j + 1
		}
		return r
	}
	const rx = rank(x), ry = rank(y)
	const n = x.length
	const mx = rx.reduce((a, c) => a + c, 0) / n, my = ry.reduce((a, c) => a + c, 0) / n
	let num = 0, dx = 0, dy = 0
	for (let i = 0; i < n; i++) {
		num += (rx[i]! - mx) * (ry[i]! - my)
		dx += (rx[i]! - mx) ** 2
		dy += (ry[i]! - my) ** 2
	}
	return num / Math.sqrt(dx * dy)
}

const compare = (nameA: string, nameB: string) => {
	const a = boards[nameA as keyof typeof boards], b = boards[nameB as keyof typeof boards]
	const key = (r: { id: number; group: string }) => `${r.id}:${r.group}`
	const bmap = new Map(b.map(r => [key(r), r]))
	const rateable = a.filter(r => r.rateable)
	const xs = rateable.map(r => r.bscore)
	const ys = rateable.map(r => bmap.get(key(r))!.bscore)
	const slotMoves = rateable.filter(r => bmap.get(key(r))!.slot !== r.slot).length
	const aRank = new Map(a.filter(r => r.rateable).map((r, i) => [key(r), i]))
	const bRank = new Map(b.filter(r => r.rateable).map((r, i) => [key(r), i]))
	let firstDiff = -1
	const aList = a.filter(r => r.rateable), bList = b.filter(r => r.rateable)
	for (let i = 0; i < aList.length; i++)
		if (key(aList[i]!) !== key(bList[i]!)) { firstDiff = i; break }
	const top20 = new Set(aList.slice(0, 20).map(key))
	const overlap20 = bList.slice(0, 20).filter(r => top20.has(key(r))).length
	const wireA = aList.filter(r => r.wire), wireB = bList.filter(r => r.wire)
	const moved = rateable
		.map(r => ({ r, d: bmap.get(key(r))!.bscore - r.bscore }))
		.sort((x, y) => Math.abs(y.d) - Math.abs(x.d))
	console.log(
		`\n${nameA} vs ${nameB}: spearman(bscore) ${spearman(xs, ys).toFixed(6)}, ` +
			`slot changes ${slotMoves}/${rateable.length}, first ranking difference at row ` +
			`${firstDiff < 0 ? "none" : firstDiff + 1}, top-20 overlap ${overlap20}/20`
	)
	console.log(`  best gettable under ${nameA}: ${wireA.slice(0, 5).map(r => `${r.name} ${r.bscore}`).join(" | ")}`)
	console.log(`  best gettable under ${nameB}: ${wireB.slice(0, 5).map(r => `${r.name} ${r.bscore}`).join(" | ")}`)
	console.log(`  largest bscore moves: ${moved.slice(0, 5).map(m => `${m.r.name} ${m.r.bscore}→${(m.r.bscore + m.d).toFixed(2)}`).join(" | ")}`)
	// mean absolute rank movement among rateable men
	const ranks = rateable.map(r => Math.abs((bRank.get(key(r)) ?? 0) - (aRank.get(key(r)) ?? 0)))
	ranks.sort((p, q) => p - q)
	console.log(
		`  |rank move| mean ${(ranks.reduce((p, q) => p + q, 0) / ranks.length).toFixed(1)}, ` +
			`median ${ranks[Math.floor(ranks.length / 2)]}, max ${ranks[ranks.length - 1]}`
	)
	// the decision that matters: who is above his own bar (worth adding) either way
	const posA = new Set(aList.filter(r => r.wire && r.bscore > 0).map(key))
	const posB = new Set(bList.filter(r => r.wire && r.bscore > 0).map(key))
	console.log(
		`  gettable men with a POSITIVE bscore: ${nameA} ${posA.size}, ${nameB} ${posB.size}, ` +
			`in both ${[...posA].filter(k => posB.has(k)).length}`
	)
}

compare("nowire", "A")
compare("nowire", "B")
compare("A", "B")
compare("nowire", "own")
compare("A", "own")

/**
 * THE TIE AT THE TOP, which is B's structural problem rather than a measured one.
 *
 * Under B a man on the wire cannot score above zero at a slot he is eligible for: the bar
 * IS the best free man there, so his own bscore is points minus something at least as
 * large. Every slot's best free man therefore lands on exactly 0, and the question the
 * board exists to answer — WHICH of them to add — is decided by a tie-break rather than
 * by the number.
 */
for (const [name, b] of Object.entries(boards)) {
	const list = b.filter(r => r.rateable && r.wire)
	const top = list[0]?.bscore ?? 0
	const tied = list.filter(r => Math.abs(r.bscore - top) < 0.005).length
	console.log(
		`\n${name}: best gettable bscore ${top.toFixed(2)}, ${tied} men tied there; ` +
			`${list.filter(r => r.bscore > 0).length} of ${list.length} gettable men above their own bar`
	)
}

/**
 * WHAT A BAR SHIFT DOES TO THE TWO THRESHOLDS THE AUTONOMOUS RUN IS WRITTEN IN.
 *
 * src/auto/plan.ts ships `keepFloor: 25` ("never drop anyone at or above this bscore")
 * and `minGain: 5`. Both are bscore, and a semantics that moves every bar moves both of
 * them underneath the numbers they were chosen against. There is no roster in this repo
 * to apply them to, so the population here is every rateable man the capture prices as
 * TAKEN — the men somebody owns, which is who a keep floor is about.
 */
const ownedMen = (b: typeof boards.A) => b.filter(r => r.rateable && !r.wire)
for (const [name, b] of Object.entries(boards)) {
	const men = ownedMen(b)
	console.log(
		`  ${name.padEnd(6)} rostered men below keepFloor 25 (droppable): ` +
			`${men.filter(r => r.bscore < 25).length} of ${men.length}`
	)
}
