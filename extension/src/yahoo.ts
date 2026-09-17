/**
 * THE HALF THAT RUNS INSIDE YAHOO.
 *
 * This is the only code in the project that can see a Yahoo page, and it does exactly two
 * things: it reads the page the reader already has open, and — when he presses a button —
 * it asks Yahoo for the player table a few times in a row.
 *
 * It parses nothing. `document.body.innerText` and, for the player table only, the page's
 * own HTML go back to the app untouched, and the app decides what they mean using the
 * parsers it has always used on pasted pages. The reasons are in src/data/extension.ts;
 * the short one is that a parser inside an extension cannot be fixed until a store review
 * says so, and Yahoo redesigns on its own schedule.
 *
 * WHAT IT IS NOT. It does not watch what he browses, it holds nothing between reads, and
 * it never touches a page that is not fantasy baseball. Every read is a reply to a request
 * the reader started, which is also what keeps it a reader rather than a scraper.
 */
import {
	pageKind,
	leagueIdFrom,
	sportFrom,
	type Ask,
	type Grab,
	type GrabFailure
} from "../../src/data/extension.ts"
import { pageUrl } from "../../src/data/yahoo-pool.ts"

/** Yahoo throttles by serving a wall rather than an error status, so the words are the
 *  only signal — the same two tests `src/auto/roster.ts` uses against the same site, kept
 *  identical on purpose so both readers call the same page the same thing. */
const THROTTLED = /too many requests|unusual traffic|rate limit|temporarily blocked|request denied/i
const SIGN_IN = /login\.yahoo\.com|\/account\/challenge|guce\.yahoo\.com|please sign in/i

const now = (): string => new Date().toISOString()

/**
 * SAME ORIGIN, ALWAYS — the path, never the absolute URL.
 *
 * `pageUrl` in src/data/yahoo-pool.ts builds `https://<sport>.fantasysports.yahoo.com/...`
 * because the Node reader has no origin of its own to be relative to. A content script
 * does: it is already ON that host, and fetching the absolute form makes it a cross-origin
 * request the moment the tab's scheme is not the one baked into the string. Fetching the
 * path keeps every request same-origin, which is what sends the reader's cookies without
 * asking for a single extra permission.
 *
 * The absolute URL still travels with the grab, because the app reads the league id and
 * the position back out of it.
 */
const samePath = (absolute: string): string => {
	try {
		const u = new URL(absolute)
		return `${u.pathname}${u.search}`
	} catch {
		return absolute
	}
}

const grabHere = (): Grab => {
	const kind = pageKind(location.href)
	return {
		url: location.href,
		kind,
		text: document.body?.innerText ?? "",
		/* HTML for the player table alone. `parsePage` reads `data-ys-playerid` and the
		   row's `title=`, neither of which survives innerText — and the id is what makes a
		   free agent the same man as a snapshot player rather than a name that might be two
		   people. A roster page's HTML is ~400 KB against ~4 KB of text and would buy
		   nothing. */
		html: kind === "players" ? document.documentElement.outerHTML : undefined,
		at: now()
	}
}

/** The sign-in wall and the throttle wall both arrive as a 200 with a page, so the only
 *  way to tell them from a real answer is to read the words. Checked on the text rather
 *  than the HTML because the HTML of every Yahoo page contains the string "sign in"
 *  somewhere in its header. */
const wallIn = (text: string): GrabFailure | null => {
	const head = text.slice(0, 600)
	if (SIGN_IN.test(head))
		return {
			step: "yahoo",
			what: "Yahoo asked you to sign in",
			fix: "Sign in to Yahoo in that tab, then try again."
		}
	if (THROTTLED.test(head))
		return {
			step: "yahoo",
			what: "Yahoo is refusing to answer for the moment",
			fix: "Wait a few minutes and try again. Nothing is wrong with your league."
		}
	return null
}

/**
 * THE PLAYER TABLE, ONE POSITION AT A TIME, SLOWLY.
 *
 * Yahoo serves 25 rows a page and `count=` is an OFFSET rather than a page size — both
 * facts measured and written down in src/data/yahoo-pool.ts, which builds these URLs. The
 * union across positions is what makes a pool that covers every seat instead of the global
 * top 25.
 *
 * SEQUENTIAL, WITH A GAP, AND IT STOPS AT THE FIRST WALL. Nine simultaneous requests get
 * throttled: commit de44045 records the sweep returning 150 players, then 25, then 0, then
 * the literal string "Request denied". A partial read is reported as partial — the app
 * already has `poolIsPartial` for exactly this — and is never presented as a small league.
 */
const sweep = async (
	leagueId: string,
	sport: string,
	positions: string[],
	say: (s: string, done: number, total: number) => void
): Promise<{ grabs: Grab[]; failure: GrabFailure | null }> => {
	const grabs: Grab[] = []
	const spoken: Record<string, string> = {
		C: "catchers",
		"1B": "first basemen",
		"2B": "second basemen",
		"3B": "third basemen",
		SS: "shortstops",
		OF: "outfielders",
		Util: "utility men",
		SP: "starters",
		RP: "relievers"
	}
	for (const [i, pos] of positions.entries()) {
		say(`reading ${spoken[pos] ?? pos}`, i, positions.length)
		const url = pageUrl(leagueId, sport, pos, 0, "A")
		try {
			/* Same-origin, from inside the reader's own signed-in tab, so his cookies go
			   with it exactly as they would if he clicked the link himself. `credentials`
			   is spelled out rather than left to the default because the default differs
			   between the two browsers this has to work in. */
			const res = await fetch(samePath(url), { credentials: "include" })
			if (!res.ok)
				return {
					grabs,
					failure: {
						step: "pool",
						what: `Yahoo answered ${res.status} for ${pos}`,
						fix: "Try again in a few minutes.",
						detail: url
					}
				}
			const html = await res.text()
			const wall = wallIn(html.replace(/<[^>]+>/g, " ").slice(0, 600))
			if (wall) return { grabs, failure: wall }
			grabs.push({ url, kind: "players", text: "", html, at: now() })
		} catch (e) {
			return {
				grabs,
				failure: {
					step: "pool",
					what: "that request never came back",
					fix: "Check you are still signed in to Yahoo.",
					detail: String(e)
				}
			}
		}
		/* A gap between requests. 250ms is four a second against a site that serves
		   millions; the Node reader uses 120ms and has still been throttled, and nothing
		   here is in a hurry — the reader is watching a progress line, not a spinner. */
		await new Promise(r => setTimeout(r, 250))
	}
	say("done", positions.length, positions.length)
	return { grabs, failure: null }
}

chrome.runtime.onMessage.addListener(
	(
		msg: { ask: Ask; id: string; leagueId?: string; sport?: string; positions?: string[] },
		_sender,
		reply
	) => {
		if (!msg || typeof msg.ask !== "string") return
		const wall = wallIn(document.body?.innerText ?? "")
		if (wall) {
			reply({ kind: "failed", failure: wall })
			return true
		}
		if (msg.ask === "page") {
			reply({ kind: "grabs", grabs: [grabHere()] })
			return true
		}

		/*
		   ONE PRESS, TWO PAGES.
		
		   A team page carries the roster and no scoring table; the settings page carries the
		   scoring table and no roster. A reader told to press one button and then told the
		   app still does not know how his league scores has been asked to do a thing twice,
		   so the settings page is fetched alongside whatever he is looking at.
		
		   It is ONE extra request, to a page of his own league, from his own signed-in tab.
		   That is the whole difference between this and a sweep, which asks nine times and
		   therefore sits behind its own button.
		*/
		if (msg.ask === "league") {
			const here = grabHere()
			const leagueId = msg.leagueId ?? leagueIdFrom(location.href)
			const sport = msg.sport ?? sportFrom(location.href) ?? "baseball"
			if (!leagueId) {
				reply({ kind: "grabs", grabs: [here] })
				return true
			}
			const settingsUrl = `https://${sport}.fantasysports.yahoo.com/b1/${leagueId}/settings`
			void (async () => {
				if (here.kind === "settings") {
					reply({ kind: "grabs", grabs: [here] })
					return
				}
				try {
					const res = await fetch(samePath(settingsUrl), { credentials: "include" })
					const html = res.ok ? await res.text() : ""
					/* Text, not HTML, because `leagueFromPastedSettings` is written to be handed
					   what a reader would get by selecting the page and copying it — and it is the
					   parser the paste box has used all along, with its own tests. Tags are
					   stripped here rather than in the app so the 400 KB never crosses the wire. */
					const text = html
						.replace(/<script[\s\S]*?<\/script>/gi, " ")
						.replace(/<style[\s\S]*?<\/style>/gi, " ")
						.replace(/<\/(tr|div|p|li|h\d|table)>/gi, "\n")
						.replace(/<\/t[dh]>/gi, "\t")
						.replace(/<[^>]+>/g, "")
						.replace(/&nbsp;/g, " ")
						.replace(/&amp;/g, "&")
						.replace(/[ \t]+\n/g, "\n")
						.replace(/\n{3,}/g, "\n\n")
					const wall = wallIn(text)
					reply({
						kind: "grabs",
						grabs: wall || !text.trim() ? [here] : [here, { url: settingsUrl, kind: "settings", text, at: now() }],
						failure: wall ?? undefined
					})
				} catch {
					reply({ kind: "grabs", grabs: [here] })
				}
			})()
			return true
		}
		if (msg.ask === "pool") {
			const leagueId = msg.leagueId ?? leagueIdFrom(location.href)
			const sport = msg.sport ?? sportFrom(location.href) ?? "baseball"
			if (!leagueId) {
				reply({
					kind: "failed",
					failure: {
						step: "pool",
						what: "this page does not say which league it is",
						fix: "Open your own team page on Yahoo and try again."
					}
				})
				return true
			}
			void sweep(
				leagueId,
				sport,
				msg.positions ?? ["C", "1B", "2B", "3B", "SS", "OF", "Util", "SP", "RP"],
				(say, done, total) => {
					/* Progress goes to the background rather than back down the reply
					   channel, which can only be used once. The app renders `say`
					   verbatim, so it is written in the reader's words. */
					chrome.runtime.sendMessage({ kind: "progress", id: msg.id, say, done, total })
				}
			).then(({ grabs, failure }) => {
				reply(failure && !grabs.length ? { kind: "failed", failure } : { kind: "grabs", grabs, failure })
			})
			return true
		}
		return false
	}
)

/* Tells the background this tab can be read, so "is Yahoo open?" is answered without
   asking every tab in the browser. */
void chrome.runtime.sendMessage({
	kind: "yahoo-here",
	url: location.href,
	league: leagueIdFrom(location.href),
	sport: sportFrom(location.href)
})
