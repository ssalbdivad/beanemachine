import { useCallback, useEffect, useRef, useState } from "react"
import {
	FROM_APP,
	MARK,
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
		return !!document.documentElement.getAttribute(MARK)
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
		const stamped = document.documentElement.getAttribute(MARK)
		if (stamped) {
			setPresent(true)
			setVersion(stamped)
		}
		/** What the poll below last saw, so it only acts on a CHANGE. A plain local rather
		 *  than state: it is read and written inside one interval and must not be a render's
		 *  worth of stale. */
		let had = !!stamped
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
		  cost, and two seconds is under the time it takes to read the step it sits beside.

		  ── AND IT WATCHES IT GO AWAY, WHICH IS THE HALF THAT WAS MISSING ─────────────────

		  This was `if (!now) return; clearInterval(watch)` — it stopped the moment it found the
		  attribute, so nothing on a live page could ever observe the attribute being REMOVED.
		  `present` was written true in three places and false in none.

		  The bridge takes the mark off when it is orphaned and its comment claims that is what
		  makes the app recover: "it is the same flag the app's first render reads, so the offer
		  stops being made without the app needing to know any of this happened." True of a page
		  that RELOADS, and a reader who has just switched the add-on off or taken a store update
		  has not reloaded — that is the whole situation. So Connect stayed in its `ext.present`
		  branch offering "Read my league" to a browser with nothing left to read it with, and he
		  found out by pressing the button and reading the orphan failure.

		  Kept running costs one attribute read every two seconds for the life of the page, which
		  is the price of the claim in bridge.ts being true. `had` is what makes it a change
		  detector rather than four state writes a second.
		*/
		const watch = setInterval(() => {
			const now = document.documentElement.getAttribute(MARK)
			if (!!now === had) return
			had = !!now
			setPresent(had)
			setVersion(now)
			if (!had) {
				/* Everything that was known ABOUT it is now unknown, and stale answers here are
				   what the screens read to decide what to offer: a remembered "a Yahoo tab is
				   open" would keep the read on offer, and a remembered skew would tell him to
				   update a thing that is no longer installed. */
				setYahooOpen(false)
				setSkew(null)
				return
			}
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
						| { kind: "grabs"; grabs: Grab[]; failure?: GrabFailure; yahooOpen?: boolean }
						| { kind: "failed"; failure: GrabFailure; yahooOpen?: boolean; gone?: true }
				): void => {
					clearTimeout(timer)
					setBusy(false)
					setProgress(null)
					/*
					   A YAHOO TAB WAS FOUND OR IT WAS NOT, AND THE ROUTER NOW SAYS WHICH.

					   This was `/no Yahoo/i.test(answer.failure.what)` — a regex over a sentence
					   written for a reader. The router writes three different refusals when it
					   cannot use a tab and only one of them contains those two words, so the
					   football refusal — "the Yahoo tab that is open is your football league",
					   whose own `fix` says to open a baseball one — set `yahooOpen` TRUE, and
					   Connect hides the "Open Yahoo" button when `yahooOpen` is true. He was told
					   to open a tab at the moment the button for it disappeared. The orphan
					   failure did the same, for a browser that can no longer read anything.

					   `hello` has carried the fact as a typed field since the first build; the
					   answer to an ask now carries it too. The `??` is the older half in the
					   browser, which sends neither field: a `grabs` answer came through a tab, so
					   it is evidence of one, and a failure that says nothing leaves the last
					   known answer alone rather than inventing a new one.
					*/
					if (answer.kind === "failed" && answer.gone) {
						/* It is not that the tab is gone — it is that the thing which reads tabs
						   is. Everything the screens key off it is now false. The poll above
						   would reach the same conclusion from the mark within two seconds; this
						   is the press that is happening right now. */
						setPresent(false)
						setVersion(null)
						setYahooOpen(false)
						setSkew(null)
					} else if (typeof answer.yahooOpen === "boolean") setYahooOpen(answer.yahooOpen)
					else if (answer.kind === "grabs") setYahooOpen(true)
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
