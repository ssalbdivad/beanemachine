import { type } from "arktype"
import type { Filters } from "./useBoard.ts"

/**
 * Which question the reader was last asking.
 *
 * The board opens on "This fortnight" for everybody, every time. For a reader who
 * came back to do the thing this app is for — check the wire before the reset —
 * that is a click and a window chip of tax on every visit, and it is the same two
 * clicks he paid yesterday.
 *
 * Remembering is better than changing the default, because the default is a guess
 * about a stranger and this is a fact about him. It also avoids the trap the other
 * direction: hardcoding "stream" would be wrong for somebody who uses the fortnight
 * board, and there is no way to know which he is until he tells you by clicking.
 *
 * Only the QUESTION is remembered — mode, window, and how many moves he has. Not
 * the filters: a search string or a position chip left over from last week is a
 * board that opens narrowed for a reason the reader cannot see, which is the same
 * defect as a hidden filter and this project has already been bitten by it once.
 */
const STORE_KEY = "beanemachine:view"

const Stored = type({
	"mode?": "'stream' | 'board' | 'stash'",
	"days?": "number | null",
	"moves?": "number"
})
type Stored = typeof Stored.infer

/** A remembered view is a convenience, never a source. Anything unreadable is
 *  discarded silently and the reader gets the default — unlike the roster store,
 *  where losing it means retyping a team. */
export const readView = (): Stored => {
	try {
		const raw = window.localStorage.getItem(STORE_KEY)
		if (raw === null) return {}
		const out = Stored(JSON.parse(raw))
		return out instanceof type.errors ? {} : out
	} catch {
		return {}
	}
}

export const writeView = (f: Pick<Filters, "mode" | "days" | "moves">): void => {
	try {
		window.localStorage.setItem(
			STORE_KEY,
			JSON.stringify({ mode: f.mode, days: f.days, moves: f.moves })
		)
	} catch {
		// a browser that refuses storage still gets a working board; this is the one
		// store whose failure costs the reader nothing
	}
}
