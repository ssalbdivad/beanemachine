import type { League } from "../schema.ts"
import { RESERVE_SLOTS, slotsFor, type Rated } from "./bscore.ts"

/**
 * What a trade is actually worth.
 *
 * A trade is not "who has the higher bscore". It is how much MY STARTING LINEUP
 * changes, given the roster slots I actually have to fill. Giving up a good
 * outfielder when I already start five of them is nearly free; giving up my only
 * catcher is not. So every number here comes from filling the league's real slots
 * twice — once with the roster I hold, once with the roster the deal leaves me —
 * and subtracting.
 *
 * Nothing here is inferred. A spot nothing can fill is reported as a hole rather
 * than quietly credited to a body that isn't there, a roster row with no
 * projection is named rather than counted as zero, and the body a 2-for-1 leaves
 * missing is covered at the league's own replacement level rather than by magic.
 */

/** Rated rows are keyed per side, because a two-way player is two rows and only
 *  the caller knows whether the league lets him hold both spots. */
const keyOf = (r: Rated) => `${r.player.id}:${r.player.group}`

/** The same list bscore.ts sets replacement depth by, imported rather than
 *  restated: two copies of it had already drifted apart over Yahoo's "IL+". */
const UNSTARTABLE = RESERVE_SLOTS

/**
 * One entry per startable spot: three OF slots produce three entries, because the
 * question "what do I start" is asked of spots, not of slot names.
 *
 * `slots` carries the counts and `slot_order` only the ordering — a slot_order
 * parsed off a raw roster string can disagree with the validated counts, and the
 * counts are the number the league actually stated.
 */
export const activeSlots = (league: League): string[] => {
	const counts = league.roster.slots
	const names = [...new Set([...(league.roster.slot_order ?? []), ...Object.keys(counts)])]
	return names.flatMap(slot =>
		UNSTARTABLE.has(slot) || !(slot in counts)
			? []
			: Array.from({ length: counts[slot] ?? 0 }, () => slot)
	)
}

/**
 * The replacement bar at every startable slot: the (teams × slots)-th best
 * projected player eligible there — literally the best man still on waivers once
 * every team in the league has filled that slot.
 *
 * Same rule and same arithmetic as `rateAll`, which computes these bars to make a
 * bscore but does not hand them back. They cannot be read off `Rated.replacement`
 * either, because that field reports the bar at the slot where a player was worth
 * MOST, so a slot that is nobody's best is absent from it altogether. SP is that
 * slot in the reference league: its bar (64.97) sits above P's (57.59), so every
 * starting pitcher is worth more at P and no `Rated.slot` ever reads "SP".
 * `test/trade.mjs` pins the two computations against each other and names that
 * gap, so neither the bars nor the gap can drift silently.
 *
 * `teams` is required and never defaulted, for the reason bscore.ts gives: a
 * guessed team count moves every bar and therefore every number on this page.
 */
export const replacementBySlot = (
	league: League,
	pool: Rated[],
	teams: number
): Map<string, number> => {
	const bars = new Map<string, number>()
	for (const [slot, count] of Object.entries(league.roster.slots)) {
		if (UNSTARTABLE.has(slot)) continue
		const eligible = pool
			.filter(r => r.rateable && r.slots.includes(slot))
			.sort((a, b) => b.points - a.points)
		// no eligible player means the bar is unknown, not zero — the slot is left
		// out of the map and any spot it leaves empty is reported as a hole
		if (!eligible.length) continue
		const depth = Math.min(teams * count, eligible.length - 1)
		bars.set(slot, Number((eligible[depth]?.points ?? 0).toFixed(2)))
	}
	return bars
}

export interface Start {
	slot: string
	/** Null when no rostered player filled the spot. */
	player: Rated | null
	points: number
	/** `replacement` means a freely available body covers the spot — either nobody
	 *  you own is eligible there, or nobody you own is worth more than that body.
	 *  `empty` means not even a bar is known for the slot, so it really is worth
	 *  nothing. */
	source: "roster" | "replacement" | "empty"
}

export interface Lineup {
	starters: Start[]
	/** Projected points of the starting lineup over the horizon. */
	points: number
	/** Rostered players not in the lineup: beaten to every spot they are eligible
	 *  for, or worth less than the replacement bar at all of them. Since the
	 *  matching prices a spot rather than a player, both are the same answer to the
	 *  same question — he is not worth a seat — and neither is a demotion. */
	bench: Rated[]
	/** The benched men who are not merely behind somebody — at every slot they are
	 *  eligible for, they project below what that slot's replacement bar is worth, so
	 *  the lineup would rather leave the seat to a waiver body. Empty when no bars
	 *  were supplied, since without a bar there is nothing to be below. A subset of
	 *  `bench`, kept separate because the two are different news about a player. */
	belowBar: Rated[]
	/** Startable spots left at nothing: no replacement bar is known for the slot and
	 *  nobody on the roster is worth seating there. Usually that means nobody is
	 *  eligible at all; it can also mean the only eligible men project below zero,
	 *  which an empty seat beats. */
	holes: string[]
	/** Roster rows with no projection. They cannot be started, and saying so is the
	 *  point — ranking them at zero next to real players would be a quiet lie. */
	unprojectable: Rated[]
}

/**
 * Maximum-gain augmenting path, or null when no path gains anything.
 *
 * Nodes are players and spots; a path alternates unseated player → spot, spot →
 * the player it currently seats, and ends at a spot nobody holds. Starting from an
 * empty lineup and always augmenting along the best path keeps the invariant that
 * the current lineup is the best of its size, and that invariant is exactly what
 * rules out positive cycles — so a Bellman-Ford relaxation over |V| rounds finds
 * the longest path rather than looping on one.
 *
 * Relaxation is strict (`>`), and both loops run in the caller's fixed order, so a
 * tie between two equally-good seatings always resolves the same way. That is what
 * keeps the lineup a function of the roster and not of the order it arrived in.
 */
const bestAugmentation = (
	gain: Float64Array,
	spots: number,
	seatedAt: Int32Array,
	holder: Int32Array
): [number, number][] | null => {
	const P = seatedAt.length
	// best[p] is the gain of the best path reaching player p with him still to seat
	const best = new Float64Array(P).fill(-Infinity)
	const from = new Int32Array(P).fill(-1)
	// the spot each player leaves on his best path, so the walk back can be replayed
	const via = new Int32Array(P).fill(-1)
	for (let p = 0; p < P; p++) if (seatedAt[p]! < 0) best[p] = 0
	let endPlayer = -1, endSpot = -1, endGain = 0
	for (let round = 0; round <= P; round++) {
		let moved = false
		for (let p = 0; p < P; p++) {
			if (best[p]! === -Infinity) continue
			for (let s = 0; s < spots; s++) {
				const w = gain[p * spots + s]!
				if (Number.isNaN(w) || s === seatedAt[p]) continue
				const total = best[p]! + w
				const held = holder[s]!
				if (held < 0) {
					// a free spot ends the path
					if (total > endGain) {
						endGain = total
						endPlayer = p
						endSpot = s
					}
					continue
				}
				// continuing costs whatever the man already there was earning
				const displaced = total - gain[held * spots + s]!
				if (displaced > best[held]!) {
					best[held] = displaced
					from[held] = p
					via[held] = s
					moved = true
				}
			}
		}
		if (!moved) break
	}
	if (endPlayer < 0) return null
	const path: [number, number][] = []
	for (let p = endPlayer, s = endSpot; p >= 0; s = via[p]!, p = from[p]!) path.push([p, s])
	return path
}

/**
 * Which player sits in each spot, or -1 where the spot is better left to a
 * replacement body. `bar[i]` is what spot `i` is worth unfilled, so the gain of
 * seating a man there is his points less that bar, and an ineligible pairing is
 * NaN rather than a large negative — an edge that does not exist.
 */
const seat = (startable: Rated[], bar: number[], spots: string[]): Int32Array => {
	const S = spots.length
	const gain = new Float64Array(startable.length * S)
	startable.forEach((r, p) =>
		spots.forEach((slot, i) => {
			gain[p * S + i] = r.slots.includes(slot) ? r.points - (bar[i] ?? 0) : NaN
		})
	)
	const seatedAt = new Int32Array(startable.length).fill(-1)
	const holder = new Int32Array(S).fill(-1)
	for (;;) {
		const path = bestAugmentation(gain, S, seatedAt, holder)
		if (!path) break
		for (const [p, s] of path) {
			seatedAt[p] = s
			holder[s] = p
		}
	}
	return holder
}

/**
 * Seats a roster in the league's startable spots, optimally.
 *
 * This used to fill greedily, scarcest slot first, and carried a proof that greed
 * could not be beaten: every player had one kind slot (C, OF, SP…) plus one
 * catch-all (Util, P) whose eligible set was a superset of it, so the graph was
 * two-level and the exchange argument closed. Reading real multi-position
 * eligibility off the platform made that proof false — 1B/2B/3B/SS lines are
 * ordinary — and the smallest counterexample costs 97 points on three spots:
 *
 * ```
 * A{2B,3B,Util}=100   B{2B,Util}=99   C{3B,Util}=1   D{Util}=98
 * greedy:  2B=A 3B=C Util=B = 200      optimal: 2B=B 3B=A Util=D = 297
 * ```
 *
 * The objective is not the weight of the players seated. An empty spot is not
 * worth zero, it is worth that slot's replacement bar — the body any manager can
 * claim off waivers — so seating a man is only worth `points − bar` at that spot,
 * and a man below the bar is worth benching. Since the gain depends on the spot,
 * this is a weighted bipartite matching. It is NOT a matroid, which is why an
 * earlier augmenting-path version was optimal for the wrong objective and measured
 * worse than the greed it replaced; and the optimum can need a rotation through an
 * equal-value plateau, which is why hill-climbing could not reach it either. Both
 * attempts are recorded in METHODOLOGY §12.
 *
 * So: subtract each spot's bar, match by successive maximum-gain augmenting paths,
 * and stop when the best remaining path gains nothing. Leaving a spot unmatched is
 * always available and worth exactly 0 after the subtraction, so the same run
 * decides who sits as well as who plays. Both sides are tiny — tens of players
 * across tens of spots — so the cost of exactness is nothing worth measuring.
 *
 * `replacement` is required rather than optional so the caller states which
 * question is being asked: pass the bars to model a manager who would cover an
 * empty spot off waivers, pass null to see the roster on its own.
 */
export const startingLineup = (
	league: League,
	roster: Rated[],
	replacement: Map<string, number> | null
): Lineup => {
	const unprojectable = roster.filter(r => !r.rateable)
	// deterministic: the same roster must produce the same lineup whatever order it
	// arrives in, or trading a player for himself would not come out at zero
	// One row per man. The greedy fill this replaced keyed its `taken` set on
	// `keyOf`, so a roster that carried the same player twice could only seat him
	// once; the matching indexes players by position in this array, so a duplicate
	// row would be a second node in the graph and the same man would start in two
	// spots, inflating the lineup and every trade delta read off it.
	const seen = new Set<string>()
	const startable = roster
		.filter(r => r.rateable && !seen.has(keyOf(r)) && (seen.add(keyOf(r)), true))
		.sort(
			(a, b) =>
				b.points - a.points ||
				a.player.id - b.player.id ||
				a.player.group.localeCompare(b.player.group)
		)

	const spots = activeSlots(league)
	const holder = seat(
		startable,
		spots.map(slot => replacement?.get(slot) ?? 0),
		spots
	)
	const filled = spots.map((_, i) => startable[holder[i]!] ?? null)
	const taken = new Set(filled.filter(r => r !== null).map(keyOf))

	const holes: string[] = []
	const starters: Start[] = spots.map((slot, index) => {
		const player = filled[index]
		if (player) return { slot, player, points: player.points, source: "roster" }
		const bar = replacement?.get(slot)
		if (bar === undefined) {
			holes.push(slot)
			return { slot, player: null, points: 0, source: "empty" }
		}
		return { slot, player: null, points: bar, source: "replacement" }
	})

	const bench = startable.filter(r => !taken.has(keyOf(r)))
	return {
		starters,
		points: Number(starters.reduce((sum, s) => sum + s.points, 0).toFixed(2)),
		bench,
		// "he lost his seat to someone better" and "he is worth less than the wire"
		// are different news, and the second is the one that suggests a move
		belowBar: replacement
			? bench.filter(r => {
					const bars = r.slots.flatMap(slot => {
						const bar = replacement.get(slot)
						return bar === undefined ? [] : [bar]
					})
					return bars.length > 0 && bars.every(bar => r.points < bar)
				})
			: [],
		holes,
		unprojectable
	}
}

export interface TradeProposal {
	league: League
	/** My roster, rated against the same pool as everything else here. */
	roster: Rated[]
	/** Players leaving. Each must be on the roster; one that isn't is reported. */
	out: Rated[]
	/** Players arriving. */
	in: Rated[]
	/** The whole rated pool — what the replacement bars are read off. */
	pool: Rated[]
	teams: number
}

export interface SlotChange {
	slot: string
	/** Names, or null where the spot was empty. A replacement body is named as one. */
	before: string | null
	after: string | null
	/** Points the spot gains (or loses) because of the change. */
	points: number
}

export interface TradeVerdict {
	/** Starting-lineup points before the trade. */
	before: number
	after: number
	/** after − before. The whole answer. */
	delta: number
	lineups: { before: Lineup; after: Lineup }
	/** Every spot whose occupant changed. */
	changes: SlotChange[]
	explanation: string
	/** Anything the evaluation could not read from its inputs. Never worked around
	 *  silently. */
	missing: string[]
}

const POSITION_WORDS: Record<string, string> = {
	C: "catcher",
	"1B": "first baseman",
	"2B": "second baseman",
	"3B": "third baseman",
	SS: "shortstop",
	OF: "outfielder",
	Util: "bat",
	SP: "starting pitcher",
	RP: "reliever",
	P: "pitcher"
}

const ORDINALS = [
	"", "", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth"
]

const startersOf = (lineup: Lineup) =>
	lineup.starters.flatMap(s => (s.player ? [s.player] : []))

/** "a second catcher (Drake Baldwin)" — the mechanism in the words a manager uses.
 *  The ordinal counts how many players of his own kind the lineup already starts,
 *  which is exactly the scarcity the trade turns on. */
const phraseFor = (player: Rated, among: Rated[]) => {
	const kind = player.slots[0] ?? "Util"
	const peers = among
		.filter(r => (r.slots[0] ?? "Util") === kind)
		.sort((a, b) => b.points - a.points)
	const rank = peers.findIndex(r => keyOf(r) === keyOf(player)) + 1
	const ordinal = rank <= 1 ? "" : `${ORDINALS[rank] ?? `${rank}th`} `
	return `a ${ordinal}${POSITION_WORDS[kind] ?? kind} (${player.player.name})`
}

const nameOf = (s: Start) =>
	s.player ? s.player.player.name : s.source === "replacement" ? `replacement ${s.slot}` : null

/**
 * Evaluates a proposed trade by the only measure that decides one: what my
 * starting lineup projects for before and after.
 *
 * Bench depth enters exactly as far as it changes what can be started. A deal that
 * costs me my fourth outfielder while three still start costs me nothing here, and
 * that is not an oversight — it is the answer.
 */
export const evaluateTrade = (proposal: TradeProposal): TradeVerdict => {
	const { league, roster, pool, teams } = proposal
	const incoming = proposal.in
	const missing: string[] = []

	const held = new Map(roster.map(r => [keyOf(r), r]))
	const leaving = new Set<string>()
	for (const r of proposal.out) {
		if (!held.has(keyOf(r))) {
			missing.push(`${r.player.name} is not on this roster, so giving him up changes nothing`)
			continue
		}
		leaving.add(keyOf(r))
	}
	for (const r of incoming)
		if (held.has(keyOf(r)) && !leaving.has(keyOf(r)))
			missing.push(`${r.player.name} is already on this roster`)

	const after = [...roster.filter(r => !leaving.has(keyOf(r))), ...incoming]
	const bars = replacementBySlot(league, pool, teams)
	const lineups = {
		before: startingLineup(league, roster, bars),
		after: startingLineup(league, after, bars)
	}
	for (const r of [...lineups.before.unprojectable, ...lineups.after.unprojectable])
		missing.push(`${r.player.name} has no projection, so he can start nowhere`)
	for (const slot of new Set([...lineups.before.holes, ...lineups.after.holes]))
		missing.push(`no replacement level for ${slot}: nobody in the pool is eligible there`)

	const delta = Number((lineups.after.points - lineups.before.points).toFixed(2))
	const changes: SlotChange[] = []
	lineups.before.starters.forEach((was, i) => {
		const now = lineups.after.starters[i]!
		if (nameOf(was) === nameOf(now)) return
		changes.push({
			slot: was.slot,
			before: nameOf(was),
			after: nameOf(now),
			points: Number((now.points - was.points).toFixed(2))
		})
	})

	return {
		before: lineups.before.points,
		after: lineups.after.points,
		delta,
		lineups,
		changes,
		explanation: explain(proposal, lineups, delta, leaving.size),
		missing
	}
}

/** Names the mechanism, not the verdict: which slot the deal actually moved, and
 *  what filled the space. A manager can disagree with a sentence; he cannot
 *  disagree with "+38.2". */
const explain = (
	proposal: TradeProposal,
	lineups: { before: Lineup; after: Lineup },
	delta: number,
	/** Players who really left. Naming someone in `out` who was never on the roster
	 *  must not make the deal look a body short. */
	departing: number
): string => {
	const wasStarting = startersOf(lineups.before)
	const isStarting = startersOf(lineups.after)
	const beforeKeys = new Set(wasStarting.map(keyOf))
	const afterKeys = new Set(isStarting.map(keyOf))
	const entered = isStarting
		.filter(r => !beforeKeys.has(keyOf(r)))
		.sort((a, b) => b.points - a.points)
	const left = wasStarting
		.filter(r => !afterKeys.has(keyOf(r)))
		.sort((a, b) => b.points - a.points)

	const parts: string[] = []
	const kindOf = (r: Rated) => r.slots[0] ?? "Util"
	if (entered.length && left.length) {
		// The ordinal phrasing is the point when the kinds differ — "a second catcher
		// instead of a fourth outfielder" IS the mechanism. When they match it says
		// nothing, so the spot itself is named instead.
		const slot =
			lineups.after.starters.find(s => s.player && keyOf(s.player) === keyOf(entered[0]!))?.slot
		parts.push(
			kindOf(entered[0]!) === kindOf(left[0]!)
				? `You start ${entered[0]!.player.name} at ${slot} in place of ${left[0]!.player.name}.`
				: `You start ${phraseFor(entered[0]!, isStarting)} instead of ` +
					`${phraseFor(left[0]!, wasStarting)}.`
		)
	} else if (entered.length)
		parts.push(
			`You start ${phraseFor(entered[0]!, isStarting)} in a spot your roster ` +
				`could not fill before.`
		)
	else if (left.length) parts.push(`You stop starting ${phraseFor(left[0]!, wasStarting)}.`)
	else parts.push("Your starting lineup does not change at all.")

	const alsoOut = left.slice(1).map(r => r.player.name)
	const alsoIn = entered.slice(1).map(r => r.player.name)
	if (alsoOut.length)
		parts.push(`${alsoOut.join(" and ")} also stop${alsoOut.length > 1 ? "" : "s"} starting.`)
	if (alsoIn.length)
		parts.push(`${alsoIn.join(" and ")} also start${alsoIn.length > 1 ? "" : "s"}.`)

	// a 2-for-1 leaves the roster a body short; the spots it opens are covered at the
	// league's own replacement level, because nobody appears to fill them. Which spots
	// those are is read off the two lineups position by position — a spot that was
	// already on the wire before the deal did not open, and naming it would blame this
	// trade for a hole it did not make.
	const opened = lineups.after.starters.filter(
		(s, i) => s.source === "replacement" && lineups.before.starters[i]!.source !== "replacement"
	)
	const priced = opened.map(s => `${s.slot} (${s.points} pts)`).join(" and ")
	const short = departing - proposal.in.length
	if (opened.length)
		parts.push(
			opened.length > 1
				? `The spots that open are priced off the wire — ${priced} — because nobody you ` +
					`still own is worth seating there.`
				: `The spot that opens is priced at a freely available ${priced}, because nobody ` +
					`you still own is worth seating there.`
		)
	else if (short > 0)
		parts.push(
			`You end up ${short} ${short > 1 ? "bodies" : "body"} short, but your bench ` +
				`covers every startable spot, so the shortfall costs you nothing.`
		)

	parts.push(
		`Net ${delta >= 0 ? "+" : ""}${delta} projected points over the horizon ` +
			`(${lineups.before.points} → ${lineups.after.points}).`
	)
	return parts.join(" ")
}

/** Re-exported so a caller reasoning about slots uses the one definition of them.
 *  StatsAPI reports one primary position and no source we read exposes a league's
 *  real multi-position eligibility, so the limitation is shared too. */
export { slotsFor }
