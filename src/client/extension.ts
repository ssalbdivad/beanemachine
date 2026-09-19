import { useCallback, useEffect, useRef, useState } from "react"
import {
	FROM_APP,
	isFromExtension,
	protocolSkew,
	type Ask,
	type Grab,
	type GrabFailure
} from "../data/extension.ts"

/**
 * THE PAGE'S SIDE OF THE WIRE.
 *
 * Everything this app knows about a Yahoo league has had to be typed, pasted or carried in
 * a file, because Yahoo sends no `access-control-allow-*` header and never will. An
 * extension is the one way round that: its content script is inside the reader's own
 * signed-in tab, and a second content script is inside this page, so the two halves talk
 * across `window.postMessage` like any two scripts on one page.
 *
 * WHAT THIS HOOK REFUSES TO DO. It does not poll, it does not ask for anything on its own,
 * and it does not keep what comes back — every read is started by the reader pressing
 * something, and what comes back goes straight into the stores that already exist, stamped
 * with when it was read. An extension that quietly refreshed a league in the background
 * would be a second source of truth with its own age, and this app's whole argument about
 * staleness is that there is one.
 *
 * PRESENCE IS READ TWICE. The extension says hello, and it also stamps an attribute on the
 * document. The attribute is what survives the case that actually matters: a reader
 * installs the extension with this page already open, comes back to the tab and reloads —
 * a message sent before this hook existed is gone, an attribute is not.
 */
export interface ExtensionState {
	/** The extension is in this browser and talking to this page. */
	present: boolean
	version: string | null
	/** A Yahoo fantasy tab is open right now, which decides whether the button offers to
	 *  read the league or to open Yahoo first. */
	yahooOpen: boolean
	busy: boolean
	/** Non-null when this page and the reader in this browser are on different versions of
	 *  the protocol. The sentence names which of the two is behind. */
	skew: GrabFailure | null
	/** The sweep's own words for what it is doing — "reading shortstops" — rendered
	 *  verbatim, never a count of requests or a URL. */
	progress: string | null
	ask: (
		ask: Ask,
		opts?: {
			leagueId?: string
			sport?: string
			positions?: string[]
			teamIds?: string[]
			/** For `league`: which team in it is his, so one press can fetch his roster from
			 *  a page whose URL does not name a team. See `AppMessage.teamId`. */
			teamId?: string
		}
	) => Promise<{ grabs: Grab[]; failure?: GrabFailure } | { grabs?: undefined; failure: GrabFailure }>
	/** Opens Yahoo in a tab of its own, on the reader's press — the extension never opens
	 *  one by itself. */
	openYahoo: (url?: string) => void
}

/** How long to wait for an answer before saying so. A sweep is nine sequential requests
 *  with a quarter-second between them against somebody else's site; ninety seconds is
 *  generous enough that a slow answer is never reported as a failure, and short enough
 *  that a dead extension does not leave a button spinning forever. */
const PATIENCE_MS = 90_000

/**
 * IS THE READER IN THIS BROWSER, asked from anywhere, without a hook.
 *
 * The bridge stamps the document as soon as it runs, at `document_start`, so this is
 * answerable synchronously during a first render — which is what the sentences elsewhere in
 * the app need. A sentence that says "no website can read your Yahoo league" is TRUE for a
 * reader without it and FALSE for a reader with it, and the difference has to be decidable
 * at the moment the sentence is written rather than a tick later.
 *
 * It answers the narrow question — is it installed — and deliberately not "can it read
 * right now", which depends on a Yahoo tab being open and is only knowable by asking.
 */
export const extensionHere = (): boolean => {
	try {
		return !!document.documentElement.getAttribute("data-beanemachine-extension")
	} catch {
		return false
	}
}

let nextId = 0

export const useExtension = (): ExtensionState => {
	const [present, setPresent] = useState(false)
	const [version, setVersion] = useState<string | null>(null)
	const [yahooOpen, setYahooOpen] = useState(false)
	const [busy, setBusy] = useState(false)
	const [progress, setProgress] = useState<string | null>(null)
	/** Set when the two halves are speaking different versions of the protocol — see
	 *  `protocolSkew`. Null when they agree, which is the ordinary case. */
	const [skew, setSkew] = useState<GrabFailure | null>(null)
	/** Which request each pending promise belongs to. A second tab, or a second press,
	 *  must not resolve this one — and a progress line about somebody else's sweep must
	 *  not be rendered as this one's. */
	const waiting = useRef(new Map<string, (m: never) => void>())

	useEffect(() => {
		const stamped = document.documentElement.getAttribute("data-beanemachine-extension")
		if (stamped) {
			setPresent(true)
			setVersion(stamped)
		}
		const onMessage = (event: MessageEvent): void => {
			if (event.source !== window || event.origin !== location.origin) return
			if (!isFromExtension(event.data)) return
			const msg = event.data
			if (msg.kind === "hello") {
				setPresent(true)
				setVersion(msg.version)
				setYahooOpen(msg.yahooOpen)
				/* A HALF THAT IS BEHIND THE OTHER SAYS WHICH ONE, at hello rather than at the
				   first thing it cannot do. The page redeploys in a minute and the extension
				   waits on a store review, so the two WILL drift — and an older extension that
				   still answers every ask it knows produces no failure to hang a sentence on,
				   which is exactly the case a reader cannot diagnose for himself. */
				setSkew(protocolSkew(msg.protocol))
				return
			}
			if (msg.kind === "progress") {
				if (waiting.current.has(msg.id)) setProgress(msg.say)
				return
			}
			const settle = waiting.current.get(msg.id)
			if (!settle) return
			waiting.current.delete(msg.id)
			settle(msg as never)
		}
		window.addEventListener("message", onMessage)
		/*
		  WATCHING FOR IT TO ARRIVE, because the screen promises that it is.
		
		  The install walkthrough's last line says "this page notices the moment it is added —
		  nothing to press here", and until now nothing in this app could keep that promise: the
		  bridge stamps the document when it loads, and a page that was already open when the
		  reader installed it is never stamped at all. He would have watched three steps sit
		  there and concluded the install had failed, at the highest-attrition moment in the
		  product.
		
		  A poll rather than a MutationObserver: the attribute is set on `document.documentElement`
		  at `document_start`, an observer on the root element with `attributes: true` is the same
		  cost, and this stops as soon as it finds it. Two seconds is under the time it takes to
		  read the step it sits beside.
		*/
		const watch = setInterval(() => {
			const now = document.documentElement.getAttribute("data-beanemachine-extension")
			if (!now) return
			clearInterval(watch)
			setPresent(true)
			setVersion(now)
			/* And ask, so `yahooOpen` and the protocol version arrive too — the attribute alone
			   says it is there and nothing else. */
			window.postMessage({ from: FROM_APP, id: "hello", ask: "hello" as Ask }, location.origin)
		}, 2000)
		/* Asking is how a page that loaded after the extension finds out it is there: the
		   bridge answers a hello with a hello, without anything leaving the browser. Sent
		   once, on mount, not on a timer — the answer also arrives unasked on focus and on
		   the extension's own load. */
		window.postMessage({ from: FROM_APP, id: "hello", ask: "hello" as Ask }, location.origin)
		return () => {
			clearInterval(watch)
			window.removeEventListener("message", onMessage)
		}
	}, [])

	const ask = useCallback<ExtensionState["ask"]>(
		(what, opts = {}) =>
			new Promise(resolve => {
				if (!present) {
					resolve({
						failure: {
							step: "extension",
							what: "nothing in this browser can read Yahoo",
							fix: "Add the reader to this browser, or paste your league page instead."
						}
					})
					return
				}
				const id = `bm-${++nextId}`
				setBusy(true)
				setProgress(null)
				const done = (
					answer:
						| { kind: "grabs"; grabs: Grab[]; failure?: GrabFailure }
						| { kind: "failed"; failure: GrabFailure }
				): void => {
					clearTimeout(timer)
					setBusy(false)
					setProgress(null)
					/* A Yahoo tab was found or it was not, and the next press should offer the
					   right thing without waiting for another hello. */
					if (answer.kind === "failed" && /no Yahoo/i.test(answer.failure.what))
						setYahooOpen(false)
					else setYahooOpen(true)
					resolve(
						answer.kind === "failed" ?
							{ failure: answer.failure }
						:	{ grabs: answer.grabs, failure: answer.failure }
					)
				}
				waiting.current.set(id, done as never)
				const timer = setTimeout(() => {
					waiting.current.delete(id)
					setBusy(false)
					setProgress(null)
					resolve({
						failure: {
							step: "extension",
							what: "the read did not come back",
							fix: "Check your Yahoo tab is still open, then try again."
						}
					})
				}, PATIENCE_MS)
				window.postMessage(
					{ from: FROM_APP, id, ask: what, ...opts },
					location.origin
				)
			}),
		[present]
	)

	/*
	   A LINK, AND IT USED TO BE A LINK PLUS A READ OF SOMEBODY ELSE'S SITE.

	   This posted `{ ask: "page", open: url }` before opening the tab. Three things were
	   wrong with that and one of them left the browser. `open` is dropped by the bridge,
	   which forwards the ask and the four named fields and nothing else, so the branch in
	   extension/src/background.ts that would have opened a tab was never reached and the tab
	   has always been opened by the `window.open` below — inside the click, which is what
	   makes it survive a popup blocker. What DID arrive at the router was a bare `page` ask:
	   the router picked one of the reader's Yahoo tabs and its content script read the page
	   out of the DOM and sent it back, for a press that meant "take me to Yahoo". Not a
	   request to Yahoo — `grabHere` reads the tab it is already in — but the contents of a
	   league page crossing two message hops for nothing, and on the players page that is the
	   markup: `rowsOnly` of a table Yahoo follows with about 90 KB of footer. Nothing was
	   waiting on the id, because `waiting` is only written by `ask`, so the answer was
	   dropped the moment it arrived.

	   Counted on the press: one message to the extension, one tab query, one tab picked, one
	   page read out of its DOM, one answer discarded. Now: none of them, and the same tab
	   opens.
	*/
	const openYahoo = useCallback((url?: string) => {
		window.open(url ?? "https://baseball.fantasysports.yahoo.com/", "_blank", "noopener")
	}, [])

	return { present, version, yahooOpen, busy, progress, skew, ask, openYahoo }
}
