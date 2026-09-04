import { type } from "arktype"

/**
 * The free agents in YOUR league, exactly as they were read — carried in a file.
 *
 * This is the store that closes the hosted site's last real gap. "Which starters
 * should I stream over the next three days" is a question about players you can
 * ADD, and the only list of those is your league's own free-agent page. Yahoo
 * sends no `access-control-allow-*` headers on it, so beanemachine.com is never
 * handed the response however hard it asks — `fetchAvailable` in
 * src/data/yahoo-pool.ts can read it, and only from a machine, not from a page.
 *
 * So the read happens once, locally, and travels: `src/cli.ts` writes it into
 * scoring.json under `pools`, `leagues.replace` puts it here, and `api.available`
 * serves it to the board. Nothing about the board changes — it already asks for a
 * pool and already prefers one over the ownership estimate; it simply now gets an
 * answer on a page that had none.
 *
 * Same rules as roster.ts and lineup.ts: this browser is the store, the shape is
 * validated going in and coming out, and every entry is stamped with WHEN it was
 * read. That stamp is not decoration. A free-agent list is the most perishable
 * thing this app holds — one rival's waiver claim invalidates a row of it — so a
 * pool that is presented without its age is presenting last Tuesday's wire as
 * today's. Everything below carries the timestamp with the data so no consumer
 * has the option of forgetting it.
 *
 * It deliberately does NOT import from api.ts. roster.ts and lineup.ts both take
 * `ApiError` from there, which is fine because nothing in api.ts imports them
 * back; api.ts DOES import this module, and a class declared with `extends
 * ApiError` is evaluated at module scope, so the cycle would hit `ApiError` in its
 * temporal dead zone and take the whole bundle down.
 */
const STORE_KEY = "beanemachine:pool"

export class PoolError extends Error {}

/** One free agent, as Yahoo's own player page prints him. No stats and no rating:
 *  those are computed from the snapshot against your league, and a pool that
 *  carried its own numbers would be a second, staler answer to a question the
 *  engine already answers. */
const Player = type({
	yahooId: "string > 0",
	name: "string > 0",
	team: "string | null",
	positions: "string[]"
})

const Entry = type({
	/** ISO instant the read happened. Required — a pool with no timestamp cannot be
	 *  told from a fresh one, and the UI's whole claim here is that it can say how
	 *  old this is. */
	at: "string > 0",
	/** The league id this was read FOR. The store is keyed by league KEY, which is
	 *  a name in this browser; the board asks by league id, which is the league's
	 *  own. Keeping both means a pool can never be served for the wrong league
	 *  because two browsers happened to name their leagues the same way. */
	leagueId: "string > 0",
	players: Player.array(),
	/** Which roster slots were swept, so "he isn't in the pool" can be told from
	 *  "his position was never read". */
	positionsRead: "string[]",
	/** The reader's own account of what it got, quoted rather than re-summarised. */
	note: "string"
})

const Stored = type({ "[string]": Entry })
type Stored = typeof Stored.infer

/**
 * Exported so the contract can be checked from BOTH ends without a browser.
 *
 * `src/cli.ts` writes these entries into scoring.json on a machine, and this
 * module validates them coming out of a file in a browser — two files, no shared
 * code path, and nothing but a suite to notice if they drift. test/leagues.mjs
 * runs the CLI's own output shape through this, so a rename on either side fails
 * in node rather than silently producing a file the page throws away.
 */
export const StoredPoolShape = Entry

export type StoredPool = typeof Entry.infer

/** Reaching localStorage at all throws in a private window, and setItem throws
 *  when the quota is full. Both are the store failing, so both read as one. */
const storage = (): Storage => {
	try {
		return window.localStorage
	} catch (e) {
		throw new PoolError(
			`This browser won't let the page use local storage (${(e as Error).message}), ` +
				`so there is nowhere to keep your league's free agents.`
		)
	}
}

/**
 * An unreadable pool is DISCARDED rather than surfaced, which is what lineup.ts
 * does and the opposite of what roster.ts does. The rule is whether losing it
 * costs the reader anything they cannot get back: a roster is typed in by hand and
 * must never be thrown away silently, whereas a pool is one command away and is
 * worthless the moment it is doubted. What must not happen is a garbled pool
 * reaching the board as if it were read — every path out of here is validated.
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

/** Validates before writing, so an invalid pool can never reach storage — and a
 *  file carrying one is refused by this store rather than by a second copy of
 *  these rules living in leagues.ts. */
const write = (next: Stored): Stored => {
	const out = Stored(next)
	if (out instanceof type.errors) throw new PoolError(`Refusing to store an invalid pool:\n${out}`)
	try {
		storage().setItem(STORE_KEY, JSON.stringify(out))
	} catch (e) {
		throw new PoolError(`This browser refused to store the free-agent pool: ${(e as Error).message}`)
	}
	return out
}

const of = (league: string): StoredPool | null => read()[league] ?? null

/**
 * The pool for a league ID rather than a league key.
 *
 * `api.available` is handed a league id and nothing else — it is the same call the
 * server takes — so this is the lookup that lets a carried pool answer it without
 * every caller learning about league keys. The id is matched, never the key, so a
 * pool read for league 228947 cannot be served to a league that merely happens to
 * be filed under the same name in this browser.
 */
const byLeagueId = (leagueId: string): StoredPool | null => {
	for (const entry of Object.values(read())) if (entry.leagueId === leagueId) return entry
	return null
}

/** A read is the whole truth about that league's wire, so it replaces rather than
 *  merges: a player claimed off waivers since the last read has to be able to
 *  LEAVE the pool, and a merge could never remove anybody. */
const set = (league: string, entry: StoredPool): StoredPool => {
	const stored = read()
	return write({ ...stored, [league]: entry })[league]!
}

const clear = (league: string): null => {
	const { [league]: _, ...kept } = read()
	write(kept)
	return null
}

/**
 * How long ago, in words, plus the raw hours so a caller can decide what to do
 * about it.
 *
 * Deliberately NOT `freshness` from panels.tsx, which answers the same question
 * for the MLB capture and calls 36 hours the line. That number was chosen for
 * observed player data, which changes once a day when the games end. A free-agent
 * list changes whenever anybody in the league clicks Add, so the two would want
 * different thresholds — and rather than have this file assert a threshold it
 * cannot measure, it returns the age and states no verdict. The one caller that
 * wants a verdict (the masthead chip) declares its own line and says what it is.
 */
export const since = (at: string, now: number): { label: string; hours: number } => {
	const hours = (now - Date.parse(at)) / 3_600_000
	if (!Number.isFinite(hours)) return { label: "at an unreadable time", hours: NaN }
	if (hours < 0) return { label: "just now", hours: 0 }
	if (hours < 1) return { label: `${Math.max(1, Math.round(hours * 60))}m ago`, hours }
	if (hours < 48) return { label: `${Math.round(hours)}h ago`, hours }
	return { label: `${Math.round(hours / 24)}d ago`, hours }
}

export const pool = { of, byLeagueId, set, clear }
