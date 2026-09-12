import { useEffect, useState } from "react"
import { fetchActuals, type Actuals } from "../data/actuals.ts"
import { localDate } from "../data/today.ts"

/**
 * What actually happened on one day, live, for every man in baseball.
 *
 * The counterpart to `useSlate`: that one asks what is about to happen, this one asks what
 * did. Same contract, same reasons — one public endpoint that sends
 * `access-control-allow-origin: *`, no server, no key, and failure is a STATE rather than
 * an exception, because a page that cannot reach MLB must say so instead of rendering a
 * scoreless day.
 *
 * IT IS NOT POLLED, and that is the difference. A slate changes all evening; a finished day
 * does not change at all. One read per date, and the only thing that can make it read again
 * is being asked about a different date.
 *
 * WHAT IT COSTS, measured rather than estimated. `curl -H 'Accept-Encoding: gzip'` against
 * both reads for 2026-09-11, on 2026-09-12: 23,019 bytes for the 353 hitters and 15,648 for
 * the 133 pitchers, **38,667 bytes on the wire** for the whole of baseball. That is a fifth
 * of what the committed capture costs the same page load, for the one screen in this app
 * that states a fact rather than an estimate. It is still not free, so it is asked for only
 * when there is a team to ask about — see `enabled`.
 */
export interface ActualsState {
	actuals: Actuals | null
	error: string | null
	loading: boolean
}

/**
 * Yesterday, on the reader's own calendar.
 *
 * "Last night" is always the previous local day, even at one in the morning: MLB dates a
 * game by the day it started, so the games a reader means when he says last night are
 * yesterday's games whether he asks at 9am or at 1am. Local rather than UTC for the reason
 * written out in src/data/today.ts — after 8pm Eastern the UTC date is already tomorrow,
 * which would make this ask about tonight's unfinished games and call them last night.
 */
export const lastNight = (now: Date = new Date()): string =>
	localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))

export const useActuals = (
	season: number | null,
	date: string | null,
	/** False until there is a team to say anything about, so a visitor who has told the
	 *  page nothing is never charged 38 KB for a screen that would have nothing on it. */
	enabled: boolean
): ActualsState => {
	const [state, setState] = useState<ActualsState>({ actuals: null, error: null, loading: false })

	useEffect(() => {
		if (!enabled || season === null || date === null) {
			setState({ actuals: null, error: null, loading: false })
			return
		}
		const ctl = new AbortController()
		let live = true
		setState(s => ({ ...s, loading: true }))
		void fetchActuals(season, date, ctl.signal).then(({ actuals, error }) => {
			if (!live) return
			/* A PARTIAL answer is kept, unlike the slate's. `fetchActuals` fetches both sides
			   of the ball independently and reports which failed, and half a day of real
			   results beside a sentence saying the other half is missing is worth more than a
			   blank screen — the men who are there are still correctly priced. The slate's
			   all-or-nothing rule is right for a slate, where a missing game reads as a club
			   with no game; here a missing side reads as men who did not play, which is why
			   `error` has to be rendered and not merely stored. */
			setState({ actuals, error, loading: false })
		})
		return () => {
			live = false
			ctl.abort()
		}
	}, [season, date, enabled])

	return state
}
