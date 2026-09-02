import type { SlateGame } from "../data/statsapi.ts"
import type { League } from "../schema.ts"

/**
 * Where a streaming week actually ends.
 *
 * The board used to rank the "week" as a rolling seven days from today, which is
 * wrong in any league that scores matchups over a fixed period. Measured against the
 * shipped league on a Wednesday: the rolling window counted 7.4 games per club when
 * 4.7 remained in the matchup, a 59% overstatement, and it did so unevenly — clubs
 * were inflated between 1.40x and 1.75x, so 144 of 435 club pairs carried wrong
 * schedule information. Not as inversions; the board never claimed a worse club was
 * better. It tied 54 pairs that truly differed and split 90 that were truly equal, on
 * the one tab whose entire job is schedule density.
 *
 * There is no neutral default here. `today … today + 7` is an assumption too — that
 * the period is seven days long and starts today — and it is wrong every day of the
 * week except the first. The difference is that this module says which assumption it
 * is making, and the board prints it.
 *
 * Dates are ISO `YYYY-MM-DD` and every boundary is INCLUSIVE, matching the MLB
 * schedule endpoint, which returns both endpoints. That inclusivity is why the old
 * code was also off by one: `now + 7 days` asked for eight dates, one more than the
 * seven-date week the model was ever measured on.
 */

const DAY = 86400_000
/** ISO weekday index, Sunday first, matching `Date.getUTCDay`. */
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const

const iso = (t: number) => new Date(t).toISOString().slice(0, 10)
const at = (d: string) => Date.parse(`${d}T00:00:00Z`)
const shift = (d: string, days: number) => iso(at(d) + days * DAY)
/** Inclusive, so a single date spans one day rather than zero. */
export const datesBetween = (start: string, end: string) =>
	Math.floor((at(end) - at(start)) / DAY) + 1

export interface ResolvedPeriod {
	/** Inclusive window a streaming decision actually accrues over. */
	start: string
	end: string
	/** The period's own last day, even where `end` was clipped to the slate. */
	periodEnd: string | null
	kind: "matchup" | "daily" | "rolling"
	/** True where the league stated no period and this is the fallback. */
	assumed: boolean
	/** True where the window was cut short by the end of the captured slate. */
	clipped: boolean
	/** One sentence naming the window and where its edges came from, for the UI to
	 *  print. A window the reader cannot account for is worse than a wrong one. */
	basis: string
}

/** Most recent occurrence of `weekday` on or before `from`. */
const periodStartFor = (from: string, weekday: string, days: number, anchor: string | null) => {
	if (anchor) {
		// an explicit pin: periods are anchor + k*days, so walk back to the one holding `from`
		const elapsed = Math.floor((at(from) - at(anchor)) / DAY)
		return shift(anchor, Math.floor(elapsed / days) * days)
	}
	const want = WEEKDAYS.indexOf(weekday as (typeof WEEKDAYS)[number])
	if (want < 0) return from
	const back = (new Date(at(from)).getUTCDay() - want + 7) % 7
	return shift(from, -back)
}

/**
 * The window to rank a streaming decision over, given the league's own period.
 *
 * `slateEnd` clips the answer to what was actually captured: a fortnight-old snapshot
 * can be asked about a period that starts after its last game, and an empty window
 * must be reported rather than silently returned as zero games for everybody.
 */
export const resolvePeriod = (
	league: League,
	today: string,
	slateEnd: string
): ResolvedPeriod => {
	const p = league.scoring_period ?? null
	const rolling = (why: string): ResolvedPeriod => {
		const end = shift(today, 6)
		return {
			start: today,
			end: end > slateEnd ? slateEnd : end,
			periodEnd: null,
			kind: "rolling",
			assumed: true,
			clipped: end > slateEnd,
			basis: `a rolling seven days, ${why}`
		}
	}
	if (!p || p.kind === null) return rolling("because this league has not said how its scoring period runs")
	if (p.kind === "none")
		return {
			...rolling("because this league scores the whole season rather than by period"),
			assumed: false
		}
	if (p.kind === "daily")
		return {
			start: today,
			end: today,
			periodEnd: today,
			kind: "daily",
			assumed: false,
			clipped: today > slateEnd,
			basis: "today only, because this league scores each day as its own period"
		}

	const days = p.days ?? 7
	const weekday = p.starts_on ?? "mon"
	const stated = p.starts_on !== null || p.anchor !== null
	let start = periodStartFor(today, weekday, days, p.anchor)
	let periodEnd = shift(start, days - 1)
	// A lineup locked for the period means the rest of THIS one cannot be acted on,
	// so the decision in front of the reader is about the next period, not this one.
	const locked = p.lineup_lock === "period"
	if (locked) {
		start = shift(periodEnd, 1)
		periodEnd = shift(start, days - 1)
	}
	const from = locked ? start : today > start ? today : start
	const end = periodEnd > slateEnd ? slateEnd : periodEnd
	return {
		start: from,
		end,
		periodEnd,
		kind: "matchup",
		assumed: !stated,
		clipped: periodEnd > slateEnd,
		basis:
			(locked ?
				`the next scoring period, ${start} to ${periodEnd}, because lineups are locked for the current one`
			:	`the rest of this scoring period, through ${periodEnd}`) +
			(stated ? "" : ", assuming a Monday start because the league has not said")
	}
}

/**
 * Everything a window is worth, counted from the games in it.
 *
 * All five quantities come from the same rows over the same dates, which is the
 * point: the coverage fraction's numerator and denominator can no longer be drawn
 * from different windows, because there is only one window.
 */
export interface Window {
	/** Games each club plays in the window. */
	games: Map<number, number>
	/** Who each club faces, one entry per game. */
	opponents: Map<number, number[]>
	/** Starts each pitcher is announced for. Absent means unannounced, not zero. */
	probableStarts: Map<number, number>
	/** The opposing starters each club is booked against, where they are announced. */
	opposingStarters: Map<number, number[]>
	/** How much of each club's window MLB has actually named starters for. */
	coverage: Map<number, { published: number; games: number }>
}

export const windowFrom = (
	slate: SlateGame[],
	start: string,
	end: string,
	/** Count only games already final — what a rate over played games needs. */
	playedOnly = false
): Window => {
	const w: Window = {
		games: new Map(),
		opponents: new Map(),
		probableStarts: new Map(),
		opposingStarters: new Map(),
		coverage: new Map()
	}
	// an empty or inverted range counts nothing, which is the honest answer for a
	// snapshot asked about a period that begins after its last captured game
	if (start > end) return w
	for (const g of slate) {
		if (g.date < start || g.date > end) continue
		if (playedOnly && !g.final) continue
		for (const side of ["home", "away"] as const) {
			const team = side === "home" ? g.home : g.away
			const opp = side === "home" ? g.away : g.home
			const mine = side === "home" ? g.homeProbable : g.awayProbable
			const theirs = side === "home" ? g.awayProbable : g.homeProbable
			w.games.set(team, (w.games.get(team) ?? 0) + 1)
			w.opponents.set(team, [...(w.opponents.get(team) ?? []), opp])
			const cov = w.coverage.get(team) ?? { published: 0, games: 0 }
			cov.games++
			if (mine !== null) cov.published++
			w.coverage.set(team, cov)
			if (mine !== null) w.probableStarts.set(mine, (w.probableStarts.get(mine) ?? 0) + 1)
			if (theirs !== null)
				w.opposingStarters.set(team, [...(w.opposingStarters.get(team) ?? []), theirs])
		}
	}
	return w
}
