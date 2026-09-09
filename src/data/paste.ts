import { normalizeName } from "./yahoo-pool.ts"

/**
 * Reading a team out of whatever the reader pasted.
 *
 * Every other route into this app depends on somebody else's permission. Scraping a
 * Yahoo page works until Yahoo decides it does not: on 2026-09-09 a sweep that had
 * been returning 150 free agents returned 25, then none, then the string "Request
 * denied" — and the app went on offering a "Read my roster from Yahoo" button and
 * calling itself a Yahoo app. The official API needs an app registration, a deployed
 * server to hold the secret, and a consent screen. Both are things the READER cannot
 * fix when they break.
 *
 * Pasting cannot break that way, and it is worth being precise about why:
 *
 *  · The browser doing the reading is his, already signed in, and not rate-limited
 *    as a scraper — because it is not one.
 *  · It works on PRIVATE leagues, which is most leagues, and which no amount of
 *    scraping will ever reach. This app has quietly only ever supported
 *    publicly-viewable ones.
 *  · It works on any platform. ESPN, CBS, Fantrax and Sleeper all render a roster as
 *    text, and none of them has to be taught to this file.
 *  · It is Ctrl-A, Ctrl-C, Ctrl-V.
 *
 * The trick that makes it robust is refusing to parse. There is no attempt to
 * understand Yahoo's table, because that is the thing that keeps breaking. The
 * pasted text is searched for names we already know — the snapshot holds every
 * player in baseball — and everything else is ignored. A layout change, a redesign,
 * an ad, a different platform: none of them matter to a search for "Kevin
 * McGonigle".
 */

/** A slot label as the platforms write it, so a seat can be recovered when the
 *  paste happens to carry one. Order matters: "IL+" before "IL", "1B" before "B". */
const SLOT_TOKENS = [
	"BN", "IL+", "IL", "NA", "Util", "UTIL", "SP", "RP", "P",
	"C", "1B", "2B", "3B", "SS", "OF", "LF", "CF", "RF", "DH"
]

export interface PastedPlayer {
	/** The snapshot's own spelling, not the reader's paste. */
	name: string
	id: number
	group: "hitting" | "pitching"
	/** The seat he was sitting in, where the paste carried one. Null is honest: a
	 *  free-agent list has no seats, and neither does a bare list of names. */
	slot: string | null
}

export interface PasteResult {
	players: PastedPlayer[]
	/** Names that matched more than one player and were therefore left out rather
	 *  than guessed at. */
	ambiguous: string[]
}

/**
 * A name reduced to the form both sides are compared in.
 *
 * `normalizeName` is the app's own comparison everywhere else and is not changed
 * here, but it keeps punctuation: "Rice, Ben" normalizes to `rice, ben` and the
 * index's `rice ben` never matched it, so the whole surname-first case silently did
 * nothing. Punctuation is collapsed to a space on BOTH sides, which also folds the
 * periods in "J.T. Ginn" and the suffix in "Fernando Tatis Jr." however the platform
 * happened to print them.
 */
const key = (s: string): string =>
	normalizeName(s)
		.replace(/[.,'’\-]/g, " ")
		.replace(/\s+/g, " ")
		.trim()

/**
 * The same man written surname-first, which is how a sorted list renders him.
 *
 * Generated from the INDEX rather than detected in the paste, so one player yields
 * both spellings and the scan below stays a plain substring search. The first
 * version had this backwards — it looked for a comma in the SNAPSHOT's names, which
 * never have one, so it produced nothing and the whole surname-first case silently
 * did not work.
 *
 * `normalizeName` drops the comma, so "Lowe, Brandon" and "Lowe Brandon" are the
 * same key and both are found.
 */
const surnameFirst = (name: string): string | null => {
	const parts = name.split(/\s+/).filter(Boolean)
	if (parts.length < 2) return null
	return `${parts.slice(1).join(" ")} ${parts[0]}`
}

/**
 * Find every player from `players` that appears in `text`.
 *
 * Full names only. A surname alone is not enough — "Rice", "Jones" and "Anthony" all
 * appear in ordinary prose and in the navigation furniture of a fantasy site, and a
 * roster assembled out of those would be confidently wrong. That costs the rare
 * platform that prints only surnames, which is the right trade.
 */
export const playersInText = (
	text: string,
	players: { id: number; name: string; group: string }[]
): PasteResult => {
	const hay = ` ${key(text)} `
	const byKey = new Map<string, { id: number; name: string; group: string }[]>()
	for (const p of players) {
		for (const spelling of [p.name, surnameFirst(p.name)]) {
			if (!spelling) continue
			const k = key(spelling)
			// a single token is a surname or a nickname; both are too weak to match on
			if (k.split(" ").length < 2) continue
			;(byKey.get(k) ?? byKey.set(k, []).get(k)!).push(p)
		}
	}

	const found: { p: { id: number; name: string; group: string }; at: number }[] = []
	const ambiguous: string[] = []
	const seen = new Set<number>()
	for (const [k, matches] of byKey) {
		const at = hay.indexOf(` ${k} `)
		if (at < 0) continue
		// Two different men with the same name is rare and real. Guessing between them
		// puts a player on somebody's roster who is not on it, so neither is taken and
		// the name is reported.
		const distinct = [...new Map(matches.map(m => [m.id, m])).values()]
		if (distinct.length > 1) {
			ambiguous.push(distinct[0]!.name)
			continue
		}
		const p = distinct[0]!
		if (seen.has(p.id)) continue
		seen.add(p.id)
		found.push({ p, at })
	}

	// In the order they appeared, because a roster page lists a team in seat order and
	// that order is information the reader can check at a glance.
	found.sort((a, b) => a.at - b.at)

	return {
		players: found.map(({ p, at }) => ({
			name: p.name,
			id: p.id,
			group: p.group === "pitching" ? "pitching" : "hitting",
			slot: slotBefore(hay, at)
		})),
		ambiguous: [...new Set(ambiguous)]
	}
}

/**
 * The seat label immediately before a name, if the paste carried one.
 *
 * Yahoo, ESPN and the rest all print the slot to the left of the player, so the last
 * slot token in the ~24 characters before a match is his seat. Anything further away
 * belongs to somebody else's row and is not used: a wrong seat is worse than no seat,
 * because the card diffs against it.
 */
const slotBefore = (hay: string, at: number): string | null => {
	// `at` is the index of the SPACE before the name, so the window has to reach one
	// character past it or the nearest token loses its trailing space and cannot
	// match — which silently returned the PREVIOUS row's seat for every player.
	const window = hay.slice(Math.max(0, at - 24), at + 1)
	let best: { slot: string; at: number } | null = null
	for (const slot of SLOT_TOKENS) {
		const i = window.toLowerCase().lastIndexOf(` ${slot.toLowerCase()} `)
		if (i >= 0 && (!best || i > best.at)) best = { slot, at: i }
	}
	return best?.slot ?? null
}
