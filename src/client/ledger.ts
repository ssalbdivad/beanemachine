import { type } from "arktype"
import { stored, storageFor } from "./stores.ts"
import { ApiError } from "./api.ts"

/**
 * WHAT BILLY SAID, AND WHEN HE SAID IT.
 *
 * This is the only store in the app whose contents cannot be rebuilt. A roster can be
 * re-pasted, a league re-imported, a board recomputed from the capture — but what the
 * app recommended on the 8th, priced against the projections it held on the 8th, exists
 * nowhere else the moment the capture is replaced. So it is written at the moment the
 * advice is given and never recomputed afterwards.
 *
 * THE REASON IT EXISTS. `src/auto/recap.ts` can already say what your men scored and
 * what the best lineup would have scored, both from public data and with no history at
 * all. What it cannot do without a record is the thing that actually earns trust: score
 * BILLY against the lineup you already had. That comparison is only honest if the
 * recommendation was captured before the games were played, because a recommendation
 * reconstructed afterwards is reconstructed from numbers that now include the answer.
 * Recording it in advance is the difference between a claim and a backtest.
 *
 * WHAT IT DELIBERATELY DOES NOT RECORD. Whether you took the advice. The app has no way
 * to know, and a screen that said "you ignored Billy on Tuesday" would be inventing it.
 * The record supports exactly one sentence — "these are the seats Billy asked for, and
 * this is what those men did" — and the grading in recap.ts is written to say no more.
 */
const STORE_KEY = "beanemachine:ledger"

/** History is the one thing in here that cannot be re-read from anywhere, so a damaged
 *  ledger is surfaced like an unreadable roster rather than discarded like a stale seat. */
export class LedgerError extends ApiError {}

const Side = type({
	/** `id:group` — the same key `rosterKey` and `src/data/actuals.ts` use. */
	key: "string > 0",
	name: "string > 0",
	/** The seat asked for, or the seat left, depending on which side of the entry. */
	slot: "string | null",
	/** What the projection said at the time, kept so a grade can show both numbers. */
	projected: "number | null"
})

const Entry = type({
	/** The reader's own calendar date, which is the unit a slate and a lineup live in. */
	date: /^\d{4}-\d{2}-\d{2}$/,
	/** When this was written, so the screen can say how late in the day it was asked. */
	at: "string",
	/** The lineup Billy asked for. */
	start: Side.array(),
	/** The men it asked to sit, with what it expected of them. */
	sit: Side.array(),
	/** The lineup that was already in place when it was asked, where the seats were
	 *  known. Empty when they were not — and then no comparison is offered at all. */
	had: Side.array(),
	/** Adds and drops proposed that day, names only: a move is graded by what the man
	 *  did, and the board that priced him is gone by the time it is graded. */
	moves: type({ add: "string", drop: "string | null" }).array()
})

export type LedgerEntry = typeof Entry.infer

const Stored = type({ "[string]": Entry.array() })
type Stored = typeof Stored.infer

/**
 * How many days of history one league keeps.
 *
 * A season is about 185 days and an entry is roughly 1.5 KB with a full roster in it, so
 * an uncapped ledger reaches a quarter of a megabyte in one league and localStorage is a
 * few megabytes for the whole origin — shared with the capture-derived stores. Sixty
 * days is two months of evidence, which is long enough for a record to mean something
 * and short enough that a reader with four leagues is nowhere near the ceiling.
 *
 * Oldest first out, and the UI is required to say what the window is rather than let a
 * silently-truncated record read as a complete one.
 */
export const KEEP_DAYS = 60

/** Shared with the other three stores — see `storageFor` in stores.ts. The noun stays
 *  this store's own, because "a record of what was recommended" is the only phrasing a
 *  reader who has never opened the history would recognise. */
const storage = (): Storage => storageFor("a record of what was recommended", LedgerError)

const read = (): Stored => {
	const raw = storage().getItem(STORE_KEY)
	if (raw === null) return {}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		throw new LedgerError("The record this browser saved of past advice is damaged and cannot be read back.")
	}
	const out = Stored(parsed)
	// Repairing it would mean guessing which recommendations were made, and a guessed
	// recommendation graded against real results is the one output this store must never
	// produce. Say what's wrong and let the reader clear it.
	if (out instanceof type.errors)
		throw new LedgerError(
			`The record this browser saved of past advice is not in a shape this page can read:\n${out}\n` +
				`Clearing it loses the history and nothing else.`
		)
	return out
}

const write = (next: Stored): Stored => {
	const out = Stored(next)
	if (out instanceof type.errors) throw new LedgerError(`Refusing to store an invalid record:\n${out}`)
	try {
		storage().setItem(STORE_KEY, JSON.stringify(out))
		// tell the screens to look again — see src/client/stores.ts
		stored()
	} catch (e) {
		throw new LedgerError(`This browser refused to store the record: ${(e as Error).message}`)
	}
	return out
}

const of = (league: string): LedgerEntry[] => read()[league] ?? []

/**
 * One entry per league per day, replaced while the day is still open.
 *
 * A reader who opens the app at two in the afternoon and again at half past six is asked
 * twice, and the second answer is better: by then the lineups are posted and a scratch
 * is known. The later one therefore wins, and `at` carries the time so the screen can
 * say WHEN it was asked rather than implying the advice stood all day.
 *
 * Writing is skipped outright when the entry would say nothing — no lineup asked for and
 * no move proposed — because a day the app was opened and had nothing to suggest is not
 * evidence about anything, and padding the record with empty days would flatter the
 * record's own denominator.
 */
const record = (league: string, entry: LedgerEntry): LedgerEntry[] => {
	if (!entry.start.length && !entry.moves.length) return of(league)
	const all = read()
	const kept = (all[league] ?? []).filter(e => e.date !== entry.date)
	const next = [...kept, entry]
		.sort((a, b) => a.date.localeCompare(b.date))
		.slice(-KEEP_DAYS)
	return write({ ...all, [league]: next })[league]!
}

const clear = (league: string): void => {
	const { [league]: _, ...kept } = read()
	write(kept)
}

const reset = (): void => {
	try {
		storage().removeItem(STORE_KEY)
		// tell the screens to look again — see src/client/stores.ts
		stored()
	} catch (e) {
		throw new LedgerError(`This browser refused to clear the record: ${(e as Error).message}`)
	}
}

export const ledgerStore = { of, record, clear, reset }
