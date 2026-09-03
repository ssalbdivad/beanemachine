import { type } from "arktype"
import { ApiError } from "./api.ts"

/**
 * Which players are actually mine, per league.
 *
 * A roster is only meaningful inside one league — the same twelve players fill a
 * different set of slots, against a different replacement level, in a league next
 * door — so it is stored under the league's own key rather than as one global
 * team. Switching leagues switches rosters; it never carries one across.
 *
 * Same place and same rules as leagues.ts: this browser is the store, the shape
 * is validated by ArkType before it is written and again after it is read, and a
 * store that can't be read says so rather than being silently reseeded. Nothing
 * here is a copy of player data — only ids — so a roster stays correct as the
 * snapshot behind it is recaptured.
 */
const STORE_KEY = "beanemachine:roster"

/** A stored roster is as much a source as the API, so its failures surface the same way. */
export class RosterError extends ApiError {}

/**
 * The id a rated row is keyed by — id AND side, because a two-way player is two
 * rated rows and only a roster knows which of them you hold.
 *
 * This has to agree with the `keyOf` inside `src/engine/trade.ts`, which the
 * engine keeps private. Drift is visible rather than silent: a key that matches
 * no rated row is reported by the UI as an id it cannot resolve, never dropped.
 */
export const rosterKey = (player: { id: number; group: string }): string =>
	`${player.id}:${player.group}`

const Stored = type({ "[string]": type(/^\d+:(hitting|pitching)$/).array() })
type Stored = typeof Stored.infer

/** Reaching localStorage at all throws in a private window, and setItem throws
 *  when the quota is full. Both are the store failing, so both read as one. */
const storage = (): Storage => {
	try {
		return window.localStorage
	} catch (e) {
		throw new RosterError(
			`This browser won't let the page use local storage (${(e as Error).message}), ` +
				`so there is nowhere to keep a roster. A private window usually does this.`
		)
	}
}

const read = (): Stored => {
	const raw = storage().getItem(STORE_KEY)
	if (raw === null) return {}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (e) {
		throw new RosterError(
			`The roster in this browser ("${STORE_KEY}") isn't valid JSON: ${(e as Error).message}`
		)
	}
	const out = Stored(parsed)
	// Repairing it would mean guessing which ids were meant, and a roster guessed
	// wrong prices every trade on this page. Say what's wrong and how to clear it.
	if (out instanceof type.errors)
		throw new RosterError(
			`The roster in this browser ("${STORE_KEY}") isn't a valid roster:\n${out}\n` +
				`Clear it to start again.`
		)
	return out
}

/** Validates before writing, so an invalid roster can never reach storage. */
const write = (next: Stored): Stored => {
	const out = Stored(next)
	if (out instanceof type.errors)
		throw new RosterError(`Refusing to store an invalid roster:\n${out}`)
	try {
		storage().setItem(STORE_KEY, JSON.stringify(out))
	} catch (e) {
		throw new RosterError(`This browser refused to store the roster: ${(e as Error).message}`)
	}
	return out
}

/** Every write starts from what is in storage right now: another tab may have
 *  moved it out from under us since this page rendered. */
const of = (league: string): string[] => read()[league] ?? []

const add = (league: string, key: string): string[] => {
	const stored = read()
	const held = stored[league] ?? []
	if (held.includes(key)) return held
	return write({ ...stored, [league]: [...held, key] })[league]!
}

const remove = (league: string, key: string): string[] => {
	const stored = read()
	const kept = (stored[league] ?? []).filter(k => k !== key)
	return write({ ...stored, [league]: kept })[league]!
}

/**
 * Replace this league's roster outright — what reading it off Yahoo does.
 *
 * Adding twenty-four keys one at a time would write the store twenty-four times
 * and, worse, would MERGE with whatever is already there: re-reading a roster
 * after a trade would leave the players you no longer own still on the team. A
 * read is the whole truth about that team, so it replaces rather than accumulates.
 * Duplicates are dropped, and every other league's roster is left alone.
 */
const set = (league: string, keys: string[]): string[] => {
	const stored = read()
	return write({ ...stored, [league]: [...new Set(keys)] })[league] ?? []
}

/** Drops this league's roster and leaves every other league's alone. */
const clear = (league: string): string[] => {
	const { [league]: _, ...kept } = read()
	write(kept)
	return []
}

/**
 * The way back from a store too broken to read — the same escape hatch
 * `leagues.replace` is. `clear` has to parse first so it can leave the other
 * leagues' rosters alone, which means it cannot run on the store that most needs
 * clearing; this one removes the key outright and reads nothing. It is only ever
 * offered next to the error saying what was wrong, so no readable roster is
 * discarded without the reader being told why.
 */
const reset = (): void => {
	try {
		storage().removeItem(STORE_KEY)
	} catch (e) {
		throw new RosterError(`This browser refused to clear the roster: ${(e as Error).message}`)
	}
}

export const roster = { of, add, set, remove, clear, reset }
