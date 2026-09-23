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
	teamIdFrom,
	rowsOnly,
	isKnownAsk,
	SPORT,
	type Ask,
	type Grab,
	type GrabFailure
} from "../../src/data/extension.ts"
import { YAHOO, type Fetchable } from "../../src/data/platforms.ts"
/* The app's own entity decoder, so a page read here and the same page fetched from Node
   produce the same text. See `renderedText`. */
import { decodeEntities } from "../../src/html.ts"

/** Yahoo throttles by serving a wall rather than an error status, so the words are the
 *  only signal — the same test `src/auto/roster.ts` uses against the same site, kept
 *  identical on purpose so both readers call the same page the same thing. */
const THROTTLED = /too many requests|unusual traffic|rate limit|temporarily blocked|request denied/i

/**
 * THE SIGN-IN WALL ARRIVES TWO WAYS, AND ONE REGEX WAS BEING ASKED TO CATCH BOTH.
 *
 * It was `/login\.yahoo\.com|\/account\/challenge|guce\.yahoo\.com|please sign in/i`, applied
 * to TEXT at all four call sites — and text here has been through `renderedText`, which
 * deletes every tag and therefore every href, after deleting the script bodies. So three of
 * the four alternatives could not match anything the function was ever handed. `innerText`
 * carries no href either. What was left doing the whole job was the literal visible phrase
 * "please sign in", on a check the file's own note calls the most expensive one it has: "a
 * MISSED wall is a throttle parsed as a league, written into his stores as an empty team and
 * an empty wire, and presented as the truth".
 *
 * The sibling reader has the same pattern and applies it correctly — `src/auto/roster.ts`
 * tests it against `page.url()` — so the two were only ever "identical on purpose" in their
 * spelling. Split here into the two things they are:
 *
 *   `SIGN_IN_URL` is the definitive signal and needs no guessing at wording, and it is the
 *   one `roster.ts` uses. It is tested against `Response.url`, which is the FINAL url after
 *   redirects. That reaches the case that matters most in a content script — a same-origin
 *   redirect to `/account/challenge` — and cannot reach `login.yahoo.com` or `guce`, which
 *   are other hosts: an MV3 content script's fetch is subject to the page's CORS, so a
 *   cross-origin redirect rejects rather than resolving, and the throw is already turned
 *   into a sentence by every caller. Kept in full anyway, because it costs nothing and it is
 *   the test that stops being a guess if that ever changes.
 *
 *   `SIGN_IN_TEXT` is the words, for the case the file's own comment says is the ordinary
 *   one: the wall arrives as a 200 with a page at the same url. THE EXACT WORDING IS NOT
 *   MEASURED — no capture of a Yahoo sign-in interstitial is committed here, and the fixture
 *   in test/extension.mjs serves a sentence this file chose. So this is the half that can be
 *   wrong, and it is deliberately a phrase rather than the bare words "sign in", which
 *   appear in the header of every signed-in Yahoo page.
 */
const SIGN_IN_URL = /login\.yahoo\.com|\/account\/challenge|guce\.yahoo\.com/i
const SIGN_IN_TEXT = /please sign in|sign in to continue|sign in to your account/i

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
 * ONE REQUEST, WITH AN END TO IT.
 *
 * `fetch` has no timeout. A server that accepts a connection and then sends nothing leaves the
 * promise pending until the operating system's keepalive gives up, which is minutes and can be
 * hours — and a request that never settles is a `finally` that never runs.
 *
 * That is not a theoretical shape: it is a wifi drop mid-sweep, a laptop waking from sleep, or
 * Yahoo hanging. Reproduced against the suite's own fake Yahoo by holding one players response
 * open: the gate stayed claimed, and every later press of EITHER button was refused with "your
 * free agents are being read right now — it takes a few seconds", which is false in both
 * halves, for the life of the tab. The file's own note beside the gate says a gate that is not
 * released is an extension that has quietly stopped working; this is what it was warning about.
 *
 * Twenty seconds per page. A Yahoo page that has not begun to answer in twenty seconds is not
 * about to — the sweep's whole nine pages take about three — and the app's own patience is
 * ninety, so nine pages each taking the full twenty would still report a failure rather than
 * hang. The abort surfaces as a rejected fetch, which both callers already turn into a
 * sentence.
 */
const PAGE_MS = 20_000
const getPage = async (url: string): Promise<Response> => {
	const stop = new AbortController()
	const bell = setTimeout(() => stop.abort(), PAGE_MS)
	try {
		/* Same-origin, from inside the reader's own signed-in tab, so his cookies go with it
		   exactly as they would if he clicked the link himself. `credentials` is spelled out
		   rather than left to the default because the default differs between the two browsers
		   this has to work in. */
		return await fetch(samePath(url), { credentials: "include", signal: stop.signal })
	} finally {
		clearTimeout(bell)
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
 *
 * ── AND IT DECODES WHAT THE APP'S OWN CONVERTER DECODES ───────────────────────────────
 *
 * This had two hand-written replaces, `&nbsp;` and `&amp;`, against `decodeEntities` in
 * src/html.ts — six named entities plus decimal and hex numeric refs — which is what
 * src/import.ts and src/data/yahoo-pool.ts run over THE SAME YAHOO PAGES when they are
 * fetched server-side. So one page had two readings. Run on
 * `<td>Mrs. Met&#39;s Harem</td><td>Hits &gt; 2</td>`, this file produced
 * `Mrs. Met&#39;s Harem\tHits &gt; 2` and `documentText` produced `Mrs. Met's Harem Hits > 2`
 * — and the text from here is what goes to `leagueFromPastedSettings`, the parser that names
 * the teams. A team name carrying a literal `&#39;` does not match the same team name
 * carrying an apostrophe, because `normalizeName` strips `'` and knows nothing about `&#39;`.
 * Latent rather than demonstrated: no committed fixture carries an entity. It is here
 * because the two files are the reader and the fetcher of one page and only one of them
 * decoded.
 *
 * IMPORTING IT IS NOT PARSING. The rule at the top of this file is that the extension hands
 * over text and the app decides what it means; `decodeEntities` is a leaf with no imports
 * that turns `&gt;` into `>`, which is a fact about HTML rather than a fact about Yahoo, and
 * it is the same function the app would have applied a moment later if the page had been
 * fetched from Node. Nothing about a league is decided here.
 *
 * Decoded AFTER the tags come out and BEFORE the whitespace passes, so `&nbsp;` becomes the
 * plain space `ENTITIES` maps it to and is then collapsed with the rest.
 */
const renderedText = (html: string): string =>
	decodeEntities(
		html
			.replace(/<script[\s\S]*?<\/script>/gi, " ")
			.replace(/<style[\s\S]*?<\/style>/gi, " ")
			.replace(/<\/(tr|div|p|li|h\d|table)>/gi, "\n")
			.replace(/<\/t[dh]>/gi, "\t")
			.replace(/<[^>]+>/g, "")
	)
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")

/**
 * THE SAME PAGE, WITHOUT ITS SCRIPTS.
 *
 * `renderedText` above strips script and style bodies FIRST, for an unrelated reason — a
 * Yahoo page's inline script contains the string `login.yahoo.com`, which `wallIn` would read
 * as a sign-in wall on a page the reader is perfectly well signed in to. The MARKUP path had
 * no such step, and the markup path has a deliberate fail-safe: when `rowsOnly` finds no row
 * marker it sends the whole page, so that a Yahoo redesign costs bandwidth and never costs a
 * row.
 *
 * Those two facts meet badly. The day Yahoo moves the row marker is the day the entire
 * players page crosses `postMessage` to the app origin — and a signed-in Yahoo fantasy page's
 * inline script is not neutral: it carries session-scoped values, the request crumb among
 * them. Nothing on the app side wants them, `parsePage` reads only `data-ys-playerid` and
 * `title=` off anchors, and the day it happens is precisely the day nobody notices, because
 * the parse still works through the fallback.
 *
 * So the same strip runs on both paths. It costs one pass over a string that is about to be
 * cut up anyway, and it cannot remove a row: a row is an anchor, not a script.
 */
const withoutScripts = (html: string): string =>
	html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")

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
	const markup = kind === "players" ? withoutScripts(document.documentElement.outerHTML) : null
	return {
		url: location.href,
		kind,
		text: document.body?.innerText ?? "",
		html: markup === null ? undefined : (rowsOnly(markup) ?? markup),
		at: now()
	}
}

/**
 * The sign-in wall and the throttle wall both arrive as a 200 with a page, so for a page
 * that did not redirect the words are the only way to tell them from a real answer —
 * `wallAt` below is the half that reads the url instead, and it runs first wherever there is
 * a `Response` to read it off. Checked on the text rather than the HTML because the HTML of
 * every Yahoo page contains the string "sign in" somewhere in its header, and on text put
 * through `renderedText`, which is what takes the inline script in the head out of the way.
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
const SIGNED_OUT: GrabFailure = {
	step: "yahoo",
	what: "Yahoo asked you to sign in",
	fix: "Sign in to Yahoo in that tab, then try again."
}

/**
 * THE WALL AS THE URL TELLS IT, before anybody reads a word of the page.
 *
 * `Response.url` is the url the fetch ENDED on, so a page that redirected to Yahoo's own
 * sign-in challenge says so in a field rather than in prose. Checked first because it cannot
 * be wrong: there is no wording to guess at and no false wall to trade against (a league
 * NAMED "Request Denied" is a live hazard for the text test below and is no hazard at all
 * here). See `SIGN_IN_URL` for what this can and cannot reach from inside a content script.
 */
const wallAt = (res: Response): GrabFailure | null =>
	SIGN_IN_URL.test(res.url) ? SIGNED_OUT : null

const wallIn = (text: string): GrabFailure | null => {
	const head = text.slice(0, 2000)
	if (SIGN_IN_TEXT.test(head)) return SIGNED_OUT
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

/**
 * THE SAME THING FOR PAGES, and for the same reason.
 *
 * A one-press read fetches three or four pages of the reader's own league, and when one of
 * them will not come the sentence has to name WHICH — "Yahoo would not answer for your
 * league's scoring page" tells him what he is missing off the board, and `/settings` or a
 * `PageKind` tells him nothing he can hold. `unknown` is here so the lookup cannot produce
 * `undefined` for a page kind added later; the fallback at the call site is the same words.
 */
const SPOKEN_PAGE: Record<string, string> = {
	team: "your team's roster page",
	settings: "your league's scoring page",
	eligibility: "your league's eligibility page",
	matchup: "this week's matchup page",
	players: "your league's player list",
	league: "your league's home page",
	unknown: "one of your league's pages"
}

const sweep = async (
	leagueId: string,
	sport: string,
	positions: string[],
	say: (s: string, done: number, total: number) => void
): Promise<{ grabs: Grab[]; failure: GrabFailure | null }> => {
	const grabs: Grab[] = []
	const spoken = SPOKEN
	/* The URLs come from the descriptor, the same record the one-press plan and the manifest's
	   own match patterns come from — so `count=0`, `status=A` and the per-position shape are
	   stated once, in the file that says what Yahoo is, rather than here in the file that
	   fetches. `pageUrl` is still what builds them; this asks the descriptor rather than
	   reaching for it directly, so a platform that pages its wire differently can. */
	const plan = YAHOO.sweep!({ kind: "players", leagueId, teamId: null, sport }, positions)
	for (const [i, pos] of positions.entries()) {
		say(`reading ${spoken[pos] ?? pos}`, i, positions.length)
		const url = plan[i]!.url
		try {
			/* Counted against this tab's per-minute ceiling as it is spent rather than reserved
			   up front, so a sweep that stops at position four leaves five requests' worth of
			   room behind it instead of holding them until the window rolls. `getPage` is where
			   the request and its deadline live. */
			spend()
			const res = await getPage(url)
			/* The sign-in wall as the url tells it, before the page is read — see `wallAt`.
			   Checked before the status, because a challenge can arrive with a 200. */
			const sent = wallAt(res)
			if (sent) return { grabs, failure: sent }
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
				html: (() => {
					/* Scripts out FIRST, so the `?? page` fail-safe below cannot hand the app a
					   signed-in page's inline session values — see `withoutScripts`. */
					const page = withoutScripts(html)
					return rowsOnly(page) ?? page
				})(),
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

/**
 * WHAT THIS TAB IS DOING RIGHT NOW, AND HOW HARD IT HAS BEEN ASKING.
 *
 * ── what this used to be ──────────────────────────────────────────────────────────────
 *
 * `let sweeping = false`, held over the free-agent sweep alone, because a sweep is nine
 * requests and two interleaved sweeps are eighteen in the time budgeted for nine. That was
 * true and it was half the problem. The `league` press had no flag, no spacing and no cap at
 * all, and it makes network requests too: twenty `{ask:"league"}` posts from a page script
 * produced FORTY fetches of the reader's signed-in Yahoo in 68 milliseconds, measured against
 * the real unpacked extension. Nothing in the app does that, but the app is a static site
 * whose whole threat model is a script injected into a page of it, and the consequence lands
 * on the reader rather than on this project: it is HIS Yahoo account that gets throttled, and
 * uninstalling the extension afterwards does not un-throttle it.
 *
 * Neither did anything stop sweeps running back to back for ever — three in a row measured at
 * 27 requests in 6.9 seconds, a sustained four a second, with no refusal and no counter.
 *
 * ── what it is now ────────────────────────────────────────────────────────────────────
 *
 * Two rules, both about REQUESTS rather than about presses, because requests are what the
 * other site sees:
 *
 *   ONE AT A TIME. Any ask that fetches claims `reading` and gives it back in a `finally`.
 *   The second press is refused with a sentence rather than queued — queueing makes a reader
 *   wait twice as long for a list he is about to be handed anyway, and a sentence he can read
 *   beats a spinner that is secretly two spinners.
 *
 *   A CEILING PER MINUTE. `ALLOWANCE` requests in any rolling `WINDOW`, counted as they are
 *   spent. A sweep is nine and a league press is two or three, so a reader pressing both
 *   buttons as fast as he can read them never comes near it, and a loop hits it in under a
 *   second and is told so in words. The number is deliberately close to what a real session
 *   costs: two full sweeps and a couple of presses in a minute is already more than any
 *   reader does, and the ceiling is a bound on abuse, not a rationing of use.
 *
 * Both are per-tab and per-page-load: not stored, not shared, gone when the tab is closed.
 * A fact about what this script is doing right now is the only thing it is allowed to
 * remember — see PRIVACY.md, where that is a promise rather than an implementation note.
 *
 * WHICH MEANS THE CEILING IS PER TAB, and a reader with three Yahoo tabs open has three
 * ceilings. That is a real limit on what this can promise and it is the right trade: the
 * alternative is a shared counter, which means either storage — a thing this add-on does not
 * have and says it does not have — or a service worker that the browser restarts whenever it
 * feels like it, taking the count with it. Neither is worth a promise they cannot keep.
 *
 * It still bounds the failure it was written for: a script injected into the app's own page
 * can only reach the tab the ROUTER picks for it, which is one tab per ask (`pickTab` in
 * background.ts), so driving three tabs at once means three real Yahoo pages the reader has
 * open on three different leagues.
 */
let reading: null | "league" | "pool" | "rosters" = null
/**
 * WHEN THE CURRENT READ CLAIMED THE GATE, so a read that cannot end cannot hold it.
 *
 * `getPage` bounds each request, which bounds a sweep at nine pages of twenty seconds plus its
 * own pacing — about three minutes in the worst case anybody has ever seen, against three
 * seconds in the ordinary one. This is the backstop under that: a claim older than four
 * minutes is treated as abandoned and the next press takes the gate.
 *
 * Belt and braces on purpose. The failure it guards against is the one the gate's own note
 * calls worse than the burst — an extension that has quietly stopped working — and the cost of
 * being wrong here is two overlapping reads, once, which the per-minute ceiling still bounds.
 */
let readingSince = 0
const STUCK_MS = 240_000
const gateHeld = (): boolean => reading !== null && Date.now() - readingSince < STUCK_MS
const claim = (what: "league" | "pool" | "rosters"): void => {
	reading = what
	readingSince = Date.now()
}
const WINDOW = 60_000
/*
   WAS 45, AND A READER STARTED FEELING IT — which the number is defined by not doing.

   A "read my league" press is not one request: `readLeagueHere` reads the league and then
   sweeps, so it is `onePress` plus nine positions. `onePress` went from two pages to four
   (his own team, which it could not ask for at all from a URL that names no team, and the
   eligibility page, which nothing had ever asked for), so a press went from 11 requests to
   13, and a reader who also presses "read who is taken" spends 9 more.

   Measured in test/extension.mjs against the published build: the journey block pressed the
   button on a tab that had already been read from, and the sweep was refused with "this has
   asked Yahoo a lot in the last minute… try again in about 30 seconds" — the free agents
   came back empty and the board had no wire. At 45 the ceiling sat between three presses
   (39) and three presses plus a rosters read (48); at 60 it sits past four full presses (52),
   which is more than a reader can produce without waiting for each one to finish.

   Still a bound on abuse rather than a ration. A sweep paces itself at a quarter-second a
   position and there is nothing to press while it runs, so 60 in a rolling minute is a rate
   no hand reaches; a loop on the app origin reaches it in under a second and is told, in a
   sentence, when it may ask again.
*/
const ALLOWANCE = 60
/** When each request this tab has made was made, oldest first, trimmed to the window. */
const spent: number[] = []
const trim = (): void => {
	const cut = Date.now() - WINDOW
	while (spent.length && spent[0]! < cut) spent.shift()
}
/** Milliseconds until `n` more requests would be within the ceiling, or 0 if they are now. */
const waitFor = (n: number): number => {
	trim()
	if (spent.length + n <= ALLOWANCE) return 0
	/* The request whose expiry makes room for the nth one. */
	const need = spent.length + n - ALLOWANCE
	return Math.max(0, spent[need - 1]! + WINDOW - Date.now())
}
/** Called once per request actually made, by the only two places that make them. */
const spend = (): void => {
	trim()
	spent.push(Date.now())
}

/**
 * THE TWO REFUSALS THE GATE CAN GIVE, in the reader's words rather than in the gate's.
 *
 * He is never told about a mutex or an allowance. He is told that something is already
 * running, or that this has asked Yahoo a lot in the last minute and should wait — both of
 * which are true sentences about his league rather than about this file, and both of which
 * tell him what to do next. The `detail` field is where the machine's account goes; the app
 * prints it only where it prints everything.
 */
const alreadyBusy = (step: "pool" | "league" | "rosters"): { kind: "failed"; failure: GrabFailure } => ({
	kind: "failed",
	failure: {
		step,
		what:
			reading === "pool" ? "your free agents are being read right now"
			: reading === "rosters" ? "your league's rosters are being read right now"
			: "your league is being read right now",
		/* The second sentence is the one that matters when this is wrong. A read that is
		   genuinely stuck says "a few seconds" for as long as it is stuck, and the reader has no
		   way to know which of the two he is looking at — so he is given the action that fixes
		   the stuck case and costs nothing in the ordinary one. */
		fix:
			"Wait for that to finish — it takes a few seconds. If it stays stuck, reload your " +
			"Yahoo tab and press again."
	}
})

const askedTooHard = (step: "pool" | "league" | "rosters", ms: number): { kind: "failed"; failure: GrabFailure } => ({
	kind: "failed",
	failure: {
		step,
		what: `this has asked Yahoo a lot in the last minute, so it is giving your league a rest`,
		fix: `Try again in about ${Math.max(1, Math.ceil(ms / 1000))} seconds.`,
		detail: `${spent.length} requests in the last ${WINDOW / 1000}s, which is the ceiling.`
	}
})

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
		msg: {
			ask: Ask
			id: string
			leagueId?: string
			sport?: string
			positions?: string[]
			teamIds?: string[]
			/** For `league`: the team the APP knows is his. A Yahoo URL names a team on the
			 *  team page and nowhere else, so without this a press from the players page
			 *  could not ask for his roster — see `onePress` in src/data/platforms.ts. */
			teamId?: string
		},
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
		/*
		   THE `page` ASK IS GONE, and it stood here.

		   `if (msg.ask === "page") { reply({ kind: "grabs", grabs: [grabHere()] }); return true }`
		   — above the gate, above the ceiling, answering with `document.body.innerText` and,
		   on a players page, the row markup, for whatever league tab the router chose. Nothing
		   in the app had asked for it since the "take me to Yahoo" press stopped posting one;
		   the only remaining callers were probes in test/extension.mjs, which use `league` now.

		   Removed rather than narrowed. This file's threat model is a script injected into a
		   page of the app's own origin (see `asked` below), and a gate on an ask the product
		   does not make is a gate nobody exercises — the honest move is for the capability not
		   to exist. `grabHere()` stays; the `league` branch is what needs it. The full account
		   is at `ASKS` in src/data/extension.ts.
		*/

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
			/*
			   THE PAGES COME FROM THE DESCRIPTOR, not from string-building here.
			
			   This used to build two URLs by hand, a settings page and a matchup page, with the
			   sport interpolated into the host — which is a fact about Yahoo written inside the
			   only file that was ever going to run on Yahoo, and therefore invisible the day a
			   second platform arrives. `onePress` in src/data/platforms.ts answers "given where
			   he is standing, what else does one press need", and it is the same record the
			   manifest's match patterns are written from. This file's job is to fetch what it is
			   handed, from the tab it is in, and to say what came back.
			*/
			const plan = YAHOO.onePress(
				{
					kind: here.kind,
					leagueId,
					teamId: teamIdFrom(location.href),
					sport
				},
				/* What the app already knows, which is the half this tab cannot see. `asked`
				   is the same digits-only filter every other id from the page goes through:
				   this string arrives from a web page and is about to be interpolated into a
				   URL fetched with the reader's own cookies. */
				{ teamId: asked(msg.teamId) }
			)
			/*
			   THIS PRESS FETCHES, SO IT QUEUES BEHIND THE ONE RULE EVERY FETCHING ASK OBEYS.
			
			   It did not, and that was the hole: a `league` ask reached the fetch loop below with
			   no flag, no spacing and no ceiling, so a loop on the app origin drove the reader's
			   own signed-in Yahoo as fast as the browser would go. The page in hand is sent back
			   either way — `here` was read from the DOM and cost nobody a request — so a refusal
			   here is never an empty answer; it is the same read without the extra pages.
			*/
			/*
			   A REFUSAL STILL HANDS BACK THE PAGE HE IS STANDING ON.
			
			   `here` was read from the DOM and cost nobody a request, and the comment above says
			   so — and these two branches replied `failed`, which throws it away. A reader whose
			   second press was refused got nothing at all from a read that had his team page in
			   hand, and the app's own caller treats `kind: "failed"` as "nothing came back".
			   What is refused is the extra fetching, not the read.
			*/
			if (gateHeld()) {
				reply({ kind: "grabs", grabs: [here], failure: alreadyBusy("league").failure })
				return true
			}
			const hold = waitFor(plan.length)
			if (hold > 0) {
				reply({ kind: "grabs", grabs: [here], failure: askedTooHard("league", hold).failure })
				return true
			}
			claim("league")
			/**
			 * A page fetched from the reader's own signed-in tab, IN THE FORM THE DESCRIPTOR
			 * ASKED FOR.
			 *
			 * It used to be `asText` and nothing else, which made `Fetchable.as` a field that
			 * was declared, set on every page and read by nobody: the first `as: "html"` page
			 * anybody added to `onePress` would have been stripped to text on the way in,
			 * parsed to nothing by a parser that reads attributes, and reported as a page that
			 * came back empty. Markup goes through `rowsOnly` for the same reason a swept page
			 * does — the last row of a players page is followed by roughly 90 KB of footer and
			 * a whole page of it crosses `postMessage`.
			 *
			 * Empty text is how a page Yahoo would not serve comes back, and the caller treats
			 * that as "not read" rather than as "empty".
			 *
			 * ── IT RETURNS A REASON NOW, AND IT USED TO RETURN `null` ─────────────────────
			 *
			 * `if (!res.ok) return null` and `if (!text.trim()) return null`, and the loop below
			 * read `if (!got) continue`. So a settings page Yahoo answered 429 or 500 for was
			 * DROPPED, and the reply went back as `{ kind: "grabs", grabs: [...] }` with no
			 * `failure` at all — a successful read, by its own account, missing the one page
			 * that carries the scoring table.
			 *
			 * src/client/read-yahoo.ts states the opposite as settled fact: "`answer.failure` is
			 * set whenever a page in the set could not be fetched — a settings page Yahoo
			 * refused, a matchup page behind a wall — while the grabs that DID arrive come back
			 * as normal." That fix was applied to the app side only; this side never set the
			 * field. Nothing downstream compensates either — `readGrabs` has `if (settings) {`
			 * with no else — so the reader was told "9 men, in the seats they are in" and got a
			 * board priced on borrowed scoring values with nothing anywhere saying so.
			 *
			 * The sweep a hundred lines up has always done this correctly. This is the same
			 * shape: name the page in the reader's words, keep what did arrive, send both.
			 */
			const fetchAs = async (
				want: Fetchable
			): Promise<{ grab: Grab } | { failure: GrabFailure; stop?: true }> => {
				const named = SPOKEN_PAGE[want.kind] ?? "one of your league's pages"
				try {
					spend()
					const res = await getPage(want.url)
					/* A redirect to Yahoo's own sign-in challenge is a fact about the SESSION,
					   so it stops the press the same way a wall in the text does. */
					const sent = wallAt(res)
					if (sent) return { failure: sent, stop: true }
					if (!res.ok)
						return {
							failure: {
								step: "league",
								/* A status code is Yahoo's word to a program. What the reader can
								   act on is which page stopped — the same choice the sweep made
								   for positions, and the code travels in `detail`. */
								what: `Yahoo would not answer for ${named}`,
								fix: "Wait a few minutes and try again. Nothing is wrong with your league.",
								detail: `${res.status} ${want.url}`
							}
						}
					const raw = await res.text()
					const text = renderedText(raw)
					if (!text.trim())
						return {
							failure: {
								step: "league",
								what: `Yahoo sent back an empty ${named}`,
								fix: "Wait a few minutes and try again. Nothing is wrong with your league.",
								detail: `${res.status} with no text, ${want.url}`
							}
						}
					return {
						grab: {
							url: want.url,
							kind: want.kind,
							text,
							html: want.as === "html" ? (rowsOnly(raw) ?? raw) : undefined,
							at: now()
						}
					}
				} catch (e) {
					/* Caught HERE rather than around the loop, so a page that timed out costs
					   that page and not the three that had already arrived. `getPage`'s abort
					   lands here, and so does the CORS rejection a cross-origin redirect to
					   `login.yahoo.com` produces — which is the sign-in wall arriving as a throw
					   rather than as a url, and is why the sentence names the session. */
					return {
						failure: {
							step: "league",
							what: `${named} never came back`,
							fix: "Check you are still signed in to Yahoo, then try again.",
							detail: String(e)
						}
					}
				}
			}
			void (async () => {
				const extra: Grab[] = []
				/*
				   THE FIRST THING THAT WENT WRONG, KEPT — and a wall replaces it.

				   `GrabFailure` is one failure and not a list, which is the right shape for a
				   screen: the first refusal is what explains the ones after it, and four
				   sentences about four pages is a reader reading a log. A wall is the exception
				   and overwrites, because a throttle or a sign-in is a fact about the whole
				   session rather than about one page, and it is the sentence he can act on.
				*/
				let failure: GrabFailure | null = null
				try {
					/*
					   ONE PRESS, EVERY PAGE THE DESCRIPTOR ASKED FOR, SEQUENTIALLY.

					   Sequential rather than parallel for the reason the sweep is: Yahoo answers a
					   burst by refusing, and commit de44045 records what that looks like — 150
					   players, then 25, then 0, then "Request denied". Two or three requests is not
					   a burst, and the gap is left to the sweep, which is the one that asks nine
					   times; this loop is bounded by the descriptor and the descriptor is bounded by
					   a reader's patience.

					   A WALL ON ANY PAGE STOPS THE PRESS, because a throttle is a fact about the
					   session rather than about the page: the second request would be refused too,
					   and a half-read league written into his stores is the failure this whole
					   check exists to prevent. A page that merely failed does NOT stop it — the
					   other pages are still worth having, and the reason it failed now travels
					   with them.
					*/
					for (const want of plan) {
						const got = await fetchAs(want)
						if ("failure" in got) {
							if (got.stop) {
								failure = got.failure
								break
							}
							failure ??= got.failure
							continue
						}
						const wall = wallIn(got.grab.text)
						if (wall) {
							failure = wall
							break
						}
						extra.push(got.grab)
					}
					reply({ kind: "grabs", grabs: [here, ...extra], failure: failure ?? undefined })
				} catch (e) {
					/*
					   AND THE UNPLANNED THROW SAYS SO TOO.

					   This replied `{ kind: "grabs", grabs: [here] }` and nothing else, so a
					   failure nobody predicted — inside `wallIn`, inside `rowsOnly`, inside the
					   reply itself — was reported as a completed read of one page. The pages that
					   had already arrived went with it.
					*/
					reply({
						kind: "grabs",
						grabs: [here, ...extra],
						failure: failure ?? {
							step: "league",
							what: "your league could not be read all the way through",
							fix: "Wait a few minutes and try again. Nothing is wrong with your league.",
							detail: String(e)
						}
					})
				} finally {
					/* Given back on every path, including the ones that threw: a gate that is not
					   released is an extension that has quietly stopped working, which is worse
					   than the burst it was put there to stop. */
					reading = null
				}
			})()
			return true
		}
		/*
		   EVERY OTHER TEAM IN HIS LEAGUE, WHICH IS THE ONLY EXACT ANSWER TO "WHO IS TAKEN".
		
		   The sweep reads Yahoo's free-agent table twenty-five rows deep per position, so the
		   list it produces is Yahoo's own top 225 and everything past that is an estimate off a
		   capture's ownership column. The union of the league's rosters is neither capped nor
		   estimated; it is the set.
		
		   Built from the `league` branch and not from the `pool` one, because these are ordinary
		   page reads at `as: "text"` rather than a paginated table — but it takes the sweep's
		   spacing and the sweep's progress messages, because nine sequential requests inside a
		   one-at-a-time gate is a long time to say nothing.
		
		   THE TEAM IDS COME FROM THE APP, which derives them from the league's own stated size.
		   This file never guesses how many teams there are and never crawls for them: an ask
		   with no ids is refused, and the ids it is given are digits, deduped and capped. A
		   league is teams, not a search.
		*/
		if (msg.ask === "rosters") {
			const leagueId = asked(msg.leagueId) ?? leagueIdFrom(location.href)
			const sport = sportAsked(msg.sport) ?? sportFrom(location.href) ?? SPORT
			if (!leagueId) {
				reply({
					kind: "failed",
					failure: {
						step: "rosters",
						what: "this page does not say which league it is",
						fix: "Open your own team page on Yahoo and try again."
					}
				})
				return true
			}
			const teamIds = [
				...new Set((msg.teamIds ?? []).map(x => asked(x)).filter((x): x is string => !!x))
			].slice(0, 32)
			if (!teamIds.length) {
				reply({
					kind: "failed",
					failure: {
						step: "rosters",
						what: "this page does not say which teams your league has",
						fix: "Set the number of teams on My league, then press this again."
					}
				})
				return true
			}
			const plan = YAHOO.rosters?.({ kind: "team", leagueId, teamId: null, sport }, teamIds) ?? []
			if (gateHeld()) {
				reply(alreadyBusy("rosters"))
				return true
			}
			const hold = waitFor(plan.length)
			if (hold > 0) {
				reply(askedTooHard("rosters", hold))
				return true
			}
			claim("rosters")
			void (async () => {
				try {
					const grabs: Grab[] = []
					/* The wall, or — kept for the same reason the `league` branch keeps one —
					   the first roster that simply would not come. A missing roster is already
					   refused downstream by counting `askedTeams`, so this does not decide
					   anything; it is the difference between the app saying "one of the rosters
					   did not come back" and the app saying nothing while it refuses. */
					let wall: GrabFailure | null = null
					for (let i = 0; i < plan.length; i++) {
						const want = plan[i]!
						/* Said before the request, not after, so the line on screen names the page
						   the reader is waiting on rather than the one that just landed. */
						try {
							chrome.runtime.sendMessage({
								kind: "progress",
								id: msg.id,
								say: `reading roster ${i + 1} of ${plan.length}`,
								done: i,
								total: plan.length
							})
						} catch {
							/* Orphaned — see the sweep's own note. The pages still go back. */
						}
						if (i > 0) await new Promise(r => setTimeout(r, 250))
						spend()
						const res = await getPage(want.url)
						/* A redirect to the sign-in challenge, read off the url rather than
						   guessed at from the words — see `wallAt`. Same stop as a wall. */
						const sent = wallAt(res)
						if (sent) {
							wall = sent
							break
						}
						if (!res.ok) {
							wall ??= {
								step: "rosters",
								what: `Yahoo would not answer for roster ${i + 1} of ${plan.length}`,
								fix: "Wait a few minutes and try again. Nothing is wrong with your league.",
								detail: `${res.status} ${want.url}`
							}
							continue
						}
						const text = renderedText(await res.text())
						if (!text.trim()) {
							wall ??= {
								step: "rosters",
								what: `Yahoo sent back an empty roster ${i + 1} of ${plan.length}`,
								fix: "Wait a few minutes and try again. Nothing is wrong with your league.",
								detail: `${res.status} with no text, ${want.url}`
							}
							continue
						}
						/* A WALL STOPS THE PRESS. A throttle is a fact about the session, not about
						   the page: the next request would be refused too, and a union missing one
						   roster is not a smaller answer — it is 27 taken men reported as free. */
						const walled = wallIn(text)
						if (walled) {
							wall = walled
							break
						}
						grabs.push({
							url: want.url,
							kind: want.kind,
							text,
							at: now(),
							/* Carried on every grab for the reason `asked` is: a page that never
							   arrived cannot carry anything, and the count of what was asked for is
							   the only thing that can refuse a partial complement. */
							askedTeams: teamIds
						})
					}
					reply(
						wall && !grabs.length ?
							{ kind: "failed", failure: wall }
						:	{ kind: "grabs", grabs, failure: wall ?? undefined }
					)
				} catch (e) {
					reply({
						kind: "failed",
						failure: {
							step: "rosters",
							what: "your league's rosters could not be read",
							fix: "Wait a few minutes and try again. Nothing is wrong with your league.",
							detail: String(e)
						}
					})
				} finally {
					reading = null
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
			if (gateHeld()) {
				reply(alreadyBusy("pool"))
				return true
			}
			/*
			   AND NOT BACK TO BACK FOR EVER, EITHER.
			
			   The flag above blocks OVERLAP, which is exactly what its comment claimed and no
			   more: three sweeps run in sequence were 27 requests in 6.9 seconds, a sustained
			   four a second, refused by nothing. The ceiling is what makes a sweep a thing a
			   reader does and not a thing a loop does. Checked for the WHOLE sweep up front —
			   nine requests are asked for as nine — because a sweep that stops at position four
			   is the partial list `poolIsPartial` exists to refuse, and refusing before it starts
			   costs the reader a sentence instead of a wrong wire.
			*/
			const slots = slotsAsked(msg.positions)
			const hold = waitFor(slots.length)
			if (hold > 0) {
				reply(askedTooHard("pool", hold))
				return true
			}
			claim("pool")
			void sweep(
				leagueId,
				sport,
				slots,
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
					reading = null
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
