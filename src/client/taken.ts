import { type } from "arktype"
import { stored, saidPlainly, storageFor } from "./stores.ts"

/**
 * WHO IS ALREADY OWNED IN YOUR LEAGUE — read, not estimated.
 *
 * Every other answer this app has to "can I add him" is an approximation of this one.
 * The free-agent sweep reads Yahoo's player table twenty-five rows deep per position, so
 * the addable universe it produces is Yahoo's own top ~225 by their rank and everyone
 * below that is invisible to it. Without a sweep the board falls back to `ownershipCut`
 * and `likelyAvailable`, which locate the boundary in a capture's rostered-share column:
 * measured on the committed capture that calls 1,010 of 1,248 rateable men gettable where
 * the derived wire calls 540.
 *
 * The union of the league's own rosters is neither capped nor estimated. It is the set,
 * for this league, on the day it was read — and its complement against the snapshot is
 * every man a reader could actually put in a seat.
 *
 * ALL OR NOTHING, which is the rule the whole store is shaped around. A union missing one
 * roster is not a slightly smaller answer: it is that team's twenty-seven men reported as
 * free, and rostered men rank at the TOP, so they would head the board — the failure
 * `likelyAvailable` already records on Blake Snell. `readGrabs` refuses to call a partial
 * read complete and nothing here is written unless it is.
 *
 * WHAT IS STORED IS WHAT WAS READ. The taken men, per team, not the complement: the
 * complement is one pass against a snapshot every consumer already holds, and storing it
 * would be storing a list nobody read. Keeping it per TEAM rather than as one flat set is
 * what lets a screen name a counterparty — who owns the man you want — instead of only
 * saying that somebody does.
 *
 * Perishable like the pool, and stamped the same way: one rival's waiver claim invalidates
 * a row of it, so nothing here is presented without its age.
 */
const STORE_KEY = "beanemachine:taken"

export class TakenError extends Error {}

const Entry = type({
	/** ISO instant the read happened. Required, for the same reason the pool's is: a list
	 *  this perishable cannot be presented without saying how old it is. */
	at: "string > 0",
	/** The league id this was read FOR, so a list can never be served to a different
	 *  league that happens to be filed under the same name in this browser. */
	leagueId: "string > 0",
	/** `id:group` keys per team id — the same key the roster store holds, so a two-way
	 *  player is one man on one team. */
	byTeam: { "[string]": "string[]" },
	/** Which teams were read, and which were asked for. Both are kept because the second
	 *  is what makes "complete" checkable by anything that reads this back. */
	teamsRead: "string[]",
	teamsAsked: "string[]",
	/** The reader's own account of what happened, quoted rather than re-summarised. */
	note: "string"
})

const Stored = type({ "[string]": Entry })
type Stored = typeof Stored.infer

/** Exported so the shape can be checked from both ends without a browser, the way
 *  `StoredPoolShape` is. */
export const StoredTakenShape = Entry
export type StoredTaken = typeof Entry.infer

const storage = (): Storage => storageFor("who is taken in your league", TakenError)

/**
 * An unreadable list is DISCARDED rather than surfaced — the pool's rule, and for a
 * stronger reason. A garbled pool costs the reader a list he can re-read in one press; a
 * garbled taken list would mark real free agents as owned and hide them, silently, from
 * every screen. Nothing reaches a consumer that did not validate.
 */
const read = (): Stored => {
	let raw: string | null
	try {
		raw = storage().getItem(STORE_KEY)
	} catch {
		return {}
	}
	if (raw === null) return {}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return {}
	}
	const out = Stored(parsed)
	return out instanceof type.errors ? {} : out
}

const write = (next: Stored): Stored => {
	const out = Stored(next)
	if (out instanceof type.errors)
		throw new TakenError(`Refusing to store an invalid taken list:\n${out}`)
	try {
		storage().setItem(STORE_KEY, JSON.stringify(out))
		// tell the screens to look again — see src/client/stores.ts
		stored()
	} catch (e) {
		throw new TakenError(`This browser refused to store who is taken: ${saidPlainly(e)}`)
	}
	return out
}

const of = (league: string): StoredTaken | null => read()[league] ?? null

const byLeagueId = (leagueId: string): StoredTaken | null => {
	for (const entry of Object.values(read())) if (entry.leagueId === leagueId) return entry
	return null
}

/** A read is the whole truth about that league's rosters, so it replaces rather than
 *  merges: a man dropped since the last read has to be able to LEAVE the taken set, and a
 *  merge could never remove anybody. */
const set = (league: string, entry: StoredTaken): StoredTaken => {
	const now = read()
	return write({ ...now, [league]: entry })[league]!
}

const clear = (league: string): null => {
	const { [league]: _, ...kept } = read()
	write(kept)
	return null
}

/** Every taken man in one set, which is what a consumer asking "can I add him" wants. */
export const takenKeys = (entry: StoredTaken | null): Set<string> =>
	new Set(Object.values(entry?.byTeam ?? {}).flat())

/** Which team holds him, where one does. This is the field that makes a counterparty
 *  nameable: "he is on team 4" is a different sentence from "somebody has him". */
export const ownerOf = (entry: StoredTaken | null, key: string): string | null => {
	for (const [team, keys] of Object.entries(entry?.byTeam ?? {}))
		if (keys.includes(key)) return team
	return null
}

export const taken = { of, byLeagueId, set, clear }
