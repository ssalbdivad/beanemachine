/**
 * Who went on the injured list since the capture, and who came off it.
 *
 * `data/snapshot.json` carries an injury map — 198 players when this was written —
 * read from MLB's roster endpoints at capture time. It is right on the day it is
 * built and wrong every day after, and it is wrong in the direction that costs most:
 * a man placed on the IL yesterday is still, to the shipped file, available to start
 * tonight. Recommending him is the single failure that turns a reader into an
 * anti-user — the complaint people actually make about fantasy tools is never "your
 * model is wrong", it is "you told me something the box score already contradicted".
 *
 * MLB publishes every roster move on one endpoint, and it answers a browser:
 *
 *   https://statsapi.mlb.com/api/v1/transactions?sportId=1&startDate=..&endDate=..
 *
 * Measured 2026-09-10 with `Origin: https://beanemachine.com`: HTTP 200,
 * `access-control-allow-origin: *`, 72 KB and about a fifth of a second for five
 * days. `sportId=1` is not optional — without it the rows are minor-league noise.
 *
 * The one uncomfortable thing here is that the payload's structured fields say
 * "Status Change" and nothing more; which status, and to what, is only in the
 * English sentence. So this file reads that sentence, and it reads it
 * CONSERVATIVELY: a description it cannot match confidently changes nothing. The
 * capture stays authoritative unless MLB has said, in words this file recognises,
 * that it is out of date. Being silently unchanged is the correct failure; guessing
 * from a sentence is not.
 */

/** What MLB writes when a man goes on, and when he comes off. Both forms carry the
 *  list's length, which is the part a reader can act on — a 10-day is a hole to
 *  cover, a 60-day is a roster spot to give up. */
const PLACED =
	/\bplaced\b[^.]*?\bon the (\d+)-day (?:injured list|il)\b/i
const TRANSFERRED = /\btransferred\b[^.]*?\bto the (\d+)-day (?:injured list|il)\b/i
const ACTIVATED = /\b(?:activated|reinstated)\b[^.]*?\bfrom the (?:\d+-day )?(?:injured list|il)\b/i

/** The trailing sentence MLB adds: "Right elbow discomfort." Worth keeping — the
 *  body part is what a reader uses to guess how long this lasts, and no projection
 *  can supply it. */
const AILMENT = /\.\s*([A-Z][^.]{2,60})\.\s*$/

export interface Move {
	playerId: number
	/** `"Injured 10-Day"`, spelled the way the snapshot's own map spells it, so the
	 *  two can be merged without a translation table. */
	status: string
	/** What MLB says is wrong, where it said. */
	note: string | null
	/** The day the move took effect, not the day it was published. */
	on: string
}

export interface Moves {
	/** Men who went ON the list since the capture. */
	placed: Map<number, Move>
	/** Men who came OFF it. These have to be REMOVED from the snapshot's map, or a
	 *  returning star stays benched by a file that is a week old. */
	activated: Map<number, string>
	/** Every row that was a status change and that this file could not read. Counted,
	 *  not hidden: a parser that silently ignores half the feed and a parser that has
	 *  nothing to do look identical from outside. */
	unparsed: number
}

interface RawTx {
	person?: { id?: number }
	typeCode?: string
	description?: string
	effectiveDate?: string
	date?: string
}

const EMPTY: Moves = { placed: new Map(), activated: new Map(), unparsed: 0 }

export const readMoves = (json: unknown): Moves => {
	const rows = (json as { transactions?: RawTx[] } | null)?.transactions
	if (!Array.isArray(rows)) return { placed: new Map(), activated: new Map(), unparsed: 0 }

	const placed = new Map<number, Move>()
	const activated = new Map<number, string>()
	let unparsed = 0

	// In feed order, so the LAST word on a player wins: a man placed on Monday and
	// activated on Thursday is active, and one activated and then placed again is not.
	for (const r of rows) {
		const id = r.person?.id
		const text = r.description ?? ""
		if (typeof id !== "number" || !text) continue
		const on = r.effectiveDate ?? r.date ?? ""

		const off = ACTIVATED.exec(text)
		if (off) {
			activated.set(id, on)
			placed.delete(id)
			continue
		}
		const hit = PLACED.exec(text) ?? TRANSFERRED.exec(text)
		if (hit) {
			activated.delete(id)
			placed.set(id, {
				playerId: id,
				status: `Injured ${hit[1]}-Day`,
				note: AILMENT.exec(text)?.[1] ?? null,
				on
			})
			continue
		}
		// Only status changes are this file's business. An option, a recall or a
		// waiver claim is a real move and not an injury, and counting them as
		// unreadable would make the number below meaningless.
		if (r.typeCode === "SC" && /injured list|\bil\b/i.test(text)) unparsed++
	}
	return { placed, activated, unparsed }
}

export const TRANSACTIONS_URL = (start: string, end: string): string =>
	`https://statsapi.mlb.com/api/v1/transactions?sportId=1&startDate=${start}&endDate=${end}`

/** The same five-second rule the slate reads under: this is an overlay on data that
 *  already works, and a reader must never wait on it. */
const TIMEOUT_MS = 5_000

export const fetchMoves = async (
	start: string,
	end: string,
	signal?: AbortSignal,
	timeoutMs: number = TIMEOUT_MS
): Promise<{ moves: Moves; error: string | null }> => {
	const deadline = AbortSignal.timeout(timeoutMs)
	const abort = signal ? AbortSignal.any([signal, deadline]) : deadline
	try {
		const res = await fetch(TRANSACTIONS_URL(start, end), { signal: abort })
		if (!res.ok) return { moves: EMPTY, error: `MLB answered HTTP ${res.status}` }
		return { moves: readMoves(await res.json()), error: null }
	} catch (e) {
		return {
			moves: EMPTY,
			error:
				deadline.aborted ?
					`MLB did not answer within ${timeoutMs / 1000}s`
				:	(e as Error).message
		}
	}
}

/**
 * The capture's injury map, brought up to date.
 *
 * Additive in both directions and neither is optional. Adding the new placements is
 * the obvious half; REMOVING the activations is the half that gets forgotten, and it
 * is the one that keeps a returning star on the bench of a page reading a file from
 * last Tuesday.
 *
 * The snapshot is never mutated — the caller may hold it across renders — and where
 * the feed said nothing the capture is left exactly as it was.
 */
export const withMoves = (
	captured: Map<number, string>,
	moves: Moves
): Map<number, string> => {
	const out = new Map(captured)
	for (const id of moves.activated.keys()) out.delete(id)
	for (const [id, m] of moves.placed) out.set(id, m.status)
	return out
}
