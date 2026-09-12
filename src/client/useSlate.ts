import { useEffect, useRef, useState } from "react"
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
 * server, no key and no proxy — one request, for the whole league.
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

/**
 * How often the evening is re-read.
 *
 * It used to be read ONCE, on mount, and that was the whole of it. Measured by
 * installing the card at 18:40 and fast-forwarding three hours: the rendered text came
 * back byte-identical and not one further request was made. Instrumented
 * `window.setInterval`/`setTimeout` before first paint — one interval in the entire page,
 * belonging to Vite's dev client, and zero timeouts longer than ten seconds. Only a tab
 * round-trip re-mounted the card.
 *
 * An evening is precisely when a static read stops being good enough, and the two things
 * that change are the two a manager is waiting on. At 19:06 the card still said "next
 * lock 7:05pm" and still offered changes to seats that had shut. The 8:10pm game's
 * batting order posts around 7:10 — so the scratch he most wants to know about is the one
 * the page could never tell him, because it had already decided what tonight looked like
 * an hour before the order existed.
 *
 * Three minutes because the request is ONE read for the whole league, not one per player,
 * and because a lineup card posts about an hour before first pitch: three minutes is
 * under 5% of that hour, and twenty reads an hour against a public endpoint nobody is
 * paying for is polite by any reading. Paired with the visibility refetch below, a reader
 * who puts his phone down at 18:40 and picks it up at 19:30 gets tonight rather than
 * what tonight looked like fifty minutes ago.
 */
const POLL_MS = 180_000

/**
 * What about the evening would make a screen say something different.
 *
 * A poll that replaced the slate every three minutes would hand every consumer a new
 * object, and the Tonight card's memo re-rates 1,248 players when the slate changes. Most
 * polls bring back nothing new — the same fifteen games, the same unposted orders — so the
 * state is only replaced when one of the facts a screen renders has actually moved.
 *
 * `state` is in here and is load-bearing beyond its own text: it is what flips from
 * "Pre-Game" to "In Progress" at first pitch, which is the moment a seat stops being
 * changeable. So the signature changing is how the card learns, within one poll, that a
 * lock has passed. The sizes of the four sets cover a lineup being posted, a probable
 * being named and a game being called off; the per-game list covers a probable being
 * CHANGED rather than added, which a size alone would miss.
 */
const signature = (s: Slate): string =>
	[
		s.games.length,
		s.called.size,
		s.playing.size,
		s.postedFor.size,
		s.battingOrder.size,
		s.probables.size,
		s.games
			.map(g => `${g.gamePk}:${g.state}:${g.homeProbable ?? ""}:${g.awayProbable ?? ""}:${g.posted ? 1 : 0}`)
			.join(",")
	].join("|")

export const useSlate = (date: string = localDate()): SlateState => {
	const [state, setState] = useState<SlateState>({ slate: null, error: null, loading: true })
	/** The last signature handed to React, so an unchanged evening costs no re-render.
	 *  A ref rather than state, because comparing it must not itself cause one. */
	const seen = useRef<string | null>(null)

	useEffect(() => {
		const ctl = new AbortController()
		let live = true
		seen.current = null

		const read = async () => {
			const { slate, error } = await fetchSlate(date, ctl.signal)
			if (!live) return
			/* An error REPLACES the slate with null, the way it always has: a page that
			   cannot check tonight must say so rather than go on rendering the last answer
			   as though it were current. A failed poll therefore clears a slate that was
			   working, which is the honest reading — "couldn't check" is true. */
			if (error) {
				seen.current = null
				setState({ slate: null, error, loading: false })
				return
			}
			const next = signature(slate)
			if (seen.current === next) return
			seen.current = next
			setState({ slate, error: null, loading: false })
		}

		void read()
		const every = setInterval(() => void read(), POLL_MS)
		/* A phone suspends timers in a background tab, so coming back is its own event and
		   not merely the next tick. Re-read immediately on return rather than waiting up to
		   three minutes, which is exactly the wait a reader notices. */
		const onVisible = () => {
			if (document.visibilityState === "visible") void read()
		}
		document.addEventListener("visibilitychange", onVisible)

		return () => {
			live = false
			clearInterval(every)
			document.removeEventListener("visibilitychange", onVisible)
			ctl.abort()
		}
	}, [date])

	return state
}
