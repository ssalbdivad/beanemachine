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
 * `pool` is the only one that costs Yahoo more than the page the reader already has open,
 * and it is the only one behind a button of its own.
 */
export type Ask = "hello" | "page" | "league" | "pool"

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
}

export type ExtensionMessage =
	| {
			from: typeof FROM_EXTENSION
			id: null
			kind: "hello"
			/** The extension's own version, so the app can say "update the extension"
			 *  rather than "something went wrong" when a protocol changes. */
			version: string
			/** Whether a Yahoo tab is open RIGHT NOW, which decides whether the app offers
			 *  "read it" or "open Yahoo first". */
			yahooOpen: boolean
	  }
	| { from: typeof FROM_EXTENSION; id: string; kind: "grabs"; grabs: Grab[] }
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
	const seg = path.split("/").filter(Boolean)
	// b1 / <leagueId> / <teamId>
	if (seg.length >= 3 && /^\d+$/.test(seg[2]!)) return "team"
	if (seg.length >= 2 && /^\d+$/.test(seg[1]!)) return "league"
	return "unknown"
}

/** The league id out of any fantasy URL, or null. The app keys a league on
 *  `yahoo:<id>` and has done since before any of this existed, so this is what makes an
 *  extension read land on the league the reader already has rather than beside it. */
export const leagueIdFrom = (url: string): string | null => {
	try {
		const seg = new URL(url).pathname.split("/").filter(Boolean)
		const at = seg.findIndex(s => /^\d+$/.test(s))
		return at === -1 ? null : seg[at]!
	} catch {
		return null
	}
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
