import { useMemo } from "react"
import type { League } from "../schema.ts"
import type { ActualLine } from "../data/actuals.ts"
import { scoreStats, tableFor } from "../engine/points.ts"
import { resolvePeriod } from "../engine/period.ts"
import { localDate } from "../data/today.ts"
import { lastNight, usePeriodActuals } from "./useActuals.ts"
import { opponentStore } from "./opponent.ts"

/**
 * HOW THE WEEK STANDS, READ ONCE.
 *
 * Two screens have been asking the same question of the same endpoint over the same window
 * and neither knew the other was doing it. The recap reads the whole scoring period to say
 * what a reader's men have scored in it; the Tonight card reads the same period, for the
 * same league, to say how many innings his pitchers have banked against the league's floor.
 * Identical URL, identical dates, two requests — and a measured 15.6 KB of the 38 KB that
 * screen spends was the second copy of the first.
 *
 * It is one read now, held where both screens can see it. That is the whole reason this
 * module exists, and the gap below is what the second screen gets for free out of it.
 *
 * WHAT THE DUPLICATE ACTUALLY COST, measured rather than borrowed. The first version of this
 * comment quoted "15.6 KB of the 38 KB", which is the price of a ONE-DAY read and the wrong
 * measurement for a period: this window is seven days, not one. Measured on 2026-09-17 with
 * `curl -H 'Accept-Encoding: gzip'` over 2026-09-10..16, the two sides of the ball come to
 * 14,199 and 6,642 bytes. The request that has gone is the pitching one — 6.6 KB today, and
 * it grows every day of the period, because the second caller asked for pitchers alone.
 *
 * WHAT THIS IS NOT. It is not the score. Yahoo pays only the men in a lineup, and this page
 * can see neither his past lineups nor any of his opponent's — so both figures count every
 * man each side HOLDS. That makes the comparison fair in the one way available to it, and
 * every sentence built on it has to say so. A reader who wants the score opens Yahoo; a
 * reader who wants to know whether to chase tonight wants this.
 */
export interface Matchup {
	/** The league's own period, resolved once. Null before the capture arrives. */
	period: ReturnType<typeof resolvePeriod> | null
	/** Every line in baseball over `periodStart..lastNight`, or null while it is loading
	 *  or has failed. Shared with the innings floor, which needs the pitching half of it. */
	lines: Map<string, ActualLine> | null
	loading: boolean
	error: string | null
	/** What the reader's men have scored in the period. Null when there is nothing to say. */
	mine: number | null
	/** The same, for the men he has told the page his opponent holds. */
	theirs: number | null
	/** `mine - theirs`, positive when he is ahead. Null when either side is. */
	gap: number | null
	/** How many of his opponent's men are on record, so a screen can refuse to compare a
	 *  full roster with half of one. */
	rivals: number
	/** Days left in the period, inclusive of today. Null where the league states no period
	 *  end, and null where the period is this app's own guess — a clock a reader acts on
	 *  must be one his league actually stated. */
	daysLeft: number | null
}

const total = (
	keys: Iterable<string>,
	lines: Map<string, ActualLine>,
	league: League
): number | null => {
	let sum = 0
	let any = false
	for (const key of keys) {
		const line = lines.get(key)
		if (!line) continue
		any = true
		const group = key.endsWith(":pitching") ? "pitching" : "hitting"
		sum += scoreStats(line.stats, tableFor(league, group), group).points
	}
	return any ? Number(sum.toFixed(1)) : null
}

export const useMatchup = (
	season: number | null,
	league: League | null,
	horizonEnd: string | null,
	leagueKey: string | null,
	/** The reader's own men, as `id:group`. May be empty while his seats are not — the
	 *  hand-typed route stores seats and no roster — which is why `wanted` is a separate
	 *  argument rather than `owned.length > 0`. That inference cost the recap card its whole
	 *  week block on a team read from seats alone. */
	owned: string[],
	/** Whether this page has a team at all, by any measure the caller recognises. The read
	 *  is 38 KB and is not made for a visitor who has told the page nothing. */
	wanted: boolean,
	/** Bumped when a store changes, so a freshly pasted opponent is read. */
	rev: number
): Matchup => {
	const period = useMemo(
		() => (league && horizonEnd ? resolvePeriod(league, localDate(), horizonEnd) : null),
		[league, horizonEnd]
	)
	const periodTo = lastNight()
	const start = period?.periodStart ?? null
	/* BOTH SIDES OF THE BALL, once. The innings floor needs only pitchers and used to ask
	   for only pitchers; asking for both here is one extra request for the whole page rather
	   than one extra for each of two screens. */
	const read = usePeriodActuals(
		season,
		start,
		periodTo,
		!!start && start <= periodTo && wanted,
		["hitting", "pitching"]
	)

	const rivals = useMemo(() => {
		if (!leagueKey) return [] as string[]
		try {
			return opponentStore.of(leagueKey)
		} catch {
			return [] as string[]
		}
	}, [leagueKey, rev])

	const mine = useMemo(
		() => (read.lines && league && owned.length ? total(owned, read.lines, league) : null),
		[read.lines, league, owned]
	)
	const theirs = useMemo(
		() => (read.lines && league && rivals.length ? total(rivals, read.lines, league) : null),
		[read.lines, league, rivals]
	)

	const daysLeft = useMemo((): number | null => {
		/* NOT WHERE THE PERIOD IS THIS APP'S OWN GUESS. `resolvePeriod` falls back to seven
		   days from Monday where a league has stated nothing, and every other screen that
		   prints that window prints "assumed" beside it. A COUNT cannot carry that clause
		   without becoming a sentence, and "two days left" is exactly the kind of number a
		   reader acts on without re-reading. */
		if (!period || period.assumed || !period.periodEnd) return null
		const left =
			Math.round(
				(Date.parse(`${period.periodEnd}T00:00:00Z`) - Date.parse(`${localDate()}T00:00:00Z`)) /
					86_400_000
			) + 1
		return left > 0 ? left : null
	}, [period])

	return {
		period,
		lines: read.lines,
		loading: read.loading,
		error: read.error,
		mine,
		theirs,
		gap: mine !== null && theirs !== null ? Number((mine - theirs).toFixed(1)) : null,
		rivals: rivals.length,
		daysLeft
	}
}
