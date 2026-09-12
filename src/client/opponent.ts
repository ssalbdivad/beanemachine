import { type } from "arktype"
import { ApiError } from "./api.ts"
import { stored, storageFor } from "./stores.ts"

/**
 * WHO YOU ARE PLAYING THIS WEEK, because the app could not answer the one question a
 * head-to-head manager asks most.
 *
 * "Am I winning?" has had no answer here and the Tonight card says so in its own words: it
 * reads tonight's schedule, the posted orders and the injured list, and knows nothing about the
 * matchup or the score. That absence was correct — Yahoo stopped answering the read that could
 * have supplied it (commit de44045), there is no backend, and nothing in this app may invent a
 * rival roster.
 *
 * What it CAN do is the same thing it already does for the reader's own team: be told. A
 * roster pasted or typed is how this app learns everything, and an opponent's roster is the
 * same gesture against a different name. With it, `src/data/actuals.ts` prices both sides over
 * the league's own scoring period from MLB's day-by-day record, and the answer is arithmetic
 * rather than a model.
 *
 * WHAT IT IS NOT, and the UI is required to say so on both surfaces. It is not the score.
 * Yahoo pays only the men in a lineup; this page cannot see his lineups and cannot see the
 * reader's past ones either. So the number is every man each side HOLDS, which is the same
 * measure on both sides — the comparison is fair in the way that matters even though neither
 * figure is what the league will pay. A reader who wants the score opens Yahoo; a reader who
 * wants to know whether to chase a two-start arm tonight wants this.
 *
 * Ids only, never player data, and keyed per league for the same reason `roster.ts` is: the
 * same twelve men are a different team in a different league, and an opponent belongs to one
 * matchup in one of them.
 */
const STORE_KEY = "beanemachine:opponent"

export class OpponentError extends ApiError {}

/** Same shape as the roster store, deliberately: one list of `id:group` keys per league. Two
 *  stores that hold the same kind of thing should be readable by the same eye. */
const Stored = type({ "[string]": type(/^\d+:(hitting|pitching)$/).array() })
type Stored = typeof Stored.infer

/** Shared with the other stores — see `storageFor` in stores.ts. */
const storage = (): Storage => storageFor("your opponent's team", OpponentError)

const read = (): Stored => {
	const raw = storage().getItem(STORE_KEY)
	if (raw === null) return {}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		/* Forgiving, like the LINEUP store and unlike the roster: an opponent is re-pasted in
		   one gesture and costs nothing to lose, whereas losing a roster means retyping a team.
		   Discarded rather than surfaced, because an error a reader has to act on about a
		   convenience he may not even be using is worse than the convenience being absent. */
		return {}
	}
	const out = Stored(parsed)
	return out instanceof type.errors ? {} : out
}

const write = (next: Stored): Stored => {
	const out = Stored(next)
	if (out instanceof type.errors)
		throw new OpponentError(`Refusing to store an invalid opponent:\n${out}`)
	try {
		storage().setItem(STORE_KEY, JSON.stringify(out))
		// tell the screens to look again — see src/client/stores.ts
		stored()
	} catch (e) {
		throw new OpponentError(`This browser refused to store your opponent: ${(e as Error).message}`)
	}
	return out
}

const of = (league: string): string[] => read()[league] ?? []

/** A paste is the whole truth about his team, so it replaces rather than merges. */
const set = (league: string, keys: string[]): string[] =>
	write({ ...read(), [league]: [...new Set(keys)] })[league] ?? []

const clear = (league: string): void => {
	const { [league]: _, ...kept } = read()
	write(kept)
}

export const opponentStore = { of, set, clear }
