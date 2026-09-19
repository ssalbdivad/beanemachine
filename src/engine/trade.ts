import type { League } from "../schema.ts"
import { jointReplacement, RESERVE_SLOTS, slotsFor, startableSeats, type Rated } from "./bscore.ts"

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
 * The arithmetic moved to `startableSeats` in bscore.ts, where the reserve vocabulary
 * already lives, because src/auto/plan.ts had a second copy of it that answered
 * differently — see that function's note for what the disagreement cost on screen.
 * This stays as the League-shaped way to ask.
 */
export const activeSlots = (league: League): string[] => startableSeats(league.roster)

/**
 * The replacement bar at every startable slot: the (teams × slots)-th best
 * projected player eligible there — literally the best man still on waivers once
 * every team in the league has filled that slot.
 *
 * Same rule and same arithmetic as `rateAll`, which computes these bars to make a
 * bscore but does not hand them back. They cannot be read off `Rated.replacement`
 * either, because that field reports the bar at the slot where a player was worth
 * MOST, so a slot that is nobody's best is absent from it altogether. SP is that
 * slot in the reference league: its bar sits above P's, so every starting pitcher is
 * worth more at P and no `Rated.slot` ever reads "SP". The two figures used to be
 * printed here — "64.97" and "57.59" — and neither reproduces on the committed
 * capture, which gives 73.56 and 64.16. They share no value, so the capture moved
 * under the comment rather than the arithmetic drifting. The ORDERING is the claim,
 * it still holds, and `test/trade.mjs` asserts it against the numbers the engine
 * computes on the day rather than against a copy typed into prose.
 *
 * `teams` is required and never defaulted, for the reason bscore.ts gives: a
 * guessed team count moves every bar and therefore every number on this page.
 */
/**
 * The men actually on the wire at each startable slot, best first.
 *
 * `gettable` is the league's own answer to "could I have him tomorrow" — the
 * free-agent list read off the platform. Given it, replacement level stops being a
 * simulation and becomes a read: the depth arithmetic below exists only to GUESS
 * who is left once every team has filled its seats, and a real free-agent list is
 * that answer already, without the guess.
 *
 * Ranked rather than reduced to one man because a slot with two seats filled off
 * the wire takes two different people. The old code named one man and printed him
 * in both seats, which is a roster no league would accept.
 */
export const wireBySlot = (
	league: League,
	pool: Rated[],
	gettable: (r: { player: { name: string } }) => boolean
): Map<string, Rated[]> => {
	const out = new Map<string, Rated[]>()
	for (const slot of Object.keys(league.roster.slots)) {
		if (UNSTARTABLE.has(slot)) continue
		out.set(
			slot,
			pool
				.filter(r => r.rateable && r.slots.includes(slot) && gettable(r))
				.sort((a, b) => b.points - a.points || a.player.id - b.player.id)
		)
	}
	return out
}

/**
 * What a spot is worth if you do not fill it yourself.
 *
 * Two regimes, and the difference between them is the whole point of this change.
 *
 * WITH a `gettable` predicate — your league's own free-agent list — the bar is the
 * best man on that wire at the slot. That is the definition the board has always
 * printed above itself — and that sentence was wrong in its own right, since the bar
 * for a BOARD is the (teams x seats)-th gettable man rather than the first. What is
 * right for a LINEUP card is the first: the question there is whether your own man
 * beats the thing you would have instead, and the thing you would have instead is
 * the best one on the wire. Both are now what they say they are. This is
 * what a reader means when he asks what his own player is worth: the thing he
 * would have instead.
 *
 * WITHOUT one, the bar falls back to the (teams x seats)-th best player in the
 * whole rated pool. That is a SIMULATION of the wire, for a page that cannot read
 * it — beanemachine.com cannot see a Yahoo league. It is a defensible estimate and
 * a bad answer when the real list is sitting right there: on the shipped league it
 * put Freddie Freeman and Bobby Witt Jr, both 99% rostered, forward as men you
 * could pick up, and priced every one of your own players against them.
 *
 * A slot with nothing free at it is priced at zero rather than dropped. Dropping it
 * would report a structural hole ("nobody in the pool is eligible here"), and that
 * is a different and much rarer fact than "the wire is bare at catcher today".
 *
 * `teams` is required and never defaulted, for the reason bscore.ts gives: a
 * guessed team count moves every bar and therefore every number on this page.
 */
export const replacementBySlot = (
	league: League,
	pool: Rated[],
	teams: number,
	gettable?: (r: { player: { name: string } }) => boolean
): Map<string, number> => {
	const bars = new Map<string, number>()
	if (gettable) {
		for (const [slot, men] of wireBySlot(league, pool, gettable))
			bars.set(slot, Number((men[0]?.points ?? 0).toFixed(2)))
		return bars
	}
	/*
	   THE THIRD COPY OF THE RULE, AND IT NOW CALLS THE FIRST.
	
	   This walked each slot's own eligible list down to `teams x count` and read off the
	   next name — the same arithmetic `rateAll` used, written out a second time, so the
	   two could and did drift the moment one of them was corrected. It has the same
	   defect the corrected one measured: a man who qualifies at three positions is
	   counted as taken at all three, so every bar but catcher's comes out 10 to 24 points
	   too high, and this screen priced every player in a trade against them.
	
	   `jointReplacement` is that rule with the men seated once between the slots instead
	   of once per slot each. Same inputs, same depth, one assignment — and one
	   implementation, so a correction to it cannot leave this page behind again.
	*/
	const rateable = pool.filter(r => r.rateable)
	const startable = Object.fromEntries(
		Object.entries(league.roster.slots).filter(([slot]) => !UNSTARTABLE.has(slot))
	)
	for (const [slot, bar] of jointReplacement(rateable, startable, (_sl, count) => teams * count)) {
		// no eligible player means the bar is unknown, not zero — the slot is left
		// out of the map and any spot it leaves empty is reported as a hole
		if (!rateable.some(r => r.slots.includes(slot))) continue
		bars.set(slot, Number(bar.toFixed(2)))
	}
	return bars
}

/**
 * WHO each slot's bar is, not just what it costs.
 *
 * `replacementBySlot` returns the number, which is all the arithmetic needs. The
 * lineup card needs the man: telling a reader that a freely available body beats
 * the player he owns raises exactly one question, "which one", and the card could
 * not answer it. Separate from `replacementBySlot` rather than folded into it
 * because six call sites and four suites depend on that signature and only one
 * of them wants a name.
 *
 * Returns a LIST per slot, best first, because a slot with two seats covered off
 * the wire takes two different men — naming one and printing him in both seats is
 * a lineup no league would accept, and the card did exactly that.
 *
 * Who these men ARE depends on `gettable`, exactly as in `replacementBySlot`. With
 * it they are the free agents your league actually lists, and a caller may say so.
 * Without it they are the (teams x seats)-th best eligible players in the whole
 * rated pool — an estimate of who would be left, NOT verified to be free, and a
 * caller must not describe them as free agents.
 */
export const replacementPlayerBySlot = (
	league: League,
	pool: Rated[],
	teams: number,
	gettable?: (r: { player: { name: string } }) => boolean
): Map<string, Rated[]> => {
	if (gettable) return wireBySlot(league, pool, gettable)
	const out = new Map<string, Rated[]>()
	for (const [slot, count] of Object.entries(league.roster.slots)) {
		if (UNSTARTABLE.has(slot)) continue
		const eligible = pool
			.filter(r => r.rateable && r.slots.includes(slot))
			.sort((a, b) => b.points - a.points)
		if (!eligible.length) continue
		// the estimate names one man per slot; the seats below him are unpriced,
		// which is why this regime cannot fill a second seat with a second body
		const depth = Math.min(teams * count, eligible.length - 1)
		const man = eligible[depth]
		if (man) out.set(slot, [man])
	}
	return out
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
	/**
	 * THE MAN THIS PARTICULAR SEAT IS PRICED AT, where one is known.
	 *
	 * Every empty seat at a slot used to be priced at the SAME body — the best free man there
	 * — because the bar was one number per slot. A league with three uncovered pitching seats
	 * therefore counted one free agent three times, in the lineup total and in every trade
	 * delta read off it, and a man can only be added once.
	 *
	 * The card had the ranked list and paired it with that single number by seat index, so it
	 * printed the second man's NAME beside the best man's POINTS. The name and the number come
	 * off the same row now: `points` is this man's points, and this man is who the seat is
	 * priced at.
	 *
	 * Null where the caller gave no ranked list — the estimate regime, which knows one body per
	 * slot and says so — and absent where the seat is filled by the reader's own player.
	 */
	free?: Rated | null
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
	/**
	 * Slots whose seats outran the league's own free-agent list.
	 *
	 * A different fact from a hole, and it was being reported as one. A hole is "nobody in the
	 * pool is eligible at this slot at all", which is structural and rare; this is "your
	 * league's list has two men who can play here and you have three seats", which is an
	 * ordinary Tuesday and which the card was describing as "nobody at all can play there"
	 * directly under two rows naming free men at that slot.
	 */
	short: string[]
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
	replacement: Map<string, number> | null,
	/**
	 * The free men at each slot, best first — `replacementPlayerBySlot`'s own answer.
	 *
	 * With it, the k-th uncovered seat at a slot is priced at the k-th man and named after
	 * him, and a slot whose list runs out before its seats do is a HOLE: the wire really has
	 * nobody else there, and pricing that seat at the last man again would be counting one
	 * body twice. Without it, every uncovered seat is priced at the slot's single bar, which
	 * is what this did for every caller and is the honest answer in the estimate regime, where
	 * only one body per slot is known at all.
	 */
	ranked?: Map<string, Rated[]> | null
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
	/*
	   WHAT EACH SEAT COSTS TO LEAVE EMPTY, seat by seat rather than slot by slot.
	
	   The matching decides which of the reader's men to start by weighing each against what
	   the seat would be worth without him. Handed one number per SLOT — the best free man at
	   it — every seat of a three-seat slot was charged that same best man's price, so a man
	   worth more than the third-best free agent and less than the first was benched, marked
	   "under the wire", and priced at nothing in a trade that gave him away.
	
	   With the ranked list, the k-th seat of a slot is weighed against the k-th man, which is
	   what the lineup below is priced at and what the card prints. Without one, the flat bar
	   is the only thing known and this is exactly what it was.
	*/
	const seatsSoFar = new Map<string, number>()
	const barPerSeat = spots.map(slot => {
		const k = seatsSoFar.get(slot) ?? 0
		seatsSoFar.set(slot, k + 1)
		const list = ranked?.get(slot)
		if (!list) return replacement?.get(slot) ?? 0
		return list[k]?.points ?? 0
	})
	const holder = seat(startable, barPerSeat, spots)
	const filled = spots.map((_, i) => startable[holder[i]!] ?? null)
	const taken = new Set(filled.filter(r => r !== null).map(keyOf))

	const holes: string[] = []
	const short: string[] = []
	/**
	 * THE FREE MEN ALREADY SEATED, ACROSS EVERY SLOT — not a cursor per slot.
	 *
	 * The first version of this counted seats at each slot and took the nth man from that
	 * slot's list, which fixed the double count WITHIN a slot and left the one across slots
	 * untouched: `wireBySlot` builds each slot's list independently, so a man eligible at OF
	 * and Util is in both, and on this app's own shipped league every batter is in two lists
	 * (Util accepts them all) and every pitcher is in two (P accepts SP and RP).
	 *
	 * Measured on the dev server before this: `OF 100.7 Pete Crow-Armstrong` and `Util 100.7
	 * Pete Crow-Armstrong`, `SP 69.5 Chris Sale` and `P 69.5 Chris Sale` — the same name
	 * printed in two rows, which is the exact sentence the earlier fix was written against, and
	 * 237 points of a 1,344-point lineup that were three men counted twice.
	 *
	 * One set of men, then, spent once each in the order the seats are filled.
	 */
	const seatedFree = new Set<string>()
	const starters: Start[] = spots.map((slot, index) => {
		const player = filled[index]
		if (player) return { slot, player, points: player.points, source: "roster" }
		const list = ranked?.get(slot)
		if (list) {
			const man = list.find(r => !seatedFree.has(keyOf(r)))
			if (man) seatedFree.add(keyOf(man))
			if (man)
				return {
					slot,
					player: null,
					points: Number(man.points.toFixed(2)),
					source: "replacement",
					free: man
				}
			/* The list ran out before the seats did — a real and sayable fact, and NOT the one
			   `holes` carries. An absent bar means nobody in the pool is eligible at this slot at
			   all; this means his league's list is shorter than his seats. Reported apart, because
			   the card says a different sentence about each and said the wrong one about this. */
			short.push(slot)
			return { slot, player: null, points: 0, source: "empty", free: null }
		}
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
		short,
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
	/**
	 * Who the reader can actually get, if the league's wire has been read.
	 *
	 * Must be the SAME test the lineup card used, or the verdict's "before" is a
	 * different lineup from the one on screen — it read 1507.87 against a card
	 * showing 1594.78, which is the page disagreeing with itself about a team
	 * nothing had changed yet.
	 */
	gettable?: (r: { player: { name: string } }) => boolean
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
 * WHETHER TWO SEATS HOLD THE SAME THING, decided by identity rather than by spelling.
 *
 * `nameOf` is for PRINTING, and two different major leaguers share a name often enough that
 * this project has a note about it: two men called Will Smith, two called Max Muncy. A seat
 * that changed hands between two of them compared equal, so the change was skipped — and the
 * screen read "No spot in your starting lineup changes hands" beside a delta of -32.07, which
 * is the arithmetic contradicting the sentence printed next to it.
 *
 * A rostered man is his `keyOf` — id and side of the ball. A seat covered off the wire is the
 * man covering it where one is known, and the slot where none is, so two seats priced at two
 * different free agents no longer read as unchanged either.
 */
const heldBy = (s: Start): string =>
	s.player ? `own:${keyOf(s.player)}`
	: s.source === "replacement" ? `free:${s.free ? keyOf(s.free) : s.slot}`
	: `none:${s.slot}`

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
	const bars = replacementBySlot(league, pool, teams, proposal.gettable)
	/* THE RANKED LIST, so a slot with two uncovered seats is priced at two different men. With
	   one number per slot the same free agent was counted once per seat — in the lineup total
	   and therefore in every delta this function returns — and a man can only be added once.
	   Only meaningful when a wire was read: the estimate regime knows one body per slot. */
	const ranked = proposal.gettable ? replacementPlayerBySlot(league, pool, teams, proposal.gettable) : null
	const lineups = {
		before: startingLineup(league, roster, bars, ranked),
		after: startingLineup(league, after, bars, ranked)
	}
	for (const r of [...lineups.before.unprojectable, ...lineups.after.unprojectable])
		missing.push(`${r.player.name} has no projection, so he can start nowhere`)
	for (const slot of new Set([...lineups.before.holes, ...lineups.after.holes]))
		missing.push(`no replacement level for ${slot}: nobody in the pool is eligible there`)

	const delta = Number((lineups.after.points - lineups.before.points).toFixed(2))
	const changes: SlotChange[] = []
	lineups.before.starters.forEach((was, i) => {
		const now = lineups.after.starters[i]!
		if (heldBy(was) === heldBy(now)) return
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
	/*
	   "OFF THE WIRE" AND "FREELY AVAILABLE" ARE CLAIMS, and this made them whether or not a
	   wire had been read.
	
	   With no free-agent list, the bar is the (teams x seats)-th best player in the whole of
	   baseball — a SIMULATION of who would be left, which `replacementBySlot`'s own note is
	   careful to call an estimate and which the lineup card beside this hedges player by
	   player. On the shipped league the Util bar is a man rostered in 99% of leagues, and this
	   sentence called him "a freely available Util". The card four inches above said, about
	   the same seat, "priced at what a free Util would be worth, with nobody named for the
	   seat" — two sentences about one number, and only one of them was true.
	*/
	if (opened.length)
		parts.push(
			proposal.gettable ?
				opened.length > 1 ?
					`The spots that open are priced off your league's own free-agent list — ` +
					`${priced} — because nobody you still own is worth seating there.`
				:	`The spot that opens is priced at a free ${priced} off your league's own list, ` +
					`because nobody you still own is worth seating there.`
			: opened.length > 1 ?
				`The spots that open — ${priced} — are priced at what a replacement would be ` +
				`worth, estimated rather than read off your league's list, because nobody you ` +
				`still own is worth seating there.`
			:	`The spot that opens is priced at what a replacement ${priced} would be worth, ` +
				`estimated rather than read off your league's list, because nobody you still ` +
				`own is worth seating there.`
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
