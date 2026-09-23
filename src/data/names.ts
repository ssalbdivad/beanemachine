/**
 * THE JOIN KEY FOR EVERY NAME MATCH IN THIS APP, in one place.
 *
 * Yahoo exposes its own player ids and never the MLBAM one, and a roster typed by hand
 * has no ids at all — so a normalised name is what joins a pasted team to the capture,
 * a free-agent list to the board, and an eligibility grid to a player. Nearly every
 * match in the product runs through it.
 *
 * It existed TWICE, verbatim and with no comment on either copy admitting the other:
 * once in src/data/yahoo-pool.ts for the capture and CLI path, once in
 * src/client/useBoard.ts for the browser. Verified byte-equal on all 1,446 names in the
 * committed capture and on four adversarial cases, so nothing was wrong — and that is
 * the point. `Decide.tsx` crosses both copies inside a single render: it imports the
 * client one and calls `planSwaps`, which uses the other. A one-character edit to
 * either would have silently stopped rosters matching the board, with no error and no
 * failing assertion until somebody noticed his own players missing.
 *
 * Every other duplicated rule in this repo carries a comment about the incident that
 * split it. This one did not, which is why it is the one worth lifting before it costs
 * anything. It lives here — a leaf module with no imports — because that is the only
 * place both a node script and a browser bundle can reach.
 *
 * The five transforms, in order, and each is load-bearing:
 *   NFD + combining marks   "José Ramírez" and "Jose Ramirez" are the same man, and a
 *                           reader typing on a phone keyboard writes the second
 *   lower case              "AARON JUDGE" off a copied table
 *   . ' and the curly '     "J.T. Realmuto", "O'Neill", and Yahoo's typographic quote
 *   a trailing suffix       Yahoo prints "Bobby Witt Jr." where MLB prints "Bobby Witt"
 *   collapsed whitespace    a paste carries tabs and double spaces
 */
export const normalizeName = (n: string): string =>
	n
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[.'’]/g, "")
		.replace(/\s+(jr|sr|ii|iii|iv)\.?$/i, "")
		.replace(/\s+/g, " ")
		.trim()

/**
 * WHAT A NORMALISED NAME IS NOT: A KEY.
 *
 * Every join in this app was `new Map(rows.map(r => [normalizeName(r.player.name), r]))`,
 * and a Map keeps the LAST row per key. Two men with one key therefore merged in silence,
 * and the merge is manufactured by `normalizeName` itself: stripping accents and a
 * trailing `Jr.` is what makes "Luis García Jr." and "Luis García" the same string.
 *
 * On the committed capture (data/snapshot.json, 1,446 players, re-derived 2026-09-22)
 * five keys collide:
 *   luis garcia   Luis García Jr. #671277 hitting 1B | Luis García #472610 pitching P
 *   max muncy     Max Muncy #571970 hitting 3B       | Max Muncy #691777 hitting 3B
 *   jose fermin   José Fermín #665877 hitting LF     | José Fermin #820862 pitching P
 *   yunior marte  #805074 pitching                   | #628708 pitching
 *   shohei ohtani #660271 hitting                    | #660271 pitching (one man, two rows)
 *
 * Last-wins made the reliever the answer for "luis garcia", so a roster spot printing
 * "Luis Garcia Jr." at 1B resolved to a relief pitcher: wrong projection, wrong bscore,
 * wrong `player.teamId` — which is what the Tonight card reads to say when his game
 * locks — and a wrong man in the drop list. That is the planner and the daily card, the
 * two surfaces that tell a manager to start, sit, add and drop.
 *
 * So a key holds a LIST, and the caller says what it knows about the man it meant. The
 * two narrowings below are the ones the roster actually carries, in the order their
 * evidence deserves:
 *
 *   OWNED IDS FIRST. A roster id is the platform's own answer to "which man is this",
 *   and it is the only one of the two that can separate two hitters with one name.
 *   It is exactly what tells the two Max Muncys apart when one of them is yours.
 *
 *   THEN THE SEAT'S PRINTED ELIGIBILITY. "1B" cannot be a pitcher and "SP" cannot be a
 *   bat, which settles every cross-group collision above — including Ohtani, where the
 *   two rows are the same man and the question is which half of him the caller means.
 *
 * A narrowing that empties the set is DISCARDED rather than obeyed: it has told us the
 * evidence does not apply (a roster read with no ids beside it, a seat whose eligibility
 * cell could not be read), not that the man is nobody. The alternative loses the match
 * outright on exactly the readers whose data is thinnest.
 *
 * Where a key is still plural after both, the answer is `ambiguous` and the caller must
 * REFUSE the row. Picking one is a coin flip presented as advice, and this app's whole
 * rule is that a plausible unsourced answer is worse than a stated gap. Every caller
 * already had somewhere to put it: `resolveRoster` has `blocked`, `planSwaps` has
 * `skipped`, the Tonight card has `unmatched`.
 *
 * Lifted from src/client/Recap.tsx:104-125, which was the one call site that had already
 * worked this out — it built `Map<string, Player[]>` and picked by group and ownership,
 * alone among five joins. Recap is unchanged and still correct; this is its logic in the
 * leaf module both a node script and a browser bundle can reach, next to the function
 * that creates the collisions.
 */

/** The three fields telling two men with one name apart needs. */
export interface Identified {
	id: number | string
	group: string
	name: string
}

/** A row, or the reason there is not exactly one. `among` is what was left when the
 *  narrowing ran out, so a caller can name the men it is refusing to choose between. */
export type Picked<T> =
	| { row: T; why: null; among: readonly T[] }
	| { row: null; why: "unmatched" | "ambiguous"; among: readonly T[] }

/** What the caller knows about the man it meant. Both optional, both evidence rather
 *  than a requirement — see the note above on why an empty narrowing is discarded. */
export interface NameHint {
	/** Eligibility as the league prints it beside the name, or the seat he sits in. */
	positions?: readonly string[]
	/** Player ids the reader owns, as strings. `${id}` — not the `${id}:${group}` store
	 *  key, which would make a two-way player's two rows different men. */
	owned?: ReadonlySet<string>
}

export interface NameIndex<T> {
	/** Every row under a printed name, in input order. Empty where none match. */
	all: (printed: string) => readonly T[]
	/** The one row a printed name means, or why it cannot be said. */
	pick: (printed: string, hint?: NameHint) => Picked<T>
}

/**
 * A seat or an eligibility cell that can only be a pitcher.
 *
 * The test is anchored on purpose: "P" and "SP" are pitchers, "1B" is not, and a
 * substring match would make "RP" out of "CORP" and a pitcher out of nobody useful.
 * Anything else — a bat, an outfielder, a Util seat — reads as hitting, because the
 * question this answers is which of two rows for ONE name is meant, and the only two
 * groups the capture has are hitting and pitching.
 */
export const wantsPitcher = (positions: readonly string[]): boolean =>
	positions.some(x => /^(SP|RP|P)$/i.test(x.trim()))

/* A narrowing that leaves nobody has told us the evidence does not apply here, not that
   the man does not exist. Applying it anyway is how a reader with no ids in his store, or
   a league that printed no eligibility, loses the match entirely. */
const narrow = <T>(cands: readonly T[], keep: (row: T) => boolean): readonly T[] => {
	const kept = cands.filter(keep)
	return kept.length ? kept : cands
}

export const indexByName = <T>(rows: Iterable<T>, of: (row: T) => Identified): NameIndex<T> => {
	const by = new Map<string, T[]>()
	for (const row of rows) {
		const key = normalizeName(of(row).name)
		const at = by.get(key)
		if (at) at.push(row)
		else by.set(key, [row])
	}
	const all = (printed: string): readonly T[] => by.get(normalizeName(printed)) ?? []
	return {
		all,
		pick: (printed, hint = {}) => {
			const cands = all(printed)
			if (!cands.length) return { row: null, why: "unmatched", among: cands }
			// The overwhelmingly common case, and it must not be made to pay for the five.
			if (cands.length === 1) return { row: cands[0]!, why: null, among: cands }
			let left = cands
			if (hint.owned?.size) left = narrow(left, r => hint.owned!.has(String(of(r).id)))
			if (hint.positions?.length) {
				const want = wantsPitcher(hint.positions) ? "pitching" : "hitting"
				left = narrow(left, r => of(r).group === want)
			}
			return left.length === 1 ?
					{ row: left[0]!, why: null, among: left }
				:	{ row: null, why: "ambiguous", among: left }
		}
	}
}

/**
 * "A", "A and B", "A, B and C" — how a person reads a list out loud.
 *
 * One implementation, in the one module both the client and the parsers already import.
 * There were two, byte-identical: `andList` inside the board component and `andNames` in
 * src/data/paste.ts, whose own comment said it existed "because src/data/paste.ts must
 * not import from src/client" — true, and the answer was a shared module rather than a
 * copy. A third caller on the Tonight card is what made the copy untenable.
 *
 * No Oxford comma, deliberately: the lists it builds are player names, and "Soto, Judge,
 * and Alonso" reads as three things one of which might be a pair.
 */
export const andList = (xs: string[]): string =>
	xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`

/**
 * A SCORING CODE AS A READER WOULD SPELL IT.
 *
 * Almost every code in a league's scoring table is already the reader's own vocabulary — he
 * chose HR and RBI and K, they are what his platform's settings page calls them, and
 * expanding them would be the app talking down to him.
 *
 * `OUT` is the exception, and it is the first named number a stranger meets: the best-nights
 * list on a first visit prints a pitcher as "K +24 OUT +19 W +8". He never chose that code —
 * the borrowed preset did — and in a row where every other code is a credit, "OUT" reads as
 * making an out, which is the opposite of what it pays for. Yahoo spells the same category
 * Outs.
 *
 * NOT "Innings Pitched", which is a different code at a different price, and not "outs
 * recorded": the row is 243px wide at 390px and already wraps, so the noun is all there is
 * room for. Anything not listed comes back exactly as the league wrote it.
 */
const STAT_LABEL: Record<string, string> = { OUT: "Outs" }

export const statLabel = (code: string): string => STAT_LABEL[code] ?? code
