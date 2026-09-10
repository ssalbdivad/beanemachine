import { useEffect, useState } from "react"
import { fetchSlate, localDate, type Slate } from "../data/today.ts"

/**
 * Today's games, live, from the one public API a static site is allowed to call.
 *
 * Everything else on this page comes out of `data/snapshot.json`, which is captured
 * on a machine and shipped with the build — so it is right about a season and
 * necessarily wrong about tonight. Measured: the committed capture is stamped
 * 2026-09-08 and carries a slate that ends there, so on the 10th the page believed
 * clubs were idle that were playing and seated men whose clubs were off.
 *
 * MLB's schedule endpoint sends `access-control-allow-origin: *`, so this needs no
 * server, no key and no proxy — one request, on mount, for the whole league.
 *
 * A failure is a STATE, never an exception. `error` is surfaced so the page can say
 * "couldn't check tonight's lineups" instead of quietly falling back to a two-day-old
 * schedule and presenting it as today.
 */
export interface SlateState {
	slate: Slate | null
	error: string | null
	loading: boolean
}

export const useSlate = (date: string = localDate()): SlateState => {
	const [state, setState] = useState<SlateState>({ slate: null, error: null, loading: true })
	useEffect(() => {
		const ctl = new AbortController()
		let live = true
		void fetchSlate(date, ctl.signal).then(({ slate, error }) => {
			if (live) setState({ slate: error ? null : slate, error, loading: false })
		})
		return () => {
			live = false
			ctl.abort()
		}
	}, [date])
	return state
}
