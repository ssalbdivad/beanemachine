import { startableSeats } from "../engine/bscore.ts"
import { scoreStats, tableFor } from "../engine/points.ts"
import type { ActualLine } from "../data/actuals.ts"
import type { League } from "../schema.ts"
import { isBench, isReserve, legalSlotsFor, seatEveryone, type RosterShape } from "./plan.ts"

/**
 * THE MORNING AFTER.
 *
 * `plan.ts` answers "what should I do", which is a projection and says so. This answers
 * "what happened", which is a fact, and it is the only screen in this app that can check
 * the rest of it against reality. A recommendation engine that never tells you whether
 * it was right is asking for trust it has not earned.
 *
 * Three numbers come out of here, in increasing order of how much they sting:
 *
 *  1. WHAT YOUR MEN SCORED. Needs only the list of who is yours, so it works for the
 *     hand-typed team that has no seats stored at all.
 *  2. WHAT YOUR LINEUP SCORED — the men in startable seats, as the seats were last read.
 *     Null when no seats were ever read, because a lineup nobody told us is not a lineup
 *     we may invent.
 *  3. WHAT THE BEST LINEUP YOU COULD HAVE SET WOULD HAVE SCORED, seated by the planner's
 *     own solver with yesterday's real points in place of projections. The difference is
 *     the points you left on the bench, which is the number every fantasy manager
 *     already keeps in his head and no app has ever shown him.
 *
 * HINDSIGHT IS NOT A CLAIM THAT YOU SHOULD HAVE KNOWN. (3) is computed from numbers that
 * did not exist when the lineup was due, and the UI is required to say so. It is useful
 * anyway: it is the size of the prize, and over a season the gap between your lineup and
 * the best one is the whole difference between managers.
 *
 * WHO IS ELIGIBLE FOR (3). Only men who were in an ACTIVE or BENCH seat. A man on the
 * injured list could not have been started that day without a roster move you did not
 * have, so counting him would make the regret a fiction. When seats are unknown, every
 * man you hold is in the pool and `startedTotal` is null — the honest pair, rather than
 * a best lineup measured against an invented one.
 */

/** One of your men, joined to his seat and to his id, by the caller that has both. */
export interface RecapMan {
	/** `id:group`, which is how `src/data/actuals.ts` keys a real line. */
	key: string
	name: string
	/** The seat he was in when the seats were last read, or null when they never were. */
	slot: string | null
	/** Eligibility as the platform prints it — the same list `legalSlotsFor` takes. */
	positions: string[]
}

export interface RecapPlayer {
	name: string
	slot: string | null
	/** Points in THIS league's scoring, or null when he did not appear. Never zero for
	 *  an absence: a 0 here means he played and scored nothing. */
	points: number | null
	/** Which categories carried him, biggest first — the "why" behind one number. */
	top: { code: string; points: number }[]
	/** True when he was in a startable seat as the seats were last read. */
	started: boolean
}

export interface Recap {
	date: string
	/** Every man you hold, best night first, with the ones who did not play last. */
	men: RecapPlayer[]
	/** Everything your men scored, started or not. Always available. */
	ownedTotal: number
	/** What your lineup scored. Null when no seats were ever read. */
	startedTotal: number | null
	/** The best lineup available to you that day, and what it would have scored. */
	best: { total: number; seated: { slot: string; name: string; points: number }[] }
	/** `best.total - startedTotal`, or null when there is no lineup to compare against. */
	leftOnBench: number | null
	/** The single swap that explains the most of that gap, when there is one. */
	biggest: { in: string; out: string; swing: number } | null
	/** Why a number above is missing, in the reader's terms. Empty when nothing is. */
	blocked: string[]
	/** League categories MLB's day read cannot source, surfaced rather than zeroed. */
	unscoreable: string[]
}

const r2 = (n: number): number => Number(n.toFixed(2))

/** The three categories that carried a night, for a one-line "why". Zeroes are dropped:
 *  a man's night is described by what he did, not by the nine things he did not do. */
const topThree = (breakdown: Record<string, number>): { code: string; points: number }[] =>
	Object.entries(breakdown)
		.filter(([, p]) => p !== 0)
		.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || a[0].localeCompare(b[0]))
		.slice(0, 3)
		.map(([code, points]) => ({ code, points: r2(points) }))

export const recap = (input: {
	date: string
	men: RecapMan[]
	lines: Map<string, ActualLine>
	league: League
	shape: RosterShape
}): Recap => {
	const { date, men, lines, shape } = input
	const blocked: string[] = []
	const unscoreable = new Set<string>()

	/* Seats are either known for the whole team or for none of it — `lineupStore` writes a
	   team's spots in one go — so one man with a slot is enough to say the seats were read.
	   Asked rather than assumed, because the hand-typed route produces a full roster with
	   no seats and that is the common case, not the edge one. */
	const seatsKnown = men.some(m => m.slot !== null && m.slot.trim() !== "")

	const scored = men.map(m => {
		const line = lines.get(m.key)
		const group = m.key.endsWith(":pitching") ? "pitching" : "hitting"
		if (!line)
			return { man: m, points: null as number | null, top: [] as { code: string; points: number }[] }
		const result = scoreStats(line.stats, tableFor(input.league, group), group)
		for (const code of result.unscoreable) unscoreable.add(code)
		return { man: m, points: result.points, top: topThree(result.breakdown) }
	})

	const ownedTotal = r2(scored.reduce((a, s) => a + (s.points ?? 0), 0))

	const started = scored.filter(
		s => seatsKnown && s.man.slot !== null && !isBench(s.man.slot) && !isReserve(s.man.slot)
	)
	const startedTotal = seatsKnown ? r2(started.reduce((a, s) => a + (s.points ?? 0), 0)) : null
	if (!seatsKnown)
		blocked.push(
			"Nobody told this page which of your men were in your lineup, so it can say what " +
				"they scored but not what your lineup scored."
		)

	/* THE HINDSIGHT LINEUP.

	   `seatEveryone` is the planner's own solver and wants candidates best-first, which is
	   what makes the greedy provably optimal over a transversal matroid. Here "best" is
	   last night's actual points rather than a projection, and a man who did not appear
	   enters at zero — he is still legally seatable, he is simply never worth seating.
	   Name order breaks an exact tie so two runs agree. */
	const seats = startableSeats(shape)
	const accepts = shape.slot_accepts
	let best: Recap["best"] = { total: 0, seated: [] }
	let biggest: Recap["biggest"] = null
	if (!accepts)
		blocked.push(
			"This league has never said which players its seats accept, so the best lineup " +
				"you could have set cannot be worked out."
		)
	else if (!seats.length)
		blocked.push("This league lists no startable seats, so there was no lineup to set.")
	else {
		const pool = scored
			.filter(s => !(seatsKnown && s.man.slot !== null && isReserve(s.man.slot)))
			.map(s => ({ ...s, legal: legalSlotsFor(s.man.positions, accepts) }))
			.filter(s => s.legal.length > 0)
			.sort((a, b) => (b.points ?? 0) - (a.points ?? 0) || a.man.name.localeCompare(b.man.name))
		const held = seatEveryone(
			pool.map(c => c.legal),
			seats,
			pool.map(c => (c.man.slot && !isBench(c.man.slot) ? c.man.slot : null))
		)
		const seated = [...held.keys()]
			.sort((a, b) => a - b)
			.map(si => {
				const c = pool[held.get(si)!]!
				return { slot: seats[si]!, name: c.man.name, points: r2(c.points ?? 0) }
			})
		best = { total: r2(seated.reduce((a, s) => a + s.points, 0)), seated }

		/* ONE SWAP, NOT A REWRITE. The gap is usually one man, and a reader who is told
		   "your lineup was worth 13 less than it could have been" will ask which one. The
		   pair reported is the legal (bench man, starter) pair with the largest swing, and
		   it is only reported when both sides are known — so a lineup nobody read produces
		   no regret, rather than one measured against a guess. */
		if (seatsKnown) {
			const benched = scored.filter(s => s.man.slot !== null && isBench(s.man.slot))
			for (const b of benched) {
				const legal = legalSlotsFor(b.man.positions, accepts)
				for (const s of started) {
					if (s.man.slot === null || !legal.includes(s.man.slot)) continue
					const swing = r2((b.points ?? 0) - (s.points ?? 0))
					if (swing > 0 && (!biggest || swing > biggest.swing))
						biggest = { in: b.man.name, out: s.man.name, swing }
				}
			}
		}
	}

	return {
		date,
		men: scored
			/* Played-and-bad sorts above did-not-play, because the two mean different things
			   to a manager and a null dressed as a zero would mix them together. */
			.sort(
				(a, b) =>
					Number(b.points !== null) - Number(a.points !== null) ||
					(b.points ?? 0) - (a.points ?? 0) ||
					a.man.name.localeCompare(b.man.name)
			)
			.map(s => ({
				name: s.man.name,
				slot: s.man.slot,
				points: s.points,
				top: s.top,
				started: seatsKnown && s.man.slot !== null && !isBench(s.man.slot) && !isReserve(s.man.slot)
			})),
		ownedTotal,
		startedTotal,
		best,
		leftOnBench: startedTotal === null ? null : r2(best.total - startedTotal),
		biggest,
		blocked,
		unscoreable: [...unscoreable].sort()
	}
}
