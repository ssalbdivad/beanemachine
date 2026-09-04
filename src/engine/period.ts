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
	/** `days` is a window the READER asked for by length — see `withinDays`. The
	 *  other three are windows the LEAGUE implies. */
	kind: "matchup" | "daily" | "rolling" | "days"
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

	// Both of these fill a null, and both therefore have to be declared. The Monday
	// fallback always said so; the length did not, so a league stating `matchup` with
	// no `days` was ranked over a seven-day period and the board never mentioned it —
	// exactly the silent assumption this module exists to prevent.
	const days = p.days ?? 7
	const weekday = p.starts_on ?? "mon"
	const assumptions = [
		p.starts_on === null && p.anchor === null ? "a Monday start" : "",
		p.days === null ? "a seven-day period" : ""
	].filter(Boolean)
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
		assumed: assumptions.length > 0,
		clipped: periodEnd > slateEnd,
		basis:
			(locked ?
				`the next scoring period, ${start} to ${periodEnd}, because lineups are locked for the current one`
			:	`the rest of this scoring period, through ${periodEnd}`) +
			(assumptions.length ?
				`, assuming ${assumptions.join(" and ")} because the league has not said`
			:	"")
	}
}

/**
 * The reader's own horizon: the first `days` dates of a resolved window.
 *
 * "The rest of the period" is the right default and stays the default — points
 * scored after the reset belong to the NEXT matchup, so in a head-to-head league
 * the period is the decision. It is not the only question anyone asks. Streaming a
 * starter is a two- or three-day decision ("who is pitching between now and
 * Sunday"), and it is also the only horizon the schedule data can answer sharply:
 * measured on the committed capture (captured 2026-09-02) as of 2026-09-04, MLB has
 * named the starter in 15 of 32 games one day out, 41 of 92 three days out, and
 * still only 43 of 184 seven days out. The published set stops growing about three
 * days past a capture, so beyond that a longer window buys no extra certainty —
 * only more games estimated from each pitcher's own rate.
 *
 * This is the SAME control as "rest of period", not a second one. Both name one
 * inclusive window to accrue over, and everything downstream — `windowFrom`,
 * `rateAll`, the coverage line the board prints — already takes a start and an end
 * and cannot tell which of the two produced them.
 *
 * The count starts at the resolved window's OWN start rather than at today, so a
 * league whose lineups are locked for the current period counts the first `days` of
 * the period the reader can actually act on rather than days he cannot.
 *
 * A window that runs past the period's end is NOT silently clamped — a reader who
 * asks for five days is answered with five days — but `basis` says so, because a
 * pitcher's fifth-day start scores for a matchup this one has already been decided
 * without.
 */
export const withinDays = (p: ResolvedPeriod, days: number, slateEnd: string): ResolvedPeriod => {
	const want = shift(p.start, days - 1)
	const clipped = want > slateEnd
	const end = clipped ? slateEnd : want
	const past = p.periodEnd !== null && want > p.periodEnd
	return {
		...p,
		end,
		kind: "days",
		/**
		 * A rolling fallback's `assumed` was a claim about the WINDOW — "seven days,
		 * because this league has not said" — and the reader has just replaced that
		 * window with one he chose, leaving only a start date of today, which is not
		 * an assumption about anything. A matchup period keeps its flag: its start
		 * may still rest on the Monday-and-seven-days fallback, and this control does
		 * not touch the start.
		 */
		assumed: p.kind === "rolling" ? false : p.assumed,
		clipped: p.clipped || clipped,
		basis:
			`${days} days, ${p.start} to ${end}` +
			(past ?
				`, which runs past ${p.periodEnd} — games after that score for your next matchup, not this one`
			:	"") +
			(clipped ? `, clipped to ${slateEnd} because this capture holds no games after it` : "")
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
	/**
	 * Who each announced starter is booked against, one entry per announced start.
	 *
	 * `opponents` is per CLUB, so a pitcher's schedule strength was the average of
	 * every team his club faces that week — including the games he does not pitch.
	 * A man announced against the weakest lineup in the league was being priced on
	 * his club's whole week, which is the opposite of what a streaming decision
	 * turns on. Where MLB has named him, the lineup he actually faces is known.
	 */
	startOpponents: Map<number, number[]>
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
		startOpponents: new Map(),
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
			if (mine !== null) {
				w.probableStarts.set(mine, (w.probableStarts.get(mine) ?? 0) + 1)
				w.startOpponents.set(mine, [...(w.startOpponents.get(mine) ?? []), opp])
			}
			if (theirs !== null)
				w.opposingStarters.set(team, [...(w.opposingStarters.get(team) ?? []), theirs])
		}
	}
	return w
}
