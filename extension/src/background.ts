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
	APP_MATCHES,
	SPORT,
	isKnownAsk,
	pageKind,
	type Ask,
	type GrabFailure,
	type PageKind
} from "../../src/data/extension.ts"

/** What a content script told us about the tab it is in, plus when it last said so. */
interface YahooTab {
	url: string
	league: string | null
	sport: string | null
	kind: PageKind
	/** When this tab last announced itself. `Date.now()`, and the ONLY ordering that
	 *  decides which of several tabs gets read — see `pickTab`. */
	at: number
}

/** Which tabs have a Yahoo fantasy page in them, learned from the content script rather
 *  than by polling the browser. The set is authoritative only in the sense that a stale
 *  entry is discovered the moment it is used — `tabs.sendMessage` to a closed tab fails,
 *  and that failure is a "no Yahoo tab" answer rather than an error. */
const yahooTabs = new Map<number, YahooTab>()

chrome.tabs.onRemoved.addListener(id => yahooTabs.delete(id))

/**
 * THE BROWSER'S OWN "HE IS LOOKING AT THIS ONE NOW".
 *
 * The content script announces again on focus and on becoming visible, which is the signal
 * that works when he switches WINDOWS. It is not the signal that works when he switches
 * TABS: measured in test/extension.mjs, bringing a background tab to the front in headless
 * Chromium fires neither `focus` nor `visibilitychange` in the page, so a reader flicking
 * between his two leagues went on having the wrong one read — the assertion for it failed
 * against the page-side signal alone, which is how this listener came to be here.
 *
 * `chrome.tabs.onActivated` is the browser saying it, and it does not depend on a content
 * script being alive in the tab at all.
 */
chrome.tabs.onActivated.addListener(({ tabId }) => {
	const known = yahooTabs.get(tabId)
	if (known) known.at = Date.now()
})

/** A baseball tab, for "is there anything to read right now". Football does not count:
 *  offering to read a league off a football tab is an offer that ends in a refusal. */
const anyBaseball = (): boolean => [...yahooTabs.values()].some(t => t.sport === SPORT)

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
 *  2. Otherwise, baseball only, most recently announced first. "Most recent" is a stamp
 *     rather than Map insertion order, which is what it used to be and which does not do
 *     what it reads as: `Map.set` on a key that already exists leaves the key where it was,
 *     so a reader who opened league A, then league B, then went back to A and reloaded got
 *     league A's tab announcing again and STILL ranked first-inserted. The tab he was
 *     looking at last was not the tab that was read. The content script now re-announces on
 *     focus and on becoming visible, so the stamp tracks the tab he is actually in front of.
 *
 *  3. No baseball tab at all is answered by NAME — "that tab is your football league" —
 *     rather than by "nothing is open", because a reader looking straight at a Yahoo tab
 *     who is told nothing is open has been told something he can see is false.
 *
 * `want` is the league the ask named, or null for "whatever he is looking at".
 */
const pickTab = (want: string | null): { tab: number } | { failure: GrabFailure } => {
	const open = [...yahooTabs.entries()].sort((a, b) => b[1].at - a[1].at)
	const baseball = open.filter(([, t]) => t.sport === SPORT)

	if (!baseball.length) {
		const other = open.find(([, t]) => t.sport && t.sport !== SPORT)?.[1]
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
		const match = baseball.find(([, t]) => t.league === want)
		if (match) return { tab: match[0] }
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

	return { tab: baseball[0]![0] }
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
const askYahoo = (
	msg: { ask: Ask; id: string; leagueId?: string; sport?: string; positions?: string[] },
	reply: (answer: unknown) => void
): void => {
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

	const picked = pickTab(msg.leagueId ?? null)
	if ("failure" in picked) {
		reply({ kind: "failed", failure: picked.failure })
		return
	}
	const tab = picked.tab
	const known = yahooTabs.get(tab)
	chrome.tabs.sendMessage(
		tab,
		{
			...msg,
			leagueId: msg.leagueId ?? known?.league ?? undefined,
			sport: msg.sport ?? known?.sport ?? undefined
		},
		answer => {
			if (chrome.runtime.lastError || !answer) {
				/* The tab is gone, or it is a Yahoo page the content script never ran in
				   (it was open before the extension was installed, which is the common
				   case on the very first use). Both are fixed by the same sentence. */
				yahooTabs.delete(tab)
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
		const kind = pageKind(msg.url)
		if (typeof sender.tab?.id === "number" && kind !== "unknown")
			/* Replaced wholesale rather than merged, so a tab that navigated from one league
			   to another does not keep the old league on it — and stamped, because the stamp
			   is the whole ordering. */
			yahooTabs.set(sender.tab.id, {
				url: msg.url,
				league: msg.league,
				sport: msg.sport,
				kind,
				at: Date.now()
			})
		return
	}

	if (msg.kind === "status") {
		reply({ yahooOpen: anyBaseball() })
		return true
	}

	if (msg.kind === "ask") {
		askYahoo(msg, reply)
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
			for (const t of tabs)
				if (typeof t.id === "number")
					chrome.tabs.sendMessage(t.id, msg, () => void chrome.runtime.lastError)
		})
		return
	}

	if (msg.kind === "open-yahoo") {
		void chrome.tabs.create({ url: msg.url ?? "https://baseball.fantasysports.yahoo.com/" })
		reply({ kind: "opened" })
		return true
	}
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
		const open = tabs.find(t => typeof t.id === "number")
		if (open?.id !== undefined) void chrome.tabs.update(open.id, { active: true })
		else void chrome.tabs.create({ url: "https://beanemachine.com/" })
	})
})
