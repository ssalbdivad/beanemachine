/**
 * THE HALF THAT RUNS INSIDE BEANEMACHINE.
 *
 * A content script on the app's own origin, which is what lets the page and the extension
 * talk without the page knowing an extension id — see the note in src/data/extension.ts
 * for why that matters and why `externally_connectable` was not the route taken.
 *
 * It is a wire and nothing else: it forwards the page's questions to the background and
 * the background's answers back. It reads nothing from the page, stores nothing, and has
 * no opinion about any of it.
 */
import {
	FROM_APP,
	FROM_EXTENSION,
	isFromApp,
	type ExtensionMessage
} from "../../src/data/extension.ts"

const version = chrome.runtime.getManifest().version

const toPage = (msg: ExtensionMessage): void => {
	/* Targeted at this window's own origin rather than "*": the message names a league
	   the reader is in, and a wildcard target would hand it to any frame that happened to
	   be listening. */
	window.postMessage(msg, location.origin)
}

window.addEventListener("message", event => {
	/* Three checks, and all three are necessary. The source test rejects anything from an
	   iframe; the origin test rejects a message from another window pretending to be this
	   page; the `from` test stops the extension answering its own replies, which is the
	   loop every postMessage bridge writes at least once. */
	if (event.source !== window || event.origin !== location.origin) return
	if (!isFromApp(event.data)) return
	const { id, ask, leagueId, sport, positions } = event.data
	/* A hello never leaves this browser, so it is answered here rather than routed. See
	   `Ask` in src/data/extension.ts for why a page has to be able to ask for one. */
	if (ask === "hello") {
		hello()
		return
	}
	chrome.runtime.sendMessage({ kind: "ask", id, ask, leagueId, sport, positions }, answer => {
		/* An extension that has been updated or disabled mid-session leaves this channel
		   dead, and the callback then fires with `undefined` and an error on
		   `chrome.runtime.lastError`. Reading it is what stops the browser logging it as
		   unchecked, and the app is told the one thing it can act on: reload the page. */
		const dead = chrome.runtime.lastError
		if (dead || !answer) {
			toPage({
				from: FROM_EXTENSION,
				id,
				kind: "failed",
				failure: {
					step: "extension",
					what: "the connection to the extension was lost",
					fix: "Reload this page.",
					detail: dead?.message
				}
			})
			return
		}
		toPage({ from: FROM_EXTENSION, id, ...answer })
	})
})

/* Progress and other unsolicited news from the background, forwarded as it arrives. */
chrome.runtime.onMessage.addListener((msg: ExtensionMessage & { kind: string }) => {
	if (msg && typeof msg.kind === "string") toPage({ ...msg, from: FROM_EXTENSION })
})

/**
 * HELLO, TWICE.
 *
 * Once now, for a page that was already open when the extension was installed, and once
 * on every request from the page, because the app's own script may not have started
 * listening yet when this one runs at `document_start`. The app treats a second hello as
 * the same hello — it carries no state — so saying it twice costs nothing and saying it
 * once too late costs the whole connection.
 */
function hello(): void {
	chrome.runtime.sendMessage({ kind: "status" }, answer => {
		if (chrome.runtime.lastError) return
		toPage({
			from: FROM_EXTENSION,
			id: null,
			kind: "hello",
			version,
			yahooOpen: !!answer?.yahooOpen
		})
	})
}

hello()
window.addEventListener("DOMContentLoaded", hello)
window.addEventListener("focus", hello)
document.addEventListener("visibilitychange", () => {
	if (!document.hidden) hello()
})

/* A marker in the DOM as well as a message, because a page that loads AFTER the extension
   has said hello has no way to hear it — and the first thing a reader does after
   installing is go back to the tab and reload. An attribute survives the reload; a
   message does not. */
document.documentElement.setAttribute("data-beanemachine-extension", version)
