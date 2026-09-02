import type { League } from "../schema.ts"
import type { Rated } from "./bscore.ts"
import { activeSlots, replacementBySlot, startingLineup, type Lineup } from "./trade.ts"

/**
 * What to take next.
 *
 * Best available is not the top bscore. A bscore is measured against the whole
 * pool and against nobody's roster in particular, and both halves of that are
 * wrong on draft day: half the pool is already gone, and you have three
 * outfielders and no catcher. So this asks the same question `trade.ts` asks —
 * how much does MY STARTING LINEUP change — one pick at a time. A candidate is
 * worth what he adds to the eighteen spots the league makes you fill, which is
 * why the fourth outfielder collapses to nothing the moment the third one seats.
 *
 * Scarcity comes from the REMAINING pool and from nowhere else. The replacement
 * bar at every slot is recomputed off the players still on the board, so a run on
 * catchers moves the bar because the catchers are observably gone — not because
 * anything here guesses what the next manager will do. Draft order is recorded
 * and reported back so a human can see a run; it never enters a number.
 */

/** Rated rows are keyed per side, for the reason `trade.ts` gives: a two-way
 *  player is two rows and only the board knows which of them was taken. Same
 *  format `src/client/roster.ts` stores, so a key crosses between them intact. */
const keyOf = (r: Rated) => `${r.player.id}:${r.player.group}`

/** How many alternatives are handed back under the pick. Enough to overrule the
 *  top of the list with, few enough that the page still names one answer. */
const ALTERNATIVES = 6

export interface DraftSituation {
	league: League
	/** Every rated player — the universe the draft draws from. */
	pool: Rated[]
	/** Everyone already off the board, in the order they were marked, mine
	 *  included. The order is only ever reported back; nothing is priced off it. */
	taken: Rated[]
	/** The players I have taken so far. */
	mine: Rated[]
	/** Teams in the league — sets how deep the remaining pool has to run before it
	 *  reaches replacement level. Required and never defaulted, for the reason
	 *  bscore.ts gives: a guessed team count moves every bar on the page. */
	teams: number
}

export interface Candidate {
	player: Rated
	/** What my starting lineup gains by adding him. This is the ranking and the
	 *  answer — not his bscore, and not his projected points. */
	gain: number
	/** The spot he would actually take. Null when he would not crack the lineup at
	 *  all, which is exactly what a fourth outfielder looks like from here. */
	at: string | null
	/** Whom he pushes out of the starting lineup. Adding one player can displace at
	 *  most one, so this is a player rather than a list. */
	displaces: Rated | null
}

export interface SlotCliff {
	slot: string
	/** The man you would take here now, and the one left if he goes first. */
	best: Candidate | null
	next: Candidate | null
	/**
	 * `best.gain − next.gain`: what a round of waiting costs you at this slot if
	 * the best man is gone by your next pick. It is the number that says to take
	 * the catcher early — a deep slot drops a point or two, a cliff drops thirty.
	 *
	 * Null when there is no second man, because a drop to nothing is not a
	 * quantity and would sort as an infinite cliff if it were treated as one.
	 */
	cliff: number | null
	/** Available players here who would improve the lineup at all. Zero means the
	 *  slot is finished for you: it is filled, and nobody left can beat who is in it. */
	live: number
	/** Eligible players already off the board, and how many of those went in the
	 *  last round's worth of picks. Observed from what was marked, never extrapolated. */
	gone: number
	recent: number
}

export interface DraftAdvice {
	/** The pick. Null only when there is nobody left to take. */
	pick: Candidate | null
	alternatives: Candidate[]
	/** Every startable slot, steepest cliff first. */
	cliffs: SlotCliff[]
	/** My lineup as it stands, priced off what is still on the board. */
	lineup: Lineup
	/** The replacement bar at each slot, read off the REMAINING pool — so it falls
	 *  as the board is picked over, which is the scarcity being measured. */
	bars: Map<string, number>
	explanation: string
	/** Anything this could not read from its inputs. Never worked around silently. */
	missing: string[]
}

/**
 * Ranks everyone still on the board by what he adds to your starting lineup.
 *
 * The bars are read off the remaining pool rather than the whole one, using the
 * same (teams × slots) depth `bscore.ts` uses: the best man still on the board
 * once every team has filled that slot. That number falls as the board thins,
 * and it is meant to — a bar on what is left is the only scarcity a draft can
 * actually observe. It is not a forecast of what the wire looks like when the
 * draft ends, and it is not treated as one anywhere here.
 */
export const recommend = (situation: DraftSituation): DraftAdvice => {
	const { league, pool, teams } = situation
	const missing: string[] = []

	const takenKeys = new Set(situation.taken.map(keyOf))
	for (const r of situation.mine)
		if (!takenKeys.has(keyOf(r)))
			missing.push(
				`${r.player.name} is on your team but was never marked as taken. He is off ` +
					`the board either way, so nobody can be advised to draft him twice.`
			)
	// mine is unioned in rather than assumed to be a subset: a player you hold is
	// not available, and recommending him again is worse than any warning.
	const off = new Set([...takenKeys, ...situation.mine.map(keyOf)])

	const available = pool.filter(r => r.rateable && !off.has(keyOf(r)))
	const bars = replacementBySlot(league, available, teams)
	const lineup = startingLineup(league, situation.mine, bars)
	for (const r of lineup.unprojectable)
		missing.push(`${r.player.name} has no projection, so he can start nowhere and adds nothing`)
	for (const slot of new Set(lineup.holes))
		missing.push(
			`no replacement level for ${slot}: nobody left on the board is eligible there, so ` +
				`the spot is worth nothing rather than something unknown`
		)

	const started = lineup.starters.flatMap(s => (s.player ? [s.player] : []))
	const candidates: Candidate[] = available.map(r => {
		const after = startingLineup(league, [...situation.mine, r], bars)
		const seated = new Set(after.starters.flatMap(s => (s.player ? [keyOf(s.player)] : [])))
		return {
			player: r,
			gain: Number((after.points - lineup.points).toFixed(2)),
			at: after.starters.find(s => s.player && keyOf(s.player) === keyOf(r))?.slot ?? null,
			displaces: started.find(p => !seated.has(keyOf(p))) ?? null
		}
	})
	// deterministic all the way down: two men worth the same to the lineup are
	// separated by projected points and then by id, never by pool order
	candidates.sort(
		(a, b) =>
			b.gain - a.gain ||
			b.player.points - a.player.points ||
			a.player.player.id - b.player.player.id ||
			a.player.player.group.localeCompare(b.player.player.group)
	)

	/** One round of picks — what has gone since this pick came round to you. */
	const round = situation.taken.slice(-teams)
	const cliffs = [...new Set(activeSlots(league))]
		.map((slot): SlotCliff => {
			// candidates is already sorted, so the first two eligible here are the best
			// two — the man you would take now and the man left if he goes first
			const here = candidates.filter(c => c.player.slots.includes(slot))
			const [best = null, next = null] = here
			return {
				slot,
				best,
				next,
				cliff: best && next ? Number((best.gain - next.gain).toFixed(2)) : null,
				live: here.filter(c => c.gain > 0).length,
				gone: situation.taken.filter(r => r.slots.includes(slot)).length,
				recent: round.filter(r => r.slots.includes(slot)).length
			}
		})
		.sort((a, b) => (b.cliff ?? -Infinity) - (a.cliff ?? -Infinity) || a.slot.localeCompare(b.slot))

	const pick = candidates[0] ?? null
	return {
		pick,
		alternatives: candidates.slice(1, 1 + ALTERNATIVES),
		cliffs,
		lineup,
		bars,
		explanation: explain(situation, pick, cliffs),
		missing
	}
}

/** Names the mechanism, not the verdict: which spot the pick fills, what it costs
 *  to wait a round on it, and — separately — where the steepest drop on the board
 *  is. A manager can disagree with a sentence; he cannot disagree with "+42.10". */
const explain = (
	situation: DraftSituation,
	pick: Candidate | null,
	cliffs: SlotCliff[]
): string => {
	if (!pick) return "There is nobody left on the board, so there is nothing to recommend."
	const parts: string[] = []
	if (pick.at === null)
		parts.push(
			`Nobody left on the board improves your starting lineup. ${pick.player.player.name} ` +
				`is the best body still available (${pick.player.points.toFixed(2)} projected ` +
				`points), and he would sit on your bench.`
		)
	else
		parts.push(
			`Take ${pick.player.player.name}: he starts at ${pick.at} and adds ` +
				`${pick.gain.toFixed(2)} projected points to your lineup` +
				`${pick.displaces ? `, pushing ${pick.displaces.player.name} out of it` : ""}.`
		)

	const at = pick.at === null ? null : cliffs.find(c => c.slot === pick.at)
	if (at?.next && at.cliff)
		parts.push(
			`If he is gone by your next pick the best ${at.slot} left is ` +
				`${at.next.player.player.name}, worth ${at.cliff.toFixed(2)} less — that is what ` +
				`waiting a round costs you here.`
		)
	else if (at?.next)
		parts.push(
			`${at.next.player.player.name} is worth exactly as much to you at ${at.slot}, so ` +
				`waiting a round on this spot costs nothing.`
		)
	else if (at)
		parts.push(`He is the only ${at.slot} left on the board, so there is no drop to measure.`)

	// A cliff of zero is a deep slot, not a steep one, so it is never named as the
	// place to spend a pick — that sentence would be manufacturing urgency.
	const steepest = cliffs[0]
	if (steepest?.cliff && steepest.slot !== pick.at)
		parts.push(
			`The steepest drop on the board is at ${steepest.slot} — ` +
				`${steepest.best?.player.player.name}, then ${steepest.cliff.toFixed(2)} less — ` +
				`so that is the spot that punishes waiting most.`
		)

	// What the board has actually done, stated as an observation. It moves the bars
	// only through the players it removed; no part of this predicts the next pick.
	if (at && at.recent > 0)
		parts.push(
			`${at.recent} of the last ${situation.teams} players marked taken were eligible at ` +
				`${at.slot} (${at.gone} in all). That run is why the bar there has moved; nothing ` +
				`here guesses what goes next.`
		)
	return parts.join(" ")
}
