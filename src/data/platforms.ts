import { type PageKind } from "./extension.ts"
import { pageUrl } from "./yahoo-pool.ts"

/**
 * WHAT A PLATFORM IS, TO THE THING THAT READS IT.
 *
 * The reader was built for Yahoo, and every fact about Yahoo is spread through it: which
 * hosts its content script runs on, how to tell a settings page from a roster page, where
 * the league id sits in a path, which pages one press should fetch. All of that is data
 * about one website, written as code in four files.
 *
 * A second platform written the same way is a second set of four files, and a third is a
 * third. So the facts move here, one record per platform, and the two halves of the reader
 * become what they always should have been: a thing that fetches URLs somebody else chose,
 * and a thing that parses text somebody else fetched.
 *
 * ── WHAT THIS IS NOT ──────────────────────────────────────────────────────────────────
 *
 * It is not an abstraction over "fantasy platforms" in general. Those sites have nothing in
 * common worth abstracting: Yahoo serves HTML and no API a browser may use, ESPN serves JSON
 * from a documented-by-observation endpoint, Sleeper serves JSON to anybody at all with no
 * session. Pretending they are the same thing produces a lowest common denominator that fits
 * none of them.
 *
 * What IS common is narrower and is all that lives here: which URLs belong to this platform,
 * what a given URL is, and which further URLs one press should ask for. A descriptor answers
 * those three questions. Everything else — what the bytes mean — stays in the parser written
 * for that platform, where it can be as specific as it needs to be.
 *
 * ── THE RULE THAT DECIDES WHETHER A PLATFORM BELONGS HERE AT ALL ──────────────────────
 *
 * `needsReader`. Sleeper's API answers any page on the internet, so a reader adds NOTHING
 * for a Sleeper league and asking a reader to install one would be asking him to solve a
 * problem he does not have. ESPN answers a public league the same way and needs a session
 * only for a private one. Yahoo answers no web page at all, ever, which is the whole reason
 * any of this exists. A platform whose data a page can already fetch does not get a content
 * script, a host permission, or a line in the install walkthrough.
 */

/** Every platform this app can hold a league for. The same strings `League.meta.platform`
 *  uses, so a descriptor and a stored league cannot disagree about who they are about. */
export type PlatformId = "yahoo" | "espn" | "sleeper" | "cbs" | "fantrax" | "custom"

/** What one press should fetch, beyond the page the reader is standing on. */
export interface Fetchable {
	/** Absolute, so the app can read ids back out of it. The content script fetches the path,
	 *  which is what keeps it same-origin — see `samePath` in extension/src/yahoo.ts. */
	url: string
	kind: PageKind
	/**
	 * How the bytes should cross the wire.
	 *
	 * `text` is a page rendered down to what a reader would have copied, which is what the
	 * paste parsers take and what survives a redesign. `html` is for a table whose ATTRIBUTES
	 * carry the meaning — Yahoo's player rows hold the player id in `data-ys-playerid`, and
	 * an id is what makes a free agent the same man as a player in the capture rather than a
	 * name that might be two people. `json` is for a platform that answers with data.
	 */
	as: "text" | "html" | "json"
}

/** What a URL on this platform is, and which league and team it belongs to. */
export interface PageAt {
	kind: PageKind
	leagueId: string | null
	teamId: string | null
	/** Yahoo puts the sport in the hostname; ESPN puts it in the path; Sleeper says it in the
	 *  league JSON. Null where the URL does not carry it. */
	sport: string | null
}

export interface Platform {
	id: PlatformId
	/** What a reader calls it. Rendered; never a key. */
	label: string
	/**
	 * Whether a page can get this league's data for itself.
	 *
	 * False means every reader of this platform is served without installing anything, and
	 * the app must not offer him a reader — see the note at the top of this file.
	 */
	needsReader: boolean
	/** Content-script match patterns. Empty when `needsReader` is false. */
	matches: string[]
	/** True when a URL belongs to this platform at all. */
	owns: (url: string) => boolean
	/** What that URL is. Returns `kind: "unknown"` rather than guessing. */
	at: (url: string) => PageAt
	/**
	 * The pages ONE PRESS should bring back, given where the reader is standing.
	 *
	 * Returns absolute URLs and says how each should cross the wire. The reader's current
	 * page is never in here — the content script always has that one already — and the list
	 * is deliberately short: this is the press that makes the board his, and it competes with
	 * a reader's patience rather than with a crawler's budget.
	 */
	onePress: (at: PageAt) => Fetchable[]
	/**
	 * The free-agent sweep, which is the expensive one and sits behind its own button.
	 *
	 * Null for a platform that answers "who is free" in a single request. Yahoo needs one
	 * request per position because its table has no "all positions" page worth having, and
	 * that asymmetry is exactly why this is a separate function rather than more of
	 * `onePress`.
	 */
	sweep:
		| ((at: PageAt, positions: string[]) => Fetchable[])
		| null
}

/* ── Yahoo ──────────────────────────────────────────────────────────────────────────────
   The platform the reader was built for, and the only one that answers no web page at all.
   Every rule below is lifted from src/data/extension.ts with its reasoning intact; nothing
   about the behaviour changes by moving it here. */

const YAHOO_HOST = /(^|\.)fantasysports\.yahoo\.com$/i

/** The league id is the segment that follows a segment which is NOT a number — `b1` on every
 *  fantasy URL this project has seen. Taking the first number instead would key a league as
 *  `2024` on a URL shaped `/2024/b1/228947`, silently and permanently. */
const yahooSegments = (url: string): { seg: string[]; at: number } | null => {
	try {
		const seg = new URL(url).pathname.split("/").filter(Boolean)
		const at = seg.findIndex((s, i) => i > 0 && /^\d+$/.test(s) && !/^\d+$/.test(seg[i - 1]!))
		return at === -1 ? null : { seg, at }
	} catch {
		return null
	}
}

/**
 * Yahoo serves 25 rows a page and `count` is an OFFSET, not a page size — measured disjoint
 * on 2026-09-03 against league 228947, and the reason the top 25 free agents at every
 * position were once invisible.
 *
 * Built by `pageUrl` rather than by a template here, because that function is where the
 * measurement is written down and it is what the Node reader uses. Two builders would be two
 * places to get `count` wrong, and the one that was wrong would be the one nothing tests.
 */
const yahooPlayers = (sport: string, leagueId: string, pos: string): string =>
	pageUrl(leagueId, sport, pos, 0, "A")

export const YAHOO: Platform = {
	id: "yahoo",
	label: "Yahoo",
	/* Measured 2026-09-04 with `Origin: https://beanemachine.com`: no
	   `access-control-allow-*` header of any kind on any page the importer reads. A web page
	   is never handed a Yahoo league, however politely it asks. */
	needsReader: true,
	/*
	   HTTPS ONLY, AND IT USED TO BE `*://`.
	
	   Yahoo answers over plaintext http — measured, a 200 rather than a redirect — so `*://`
	   was not a formality: it let the content script be injected into a page a network could
	   have written, on a host whose cookies the same script then sends with every fetch it
	   makes. Nothing in this project ever wanted that page. The one place http is genuinely
	   needed is the test, which serves a fake Yahoo on 127.0.0.1 and tells the browser to
	   believe it, and that is what `readerMatches(dev)` is for — the same shape `appMatches`
	   has always used for the bridge's own origins.
	*/
	matches: ["https://*.fantasysports.yahoo.com/*"],
	owns: url => {
		try {
			return YAHOO_HOST.test(new URL(url).hostname)
		} catch {
			return false
		}
	},
	at: url => {
		const out: PageAt = { kind: "unknown", leagueId: null, teamId: null, sport: null }
		let path: string
		try {
			const u = new URL(url)
			if (!YAHOO_HOST.test(u.hostname)) return out
			path = u.pathname
			const host = /^([a-z]+)\.fantasysports\.yahoo\.com$/i.exec(u.hostname)
			out.sport = host ? host[1]!.toLowerCase() : null
		} catch {
			return out
		}
		const found = yahooSegments(url)
		if (found) {
			out.leagueId = found.seg[found.at]!
			const next = found.seg[found.at + 1]
			if (next && /^\d+$/.test(next)) out.teamId = next
		}
		/* The word cases first, and the team case last as a digits-only test, because every
		   other segment in that position is a word: matching `/b1/<league>/<anything>` as a
		   team is how a settings page ends up parsed as a roster of nobody. */
		if (/\/settings\b/i.test(path)) out.kind = "settings"
		else if (/\/players\b/i.test(path)) out.kind = "players"
		else if (/\/matchup\b/i.test(path)) out.kind = "matchup"
		else if (out.teamId) out.kind = "team"
		else if (out.leagueId) out.kind = "league"
		return out
	},
	onePress: at => {
		if (!at.leagueId) return []
		const sport = at.sport ?? "baseball"
		const base = `https://${sport}.fantasysports.yahoo.com/b1/${at.leagueId}`
		/* A team page carries the roster and no scoring table; the settings page carries the
		   scoring table and no roster. Asking a reader to press one button and then telling him
		   the app still does not know how his league scores is asking him to press it twice.
		   The matchup page is the third because "am I winning" is the question a head-to-head
		   manager asks most, and the page he is already signed into shows him both rosters. */
		const want: Fetchable[] = [
			{ url: `${base}/settings`, kind: "settings", as: "text" },
			{ url: `${base}/matchup`, kind: "matchup", as: "text" }
		]
		/* His own team, where the URL says which one it is and he is not already on it. */
		if (at.teamId && at.kind !== "team")
			want.unshift({ url: `${base}/${at.teamId}`, kind: "team", as: "text" })
		return want.filter(f => !(at.kind === f.kind))
	},
	sweep: (at, positions) => {
		if (!at.leagueId) return []
		const sport = at.sport ?? "baseball"
		return positions.map(pos => ({
			url: yahooPlayers(sport, at.leagueId!, pos),
			kind: "players" as PageKind,
			as: "html" as const
		}))
	}
}

/* ── Sleeper ────────────────────────────────────────────────────────────────────────────
   Here to be REFUSED, which is the most useful thing this file can say about it. */

export const SLEEPER: Platform = {
	id: "sleeper",
	label: "Sleeper",
	/*
	 * THE RIGHT ANSWER FOR THE WRONG REASON, until this comment was corrected.
	 *
	 * It said a reader adds nothing here because `api.sleeper.app` answers any page on the
	 * internet — which is true, re-measured 2026-09-18 with `Origin: https://beanemachine.com`
	 * on `/v1/state/mlb`, and beside the point. The actual reason is bigger: SLEEPER DOES NOT
	 * RUN FANTASY BASEBALL. `src/import.ts` refuses every Sleeper URL outright and sets out
	 * four independent verifications of that, `src/data/rosters.ts` records that the Sleeper
	 * reader was deleted, and the MLB player payload still carries `fantasy_positions: null`
	 * on Judge, Ohtani and Skubal.
	 *
	 * The distinction matters because the two reasons expire differently. "It is CORS-open"
	 * stops being a reason the day Sleeper closes it; "there is no baseball to read" stops
	 * being a reason the day Sleeper launches baseball, and on that day this descriptor needs
	 * a parser rather than a host permission. A comment that gives the shallower reason sends
	 * whoever reads it next to solve the wrong problem.
	 */
	needsReader: false,
	matches: [],
	owns: url => {
		try {
			return /(^|\.)sleeper\.(app|com)$/i.test(new URL(url).hostname)
		} catch {
			return false
		}
	},
	at: () => ({ kind: "unknown", leagueId: null, teamId: null, sport: null }),
	onePress: () => [],
	sweep: null
}

export const PLATFORMS: Platform[] = [YAHOO, SLEEPER]

/** Which platform a URL belongs to, or null. */
export const platformOf = (url: string): Platform | null =>
	PLATFORMS.find(p => p.owns(url)) ?? null

/**
 * Every match pattern a content script needs, across the platforms that need a reader.
 * The manifest is written from this, so a platform cannot be added to the app and left out
 * of the extension.
 *
 * `dev` adds the plaintext form of each pattern and is the ONLY thing that does. The test
 * serves a fake Yahoo over http on 127.0.0.1 and points the browser's resolver at it, so a
 * build that spoke https alone could not be exercised by the person changing it — which is
 * how a reader ends up shipped broken. It is the same bargain `appMatches(dev)` strikes for
 * the bridge, and it is struck in the same place, so nobody has to remember it twice.
 */
export const readerMatches = (dev = false): string[] =>
	PLATFORMS.filter(p => p.needsReader).flatMap(p =>
		dev ? [...p.matches, ...p.matches.map(m => m.replace(/^https:/, "http:"))] : p.matches
	)
