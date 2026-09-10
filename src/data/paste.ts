import { normalizeName } from "./yahoo-pool.ts"
import { slotsFor } from "../engine/bscore.ts"
import type { PlayerSeason } from "./statsapi.ts"

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

/**
 * A pasted roster page, shaped into the three things a team is stored as.
 *
 * `playersInText` finds the men; this decides what they mean — which store keys
 * they are, which seats they were sitting in, and what to tell the reader about
 * what did and did not come through. It lives here rather than in a component
 * because two screens now take this paste (the first-run onboarding and My team),
 * and two copies of "what does a pasted roster mean" would eventually disagree
 * about a two-way player or an empty seat.
 *
 * Nothing here touches storage. The caller owns that, because the two callers
 * handle a failed write differently and neither of them should be able to write a
 * roster this function did not shape.
 */
export interface PastedRoster {
	players: PastedPlayer[]
	ambiguous: string[]
	/** `id:group` keys, the form the roster store holds. */
	keys: string[]
	/** Seats, ready for the lineup store. Empty when the paste carried none, which
	 *  is honest: a bare list of names has no seats. */
	spots: { slot: string; name: string; positions: string[]; team: string | null }[]
	/** What actually happened, in the reader's terms, for the page to print. */
	note: string
}

export const rosterFromPaste = (
	text: string,
	snapshot: {
		players: PlayerSeason[]
		eligibility?: Record<string, string[]>
	}
): PastedRoster => {
	const found = playersInText(text, snapshot.players)
	const byId = new Map(snapshot.players.map(p => [p.id, p]))

	/**
	 * A two-way player is one man and TWO rows in the snapshot, because he is
	 * projected as a hitter and as a pitcher separately. `playersInText` dedupes by
	 * id and so returns him once, under one group — and rostering him under one
	 * group would silently drop half of what he is worth. So every snapshot row
	 * sharing his id becomes a key.
	 */
	const keys = [
		...new Set(
			found.players.flatMap(f =>
				snapshot.players.filter(p => p.id === f.id).map(p => `${p.id}:${p.group}`)
			)
		)
	]

	/**
	 * The league's own eligibility where the sweep reached him, and his primary
	 * position where it did not.
	 *
	 * The map covers a few hundred players, not all of them, and an empty list means
	 * "no slot can be proven legal for him" — so a pasted roster came back with every
	 * man unseatable and a lineup projecting zero. The primary position is a weaker
	 * claim and it is the same fallback the board already makes; stating it beats
	 * seating nobody.
	 */
	const spots = found.players
		.filter(f => f.slot)
		.map(f => {
			const p = byId.get(f.id)
			return {
				slot: f.slot!,
				name: f.name,
				/**
				 * SLOTS, not MLB positions.
				 *
				 * These reach `legalSlotsFor` in src/auto/plan.ts, which asks whether any
				 * of them appears in the league's `slot_accepts` list for a seat — and
				 * those lists are written in the platform's slot names. A centre fielder
				 * is "CF" to MLB and there is no CF seat in a fantasy league, so he never
				 * matched an OF one. The eligibility grid covers about a fifth of the
				 * capture, so most of every pasted roster fell through to that raw
				 * position and could be seated nowhere.
				 */
				positions: p ? slotsFor(p, snapshot.eligibility?.[String(f.id)]) : [],
				team: p?.team ?? null
			}
		})

	const note =
		!found.players.length ?
			"No players found in that. Select your whole roster page — the names are what " +
			"this matches on, so extra columns and adverts do no harm."
		:	`Found ${found.players.length} player${found.players.length === 1 ? "" : "s"}` +
			(spots.length ?
				`, ${spots.length} with the seat they were in — the daily lineup on Recommendations can diff against that.`
			:	". No seats were in that text, so Recommendations will show the lineup to set rather than the changes to make.") +
			(found.ambiguous.length ?
				` Two different players share ${found.ambiguous.join(" and ")}, so neither was added — search for the one you own below.`
			:	"")

	return { players: found.players, ambiguous: found.ambiguous, keys, spots, note }
}
