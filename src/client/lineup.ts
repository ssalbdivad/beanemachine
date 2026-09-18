import { type } from "arktype"
import { stored, saidPlainly, storageFor } from "./stores.ts"
import { ApiError } from "./api.ts"

/**
 * Your team as your platform actually renders it — seat by seat.
 *
 * `roster.ts` stores which players are yours, as `id:group` keys, which is all the
 * board and the trade verdict need. The add/drop planner needs more: it decides
 * what to START and what to DROP, and both turn on which seat a man is currently
 * in. Handed a fabricated "BN" for everybody it would report points "sitting on
 * your bench" that nothing had established were benched — the exact class of
 * plausible, unsourced sentence `src/auto/plan.ts` refuses to produce.
 *
 * So the seats are stored as they were READ, in their own key rather than smuggled
 * into the id list, because they are a different kind of fact with a different
 * lifetime: ids stay true as the snapshot behind them is recaptured, whereas a
 * seat is only true until you next change your lineup. The card says when it was
 * read so a stale one is visible rather than silently authoritative.
 */
const STORE_KEY = "beanemachine:lineup"

export class LineupError extends ApiError {}

const Spot = type({
	slot: "string > 0",
	name: "string > 0",
	positions: "string[]",
	"team?": "string | null",
	/** Yahoo's own flag beside him — IL, IL+, NA, DTD, Q — where his page printed one.
	 *  Optional because every set of seats stored before this shipped has none, and
	 *  because a typed list of names has no page to read one from. */
	"status?": "string | null"
})
const Stored = type({
	"[string]": {
		at: "string",
		spots: Spot.array(),
		/**
		 * WHICH TEAM IN THE LEAGUE THESE SEATS ARE, when the reader's own browser read them.
		 *
		 * Optional because every set of seats stored before the browser reader existed was
		 * pasted, and a pasted page does not say which team it is — the reader knows, because
		 * he was looking at it. A read does say, in the URL, and the id is what lets the NEXT
		 * read refuse a page that is somebody else's team: "you are on another manager's
		 * roster" is a sentence this app can only say if it remembers whose roster it stored.
		 *
		 * It lives here rather than in a store of its own because it is a fact ABOUT these
		 * seats and arrived with them. A fourth store holding one string per league would be
		 * a fourth thing to clear, to migrate and to explain.
		 */
		"teamId?": "string | null"
	}
})
type Stored = typeof Stored.infer

export type StoredLineup = typeof Stored.infer[string]

/** Shared with the other three stores — see `storageFor` in stores.ts. This file's copy
 *  of the sentence was one of the three missing "A private window usually does this." —
 *  the half that names the likely cause — which it now gets. */
const storage = (): Storage => storageFor("your lineup", LineupError)

const read = (): Stored => {
	const raw = storage().getItem(STORE_KEY)
	if (raw === null) return {}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		// A lineup is re-read with one click, so an unreadable one is discarded
		// rather than surfaced as an error the reader has to act on. The ROSTER
		// store does the opposite, because losing that means retyping it.
		return {}
	}
	const out = Stored(parsed)
	return out instanceof type.errors ? {} : out
}

const write = (next: Stored): Stored => {
	const out = Stored(next)
	if (out instanceof type.errors) throw new LineupError(`Refusing to store an invalid lineup:\n${out}`)
	try {
		storage().setItem(STORE_KEY, JSON.stringify(out))
		// tell the screens to look again — see src/client/stores.ts
		stored()
	} catch (e) {
		throw new LineupError(`This browser refused to store the lineup: ${saidPlainly(e)}`)
	}
	return out
}

const of = (league: string): StoredLineup | null => read()[league] ?? null

/** A read is the whole truth about that team, so it replaces rather than merges. */
const set = (
	league: string,
	spots: StoredLineup["spots"],
	at: string,
	/** Only the reader's own browser knows this, and only off the URL it read. Absent on
	 *  every pasted team, which is most of them. */
	teamId?: string | null
): StoredLineup => {
	const stored = read()
	return write({
		...stored,
		[league]: teamId ? { at, spots, teamId } : { at, spots }
	})[league]!
}

/**
 * Drop this league's seats, and leave every other league's alone.
 *
 * Its first caller arrived on 2026-09-11. Until then `grep -rn lineupStore src/`
 * found this function referenced nowhere, and the consequence was measurable on
 * the dev server: paste twenty names into My league, press "Clear team", accept
 * the confirm, and `beanemachine:roster` became `{}` while this store kept all
 * 1,858 characters of its twenty spots. A seat is only true about the roster it
 * was read off, so it must not outlive it.
 */
const clear = (league: string): null => {
	const { [league]: _, ...kept } = read()
	write(kept)
	return null
}

/**
 * Every league's seats at once — the counterpart to `roster.reset`.
 *
 * `clear` has to parse the store before it can spare the other leagues, and the
 * one place that calls this is the escape hatch offered beside an unreadable
 * ROSTER: that path drops the whole roster key rather than one league's, so
 * clearing one league's seats here would leave every other league's seats
 * describing a roster that no longer exists. `read` is forgiving where roster.ts
 * throws, but "forgiving" is not the same as "cleared", so the key goes outright.
 */
const reset = (): void => {
	try {
		storage().removeItem(STORE_KEY)
		// tell the screens to look again — see src/client/stores.ts
		stored()
	} catch (e) {
		throw new LineupError(`This browser refused to clear the lineup: ${saidPlainly(e)}`)
	}
}

export const lineupStore = { of, set, clear, reset }
