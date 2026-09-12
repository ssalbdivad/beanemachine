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
