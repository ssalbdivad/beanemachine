import { type } from "arktype"
import { ApiError } from "./api.ts"
import { storageFor } from "./stores.ts"

/**
 * WHAT HE HAS TYPED AND NOT YET SENT.
 *
 * Every other store in this app holds an answer. This one holds an unfinished sentence,
 * and it exists because of a measured two minutes of somebody's evening.
 *
 * The setup sheet is rendered as `{docked && <Dock>…}` and `docked` is `onboarding ||
 * !league`. A first visit adopts the borrowed league the moment the reader does anything,
 * so a league EXISTS while he is still typing — and the sheet's own close handler ends the
 * onboarding state when there is a league to go back to. Escape, which is the gesture a
 * phone keyboard teaches, therefore unmounted the whole sheet. Eighteen lines typed, one
 * Escape, an empty box. src/client/Dock.tsx had already kept its children mounted across
 * open/close for exactly this reason; what it cannot do is survive its own parent going.
 *
 * KEEPING THE TEXT IS A BETTER FIX THAN KEEPING THE COMPONENT. A draft in this browser
 * survives Escape, Back, a tab press, a crashed tab, a phone that went to sleep and a
 * reader who came back tomorrow — none of which a mounted component survives.
 *
 * FORGIVING ON READ, unlike the roster and the ledger, and that is a deliberate asymmetry:
 * those two throw because a roster nobody can parse must not silently read as an empty
 * team. A draft that cannot be parsed is a convenience that did not work, and a screen
 * that refuses to render over it would have turned the smaller problem into the larger
 * one. Anything unreadable here is dropped and the box starts empty, which is exactly
 * where the reader would have been without this file.
 *
 * IT IS CLEARED ON SUCCESS. Once a box has been read into a roster or a scoring table, its
 * draft is gone: a box that re-offers text the app has already acted on invites the reader
 * to send it twice.
 */
const STORE_KEY = "beanemachine:typing"

export class TypingError extends ApiError {}

/** Which box, not which league — a league key is the outer key. `opponent` is on the
 *  recap card, the other two are on the setup sheet. */
export type Box = "team" | "settings" | "opponent"

/** `league key` → `box` → the text. Nested because a reader with two leagues set up has
 *  two half-typed teams, the same way he has two rosters. */
const Stored = type({ "[string]": { "[string]": "string" } })
type Stored = typeof Stored.infer

/** A draft is never worth more than the screen it is on. 64 KB is four times the longest
 *  roster page this app has been handed (a Yahoo settings page copied whole ran to 14 KB)
 *  and short enough that a pathological paste cannot fill a phone's quota on its own. */
const LIMIT = 64_000

const read = (): Stored => {
	let raw: string | null = null
	try {
		raw = storageFor("what you have typed", TypingError).getItem(STORE_KEY)
	} catch {
		return {}
	}
	if (!raw) return {}
	try {
		const out = Stored(JSON.parse(raw))
		return out instanceof type.errors ? {} : out
	} catch {
		return {}
	}
}

const write = (next: Stored): void => {
	try {
		storageFor("what you have typed", TypingError).setItem(STORE_KEY, JSON.stringify(next))
	} catch {
		/* A full phone, or a private window. The box keeps working; it just will not survive
		   being closed, which is where this feature started. Nothing is said to the reader:
		   he has lost nothing he can see, and a warning about a draft he has not lost yet
		   would be noise on the one screen that has to stay simple. */
	}
}

export const typingStore = {
	of: (leagueKey: string | null, box: Box): string => read()[leagueKey ?? ""]?.[box] ?? "",
	set: (leagueKey: string | null, box: Box, text: string): void => {
		const key = leagueKey ?? ""
		const all = read()
		const mine = { ...all[key] }
		if (!text) delete mine[box]
		else mine[box] = text.slice(0, LIMIT)
		const next = { ...all, [key]: mine }
		if (!Object.keys(mine).length) delete next[key]
		write(next)
	},
	clear: (leagueKey: string | null, box: Box): void => typingStore.set(leagueKey, box, "")
}
