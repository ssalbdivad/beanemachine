import type { League } from "../schema.ts"
import { slotsFor, type Rated } from "./bscore.ts"

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

/** A bench spot creates no demand for a position, so it starts nobody. Same
 *  exclusion bscore.ts makes when it sets replacement depth. */
const UNSTARTABLE = new Set(["BN", "IL", "NA"])

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
 * MOST: the highest bar in the league (Util in the reference league, drawing on
 * every batter in baseball) is therefore nobody's best slot and never appears
 * there at all. `test/trade.mjs` pins the two computations against each other so
 * they cannot drift apart silently.
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
	/** `replacement` means a freely available body covers the spot; `empty` means
	 *  nothing does, and the spot really is worth nothing. */
	source: "roster" | "replacement" | "empty"
}

export interface Lineup {
	starters: Start[]
	/** Projected points of the starting lineup over the horizon. */
	points: number
	/** Rostered players who could not crack it. */
	bench: Rated[]
	/** Startable spots nothing could fill and no replacement bar covers. */
	holes: string[]
	/** Roster rows with no projection. They cannot be started, and saying so is the
	 *  point — ranking them at zero next to real players would be a quiet lie. */
	unprojectable: Rated[]
}

/**
 * Fills the league's startable spots from a roster, scarcest slot first.
 *
 * Scarcest-first is what stops a catcher being spent on a Util spot and leaving C
 * empty — the same greedy order `src/backtest/season.ts` fills a weekly roster
 * with. It is "optimally enough" rather than optimal: it is not a maximum-weight
 * matching, and a contrived eligibility graph can beat it. Scarcity is the failure
 * mode that actually occurs in a fantasy roster, and it is the one this handles.
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
	const startable = roster
		.filter(r => r.rateable)
		.sort(
			(a, b) =>
				b.points - a.points ||
				a.player.id - b.player.id ||
				a.player.group.localeCompare(b.player.group)
		)

	const spots = activeSlots(league)
	const eligibleFor = (slot: string) => startable.filter(r => r.slots.includes(slot)).length
	const order = spots
		.map((slot, index) => ({ slot, index }))
		.sort((a, b) => eligibleFor(a.slot) - eligibleFor(b.slot))

	const taken = new Set<string>()
	const filled: (Rated | null)[] = spots.map(() => null)
	for (const { slot, index } of order) {
		const pick = startable.find(r => !taken.has(keyOf(r)) && r.slots.includes(slot))
		if (!pick) continue
		taken.add(keyOf(pick))
		filled[index] = pick
	}

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

	return {
		starters,
		points: Number(starters.reduce((sum, s) => sum + s.points, 0).toFixed(2)),
		bench: startable.filter(r => !taken.has(keyOf(r))),
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
		explanation: explain(proposal, lineups, delta),
		missing
	}
}

/** Names the mechanism, not the verdict: which slot the deal actually moved, and
 *  what filled the space. A manager can disagree with a sentence; he cannot
 *  disagree with "+38.2". */
const explain = (
	proposal: TradeProposal,
	lineups: { before: Lineup; after: Lineup },
	delta: number
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

	// a 2-for-1 leaves the roster a body short; the spot it opens is covered at the
	// league's own replacement level, because nobody appears to fill it
	const coveredBefore = lineups.before.starters.filter(s => s.source === "replacement").length
	const covered = lineups.after.starters.filter(s => s.source === "replacement")
	const short = proposal.out.length - proposal.in.length
	if (covered.length > coveredBefore) {
		const opened = covered[covered.length - 1]!
		parts.push(
			`The spot that opens is filled by a freely available ${opened.slot} ` +
				`(${opened.points} pts), not by anyone you own.`
		)
	} else if (short > 0)
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
