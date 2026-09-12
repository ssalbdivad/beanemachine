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
 *
 * AND THE OTHER WAY A MAN CANNOT PLAY, which this file used to throw away.
 *
 * A comment here said, correctly, that "an option, a recall or a waiver claim is a
 * real move and not an injury" — and then dropped those rows, which left the board
 * ranking men who cannot appear in a major-league box score at all. Measured against
 * this endpoint for 2026-09-05 to 2026-09-12: 199 rows, of which 36 are options, 14
 * designations for assignment, 9 outrights and 5 releases. Sixty-four men the app was
 * still offering as pickups, and the cost is not a bad recommendation but a wasted
 * WAIVER CLAIM — one of six a week in the shipped league, spent on somebody who
 * cannot play.
 *
 * Those rows need no sentence reading at all, which is why this is safer than the
 * injury half: MLB gives each one a `typeCode`, so the two sets below are an
 * enumeration rather than a parse. The same conservatism holds — a code this file does
 * not list changes nothing — and `ASG` (a rehab assignment, which happens to a man
 * already on the injured list) and `SFA` (signed to a minor-league contract, which is
 * not a return to the majors) are deliberately in neither set.
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

/**
 * Out of the majors, by MLB's own type code, and what to call it.
 *
 * The strings are written to read after "MLB lists him", which is the frame
 * src/auto/plan.ts puts an unavailability in — so they are lower-case clauses rather
 * than the capture's noun-style "Injured 10-Day". A man in here cannot appear in a
 * major-league box score until a row in `BACK` says he can.
 */
const SENT: Record<string, string> = {
	OPT: "optioned to the minors",
	DES: "designated for assignment",
	OUT: "sent outright to the minors",
	REL: "released"
}

/**
 * Back on a major-league roster, which cancels anything in `SENT`.
 *
 * `CLW` is here because a claim off waivers ends the designation that preceded it. If
 * the claiming club then options him, a later `OPT` row wins — the loop below is in
 * feed order and the last word on a player is the one that counts.
 */
const BACK = new Set(["CU", "SE", "CLW"])

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
	/**
	 * Men MLB has put out of the majors since the capture, and what it called it.
	 *
	 * Kept apart from `placed` because they are different facts with different actions:
	 * an injured man is a hole to cover and may be back on Friday; an optioned man is
	 * not on a roster this league can use at all. They merge into one map for the
	 * ENGINE, whose only question is whether he can play.
	 */
	sent: Map<number, Move>
	/** Men who came back onto a major-league roster. Removed from `sent`, and from the
	 *  merged map, for the same reason activations are removed from the injury list. */
	back: Map<number, string>
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

const EMPTY: Moves = {
	placed: new Map(),
	activated: new Map(),
	sent: new Map(),
	back: new Map(),
	unparsed: 0
}

export const readMoves = (json: unknown): Moves => {
	const rows = (json as { transactions?: RawTx[] } | null)?.transactions
	if (!Array.isArray(rows))
		return { placed: new Map(), activated: new Map(), sent: new Map(), back: new Map(), unparsed: 0 }

	const placed = new Map<number, Move>()
	const activated = new Map<number, string>()
	const sent = new Map<number, Move>()
	const back = new Map<number, string>()
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
		/* OUT OF THE MAJORS, from the type code rather than from the sentence. In feed
		   order like everything above, so the last word on a player wins: optioned on
		   Monday and recalled on Thursday is available, recalled and then optioned is
		   not. */
		const code = r.typeCode ?? ""
		if (BACK.has(code)) {
			back.set(id, on)
			sent.delete(id)
			continue
		}
		const out = SENT[code]
		if (out) {
			back.delete(id)
			sent.set(id, { playerId: id, status: out, note: null, on })
			continue
		}
		// Only status changes are this file's business beyond that. Counting a rehab
		// assignment or a minor-league signing as unreadable would make the number
		// below meaningless — it exists to say how much of the INJURY feed this file
		// cannot read, and those rows are not injuries.
		if (code === "SC" && /injured list|\bil\b/i.test(text)) unparsed++
	}
	return { placed, activated, sent, back, unparsed }
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
	/* OUT OF THE MAJORS JOINS THE SAME MAP, and it joins it last.
	
	   The engine asks one question of this map — can he play — and the answer is no for
	   both kinds, so both belong in it. Last because a man can be both: placed on the
	   60-day list and then outrighted in the same week, and the outright is the later and
	   larger fact.
	
	   AND `back` IS NOT APPLIED HERE AT ALL, which took two attempts to get right.
	
	   The first version deleted every id in `back` from the map, by analogy with
	   `activated` — and that cleared INJURIES on a recall, which is a guess this file
	   refuses everywhere else. A man on the injured list is not "recalled", he is
	   ACTIVATED, and that is the row handled two lines above; a recall arriving about
	   somebody the capture lists as hurt is contradictory data, and reading it as "he is
	   healthy now" is inference, not reading. Its own test caught it.
	
	   The second version guarded the delete on the value being one of the demotion
	   strings — correct, and unreachable: `readMoves` already removes a recalled man from
	   `sent` in feed order, and the capture's map holds only injuries, so nothing in here
	   can carry a demotion before the loop below puts one there. Dead code with a
	   confident comment on it is worse than no code, so what is left is this paragraph:
	   `back` does its whole job in `readMoves`, and there is deliberately nothing for it
	   to do to the merged map. */
	for (const [id, m] of moves.sent) out.set(id, m.status)
	return out
}
