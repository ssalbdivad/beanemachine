/**
 * THE PART THAT KNOWS WHICH TABS EXIST.
 *
 * The app's page and the Yahoo page are two different tabs and cannot speak to each other;
 * this is the only piece with a view of both. It routes a question from one to the other
 * and routes the answer back, and it holds nothing that outlives a question.
 *
 * NO STORAGE, DELIBERATELY. An extension that kept a copy of somebody's league would be a
 * second place his data lives, with its own lifetime, its own staleness and its own
 * uninstall story. The app already has a store built for this, in the browser, stamped
 * with when it was read — so the extension hands over and forgets. What it remembers
 * between messages is one thing: which tab is Yahoo, and only so it can be asked.
 */
import {
	SPORT,
	YAHOO_MATCHES,
	isKnownAsk,
	leagueIdFrom,
	pageKind,
	sportFrom,
	type Ask,
	type GrabFailure
} from "../../src/data/extension.ts"

/**
 * WHERE THE APP IS, READ OUT OF THIS BUILD'S OWN MANIFEST.
 *
 * The router has to find an app tab to send progress lines to, and the set of pages it may
 * send to must be exactly the set the bridge was injected into — no wider, or it is posting
 * a message naming a fantasy league into a tab where nothing is listening, and no narrower,
 * or the reader watches a button spin with no words under it.
 *
 * Taken from the manifest rather than from the shared constant it was built from, because
 * the two builds do not carry the same list: the store build speaks to the hosted site
 * alone, and a `BM_EXT_DEV=1` build adds the local addresses (see `APP_MATCHES` in
 * src/data/extension.ts for why that is a build choice and not a shipped permission).
 * Reading it back out of the manifest makes the router right in both builds by construction
 * rather than by remembering to keep two lists in step.
 */
const APP_MATCHES = (chrome.runtime.getManifest().content_scripts ?? [])
	.filter(s => (s.js ?? []).some(f => f.endsWith("bridge.js")))
	.flatMap(s => s.matches ?? [])

/**
 * WHICH TABS ARE YAHOO IS ASKED, NOT REMEMBERED.
 *
 * This used to be a Map the content scripts filled in, and the Map was the only record
 * there was. Two things are wrong with that, one of them badly:
 *
 *  1. IT IS IN A SERVICE WORKER'S MEMORY. Chrome stops an idle MV3 worker after about
 *     thirty seconds and starts a fresh one for the next message — with an empty Map. Every
 *     Yahoo tab the reader has open becomes invisible, "no Yahoo fantasy page is open" is
 *     said with his league on the screen behind the app, and the only thing that fixes it is
 *     reloading a tab that was never broken. Nothing about a read is slow enough to keep the
 *     worker awake between two presses a minute apart.
 *
 *     NOT REPRODUCED IN test/extension.mjs, and the report says so: Playwright attaches a
 *     debugger to the worker, which keeps it alive. Measured there — still one worker, and
 *     the tab still found, after seventy seconds idle. So this is a fix argued from Chrome's
 *     documented lifetime rather than from a failing test, and it is written this way
 *     because the cost of asking is one API call and the cost of remembering is a class of
 *     failure a test in this harness can never see.
 *
 *  2. IT WENT STALE IN THE OTHER DIRECTION TOO. A tab that announced itself and then
 *     navigated somewhere that is not Yahoo stayed in the Map — nothing announces a
 *     departure — so the app went on being told a Yahoo tab was open, offered a read, and
 *     the read failed with "reload your Yahoo tab", about a tab that is now somebody's
 *     email. THAT one is reproduced, and asserted.
 *
 * So the browser is asked, every time, and the answer is filtered by the page's own URL.
 * `sportFrom` and `leagueIdFrom` read the sport and the league out of that URL, which is
 * where they were always read from — the content script was only ever passing on what the
 * URL already said.
 *
 * The Map that remains holds one thing per tab: when the reader was last in front of it. It
 * is a hint about ordering and never about existence, so losing it to a sleeping worker
 * costs the ordering of two tabs and not the feature.
 */
const lastSeen = new Map<number, number>()

chrome.tabs.onRemoved.addListener(id => lastSeen.delete(id))

interface YahooTab {
	id: number
	url: string
	league: string | null
	sport: string | null
	/** Most recent evidence that this is the tab he is in front of. The stamp we were told
	 *  about, or the browser's own `lastAccessed` (Chrome 121 and after), or merely the fact
	 *  that it is the active tab — in that order, because the first is the freshest. */
	at: number
}

const openYahooTabs = (): Promise<YahooTab[]> =>
	new Promise(resolve => {
		chrome.tabs.query({ url: YAHOO_MATCHES }, tabs => {
			/* `lastError` here means the query itself was refused, which would leave `tabs`
			   undefined; an empty list is the honest answer to "which are open". */
			void chrome.runtime.lastError
			const out: YahooTab[] = []
			for (const t of tabs ?? []) {
				if (typeof t.id !== "number" || !t.url) continue
				/* The fantasy hub and anything else without a league in its path is not a page
				   that can be read, and offering to read it is offering nothing. */
				if (pageKind(t.url) === "unknown") continue
				out.push({
					id: t.id,
					url: t.url,
					league: leagueIdFrom(t.url),
					sport: sportFrom(t.url),
					at: Math.max(
						lastSeen.get(t.id) ?? 0,
						(t as { lastAccessed?: number }).lastAccessed ?? 0,
						t.active ? 1 : 0
					)
				})
			}
			resolve(out.sort((a, b) => b.at - a.at))
		})
	})

/**
 * THE BROWSER'S OWN "HE IS LOOKING AT THIS ONE NOW".
 *
 * The content script announces again on focus and on becoming visible, which is the signal
 * that works when he switches WINDOWS. It is not enough when he switches TABS: measured in
 * test/extension.mjs, bringing a background tab to the front and waiting six hundred
 * milliseconds did not move which tab was chosen, so whatever headless Chromium does on a
 * tab activation, it did not reach the page in time to count. A reader flicking between his
 * two leagues went on having the wrong one read, and that failing assertion is how this
 * listener came to be here.
 *
 * `chrome.tabs.onActivated` is the browser saying it, and it does not depend on a content
 * script being alive in the tab at all.
 */
chrome.tabs.onActivated.addListener(({ tabId }) => {
	lastSeen.set(tabId, Date.now())
})

/** A baseball tab, for "is there anything to read right now". Football does not count:
 *  offering to read a league off a football tab is an offer that ends in a refusal. */
const anyBaseball = async (): Promise<boolean> =>
	(await openYahooTabs()).some(t => t.sport === SPORT)

/**
 * WHICH TAB, WHEN THERE IS MORE THAN ONE — and there usually is, because a manager with a
 * baseball league and a football league has both open in September.
 *
 * THE RULE, in order:
 *
 *  1. If the ask names a league, ONLY a tab on that league will do. This is the one rule
 *     worth a refusal rather than a best guess. Every page the sweep fetches is fetched
 *     from inside the chosen tab and is therefore same-origin whatever league it is on, so
 *     asking a tab on league B for league A's pages SUCCEEDS — it returns league A's free
 *     agents, correctly — while the team page in the same answer is league B's roster, and
 *     `readLeagueHere` writes both under the league key the screen was showing. That lands
 *     a rival league's nine men in this league's roster store, with no error anywhere. A
 *     read that fails leaves nothing behind; this one leaves something wrong behind, which
 *     is worse, and it is the reason this rule refuses instead of preferring.
 *
 *  2. Otherwise, baseball only, most recently in front of him first. "Most recent" is a
 *     stamp rather than Map insertion order, which is what it used to be and which does not
 *     do what it reads as: `Map.set` on a key that already exists leaves the key where it
 *     was, so a reader who opened league A, then league B, then went back to A and reloaded
 *     got league A's tab announcing again and STILL ranked first-inserted. The tab he was
 *     looking at last was not the tab that was read.
 *
 *  3. No baseball tab at all is answered by NAME — "that tab is your football league" —
 *     rather than by "nothing is open", because a reader looking straight at a Yahoo tab
 *     who is told nothing is open has been told something he can see is false.
 *
 * `want` is the league the ask named, or null for "whatever he is looking at".
 */
const pickTab = async (want: string | null): Promise<{ tab: YahooTab } | { failure: GrabFailure }> => {
	const open = await openYahooTabs()
	const baseball = open.filter(t => t.sport === SPORT)

	if (!baseball.length) {
		const other = open.find(t => t.sport && t.sport !== SPORT)
		return {
			failure:
				other ?
					{
						step: "yahoo",
						/* Named, because "no page is open" in front of an open page reads as a
						   broken app rather than as the true answer, which is that the open page
						   is a sport this app has never claimed to know. */
						what: `the Yahoo tab that is open is your ${other.sport} league, and this only knows baseball`,
						fix: "Open your baseball team on Yahoo in another tab, then try again."
					}
				:	{
						step: "yahoo",
						what: "no Yahoo fantasy page is open",
						fix: "Open your team on Yahoo in another tab, then try again."
					}
		}
	}

	if (want) {
		const match = baseball.find(t => t.league === want)
		if (match) return { tab: match }
		return {
			failure: {
				step: "yahoo",
				/* No league id and no team id in the sentence: an id is a field name to a
				   reader, and the thing he can act on is "a different league", which he can
				   see for himself once he is told to look. */
				what: "the Yahoo tab that is open is a different league from the one on this screen",
				fix: "Open that league on Yahoo, or switch this screen to the league you have open."
			}
		}
	}

	return { tab: baseball[0]! }
}

/**
 * ASK THE YAHOO TAB, OR SAY THERE ISN'T ONE.
 *
 * It does NOT open a tab by itself. An extension that quietly opens somebody's fantasy
 * site because a web page asked it to is doing something he did not ask for, and he cannot
 * tell it apart from a page doing it to him. When there is nothing to ask, the app is told
 * so and shows him a button that opens Yahoo — a tab he can see appearing, because he
 * pressed something.
 */
const askYahoo = async (
	msg: {
		ask: Ask
		id: string
		leagueId?: string
		sport?: string
		positions?: string[]
		/* For `rosters`. Forwarded by the spread below with everything else — no new rule
		   is needed, because a `rosters` ask names its league and the existing "only a tab
		   on that league will do" therefore applies to it unchanged. */
		teamIds?: string[]
		/* For `league`: which team in it is the reader's own, which the app knows and a
		   Yahoo URL does not say unless he happens to be standing on a team page. Same
		   spread, same reason. */
		teamId?: string
	},
	reply: (answer: unknown) => void
): Promise<void> => {
	/*
	   AN ASK FROM A NEWER PAGE THAN THIS BUILD.

	   The page redeploys in a minute and this waits on a store review, so a page asking for
	   something this build has never heard of is a normal Tuesday rather than an attack. It
	   used to fall out of the listener with no reply, Chrome closed the channel, and the page
	   said "the connection was lost — reload this page": advice that cannot work, to a reader
	   whose only problem was an update he had not taken. Refused by name instead.
	*/
	if (!isKnownAsk(msg.ask)) {
		reply({
			kind: "failed",
			failure: {
				step: "extension",
				what: "what reads Yahoo in this browser is older than this page, and cannot do this yet",
				fix: "Update it in your browser's extensions list, then reload this page."
			}
		})
		return
	}

	const picked = await pickTab(msg.leagueId ?? null)
	if ("failure" in picked) {
		reply({ kind: "failed", failure: picked.failure })
		return
	}
	const tab = picked.tab.id
	chrome.tabs.sendMessage(
		tab,
		{
			...msg,
			/* The league and the sport of the tab that was CHOSEN, so an ask that named
			   neither is answered about the league he is actually looking at rather than
			   about whatever the content script works out for itself. Both come off that
			   tab's URL, which is where they have always come from. */
			leagueId: msg.leagueId ?? picked.tab.league ?? undefined,
			sport: msg.sport ?? picked.tab.sport ?? undefined
		},
		answer => {
			if (chrome.runtime.lastError || !answer) {
				/* The tab is gone, or it is a Yahoo page the content script never ran in
				   (it was open before the extension was installed, which is the common
				   case on the very first use). Both are fixed by the same sentence. */
				lastSeen.delete(tab)
				reply({
					kind: "failed",
					failure: {
						step: "yahoo",
						what: "that Yahoo tab could not be read",
						fix: "Reload your Yahoo tab, then try again.",
						detail: chrome.runtime.lastError?.message
					}
				})
				return
			}
			reply(answer)
		}
	)
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
	if (!msg || typeof msg.kind !== "string") return

	if (msg.kind === "yahoo-here") {
		/* All this now carries is "he is in front of this one". What the page IS gets read
		   out of the tab's own URL when the question is asked — see `openYahooTabs` — because
		   a record of what a tab was when it last spoke goes stale the moment he navigates,
		   and because the record itself does not survive the worker being stopped. */
		if (typeof sender.tab?.id === "number") lastSeen.set(sender.tab.id, Date.now())
		return
	}

	if (msg.kind === "status") {
		void anyBaseball().then(yahooOpen => reply({ yahooOpen }))
		return true
	}

	if (msg.kind === "ask") {
		void askYahoo(msg, reply)
		return true
	}

	if (msg.kind === "progress") {
		/* Straight back to whichever app tabs are open. Sent to all of them rather than
		   tracked per request: the id on the message is what an app tab uses to decide
		   whether a progress line is about the sweep IT started.

		   Queried by the app's OWN match patterns rather than by "everything that is not
		   Yahoo", which is what it used to be. The old form posted a message naming a
		   position of a fantasy league into every open tab in the browser — a bank, a work
		   inbox — where nothing was listening and nothing was logged, so it was invisible
		   rather than harmless. Asking for the four patterns the bridge is injected into
		   sends it only where it can be heard. */
		void chrome.tabs.query({ url: APP_MATCHES }, tabs => {
			/* `?? []`: a refused query leaves `tabs` UNDEFINED and iterating it throws
			   inside a listener, where a throw is not a crash anybody sees — the channel
			   simply closes and the page waits out its patience. `extension/src` was
			   outside tsconfig's include until 2026-09-19, so this was invisible to
			   `npm run check`; typing that directory is what found it. An empty list is
			   the honest answer to "which app tabs are open". */
			for (const t of tabs ?? [])
				if (typeof t.id === "number")
					chrome.tabs.sendMessage(t.id, msg, () => void chrome.runtime.lastError)
		})
		return
	}

	/* An `open-yahoo` branch stood here and was unreachable: nothing has ever sent that
	   message, its own comment said so, and the tab the reader sees is opened by the page's
	   own `window.open` inside his click — which is what makes it survive a popup blocker
	   and what a tab created from here would not. Deleted along with the `ask: "page"` the
	   page used to post beside it, which WAS reaching this file and was a real read of the
	   reader's Yahoo tab for a press that meant "take me to Yahoo". */
	return
})

/**
 * THE TOOLBAR BUTTON OPENS THE APP.
 *
 * There is no popup, and that is the whole design: an extension with a popup is a second
 * place to look for the answer, and the answer lives on one screen already. Pressing it
 * from anywhere puts the reader on the page that has his lineup on it.
 *
 * It looks for an app tab by the same patterns the bridge is injected into, so a developer
 * running this against a local server is put back on the copy he is actually using rather
 * than sent to the hosted site — which is where it sent him before, and which is a
 * confusing way to lose your place.
 */
chrome.action.onClicked.addListener(() => {
	void chrome.tabs.query({ url: APP_MATCHES }, tabs => {
		/* `?? []` for the same reason as the other two query sites: a refused query hands
		   back undefined, and here that would throw on the reader's own press of the
		   toolbar button — the one gesture where nothing else can report the failure. */
		const open = (tabs ?? []).find(t => typeof t.id === "number")
		if (open?.id !== undefined) void chrome.tabs.update(open.id, { active: true })
		else void chrome.tabs.create({ url: "https://beanemachine.com/" })
	})
})
