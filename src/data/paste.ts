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
 * What the reader probably meant, for a line that produced nobody.
 *
 * `unmatched` quoting the line back is honest but it is also the end of the road:
 * "Aaron Judg" is one deletion from a name the reader can see in the placeholder,
 * and the only way forward is to retype the line on a phone keyboard — which is
 * where people quit. This does NOT correct anything. The matcher above still
 * refuses, `players` and `unmatched` are exactly what they were, and this is a
 * separate answer to a separate question: what ONE man is this line a single typo
 * away from? The screen can then ask, and the reader answers.
 *
 * A suggestion that is right most of the time is worse than none, because a reader
 * accepts a plausible name without reading it and would end up owning a roster he
 * did not assemble. So the rule was measured over the whole capture before it was
 * chosen, against the two rules it was chosen over, and the measurement section of
 * test/paste.mjs re-derives all of it on every run — including the rejected rules,
 * because the reason for a threshold is a comparison and a comparison nobody can
 * re-run is an opinion.
 *
 * Each cell is right/wrong over the 1,445 men in data/snapshot.json, one generated
 * input per man, as printed on 2026-09-11:
 *
 *                            distance 1    distance 2    unique surname
 *   one dropped letter          1431/0        1401/0          210/105
 *   one neighbouring key        1431/0        1412/0          212/102
 *   one doubled letter          1432/0        1424/0          213/102
 *   two letters swapped         1274/0        1267/0            1/124
 *   -- and inputs that say too little to be answered at all --
 *   a surname alone                0/0           0/0            980/0
 *   an initial and a surname      32/2         101/19           980/0
 *   a line mangled twice          44/1        1415/0           103/81
 *
 * Read the top half for the hit rate and the bottom half for the cost. On real
 * typos distance 1 is 99.1% right and 0.0% wrong; the unique surname is 11.3% right
 * and 7.7% wrong, which is wrong on two fifths of every answer it gives, because a
 * misspelled surname is a different surname. On the inputs that must be refused,
 * distance 1 answers 1.8% of them, distance 2 answers 35.4%, and the surname rule
 * answers 49.5% — and 980 of those surname answers come from the bare surname it
 * resolves by design, which is exactly the silent correction this must not make.
 *
 * The second measurement is on text holding no player at all: this repo's own
 * committed prose, README.md and docs/, about 2,700 lines. Every question asked of
 * it is a wrong question, documentation not being a roster. Distance 1 asked on 2
 * of them, 0.07%. The unique surname asked on 82, 2.8% — one line in thirty-five —
 * because a surname is an ordinary English word often enough ("Price", "Short",
 * "Sheets", "May", "Keys"), and guarding it (five letters or more, and not also
 * some player's first name) only brought that to 1.5%. That alone ruled it out.
 * Distance 2 asked on 11 of the 2,679 lines the corpus held that day, measured by
 * hand; the suite does not re-run it, because at five seconds it is not worth the
 * time and the case against distance 2 is the table above.
 *
 * So: distance 1, counting an adjacent transposition as one edit. Counting it is
 * not a nicety — "Cal Raliegh" is two plain Levenshtein edits and one Damerau one,
 * so plain Levenshtein 1 cannot resolve a single one of the 1,286 transpositions in
 * the table, and a swapped pair of letters is exactly what a thumb produces.
 *
 * Two residual errors stay, both small and both bounded by the fact that nothing is
 * ever added without the reader: a line mangled twice can land next to the wrong
 * man (1 of 1,445), and an ordinary pair of English words can sit one letter from a
 * real name — "their own pages" is one edit from Andy Pages. Nothing short of a
 * dictionary rules those out, and at one line in a thousand the reader is asked a
 * silly question rarely enough that it reads as a silly question.
 */
export interface PasteSuggestion {
	/** The reader's own line, verbatim, so the screen can show what he typed. */
	line: string
	/** The snapshot's spelling of the one man that line is a single typo from. */
	name: string
	id: number
	group: "hitting" | "pitching"
}

/**
 * Within `max` edits, counting an adjacent transposition as one.
 *
 * Optimal string alignment rather than full Damerau-Levenshtein — the difference
 * only shows up at distance 3 and above, and this never asks past 1. Rows are
 * abandoned as soon as every cell in one exceeds `max`, which is what keeps the
 * verification below cheap enough to run over a whole pasted page.
 */
const within = (a: string, b: string, max: number): boolean => {
	if (Math.abs(a.length - b.length) > max) return false
	const n = a.length
	const m = b.length
	let two: number[] = []
	let one = Array.from({ length: m + 1 }, (_, j) => j)
	for (let i = 1; i <= n; i++) {
		const cur = new Array<number>(m + 1)
		cur[0] = i
		let best = i
		for (let j = 1; j <= m; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1
			let v = Math.min(one[j]! + 1, cur[j - 1]! + 1, one[j - 1]! + cost)
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
				v = Math.min(v, two[j - 2]! + 1)
			cur[j] = v
			if (v < best) best = v
		}
		// no cell in this row is within budget, and a row never improves below its
		// own minimum, so no alignment can finish inside `max`
		if (best > max) return false
		two = one
		one = cur
	}
	return one[m]! <= max
}

/** A string, and every string reachable from it by deleting up to `depth` of its
 *  characters. */
const deletionsOf = (s: string, depth: number): Set<string> => {
	let edge = new Set([s])
	const out = new Set(edge)
	for (let d = 0; d < depth; d++) {
		const next = new Set<string>()
		for (const w of edge)
			for (let i = 0; i < w.length; i++) {
				const cut = w.slice(0, i) + w.slice(i + 1)
				if (!out.has(cut)) next.add(cut)
			}
		for (const w of next) out.add(w)
		edge = next
	}
	return out
}

interface NearIndex {
	/** Name key -> the ids that spell their name that way. */
	canon: Map<string, number[]>
	/** Every one-deletion variant of every key -> the keys it came from. */
	variant: Map<string, string[]>
	men: Map<number, { id: number; name: string; group: string }>
}

/**
 * Keys reachable in `depth` edits, without comparing against all 2,882 of them.
 *
 * Deleting one character from both sides of a single substitution, insertion,
 * deletion OR adjacent transposition yields the same string, so two keys are
 * within distance 1 only if their one-deletion sets intersect — and the same holds
 * at distance `d` for their `d`-deletion sets. Looking the query's deletion set up
 * in an index of the corpus's gives a handful of candidates to verify properly
 * instead of the whole corpus: measured over 2,679 lines of prose, comparing every
 * key took 63 seconds and this takes under 1, index build included, which is what
 * makes this affordable on every read rather than on a button.
 *
 * Memoised per players array and per depth, because both screens call this on every
 * read and the index is the same every time.
 */
const indexes = new WeakMap<object, Map<number, NearIndex>>()
const nearIndex = (
	players: { id: number; name: string; group: string }[],
	depth: number
): NearIndex => {
	const byDepth = indexes.get(players) ?? indexes.set(players, new Map()).get(players)!
	const had = byDepth.get(depth)
	if (had) return had
	const canon = new Map<string, number[]>()
	const variant = new Map<string, string[]>()
	const men = new Map<number, { id: number; name: string; group: string }>()
	for (const p of players) {
		if (!men.has(p.id)) men.set(p.id, p)
		for (const spelling of [p.name, surnameFirst(p.name)]) {
			if (!spelling) continue
			const k = key(spelling)
			// the same floor the matcher uses: one token is a surname or a nickname
			if (k.split(" ").length < 2) continue
			const ids = canon.get(k) ?? canon.set(k, []).get(k)!
			if (!ids.includes(p.id)) ids.push(p.id)
		}
	}
	for (const k of canon.keys())
		for (const v of deletionsOf(k, depth))
			(variant.get(v) ?? variant.set(v, []).get(v)!).push(k)
	const built = { canon, variant, men }
	byDepth.set(depth, built)
	return built
}

/**
 * The two- and three-word runs in a line, which is where a name sits.
 *
 * A roster line is "OF  Aaron Judeg  NYY - OF  Add/Drop", so the name is a run
 * inside it and not the line. Three words as well as two because a third of this
 * capture's men have one ("Luis Robert Jr.", "Ha-Seong Kim" once the hyphen is
 * folded), and the slot and team tokens around the name are left in rather than
 * stripped: "J.P. Crawford", "P.J. Higgins" and "J.C. Escarra" fold to keys whose
 * first token IS a slot token, so stripping those would cost three real men to
 * save nothing measurable.
 */
const runs = (line: string): string[] => {
	const t = key(line).split(" ").filter(Boolean)
	const out: string[] = []
	for (let i = 0; i < t.length - 1; i++) {
		out.push(`${t[i]} ${t[i + 1]}`)
		if (i + 2 < t.length) out.push(`${t[i]} ${t[i + 1]} ${t[i + 2]}`)
	}
	return out
}

/**
 * The one man a line is a single typo away from, or null.
 *
 * Null is the common and correct answer, and it is returned for four separate
 * reasons that all mean "do not ask the reader a question he cannot answer":
 *
 *  · nothing in the line is within one edit of a known name — junk, furniture, a
 *    player who is not in the capture at all;
 *  · two or more men are, so the line does not say which;
 *  · two different runs in the line point at two different men;
 *  · a run matches a name EXACTLY. The matcher above already saw that line and
 *    declined it — because the name is shared by two men, or because the man was
 *    already counted — and repeating its answer as a suggestion would contradict
 *    the sentence the reader is already being shown.
 *
 * `max` is 1 in the app and is a parameter only so that the threshold stays
 * checkable: test/paste.mjs runs this same function at 2 over the same 1,445 men to
 * re-derive why 2 was rejected. Nothing ships calling it with anything but 1.
 */
export const nearestName = (
	line: string,
	players: { id: number; name: string; group: string }[],
	max = 1
): { id: number; name: string; group: "hitting" | "pitching" } | null => {
	const { canon, variant, men } = nearIndex(players, max)
	const hits = new Set<number>()
	for (const run of runs(line)) {
		if (canon.has(run)) return null
		const near = new Set<string>()
		for (const v of deletionsOf(run, max)) for (const k of variant.get(v) ?? []) near.add(k)
		const ids = new Set<number>()
		for (const k of near) if (within(run, k, max)) for (const id of canon.get(k)!) ids.add(id)
		// a run that is near two men says nothing; it does not veto a run that is
		// near exactly one
		if (ids.size === 1) hits.add([...ids][0]!)
	}
	if (hits.size !== 1) return null
	const p = men.get([...hits][0]!)!
	return { id: p.id, name: p.name, group: p.group === "pitching" ? "pitching" : "hitting" }
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
	/**
	 * The lines the reader typed that produced nobody, quoted back verbatim.
	 *
	 * A count cannot be checked and a silent drop is never noticed. "Found 11 players"
	 * over a list of 13 names is a sentence a reader believes, and the two men he
	 * mistyped are then missing from every recommendation the app makes for the rest of
	 * the season without anything on screen ever mentioning them. Quoting the line back
	 * is the smallest honest thing: he can see his own typo and fix it.
	 *
	 * Not a guess at what he meant. `playersInText` does substring matching over an
	 * index of known names, not tokenising, so there is nothing here to compute an
	 * edit distance against without building a second matcher.
	 */
	unmatched: string[]
	/**
	 * What those lines were probably meant to say — a question, never an answer.
	 *
	 * One entry per unmatched line that sits a single typo from exactly one known
	 * name, in line order, at most one per man. Nothing here is counted anywhere and
	 * no caller may add it without the reader saying so: the whole value of this app
	 * refusing to guess is that `players` is a list the reader assembled, and a
	 * suggestion accepted silently is indistinguishable from a wrong roster.
	 *
	 * Usually empty, and that is the measured intent: 0.07% of ordinary prose lines
	 * produce one. See `nearestName` for the rule and the numbers behind it.
	 */
	suggestions: PasteSuggestion[]
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

	/**
	 * A line is unmatched when no player this read found appears anywhere in it.
	 *
	 * Compared on the same normalised form the matcher used, so a line that produced a
	 * player under a different spelling ("RICE, BEN" for Ben Rice) is not reported as a
	 * failure. Blank lines and lines too short to hold a name are skipped: a reader
	 * pasting a page has plenty of both, and quoting page furniture back at him as
	 * something the app failed to read would bury the two lines that matter.
	 */
	const seen = found.players.map(f => norm(f.name))
	const unmatched = text
		.split(/\r?\n/)
		.map(l => l.trim())
		.filter(l => l.length > 3 && /[a-z]/i.test(l))
		.filter(l => {
			const line = norm(l)
			return !seen.some(name => line.includes(name) || name.split(" ").every(w => line.includes(w)))
		})

	/**
	 * One question per unmatched line, and never about a man already on the team.
	 *
	 * Deduped by id because a reader who mistypes the same name twice is asked once,
	 * and skipped for anyone `found` already holds: a line that failed only because
	 * the man was already counted is not a spelling the reader needs to fix.
	 */
	const already = new Set(found.players.map(f => f.id))
	const suggestions: PasteSuggestion[] = []
	for (const line of unmatched) {
		const guess = nearestName(line, snapshot.players)
		if (!guess || already.has(guess.id)) continue
		already.add(guess.id)
		suggestions.push({ line, name: guess.name, id: guess.id, group: guess.group })
	}

	/**
	 * The question, in the note, because the note is the one thing both screens
	 * already print. It says what was NOT done, and the only thing it asks the
	 * reader to do is something the screen he is looking at can actually do: the
	 * text is still in the box and the button is still there.
	 *
	 * Three names at most. The point is to be read, and a reader who mistyped nine
	 * names is better served by fixing three and reading again than by a paragraph.
	 */
	const meant = suggestions.slice(0, 3).map(s => s.name)
	const asked =
		!suggestions.length ? ""
		:	` Did you mean ${
				meant.length > 1 ?
					`${meant.slice(0, -1).join(", ")} or ${meant[meant.length - 1]}`
				:	meant[0]
			}${suggestions.length > meant.length ? ` (and ${suggestions.length - meant.length} more)` : ""}?` +
			` ${suggestions.length === 1 ? "That line is" : "Those lines are"} still not counted —` +
			` correct the spelling and read it again.`

	return {
		players: found.players,
		ambiguous: found.ambiguous,
		keys,
		spots,
		note: note + asked,
		unmatched,
		suggestions
	}
}

/** The same fold the matcher uses, so "reported as unmatched" and "actually matched"
 *  cannot disagree about punctuation. */
const norm = (s: string): string =>
	normalizeName(s).replace(/[.,'’\-]/g, " ").replace(/\s+/g, " ").trim()
