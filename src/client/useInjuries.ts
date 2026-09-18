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
	/**
	 * DAYS BETWEEN THE CAPTURE AND THE START OF THE WINDOW, when the window no longer reaches
	 * back to it. Zero — the ordinary case — means the two overlap and the merge is complete.
	 *
	 * The lookback is capped at a fortnight, and the cap is measured from NOW: when a capture
	 * is older than that, the transactions window begins AFTER the capture and every move in
	 * between is invisible. The capture's own injury entries then stay authoritative for men
	 * who have since moved, which is the exact failure this file's header is written against —
	 * recommending a man the box score already contradicted.
	 *
	 * It arrives on a DATE with no code change: the shipped capture is 2026-09-08 and the
	 * fortnight runs out on 2026-09-21. The header already said the page should say so; this
	 * is the number it says it with.
	 */
	uncoveredDays: number
}

const DAY = 86_400_000
const MAX_LOOKBACK_DAYS = 14

/**
 * HOW MANY DAYS OF MOVES NEITHER SOURCE COVERS.
 *
 * The window starts a day before the capture so a move made on the morning of the capture is
 * picked up, and it is floored at a fortnight ago because a transactions feed cannot fix a
 * capture older than that. When the floor overtakes the capture, the two stop meeting: the
 * patch begins after the capture ends, and every placement and return in the gap is invisible
 * while the capture's own entry stays authoritative.
 *
 * Rounded DOWN, so a few hours of overlap is never reported as a day of blindness, and zero
 * whenever the window still bridges — which is the ordinary case and the one that must print
 * nothing at all.
 *
 * Exported and pure because it arrives on a DATE rather than on a change to any code — the
 * shipped capture is 2026-09-08 and the fortnight runs out on 2026-09-21 — and a thing that
 * changes by itself has to be assertable without waiting for it.
 */
export const uncoveredDaysOf = (capturedAt: string | undefined, now: number): number => {
	const from = capturedAt ? Date.parse(capturedAt) : NaN
	if (!Number.isFinite(from)) return 0
	const floor = now - MAX_LOOKBACK_DAYS * DAY
	return floor > from - DAY ? Math.max(0, Math.floor((floor - (from - DAY)) / DAY)) : 0
}

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
		loading: true,
		uncoveredDays: 0
	})

	// The window is derived from the capture's own timestamp, so a fresh snapshot
	// asks for a day and a stale one asks for a fortnight. Keyed on the DATE rather
	// than the instant so this does not re-fire on every render.
	const from = capturedAt ? Date.parse(capturedAt) : NaN
	const floor = Date.now() - MAX_LOOKBACK_DAYS * DAY
	const since = (() => {
		const start = Number.isFinite(from) ? Math.max(from - DAY, floor) : floor
		return localDate(new Date(start))
	})()
	const uncoveredDays = uncoveredDaysOf(capturedAt, Date.now())
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
				loading: false,
				uncoveredDays
			})
		})
		return () => {
			live = false
		}
		// `captured` is a fresh Map on every hydrate, so it cannot be a dependency —
		// the request depends on the WINDOW, and the merge is done against whatever
		// map was current when the answer arrived.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [since, until, !!captured, uncoveredDays])

	return state
}
