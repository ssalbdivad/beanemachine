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

	/*
	   WHEN THE HINDSIGHT LINEUP COMES OUT BELOW THE REAL ONE, THE COMPARISON IS REFUSED.
	   
	   `best` can only seat a man the league's own `slot_accepts` table proves legal for a
	   seat, and a reader's actual lineup is not bound by what this app can prove: where the
	   platform's eligibility grid does not cover him — the committed capture covers 328 of
	   1,446 players — `legalSlotsFor` returns nothing and he is seatable nowhere. Measured
	   on a 19-man test team whose men carried only their primary position: the reader's
	   lineup scored 128.6 and the "best" lineup it could assemble scored less, because it
	   could not legally seat several men who were in fact started.
	   
	   A negative "points left on your bench" is nonsense, and silently hiding it is worse —
	   that is an absence presented as a zero. So the gap is withheld and the reason is
	   stated, which is the same rule the rest of this file follows. `best` itself is still
	   returned, because a caller may want to show the lineup; what is refused is the
	   SUBTRACTION, which is the only part that claims something.
	*/
	/* Counted directly rather than inferred from how many seats got filled, which was the
	   first attempt and was wrong: a bench man who IS placeable takes the seat the
	   unplaceable starter had, so the seat COUNT comes out equal while the lineup is worth
	   far less. The question is not how many seats were filled, it is how many men the
	   reader actually started that this app cannot legally place anywhere. */
	const unseatable =
		startedTotal !== null && accepts ?
			started.filter(s => legalSlotsFor(s.man.positions, accepts).length === 0).length
		:	0
	const comparable = startedTotal === null ? false : best.total >= startedTotal && !unseatable
	if (startedTotal !== null && !comparable) {
		biggest = null
		blocked.push(
			unseatable ?
				`Your league's own list of which players may fill which seats does not cover ` +
					`${unseatable} of the men you started, so the best lineup you could have set ` +
					`cannot be worked out and nothing is claimed about what sat on your bench.`
			:	"The best lineup this page could assemble scored less than the one you actually " +
				"had, which means it could not legally seat men you did seat — so nothing is " +
				"claimed about what sat on your bench."
		)
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
		leftOnBench: comparable ? r2(best.total - startedTotal!) : null,
		biggest,
		blocked,
		unscoreable: [...unscoreable].sort()
	}
}

/**
 * BILLY, GRADED AGAINST THE LINEUP YOU ALREADY HAD.
 *
 * The recap above needs no history: it works on a first visit, from public data, and its
 * hindsight lineup is explicitly not a claim that you should have known. This is the
 * other kind of number, and it is the only one in the app that can be WRONG in public.
 *
 * The comparison is narrow on purpose. For each day the app recorded a recommendation it
 * takes two lineups — the one it asked for and the one that was already in place — scores
 * both against what those men actually did, and reports the difference. That is all. It
 * does not know whether you took the advice, so it never says you did or didn't; it does
 * not grade the days you never opened the app, so it says how many days it is speaking
 * about; and it does not grade a day it only half-knows.
 *
 * THE DENOMINATOR IS THE HONEST PART. Most days a lineup is already the best one and the
 * recommendation is "leave it alone", which is worth exactly nothing and would flatter a
 * win-rate computed over every day. So the days where Billy asked for a CHANGE are
 * counted separately, and those are the only ones a record should be read off.
 *
 * AN ABSENCE IS A ZERO HERE, AND ONLY HERE. In the recap a man with no split shows as
 * "did not play" rather than as nothing, because the reader is looking at his night. In a
 * lineup TOTAL he contributed nothing, which is a real cost of having started him, and
 * both lineups are treated the same way — so a recommendation to start a man who never
 * took the field is scored as the mistake it was.
 */
export interface GradedDay {
	date: string
	/** When the recommendation was written, so a screen can say how late it was asked. */
	at: string
	/** What the lineup Billy asked for actually scored. */
	asked: number
	/** What the lineup already in place actually scored. Null when the seats were never
	 *  read that day, which makes the day ungradeable rather than a tie. */
	had: number | null
	/** `asked - had`. Null whenever `had` is. */
	worth: number | null
	/** True when the recommendation was to leave the lineup exactly as it was. */
	unchanged: boolean
	/** The men it asked in and the men it asked out, with what they actually did. */
	calls: {
		name: string
		side: "in" | "out"
		projected: number | null
		/** Null when he never took the field. The totals above count that as nothing. */
		actual: number | null
	}[]
}

export interface Record_ {
	/** Every day with a recommendation recorded AND results available, oldest first. */
	days: GradedDay[]
	/** Days where Billy asked for a change — the only ones a record can be read off. */
	changed: number
	/** Of those: where following it scored more, less, and exactly the same. */
	better: number
	worse: number
	even: number
	/** Summed `worth` over the changed days. The headline number, and it is allowed to
	 *  be negative — a record that can only flatter is not a record. */
	net: number
	/** Days recorded where the recommendation was to leave the lineup alone. */
	unchanged: number
	/** Days recorded that could not be graded, and why, in the reader's words. */
	skipped: { date: string; why: string }[]
}

/** One side of a recorded entry, scored against what those men actually did. */
const sideTotal = (
	side: { key: string; name: string; projected: number | null }[],
	lines: Map<string, ActualLine>,
	league: League
): { total: number; each: { name: string; projected: number | null; actual: number | null }[] } => {
	const each = side.map(s => {
		const line = lines.get(s.key)
		if (!line) return { name: s.name, projected: s.projected, actual: null }
		const group = s.key.endsWith(":pitching") ? "pitching" : "hitting"
		return {
			name: s.name,
			projected: s.projected,
			actual: scoreStats(line.stats, tableFor(league, group), group).points
		}
	})
	return { total: r2(each.reduce((a, e) => a + (e.actual ?? 0), 0)), each }
}

export const gradeRecord = (input: {
	/** Recorded recommendations, any order. Shaped like `LedgerEntry` in
	 *  src/client/ledger.ts, restated structurally so the engine does not import the
	 *  browser store. */
	entries: {
		date: string
		at: string
		start: { key: string; name: string; slot: string | null; projected: number | null }[]
		sit: { key: string; name: string; slot: string | null; projected: number | null }[]
		had: { key: string; name: string; slot: string | null; projected: number | null }[]
		/** A day already settled. Present from the second morning onwards for every day
		 *  but yesterday's — see `settle` in src/client/ledger.ts for why a finished day is
		 *  graded once and kept rather than re-graded from a fresh request. */
		graded?: { asked: number; had: number | null; worth: number | null; unchanged: boolean }
	}[]
	/** Actual lines per date. A date with no entry here has no results yet and is
	 *  skipped rather than scored as a scoreless day. */
	byDate: Map<string, Map<string, ActualLine>>
	league: League
}): Record_ => {
	const days: GradedDay[] = []
	const skipped: { date: string; why: string }[] = []

	for (const e of [...input.entries].sort((a, b) => a.date.localeCompare(b.date))) {
		/* A SETTLED DAY NEEDS NO REQUEST, and that is what makes a running record free.
		   Sixty days of history graded from live reads would be 120 requests and about 2.3 MB
		   every time the strip rendered, for answers that cannot change. `calls` is not
		   stored — the per-man detail is only ever shown for yesterday, and keeping twenty
		   names and two numbers each for sixty days is a quarter of a megabyte in this
		   browser to render a line nobody asked for. */
		if (e.graded) {
			days.push({ ...e.graded, date: e.date, at: e.at, calls: [] })
			continue
		}
		const lines = input.byDate.get(e.date)
		if (!lines) {
			skipped.push({ date: e.date, why: "last night's results aren't in yet" })
			continue
		}
		if (!e.start.length) {
			skipped.push({ date: e.date, why: "no lineup was recommended that day" })
			continue
		}
		const asked = sideTotal(e.start, lines, input.league)
		/* The seats already in place. Absent for a hand-typed team, and then the day has
		   nothing to compare against — which is not a tie, and must not be reported as
		   one. The asked-for lineup is still scored, because a reader looking at the day
		   is owed what it was worth even when the comparison is unavailable. */
		const had = e.had.length ? sideTotal(e.had, lines, input.league) : null
		const sameSet =
			had !== null &&
			e.start.length === e.had.length &&
			new Set(e.start.map(s => s.key)).size === new Set([...e.start, ...e.had].map(s => s.key)).size
		const sat = sideTotal(e.sit, lines, input.league)
		days.push({
			date: e.date,
			at: e.at,
			asked: asked.total,
			had: had?.total ?? null,
			worth: had === null ? null : r2(asked.total - had.total),
			unchanged: sameSet,
			calls: [
				...asked.each.map(x => ({ ...x, side: "in" as const })),
				...sat.each.map(x => ({ ...x, side: "out" as const }))
			]
		})
		if (had === null)
			skipped.push({
				date: e.date,
				why: "nobody had told this page which of your men were in your lineup that day"
			})
	}

	const changed = days.filter(d => d.worth !== null && !d.unchanged)
	return {
		days,
		changed: changed.length,
		better: changed.filter(d => d.worth! > 0).length,
		worse: changed.filter(d => d.worth! < 0).length,
		even: changed.filter(d => d.worth! === 0).length,
		net: r2(changed.reduce((a, d) => a + d.worth!, 0)),
		unchanged: days.filter(d => d.unchanged).length,
		skipped
	}
}

/**
 * LAST NIGHT'S BEST NIGHTS, for a reader who has told the page nothing.
 *
 * The hardest thing about this product is the first thirty seconds. Every number it can show
 * a stranger is about a league he has not entered and players it ranks by value over
 * replacement — which correctly puts unrostered men at the top, and to a Yahoo manager reads
 * as a list of names he has never heard of. Measured on the committed capture before any
 * setup, the top five were a White Sox rookie reliever, a White Sox infielder, a White Sox
 * outfielder and two men off two of the worst teams in baseball. That is the entire first
 * impression and it is nobody's fault: it is what the board is for.
 *
 * This is the one thing the app can put in front of a stranger that needs nothing from him
 * and is interesting on sight: what the best nights in baseball were actually worth, last
 * night, priced in a real scoring table. The names are the names everybody knows, because a
 * big night is a big night, and the numbers are facts rather than estimates.
 *
 * Both sides of the ball in one list, deliberately. In a points league a start and a
 * three-homer game are denominated in the same currency, and splitting them would be a claim
 * that they are not comparable — which is exactly what a points league denies.
 */
export const bestNights = (
	lines: Map<string, ActualLine>,
	league: League,
	take = 10
): { name: string; team: string | null; group: "hitting" | "pitching"; points: number; top: { code: string; points: number }[] }[] => {
	const out: { name: string; team: string | null; group: "hitting" | "pitching"; points: number; top: { code: string; points: number }[] }[] = []
	for (const line of lines.values()) {
		const scored = scoreStats(line.stats, tableFor(league, line.group), line.group)
		out.push({
			name: line.name,
			team: line.team,
			group: line.group,
			points: scored.points,
			top: topThree(scored.breakdown)
		})
	}
	/* A night worth nothing is not one of the best nights, and a list headed that way with a
	   0.0 at the foot of it reads as a list that ran out rather than as a top eight. On a real
	   day this filter removes nothing — 353 hitters and 133 pitchers played on 2026-09-11 and
	   the eighth-best night is worth twenty-odd points — but the committed eight-man fixture
	   shows exactly what it looks like when it does bite, and so does a day with two games on
	   it in April. */
	return out
		.filter(x => x.points > 0)
		.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name))
		.slice(0, take)
}
