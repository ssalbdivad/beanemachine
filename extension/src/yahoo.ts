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
	rowsOnly,
	isKnownAsk,
	SPORT,
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

/**
 * A FETCHED PAGE, REDUCED TO WHAT A BROWSER WOULD HAVE SHOWN.
 *
 * Tags are stripped HERE rather than in the app so the 400 KB never crosses the wire, and
 * text rather than HTML is what goes over because text is what the app's parsers are
 * written to be handed — `leagueFromPastedSettings` takes what a reader would get by
 * selecting a page and copying it — and because text is what survives a redesign.
 *
 * Script and style bodies go FIRST and that ordering is load-bearing. Stripping only tags
 * leaves the CONTENTS of every inline script in the text, and a Yahoo page's head is inline
 * script containing, among much else, the string `login.yahoo.com` — which `wallIn` reads
 * as "Yahoo asked you to sign in". The reader would be told to sign in on the page he was
 * already signed in to, and the read would be refused for a wall that was never there.
 * Written out once because three callers needed it and two of them had their own copy.
 */
const renderedText = (html: string): string =>
	html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<\/(tr|div|p|li|h\d|table)>/gi, "\n")
		.replace(/<\/t[dh]>/gi, "\t")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")

const grabHere = (): Grab => {
	const kind = pageKind(location.href)
	/* HTML for the player table alone. `parsePage` reads `data-ys-playerid` and the row's
	   `title=`, neither of which survives innerText — and the id is what makes a free agent
	   the same man as a snapshot player rather than a name that might be two people. A
	   roster page's HTML is ~400 KB against ~4 KB of text and would buy nothing.

	   Cut to its rows on the way out, the same as a swept page and for the same reason: the
	   reader standing on the players page is the ONE case where a whole page of markup
	   crosses `postMessage` for a read nobody asked to be a sweep. Measured on the fixture
	   in test/extension.mjs, which serves the 25 rows and ~90 KB footer the real page was
	   measured to have. `rowsOnly` returns null on anything it does not recognise, and then
	   the whole page goes over exactly as it did before. */
	const markup = kind === "players" ? document.documentElement.outerHTML : null
	return {
		url: location.href,
		kind,
		text: document.body?.innerText ?? "",
		html: markup === null ? undefined : (rowsOnly(markup) ?? markup),
		at: now()
	}
}

/**
 * The sign-in wall and the throttle wall both arrive as a 200 with a page, so the only
 * way to tell them from a real answer is to read the words. Checked on the text rather
 * than the HTML because the HTML of every Yahoo page contains the string "sign in"
 * somewhere in its header — and on text put through `renderedText`, which is what takes
 * `login.yahoo.com` out of the inline script in the head where it would have matched.
 *
 * TWO THOUSAND CHARACTERS, not six hundred, AND THE TRADE IS DELIBERATE.
 *
 * The window has to be long enough to reach the wall and short enough not to swallow the
 * page. 600 was a guess: a real page's first characters are the nav and the league's own
 * name, and how much of that comes before the body is a layout nobody here controls. A wall
 * that sits 800 characters in — behind a fuller header than the fixture's — was invisible,
 * and test/extension.mjs now serves exactly that page and asserts both windows against it.
 *
 * The cost of the longer window is a false wall: a league or a team NAMED after one of
 * these phrases appears near the top of every page, so a manager whose rivals call
 * themselves "Request Denied" would be told Yahoo is refusing to answer. That is the right
 * way round to be wrong. A false wall costs him a read he can retry and a sentence that is
 * merely unhelpful; a MISSED wall is a throttle parsed as a league, written into his stores
 * as an empty team and an empty wire, and presented as the truth — which is the single most
 * expensive failure this feature has, and the reason the check exists at all.
 */
const wallIn = (text: string): GrabFailure | null => {
	const head = text.slice(0, 2000)
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
/** What each slot is called by somebody who plays baseball rather than by somebody who
 *  writes the roster rules down. Used for the progress line AND for the sentence when a
 *  position cannot be read: "Yahoo would not answer for the shortstops" is a thing a reader
 *  can picture, and `Yahoo answered 429 for SS`, which is what this said before, is two
 *  pieces of machinery and a position code. */
const SPOKEN: Record<string, string> = {
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

const sweep = async (
	leagueId: string,
	sport: string,
	positions: string[],
	say: (s: string, done: number, total: number) => void
): Promise<{ grabs: Grab[]; failure: GrabFailure | null }> => {
	const grabs: Grab[] = []
	const spoken = SPOKEN
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
						/* A status code is Yahoo's word to a program, not to a reader. What he
						   can act on is that it stopped, and where. The code travels in `detail`,
						   which is for whoever is reading a bug report rather than a screen. */
						what: `Yahoo would not answer for the ${spoken[pos] ?? pos}`,
						fix: "Wait a few minutes and try again. Nothing is wrong with your league.",
						detail: `${res.status} ${url}`
					}
				}
			const html = await res.text()
			const wall = wallIn(renderedText(html))
			if (wall) return { grabs, failure: wall }
			/*
			   THE ROWS, WITHOUT THE PAGE AROUND THEM.

			   `rowsOnly` keeps, for each of `parsePage`'s own row markers, exactly the span
			   `parsePage` would have read — so what arrives parses to the identical rows by
			   construction, which test/extension.mjs asserts rather than assumes. It is a
			   size cut and not a parse: it reads no value and knows nothing about a player.

			   FAIL-SAFE BY DESIGN. If Yahoo ever moves the marker, nothing matches, this
			   returns null, and the whole page goes over exactly as it did before. A redesign
			   costs bandwidth here; it can never cost a row. That is the only shape of
			   optimisation that belongs on this side of the wire, because this side cannot be
			   fixed until a store review says so.
			*/
			grabs.push({
				url,
				kind: "players",
				text: "",
				html: rowsOnly(html) ?? html,
				at: now(),
				swept: true,
				/* The whole list this sweep set out to get, on every page of it — see `asked`
				   in src/data/extension.ts. A page that never arrived cannot carry anything,
				   and this is the fact that makes a stopped sweep visible as a stopped sweep. */
				asked: positions
			})
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

/**
 * WHAT THE PAGE IS ALLOWED TO PUT IN A URL.
 *
 * The league and the sport arrive from the app, and both are interpolated into a path that
 * is then fetched from inside the reader's signed-in Yahoo tab. The fetch is same-origin, so
 * the worst case is bounded — nothing can be sent to another site — but "bounded" is not
 * "nothing": a league id of `228947/../../somewhere-else` is a request for a different page
 * of Yahoo, answered with the reader's own cookies, and handed back to whatever asked. The
 * app is the only thing that can ask, and the app is a static site with no server, so the
 * realistic way this gets abused is a script injected into a page of it.
 *
 * A league is digits. A sport is letters. Anything else is not narrowed or escaped, it is
 * dropped, and the tab's own URL is used instead — which is the value that was going to be
 * right nearly every time anyway.
 */
const asked = (id: string | undefined): string | null => (id && /^\d+$/.test(id) ? id : null)
const sportAsked = (s: string | undefined): string | null => (s && /^[a-z]+$/i.test(s) ? s.toLowerCase() : null)

/**
 * THE SLOTS A SWEEP MAY ASK FOR, and no others.
 *
 * `positions` arrives from the app and becomes one request each, paced a quarter-second
 * apart, against somebody else's site. A list of two hundred would be two hundred requests
 * — and the reader, not this project, is the one whose account is making them. Narrowed to
 * the nine slots that exist, deduplicated, and in the order the pool is built in, so the
 * most a press can ever cost is nine requests however it is asked for.
 */
const POSITIONS = ["C", "1B", "2B", "3B", "SS", "OF", "Util", "SP", "RP"]
const slotsAsked = (want: string[] | undefined): string[] => {
	if (!want?.length) return POSITIONS
	const kept = POSITIONS.filter(p => want.includes(p))
	/* Nothing recognisable is treated as nothing asked for, which reads the whole wire. The
	   alternative is a sweep that makes no requests and comes back with an empty answer and
	   no failure — a silence, which is the thing this whole file is written to avoid. */
	return kept.length ? kept : POSITIONS
}

/** Whether a sweep is running in THIS tab. Not stored, not shared, and gone with the page —
 *  it is a fact about what this script is doing right now, which is the only thing it is
 *  allowed to remember. See the note where it is set. */
let sweeping = false

/**
 * EVERY WAY OUT OF THIS LISTENER ENDS IN A REPLY, INCLUDING THE ONES NOBODY THOUGHT OF.
 *
 * A throw inside a message listener is not a crash a reader ever sees: the reply channel
 * simply closes, and what he gets is the app's own patience running out ninety seconds
 * later, or — worse, now that the bridge reads `lastError` — the sentence for an extension
 * that was switched off, about an extension that is running perfectly well and merely hit a
 * page it did not expect.
 *
 * Yahoo's pages are somebody else's and change without notice, so "it did not expect" is a
 * normal event rather than a bug that will have been fixed by then. The wrapper turns every
 * unplanned throw into the only honest sentence available, immediately.
 */
const answering = (
	body: () => boolean | void,
	reply: (answer: unknown) => void
): boolean | void => {
	try {
		return body()
	} catch (e) {
		reply({
			kind: "failed",
			failure: {
				step: "yahoo",
				what: "that page could not be read",
				fix: "Open your own team page on Yahoo and try again.",
				detail: String(e)
			}
		})
		return true
	}
}

chrome.runtime.onMessage.addListener(
	(
		msg: { ask: Ask; id: string; leagueId?: string; sport?: string; positions?: string[] },
		_sender,
		reply
	) => answering(() => {
		if (!msg || typeof msg.ask !== "string") return
		/* An ask from a page newer than this build. The router refuses it before it gets
		   here, but a reader can also have a newer ROUTER than content script — the router
		   is a service worker that restarts on the new build while a tab keeps the content
		   script it was injected with — so the same refusal is written on both sides rather
		   than trusted to one. Falling through with no reply is what made this look like a
		   lost connection. */
		if (!isKnownAsk(msg.ask)) {
			reply({
				kind: "failed",
				failure: {
					step: "extension",
					what: "what reads Yahoo in this browser is older than this page, and cannot do this yet",
					fix: "Update it in your browser's extensions list, then reload this page."
				}
			})
			return true
		}
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
			const leagueId = asked(msg.leagueId) ?? leagueIdFrom(location.href)
			const sport = sportAsked(msg.sport) ?? sportFrom(location.href) ?? SPORT
			if (!leagueId) {
				reply({ kind: "grabs", grabs: [here] })
				return true
			}
			const settingsUrl = `https://${sport}.fantasysports.yahoo.com/b1/${leagueId}/settings`
			const matchupUrl = `https://${sport}.fantasysports.yahoo.com/b1/${leagueId}/matchup`
			/** A page fetched from the reader's own signed-in tab, as the text a browser would
			 *  have rendered — see `renderedText`. Empty string when Yahoo would not serve it,
			 *  which the caller treats as "not read" rather than as "empty". */
			const asText = async (url: string): Promise<string> => {
				const res = await fetch(samePath(url), { credentials: "include" })
				if (!res.ok) return ""
				return renderedText(await res.text())
			}
			void (async () => {
				try {
					/*
					   THE SETTINGS PAGE IS NOT FETCHED WHEN HE IS STANDING ON IT, and the matchup
					   still is. This used to reply with the settings page alone the moment the
					   reader pressed the button from his league's settings screen — no opponent,
					   silently, for no reason beyond where the early-return was written. A press is
					   a press wherever it is made, so the only thing the current page changes is
					   which request would have been a duplicate.
					*/
					const text = here.kind === "settings" ? "" : await asText(settingsUrl)
					const wall = text ? wallIn(text) : null
					/*
					   AND WHO HE IS PLAYING, on the same press.
					
					   "Am I winning?" is the question a head-to-head manager asks most, and until
					   now the only way this app could answer it was to ask him to paste his
					   opponent's roster — a second gesture, on a second page, for a fact his own
					   league page already shows him. One more request to a page of his own league
					   is the whole cost.
					
					   The app takes the NAMES out of it and nothing else. A score is printed on
					   that page too, and it is deliberately not read: nobody here has seen the
					   real page, and a regular expression written against a page nobody has seen
					   is a number this app would print with total confidence and no idea whether
					   it was the score, the projection, or last week's.
					*/
					const matchup = await asText(matchupUrl).catch(() => "")
					const extra: Grab[] = []
					if (!wall && text.trim())
						extra.push({ url: settingsUrl, kind: "settings", text, at: now() })
					if (matchup.trim() && !wallIn(matchup))
						extra.push({ url: matchupUrl, kind: "matchup", text: matchup, at: now() })
					reply({ kind: "grabs", grabs: [here, ...extra], failure: wall ?? undefined })
				} catch {
					reply({ kind: "grabs", grabs: [here] })
				}
			})()
			return true
		}
		if (msg.ask === "pool") {
			const leagueId = asked(msg.leagueId) ?? leagueIdFrom(location.href)
			const sport = sportAsked(msg.sport) ?? sportFrom(location.href) ?? SPORT
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
			/*
			   ONE SWEEP AT A TIME, AND THE SECOND PRESS IS TOLD SO.

			   The app disables its own button while a read is running, which is enough for one
			   screen and nothing at all for two: the board and the setup sheet are different
			   tabs of the same app, each with its own idea of whether anything is busy, and
			   both route to this one Yahoo tab. Two sweeps interleaved are eighteen requests in
			   the time budgeted for nine, against a site that answers nine with a wall often
			   enough to have its own commit (de44045) — so the second press would not merely
			   duplicate the first, it would throttle it, and the reader would watch both fail.

			   Refused rather than queued. Queueing makes him wait twice as long for a list he
			   is about to be given anyway, and a sentence he can read is better than a spinner
			   that is secretly two spinners.
			*/
			if (sweeping) {
				reply({
					kind: "failed",
					failure: {
						step: "pool",
						what: "your free agents are being read right now",
						fix: "Wait for that to finish — it takes a few seconds — and the list will be here."
					}
				})
				return true
			}
			sweeping = true
			void sweep(
				leagueId,
				sport,
				slotsAsked(msg.positions),
				(say, done, total) => {
					/* Progress goes to the background rather than back down the reply
					   channel, which can only be used once. The app renders `say`
					   verbatim, so it is written in the reader's words.

					   Wrapped because the extension can be updated out from under a sweep in
					   flight, and an uncaught throw here would take the sweep's own `.then`
					   with it — losing the pages it had already collected as well as the
					   connection. */
					try {
						chrome.runtime.sendMessage({ kind: "progress", id: msg.id, say, done, total })
					} catch {
						/* Orphaned. The pages still go back if the channel outlives us; if it
						   does not, the page's own half says so — see bridge.ts. */
					}
				}
			)
				.then(({ grabs, failure }) => {
					reply(failure && !grabs.length ? { kind: "failed", failure } : { kind: "grabs", grabs, failure })
				})
				/* A sweep that throws somewhere nobody predicted must still end in a sentence.
				   Without this the promise rejects, `reply` is never called, and the reader
				   watches the app's ninety-second patience run out on a read that stopped
				   existing at the second position. */
				.catch(e =>
					reply({
						kind: "failed",
						failure: {
							step: "pool",
							what: "the free agents could not be read",
							fix: "Wait a few minutes and try again. Nothing is wrong with your league.",
							detail: String(e)
						}
					})
				)
				.finally(() => {
					sweeping = false
				})
			return true
		}
		return false
	}, reply)
)

/**
 * TELLS THE ROUTER THIS TAB CAN BE READ, so "is Yahoo open?" is answered without asking
 * every tab in the browser — and says it again whenever the reader comes back to this tab.
 *
 * The repeat is what makes "the tab he was last looking at" true rather than merely
 * written. A manager in September has his baseball league and his football league open at
 * once, and the router picks the most recently announced: with one announcement per page
 * load, that is the tab he opened LAST, which after ten minutes of switching back and forth
 * is not the tab he is in front of. Focus and visibility are the two events that mean "he
 * is here now", and they cost a message each.
 *
 * Wrapped, because an orphaned content script — one left in a page after its extension was
 * updated or switched off — throws on `sendMessage` rather than failing quietly, and an
 * uncaught throw in a visibility handler is an error in the reader's console on every tab
 * switch for the rest of the session.
 */
const announce = (): void => {
	try {
		void chrome.runtime.sendMessage({
			/* Nothing but "he is here now". What this page IS gets read out of the tab's own
			   URL by the router when a question is asked — the URL is where the league and the
			   sport were always read from, and a copy of them kept in the router goes stale the
			   moment he navigates and vanishes altogether when the worker is stopped. */
			kind: "yahoo-here"
		})
	} catch {
		/* The extension went away under this tab. Nothing here can fix that, and the app is
		   told by its own half of the wire — see bridge.ts. */
	}
}

announce()
window.addEventListener("focus", announce)
document.addEventListener("visibilitychange", () => {
	if (!document.hidden) announce()
})
