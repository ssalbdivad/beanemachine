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
import { pageKind, type Ask } from "../../src/data/extension.ts"

/** Which tabs have a Yahoo fantasy page in them, learned from the content script rather
 *  than by polling the browser. The set is authoritative only in the sense that a stale
 *  entry is discovered the moment it is used — `tabs.sendMessage` to a closed tab fails,
 *  and that failure is a "no Yahoo tab" answer rather than an error. */
const yahooTabs = new Map<number, { url: string; league: string | null; sport: string | null }>()

chrome.tabs.onRemoved.addListener(id => yahooTabs.delete(id))

/** A fantasy tab, most recently seen first: a reader with three leagues open means the one
 *  he was last looking at, not the one the browser happens to list first. */
const pickTab = (): number | null => {
	const ids = [...yahooTabs.keys()]
	return ids.length ? ids[ids.length - 1]! : null
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
	const tab = pickTab()
	if (tab === null) {
		reply({
			kind: "failed",
			failure: {
				step: "yahoo",
				what: "no Yahoo fantasy page is open",
				fix: "Open your team on Yahoo in another tab, then try again."
			}
		})
		return
	}
	const known = yahooTabs.get(tab)
	chrome.tabs.sendMessage(
		tab,
		{ ...msg, leagueId: msg.leagueId ?? known?.league ?? undefined, sport: msg.sport ?? known?.sport ?? undefined },
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
		if (typeof sender.tab?.id === "number" && pageKind(msg.url) !== "unknown")
			yahooTabs.set(sender.tab.id, { url: msg.url, league: msg.league, sport: msg.sport })
		return
	}

	if (msg.kind === "status") {
		reply({ yahooOpen: yahooTabs.size > 0 })
		return true
	}

	if (msg.kind === "ask") {
		askYahoo(msg, reply)
		return true
	}

	if (msg.kind === "progress") {
		/* Straight back to whichever app tabs are open. Sent to all of them rather than
		   tracked per request: the id on the message is what an app tab uses to decide
		   whether a progress line is about the sweep IT started. */
		void chrome.tabs.query({}, tabs => {
			for (const t of tabs)
				if (typeof t.id === "number" && t.url && !/fantasysports\.yahoo\.com/.test(t.url))
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
 */
chrome.action.onClicked.addListener(() => {
	void chrome.tabs.query({ url: ["https://beanemachine.com/*"] }, tabs => {
		const open = tabs.find(t => typeof t.id === "number")
		if (open?.id !== undefined) void chrome.tabs.update(open.id, { active: true })
		else void chrome.tabs.create({ url: "https://beanemachine.com/" })
	})
})
