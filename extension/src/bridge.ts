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
	PROTOCOL,
	isFromApp,
	type ExtensionMessage,
	type GrabFailure
} from "../../src/data/extension.ts"

const version = chrome.runtime.getManifest().version

/** The attribute the page reads to answer "is there anything in this browser that can read
 *  Yahoo" during its first render, before any message could have arrived. Named here
 *  because it is now written AND removed. */
const MARK = "data-beanemachine-extension"

const toPage = (msg: ExtensionMessage): void => {
	/* Targeted at this window's own origin rather than "*": the message names a league
	   the reader is in, and a wildcard target would hand it to any frame that happened to
	   be listening. */
	window.postMessage(msg, location.origin)
}

/**
 * WHEN THIS SCRIPT OUTLIVES THE EXTENSION IT CAME FROM.
 *
 * Disable, update or uninstall an extension and the content scripts it has already injected
 * do NOT stop running. They stay in the page with a dead handle: every `chrome.runtime`
 * call throws `Extension context invalidated`, synchronously, for as long as the tab is
 * open. A reader who updates from the store mid-session, or switches the thing off to see
 * whether it was the cause of something, is in this state on every tab he had open.
 *
 * What that used to do, measured by walking the code and then reproduced in
 * test/extension.mjs by reloading the extension out from under an open page: the throw
 * happened inside this script's own message listener, so it was invisible to the page; no
 * answer was ever posted; and the page sat on its ninety-second patience before saying "the
 * read did not come back. Check your Yahoo tab is still open" — which is false, and which
 * he waits a minute and a half to be told. Worse, the attribute above was still on the
 * document, so `extensionHere()` kept answering yes and every screen kept offering a read
 * that could not happen.
 *
 * So: the throw is caught, the mark comes off the document, and the page is told the one
 * thing that is both true and actionable. Taking the mark off is what makes the app's own
 * state recover — it is the same flag the app's first render reads, so the offer stops being
 * made without the app needing to know any of this happened.
 */
const ORPHANED: GrabFailure = {
	step: "extension",
	what: "what reads Yahoo in this browser was switched off or updated while this page was open",
	fix: "Reload this page."
}

let orphaned = false

const orphan = (id: string | null): void => {
	if (!orphaned) {
		orphaned = true
		try {
			document.documentElement.removeAttribute(MARK)
		} catch {
			/* Nothing to do about a page that will not let its own root be written. */
		}
	}
	if (id !== null) toPage({ from: FROM_EXTENSION, id, kind: "failed", failure: ORPHANED })
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
	try {
		chrome.runtime.sendMessage({ kind: "ask", id, ask, leagueId, sport, positions }, answer => {
			/* An extension that has been updated or disabled between the send and the answer
			   leaves this channel dead, and the callback then fires with `undefined` and an
			   error on `chrome.runtime.lastError`. Reading it is what stops the browser
			   logging it as unchecked, and the app is told the one thing it can act on.

			   This is the same failure as the throw below, half a second later: there, the
			   extension was already gone when the page asked; here, it went while the answer
			   was in flight. Both end in the same sentence, because they are the same event
			   to the reader. */
			const dead = chrome.runtime.lastError
			if (dead || !answer) {
				orphan(null)
				toPage({
					from: FROM_EXTENSION,
					id,
					kind: "failed",
					failure: { ...ORPHANED, detail: dead?.message }
				})
				return
			}
			toPage({ from: FROM_EXTENSION, id, ...answer })
		})
	} catch {
		/* Thrown, not returned: `Extension context invalidated`. The page gets its answer
		   immediately rather than after ninety seconds of patience. */
		orphan(id)
	}
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
 *
 * It carries the PROTOCOL as well as the version. The version is what a reader sees in his
 * browser's list and is for saying which build he has; the protocol is what the page
 * compares, because "0.1.0 against 0.3.2" is not a question the page can answer and
 * "speaks 1, needs 2" is. See `protocolSkew` in src/data/extension.ts.
 */
function hello(): void {
	try {
		chrome.runtime.sendMessage({ kind: "status" }, answer => {
			if (chrome.runtime.lastError) return
			toPage({
				from: FROM_EXTENSION,
				id: null,
				kind: "hello",
				version,
				protocol: PROTOCOL,
				yahooOpen: !!answer?.yahooOpen
			})
		})
	} catch {
		/* Orphaned. No hello, and the mark comes off, so a page that reloads its own state
		   stops believing there is anything here to ask. */
		orphan(null)
	}
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
document.documentElement.setAttribute(MARK, version)
