import { useEffect, useState } from "react"
import { fetchMoves, withMoves, type Moves } from "../data/injuries.ts"
import { localDate } from "../data/today.ts"

/**
 * The capture's injury list, brought up to date from MLB, on mount.
 *
 * `data/snapshot.json` is built on a machine and shipped with the site, so its
 * injury map is right on the day it is captured and wrong every day after — and
 * wrong in the direction that costs most, because a man placed on the list
 * yesterday is still, to the file, available to start tonight. One recommendation
 * that the box score already contradicts is worth more credibility than ten good
 * calls earn.
 *
 * `since` covers the gap the capture leaves plus a day of slack, so a move made on
 * the morning of the capture (after the roster read, before the file was written)
 * is picked up rather than falling between the two. Fourteen days is the cap:
 * beyond that the capture is stale in ways an injury feed cannot fix and the page
 * should say so rather than paper over it.
 */
export interface InjuryState {
	/** The merged map, or null while the request is in flight or after it failed —
	 *  null means "use the capture as it stands", which is the honest fallback. */
	merged: Map<number, string> | null
	moves: Moves | null
	error: string | null
	loading: boolean
}

const DAY = 86_400_000
const MAX_LOOKBACK_DAYS = 14

/**
 * One request per window per page load, however many components ask.
 *
 * Today and Wire both need this — a stale list benches a returning star on one
 * screen and recommends an injured free agent on the other — and they are separate
 * components with separate mounts. Without this they would each fetch, and switching
 * screens would fetch again. Keyed on the window because that is what the answer
 * depends on; never invalidated, because a page load is the unit of freshness here
 * and a reader who wants a newer answer reloads.
 */
const inFlight = new Map<string, Promise<{ moves: Moves; error: string | null }>>()
const once = (start: string, end: string): Promise<{ moves: Moves; error: string | null }> => {
	const key = `${start}..${end}`
	const held = inFlight.get(key)
	if (held) return held
	// No signal: the request is shared, so one component unmounting must not cancel
	// it for another. The deadline inside `fetchMoves` is what bounds it.
	const p = fetchMoves(start, end)
	inFlight.set(key, p)
	return p
}

export const useInjuries = (
	captured: Map<number, string> | null,
	capturedAt: string | undefined
): InjuryState => {
	const [state, setState] = useState<InjuryState>({
		merged: null,
		moves: null,
		error: null,
		loading: true
	})

	// The window is derived from the capture's own timestamp, so a fresh snapshot
	// asks for a day and a stale one asks for a fortnight. Keyed on the DATE rather
	// than the instant so this does not re-fire on every render.
	const since = (() => {
		const from = capturedAt ? Date.parse(capturedAt) : NaN
		const floor = Date.now() - MAX_LOOKBACK_DAYS * DAY
		const start = Number.isFinite(from) ? Math.max(from - DAY, floor) : floor
		return localDate(new Date(start))
	})()
	const until = localDate(new Date(Date.now() + DAY))

	useEffect(() => {
		if (!captured) return
		let live = true
		void once(since, until).then(({ moves, error }) => {
			if (!live) return
			setState({
				merged: error ? null : withMoves(captured, moves),
				moves: error ? null : moves,
				error,
				loading: false
			})
		})
		return () => {
			live = false
		}
		// `captured` is a fresh Map on every hydrate, so it cannot be a dependency —
		// the request depends on the WINDOW, and the merge is done against whatever
		// map was current when the answer arrived.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [since, until, !!captured])

	return state
}
