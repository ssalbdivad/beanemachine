import { type } from "arktype"
import { stored } from "./stores.ts"
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
	"team?": "string | null"
})
const Stored = type({ "[string]": { at: "string", spots: Spot.array() } })
type Stored = typeof Stored.infer

export type StoredLineup = typeof Stored.infer[string]

const storage = (): Storage => {
	try {
		return window.localStorage
	} catch (e) {
		throw new LineupError(
			`This browser won't let the page use local storage (${(e as Error).message}), ` +
				`so there is nowhere to keep your lineup.`
		)
	}
}

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
		throw new LineupError(`This browser refused to store the lineup: ${(e as Error).message}`)
	}
	return out
}

const of = (league: string): StoredLineup | null => read()[league] ?? null

/** A read is the whole truth about that team, so it replaces rather than merges. */
const set = (league: string, spots: StoredLineup["spots"], at: string): StoredLineup => {
	const stored = read()
	return write({ ...stored, [league]: { at, spots } })[league]!
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
		throw new LineupError(`This browser refused to clear the lineup: ${(e as Error).message}`)
	}
}

export const lineupStore = { of, set, clear, reset }
