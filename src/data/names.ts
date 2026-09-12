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
