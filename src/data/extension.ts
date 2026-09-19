/**
 * THE CONTRACT BETWEEN THE PAGE AND THE THING THAT CAN READ YAHOO.
 *
 * Yahoo sends no `access-control-allow-*` header on any page that matters, so
 * beanemachine.com can never read a league however politely it asks. That is a fact
 * about Yahoo and not a limitation of this code, and it is why the whole app is built
 * around being TOLD rather than around reading.
 *
 * A browser extension is the one exception available. Its content script runs INSIDE the
 * reader's own Yahoo tab, signed in as him, subject to his cookies and to nothing else. It
 * is not a scraper: it reads the page he is already looking at, and it asks Yahoo for more
 * only when he presses a button.
 *
 * ── THE EXTENSION IS A RETRIEVER, NOT A PARSER ────────────────────────────────────────
 *
 * Everything below is deliberately dumb. The extension hands over a URL and the text of a
 * page; the APP decides what any of it means, using the same parsers the paste box has
 * always used and the same tests that cover them.
 *
 * That split is the whole design, and the reason is release latency. An extension update
 * goes through a store review — days, at the mercy of somebody else's queue — while the
 * app is a static site that redeploys in a minute. Yahoo redesigns its pages; the parser
 * therefore has to live on the side that can be fixed today. An extension that parsed
 * would be a parser nobody can patch.
 *
 * It also keeps the extension's permissions honest: it reads pages and sends text. There
 * is no model of a league inside it, nothing stored that a reader would care about, and
 * nothing to explain in a permission justification beyond "reads your fantasy pages".
 *
 * ── WHY window.postMessage AND NOT chrome.runtime ─────────────────────────────────────
 *
 * The other way for a page to talk to an extension is `externally_connectable` plus
 * `chrome.runtime.sendMessage`, which requires the page to know a fixed extension id.
 * An unpacked build gets a different id on every machine, Firefox's support for that
 * route differs from Chrome's, and either way the page would need to carry an id per
 * browser per build channel. A content script injected into beanemachine's own origin
 * needs none of that: it is already in the page, so the two halves talk by
 * `window.postMessage` exactly as two scripts on one page do, and the same source file
 * works in both browsers.
 *
 * Both sides therefore check `event.source === window` and the `from` field below, and
 * nothing here is ever trusted because of where it claims to come from — see `isFromApp`
 * and `isFromExtension`. A page on beanemachine.com can post whatever it likes into its
 * own window; what makes a payload trustworthy is that it goes through the same
 * validation as a pasted page, which is to say: none of it is trusted at all, it is
 * parsed with parsers written to be handed a stranger's HTML.
 */

/** The marker both sides put on every message, so neither answers its own. */
export const FROM_APP = "beanemachine-page" as const
export const FROM_EXTENSION = "beanemachine-extension" as const

/**
 * THE TWO HALVES SHIP ON DIFFERENT CLOCKS, AND THIS IS THE NUMBER THAT SAYS SO.
 *
 * The app is a static site: a fix is live a minute after it is pushed, and every reader
 * gets it on his next load whether he wanted it or not. The half inside the browser is not:
 * it goes through a store review, it lands when the store feels like landing it, and a
 * reader can switch off updates entirely. So the two are ALWAYS allowed to disagree, and
 * the only question is whether the disagreement is announced or silent.
 *
 * Silent is what it was. An older half in the browser, asked for something it has never
 * heard of, returned `false` from its listener; Chrome closed the reply channel; the page
 * saw a dead channel and said "the connection was lost. Reload this page." — advice that
 * cannot work, for a reader whose only real problem was that he had not updated. He would
 * reload forever.
 *
 * So both halves say which protocol they speak, and the mismatch gets a sentence naming
 * which side is behind. The number goes up only when the page starts NEEDING something an
 * older half cannot do — not when a sentence changes, not when a bug is fixed.
 *
 *   1  the original: hello / page / league / pool, grabs and failures.
 *   2  a partial sweep is TYPED rather than merely sent — `failure` alongside `grabs` was
 *      always on the wire and never in this file; a swept page is marked as swept and
 *      carries the list the sweep set out to get; and an ask the browser half does not know
 *      is refused by name instead of going quiet.
 */
export const PROTOCOL = 3

/** Every ask this protocol defines. The browser half checks an incoming ask against this
 *  rather than falling through, because falling through is what made an unknown ask look
 *  like a lost connection. */
export const ASKS = ["hello", "page", "league", "pool", "rosters"] as const

export const isKnownAsk = (ask: unknown): ask is Ask =>
	typeof ask === "string" && (ASKS as readonly string[]).includes(ask)

/**
 * WHERE THE APP LIVES. One list, read by the manifest the build writes AND by the router
 * that has to find an app tab to send progress to.
 *
 * Written twice they drift, and the drift is invisible: the manifest injects the bridge
 * into a page the router will not send progress to, so the reader watches a button spin
 * with no words under it and nothing anywhere says why.
 *
 * ── WHY THE LOCAL ADDRESSES ARE NOT IN THE SHIPPED BUILD ANY MORE ─────────────────────
 *
 * They were, and the argument for it was good: this is a static site somebody can clone and
 * serve, and a bridge that only spoke to the hosted copy would be untestable by the person
 * developing it, which is how a bridge ends up shipped broken.
 *
 * But a match pattern cannot name a port — Chrome and Firefox both match on host alone — so
 * `http://localhost/*` in a shipped manifest means ANY page served from this machine, on any
 * port, can post a message to this extension and be answered with the reader's own Yahoo
 * league: his team, his league's settings, and the pages his signed-in session can reach.
 * The page does not have to be his. On a developer's machine there is usually something
 * listening on localhost, and it is not always something he wrote.
 *
 * So the capability survives as a BUILD CHOICE rather than as a shipped permission. The
 * default build — the one that goes to a store — speaks to the hosted site alone.
 * `BM_EXT_DEV=1` adds the local addresses, and test/extension.mjs builds that way because
 * the suite serves the app at 127.0.0.1. Nothing is lost for whoever clones this: he builds
 * it the way the tests build it.
 */
export const APP_MATCHES = ["https://beanemachine.com/*", "https://*.beanemachine.com/*"]

/** Added only by a build that asks for them. See above for why they are not the default. */
export const DEV_MATCHES = ["http://127.0.0.1/*", "http://localhost/*"]

export const appMatches = (dev: boolean): string[] => (dev ? [...APP_MATCHES, ...DEV_MATCHES] : [...APP_MATCHES])

/**
 * ASKING WHICH TABS ARE YAHOO'S — and nothing else.
 *
 * This is the pattern the router hands `chrome.tabs.query` to find an open league tab. It is
 * NOT what the content script is injected into: that list is `readerMatches(dev)` in
 * src/data/platforms.ts, and it is `https` only in a shipped build, because Yahoo answers
 * over plaintext http and a page a network could have written is not one this should run on.
 *
 * Both schemes stay here on purpose, and the asymmetry is safe in the only direction that
 * matters: a query is a question, an injection is a capability, and the browser answers the
 * question only for tabs the extension already has permission for. Narrowing it would cost
 * the test its fake Yahoo — served over http on 127.0.0.1 — and buy nothing.
 */
export const YAHOO_MATCHES = ["*://*.fantasysports.yahoo.com/*"]

/** The only sport this app knows. Everything else Yahoo runs fantasy for is a page that
 *  parses into a team of nobody, which is why it is refused by name rather than read. */
export const SPORT = "baseball"

/**
 * Which Yahoo page a grab came off.
 *
 * Decided from the URL alone, by `pageKind` below, because a URL is the one thing on a
 * page that Yahoo's designers do not move. Everything else about the page — the table
 * class names, the column order, the words in the header — has changed at least once in
 * this project's lifetime.
 */
export type PageKind = "team" | "settings" | "players" | "matchup" | "league" | "unknown"

/** One page, as the extension found it. */
export interface Grab {
	/** The full URL, so the app can re-derive everything and say what it read. */
	url: string
	kind: PageKind
	/** `document.body.innerText` — what a reader would get by selecting the page and
	 *  copying it, which is exactly what `rosterFromPaste` and
	 *  `leagueFromPastedSettings` are built to be handed. */
	text: string
	/**
	 * `document.documentElement.outerHTML`, ONLY for the players table.
	 *
	 * `parsePage` in src/data/yahoo-pool.ts reads `data-ys-playerid` and the row's
	 * `title=` attribute, neither of which survives `innerText` — and the ids are what
	 * make a free agent the same man as a snapshot player rather than a name that might
	 * be two people. Every other page is read from text, because text is what survives a
	 * redesign.
	 *
	 * It is not sent for other pages: a roster page's HTML is about 400 KB and its text
	 * is about 4 KB, and the 400 KB would buy nothing.
	 */
	html?: string
	/** When the page was read, ISO. The pool store stamps every row with this and the
	 *  card prints its age: a free-agent list is the most perishable thing this app
	 *  holds, and one rival's waiver claim invalidates a row of it. */
	at: string
	/**
	 * THIS PAGE WAS ASKED FOR BY A SWEEP, rather than being the page the reader happened
	 * to be standing on.
	 *
	 * It matters for exactly one thing and the thing is expensive. `poolIsPartial` in
	 * src/client/api.ts calls a pool partial when fewer than two thirds of the positions it
	 * ASKED for came back — so a pool built from nine requested positions and four answers
	 * is refused, correctly. But a reader who happens to be looking at the shortstop page
	 * and presses "read my league" produces one players grab, from which the requested list
	 * is derived as one position, and one of one is not partial: a single page of
	 * shortstops would be promoted to "the exact list of everyone free in your league" and
	 * the board would tell him nobody else is available anywhere.
	 *
	 * Nothing calls that path today — `readLeagueHere` throws away the pool it reads off a
	 * league press — so this is a gun that was loaded rather than a bug that fired. The mark
	 * is what makes the difference explicit instead of leaving it to whether a grab happened
	 * to carry innerText.
	 */
	swept?: true
	/**
	 * WHAT THE SWEEP SET OUT TO GET, carried on every page it did get.
	 *
	 * `poolIsPartial` in src/client/api.ts refuses a pool when fewer than two thirds of the
	 * positions it ASKED for came back, and that rule is the only thing standing between a
	 * throttled sweep and a board that says nobody else in the league is available. It was
	 * not working. `readGrabs` derived the asked-for list from the URLs of the pages IN
	 * HAND, so a sweep stopped at the fifth position reported four positions asked and four
	 * read — complete, by its own account — and only a page that came back EMPTY was ever
	 * counted as missing. The one failure the rule exists for was the one it could not see.
	 *
	 * Measured in test/extension.mjs, which walls the fixture at the fifth position: with
	 * the list derived from the grabs, `poolIsPartial` returned false on four positions of
	 * nine. With it carried here, true.
	 *
	 * On every grab rather than alongside them, because a page that never arrived cannot
	 * carry anything, and the list has to survive whichever pages are the ones that made it.
	 */
	asked?: string[]
	/**
	 * EVERY TEAM ID A `rosters` PRESS SET OUT TO READ.
	 *
	 * The same argument as `asked` one field up, and a stricter consequence. Who is taken
	 * in a league is the union of its rosters, and a union missing one roster is not a
	 * smaller answer — it is 27 taken men reported as free, and rostered men rank at the
	 * top, so they would head the board. So the complement is written only when EVERY
	 * asked-for roster came back, and the only way to know how many were asked for is to
	 * carry the list on the pages that did arrive.
	 */
	askedTeams?: string[]
}

/** What the extension could not do, in the same shape `src/auto/session.ts` uses — one
 *  taxonomy for both readers, so the sentences a reader sees are the same whichever one
 *  was blind. */
export interface GrabFailure {
	step: string
	what: string
	fix: string | null
	detail?: string
}

/**
 * Everything the app may ask for.
 *
 * `hello` is the only one that never leaves this browser: it asks the bridge to say who it
 * is, and it exists because the bridge's own hello is unsolicited news. A page that loaded
 * after the extension did — which is every page a reader comes back to after installing —
 * cannot hear an announcement that was made before it was listening, so it has to be able
 * to ask for one. Found by the integration suite, which timed out waiting for a hello that
 * had already been said.
 *
 * `pool` and `rosters` are the two that cost Yahoo more than the page the reader already
 * has open, and they are the two behind buttons of their own. `rosters` reads every OTHER
 * team in the league, which is the only way to know who is taken rather than to estimate
 * it — nine pages for a ten-team league, so it is a press and never a side effect.
 */
export type Ask = "hello" | "page" | "league" | "pool" | "rosters"

export interface AppMessage {
	from: typeof FROM_APP
	/** Correlates an answer with its question; the app ignores answers it did not ask
	 *  for, which is what keeps a second tab's refresh from landing in this one. */
	id: string
	ask: Ask
	/** For `pool`: which league to sweep, and how hard to sweep it. */
	leagueId?: string
	sport?: string
	positions?: string[]
	/** For `rosters`: which teams in that league to read. The app derives them from the
	 *  league's own stated size, so the extension is never asked to guess how many there
	 *  are or to crawl for them. */
	teamIds?: string[]
}

export type ExtensionMessage =
	| {
			from: typeof FROM_EXTENSION
			id: null
			kind: "hello"
			/** The version a reader would see in his browser's own list. For saying WHICH
			 *  one is installed; the protocol number below is what decides whether it can
			 *  do what is being asked. */
			version: string
			/**
			 * Which protocol it speaks. Absent from anything built before there was one,
			 * which is why `protocolSkew` reads a missing number as 1 rather than as a
			 * fault: the first shipped build genuinely spoke protocol 1 and said nothing.
			 */
			protocol?: number
			/** Whether a BASEBALL fantasy tab is open right now, which decides whether the
			 *  app offers "read it" or "open Yahoo first". A football tab does not count:
			 *  offering to read a league off it is an offer that ends in "that page is your
			 *  football league". */
			yahooOpen: boolean
	  }
	| {
			from: typeof FROM_EXTENSION
			id: string
			kind: "grabs"
			grabs: Grab[]
			/**
			 * WHAT WENT WRONG ANYWAY. A sweep that is throttled at the fifth position has
			 * four positions of real free agents and a reason it stopped, and both have to
			 * travel: four positions of list beat none, and a reader told nothing about the
			 * stop would take a partial wire for the whole wire.
			 *
			 * This field was being sent already — `yahoo.ts` has replied with it since the
			 * sweep was written — and was simply missing from the type, so the page's own
			 * handler had to declare a wider shape locally to read it. Typed here so the two
			 * sides cannot drift.
			 */
			failure?: GrabFailure
	  }
	| { from: typeof FROM_EXTENSION; id: string; kind: "failed"; failure: GrabFailure }
	| {
			from: typeof FROM_EXTENSION
			id: string
			kind: "progress"
			/** In the reader's words — "reading shortstops" — never a URL or a count of
			 *  requests. Rendered verbatim. */
			say: string
			done: number
			total: number
	  }

/**
 * WHICH PAGE THIS IS, from the URL and nothing else.
 *
 * Yahoo's fantasy URLs have been stable for a decade because they are what people
 * bookmark and what Yahoo's own links point at:
 *   /b1/<leagueId>                     the league home
 *   /b1/<leagueId>/<teamId>            a team's roster        ← teamId is digits
 *   /b1/<leagueId>/settings            the settings page
 *   /b1/<leagueId>/players?status=A…   the player/free-agent table
 *   /b1/<leagueId>/matchup?week=…      this week's matchup
 *
 * The team case is last and is a digits-only test, because every other segment above is
 * a word: matching `/b1/<league>/<anything>` as a team is how a settings page ends up
 * parsed as a roster of nobody.
 */
export const pageKind = (url: string): PageKind => {
	let path: string
	try {
		const u = new URL(url)
		if (!/(^|\.)fantasysports\.yahoo\.com$/i.test(u.hostname)) return "unknown"
		path = u.pathname
	} catch {
		return "unknown"
	}
	if (/\/settings\b/i.test(path)) return "settings"
	if (/\/players\b/i.test(path)) return "players"
	if (/\/matchup\b/i.test(path)) return "matchup"
	/*
	   OFF THE SAME DERIVATION THE IDS COME FROM, and it did not used to be.
	
	   This tested `seg[2]` for digits and `seg[1]` for digits — fixed positions — while
	   `leagueIdFrom` a few lines down takes the number that FOLLOWS a non-number, precisely
	   so that a season in the path cannot be read as a league. On `/2024/b1/228947` the two
	   disagreed: `leagueIdFrom` correctly said the league is 228947, and this said the page
	   was a TEAM page, because the third segment is digits. A team page is the one kind whose
	   text gets written into the roster store, so the disagreement pointed at the most
	   expensive parse there is.
	
	   Found by test/platforms.mjs, which asserts the platform descriptor against these
	   functions on a table of URLs and would not let the two sides differ.
	*/
	const found = leagueAt(url)
	if (!found) return "unknown"
	const next = found.seg[found.at + 1]
	return next && /^\d+$/.test(next) ? "team" : "league"
}

/**
 * The league id out of any fantasy URL, or null. The app keys a league on `yahoo:<id>` and
 * has done since before any of this existed, so this is what makes a read land ON the
 * league the reader already has rather than beside it.
 *
 * THE FIRST NUMBER IN THE PATH IS NOT NECESSARILY THE LEAGUE, which is what this used to
 * take. `/b1/228947/8` is the shape every URL this project has actually seen takes, and for
 * that shape the two rules agree. They stop agreeing the moment a number comes first —
 * `/2024/b1/228947` would key the league as 2024 and write a season into the league store,
 * quietly, under a name that will never match anything again.
 *
 * Whether Yahoo serves a URL of that shape is NOT something this project has seen; no page
 * like it has been read, and none is asserted here. The rule is narrowed anyway because the
 * cost is one condition and the failure it prevents is silent and permanent: the league id
 * is the segment that follows a segment which is not a number, which is `b1` on every
 * fantasy URL in this repository and would be `b1` there too.
 */
const leagueAt = (url: string): { seg: string[]; at: number } | null => {
	try {
		const seg = new URL(url).pathname.split("/").filter(Boolean)
		const at = seg.findIndex((s, i) => i > 0 && /^\d+$/.test(s) && !/^\d+$/.test(seg[i - 1]!))
		return at === -1 ? null : { seg, at }
	} catch {
		return null
	}
}

export const leagueIdFrom = (url: string): string | null => {
	const found = leagueAt(url)
	return found ? found.seg[found.at]! : null
}

/** The sport out of the host — `baseball.fantasysports.yahoo.com`. Needed because the
 *  players-table URL is built per sport, and because a reader with a football league open
 *  should be told this is a baseball app rather than handed nothing. */
export const sportFrom = (url: string): string | null => {
	try {
		const host = new URL(url).hostname
		const m = /^([a-z]+)\.fantasysports\.yahoo\.com$/i.exec(host)
		return m ? m[1]!.toLowerCase() : null
	} catch {
		return null
	}
}

/**
 * WHOSE TEAM PAGE THIS IS.
 *
 * `/b1/<leagueId>/<teamId>` — the second number is the team, and every team in the league
 * has a page at the same shape. A reader who follows a link from the standings, or who
 * opens his rival's roster to see what he is up against, is on a page that reads EXACTLY
 * like his own: the same table, the same slot labels, the same `innerText`. `rosterFromPaste`
 * matches names against the snapshot and has no way to notice that the names are somebody
 * else's, so the read succeeds and quietly replaces his team with a rival's.
 *
 * The id is the only thing on the page that tells them apart, and it is in the URL, which
 * is the one part of a Yahoo page that does not move. Compare it against a team id the app
 * already knows and the sentence "that is not your team" becomes sayable — see
 * `readGrabs`'s `expect` in src/data/yahoo-read.ts.
 */
export const teamIdFrom = (url: string): string | null => {
	/* The segment after the league, off the same derivation `leagueIdFrom` uses, so the two
	   cannot disagree about where the league sits in the path. A team is digits; `settings`,
	   `players`, `matchup` and `draftresults` all sit in the same position and are words,
	   which is the whole test. */
	const found = leagueAt(url)
	const next = found ? found.seg[found.at + 1] : undefined
	return next && /^\d+$/.test(next) ? next : null
}

/**
 * THE SENTENCE FOR "THESE TWO HALVES ARE NOT THE SAME AGE".
 *
 * Returns null when they can work together, and a failure naming WHICH side is behind when
 * they cannot. Naming the side is the whole value: "something went wrong" sends a reader to
 * reload, and reloading is the one thing that cannot help, because the page is already the
 * newest thing he has.
 *
 * A number from the future is not treated as a fault. A newer half in the browser is
 * expected to keep answering everything an older page asks — that is what a protocol number
 * is FOR — so the page says nothing and carries on. If that ever stops being true the
 * failure will be a specific ask being refused, which already has its own sentence.
 */
export const protocolSkew = (theirs: number | undefined, ours: number = PROTOCOL): GrabFailure | null => {
	/* Missing means the first build, which spoke protocol 1 and had no field to say so. */
	const spoken = typeof theirs === "number" && Number.isFinite(theirs) ? theirs : 1
	if (spoken >= ours) return null
	return {
		step: "extension",
		what: "what reads Yahoo in this browser is older than this page, and cannot do this yet",
		fix: "Update it in your browser's extensions list, then reload this page."
	}
}

/**
 * THE SAME ROWS, WITHOUT THE PAGE AROUND THEM.
 *
 * A players page is the one page sent as HTML rather than as text, because `parsePage`
 * reads `data-ys-playerid` and the row's `title=` out of the markup and an id is what makes
 * a free agent the same man as a snapshot player rather than a name that might be two
 * people. The cost is the whole page: src/data/yahoo-pool.ts records, from a real sweep,
 * that the last row of a players page is followed by roughly 90 KB of footer — and a sweep
 * sends nine of them across `postMessage` at once.
 *
 * THIS IS A CUT, NOT A PARSE, and the difference is the point. It does not read a value, it
 * does not know what a player is, and it cannot change what the app decides any row means.
 * It keeps, for each of `parsePage`'s own row markers, exactly the span `parsePage` would
 * have looked at — the marker plus the 9000 characters after it, which is the cap
 * `parsePage` applies itself — and throws the rest away. What comes back therefore parses
 * to the identical rows BY CONSTRUCTION, and test/extension.mjs asserts that equality
 * against the fixture rather than taking the argument's word for it.
 *
 * The marker is duplicated from `parsePage` rather than imported, because importing it
 * would pull the parser itself into the shipped extension and the whole design is that the
 * parser lives on the side that can be fixed in a minute. The duplication is safe in the
 * only direction that matters: if Yahoo ever moves the marker, NOTHING matches, this
 * returns null, and the caller sends the entire page exactly as it did before. A redesign
 * costs bandwidth here and never costs a row.
 */
const ROW_MARKER = /(?=data-ys-playerid="\d+"[^>]*title=")/
const ROW_HEAD = /^data-ys-playerid="(\d+)"[^>]*title="([^"]+)"/
/** `parsePage`'s own per-row cap. A row is never read further than this, so nothing beyond
 *  it can change an answer. */
const ROW_SPAN = 9000

export const rowsOnly = (html: string): string | null => {
	const kept: string[] = []
	for (const part of html.split(ROW_MARKER)) {
		const m = ROW_HEAD.exec(part)
		if (!m) continue
		kept.push(part.slice(0, m[0].length + ROW_SPAN))
	}
	return kept.length ? kept.join("") : null
}

export const isFromExtension = (data: unknown): data is ExtensionMessage =>
	!!data &&
	typeof data === "object" &&
	(data as { from?: unknown }).from === FROM_EXTENSION &&
	typeof (data as { kind?: unknown }).kind === "string"

export const isFromApp = (data: unknown): data is AppMessage =>
	!!data &&
	typeof data === "object" &&
	(data as { from?: unknown }).from === FROM_APP &&
	typeof (data as { ask?: unknown }).ask === "string" &&
	typeof (data as { id?: unknown }).id === "string"
