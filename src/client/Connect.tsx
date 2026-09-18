import { useEffect, useState } from "react"
import type { GrabFailure } from "../data/extension.ts"
import type { ExtensionState } from "./extension.ts"

/**
 * HOW TO LET IT READ YOUR LEAGUE, in three steps and a drawn arrow.
 *
 * Everything else in this app is built around being TOLD — typed, pasted, carried in a
 * file — because Yahoo sends no header that would let a web page read a league. This is
 * the one screen that offers the other thing, and it is the screen where a reader decides
 * whether this app is worth two minutes, so it has exactly three jobs: say what he gets,
 * name the words he will see on the next screen, and get out of the way.
 *
 * IT DRAWS ITS OWN TARGETS. There are no screenshots of anybody else's browser in here.
 * A picture of Chrome's toolbar is out of date the week Chrome is restyled, it is somebody
 * else's trade dress, and it looks nothing like the toolbar on the reader's own machine
 * anyway. What is drawn instead is OUR rendering of the words he is looking for — "Add to
 * Chrome", "Add extension" — in this app's own type, with the arrow pointing at those. The
 * words are the part that is stable; the chrome around them is not.
 *
 * WHAT IT NEVER DOES. It does not tell a reader who cannot install anything that he is
 * unsupported, it does not grey out a control he cannot use, and it does not take the
 * paste box away from him — a phone, a locked-down work laptop and a private window are
 * all cases where typing your team in is the only door, and it stays the front one.
 */

/**
 * WHICH BROWSER IS THIS, as far as the instructions are concerned.
 *
 * Not a browser-detection library and not a feature test, because there is no feature to
 * test: whether a browser takes extensions is a fact about the product, not about the
 * page. The user-agent is a bad oracle in general and a fine one here — the worst case is
 * showing a Chrome reader the Firefox line, which costs him a glance, and the cases are
 * distinguished only as far as the WORDS differ.
 *
 * Chrome on iOS and Chrome on Android take no extensions at all; Firefox on Android does;
 * Safari takes them only from the App Store, which this project has not shipped to. Each
 * of those gets a sentence that is true of it rather than a disabled button.
 */
export type Browser = "chrome" | "firefox" | "edge" | "safari" | "firefox-android" | "none"

export const browserOf = (ua: string = navigator.userAgent): Browser => {
	const mobile = /Android|iPhone|iPad|iPod/i.test(ua)
	if (/Firefox\/\d/i.test(ua)) return /Android/i.test(ua) ? "firefox-android" : "firefox"
	/* Chrome on iOS is CriOS and is Safari underneath — no extensions either way. Tested
	   before the desktop cases, because its UA also contains "Safari". */
	if (mobile) return "none"
	if (/Edg\//i.test(ua)) return "edge"
	if (/Chrome\/\d/i.test(ua) && !/OPR\//i.test(ua)) return "chrome"
	if (/Safari\/\d/i.test(ua)) return "safari"
	/* Opera, Brave, Vivaldi and everything else built on Chromium: the store page is the
	   same and the button says the same thing, so they are Chrome for the purpose of a
	   three-line instruction. */
	if (/OPR\/|Brave|Vivaldi/i.test(ua)) return "chrome"
	return "none"
}

/** Whether there is anything to install here at all. Safari is separated from "none"
 *  because the answer a Safari reader needs is different: not "your browser cannot", but
 *  "not yet". */
export const takesExtension = (b: Browser): boolean =>
	b === "chrome" || b === "firefox" || b === "edge" || b === "firefox-android"

/**
 * A HAND-DRAWN ARROW, twice.
 *
 * One cubic path, stroked twice: a ghost pass at a third opacity and a pixel and a bit off
 * true, then the real one over it. That is what makes a line look drawn rather than
 * plotted, and it costs eight lines instead of a filter — `feTurbulence` was tried on this
 * project's background once and deleted for being un-measurable.
 *
 * The draw-on is written so that killing the animation leaves a FINISHED arrow. The app's
 * reduced-motion rule is `*{animation:none!important}`, so an arrow that started at
 * `stroke-dashoffset: 140` and animated to 0 would be permanently invisible for the
 * readers most likely to need the instruction. The base state is the finished state and
 * the keyframes only ever hide it first.
 */
export const Arrow = ({ label }: { label: string }): React.ReactElement => (
	<svg className="arrow" viewBox="0 0 64 92" role="img" aria-label={label}>
		<g
			fill="none"
			stroke="var(--accent)"
			strokeWidth="2.6"
			strokeLinecap="round"
			strokeLinejoin="round"
			vectorEffect="non-scaling-stroke"
		>
			<path opacity=".32" d="M9.2 8.4C6.9 27 11.4 43.6 20.4 56.2c7.6 10.6 18.6 17 30.8 21.2" />
			<path d="M8 7C5.7 25.8 10.2 42.2 19.2 54.8c7.6 10.6 18.6 17 30.8 21.2" />
			<path opacity=".32" d="M38.6 79.2 50.8 78l-3.6-11.6" />
			<path d="M37.4 78 49.6 76.8 46 65.2" />
		</g>
	</svg>
)

/** The same two-pass stroke as the arrow, so a finished step is ticked by the hand that
 *  drew the arrow rather than by a font. */
export const Tick = (): React.ReactElement => (
	<svg className="tick" viewBox="0 0 24 24" aria-hidden="true">
		<g fill="none" stroke="var(--accent)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
			<path opacity=".32" d="M4.2 12.8 10 18.4 20.4 5.4" />
			<path d="M3.4 12 9.2 17.6 19.6 4.6" />
		</g>
	</svg>
)

/**
 * WHETHER A STORE ACTUALLY HAS IT, which is a fact about the world and not about this code.
 *
 * Step 1 of this walkthrough sent every reader to a store search page. Rendered on
 * 2026-09-18: the Chrome Web Store answered "It looks like there aren't any search results
 * for your search", and Mozilla's own API 404s the add-on id. So the topmost offer in the
 * onboarding sheet — the first thing a desktop reader is shown, 181px above the box where he
 * could have typed his team in — led him to an empty page, and no line anywhere said so.
 *
 * Until a listing exists the route is the one that actually works: the site hands him the
 * file and his browser loads it. That is more steps and it is honest, which is the trade this
 * project makes everywhere else.
 *
 * FLIP THIS WHEN THE LISTINGS ARE LIVE, and check `STORE.at` still points at the listing
 * rather than at a search for it — a search page is what produced this bug.
 */
export const IN_STORE = false

/** What the site hands out while no store does. Written by extension/build.mjs into
 *  `public/`, which Vite ships verbatim; test/static.mjs asserts the published site really
 *  serves them, because a download link that 404s is the same defect as the store link it
 *  replaces. */
/*
   THE PATH IS BUILT THE WAY EVERY OTHER PUBLISHED ASSET'S IS.
   
   These were root-absolute. This app is published with a RELATIVE base — `scoring.json` and
   `snapshot.json` are both fetched through `import.meta.env.BASE_URL` for exactly that reason
   — so a leading slash is a promise that the site sits at the root of its host, which is true
   of beanemachine.com today and is not true of a preview deployment or a project page. The
   file would 404 and the walkthrough's first step would be back where it started.
*/
const asset = (name: string): string => `${import.meta.env.BASE_URL ?? "/"}${name}`

export const DOWNLOAD: Record<Browser, string | null> = {
	chrome: asset("beanemachine-chrome.zip"),
	edge: asset("beanemachine-chrome.zip"),
	firefox: asset("beanemachine-firefox.zip"),
	"firefox-android": null,
	safari: null,
	none: null
}

/** Where each browser's own page for this lives. Named once here so a step and its button
 *  cannot drift apart, and so a browser nobody has shipped to yet has an obvious null. */
export const STORE: Record<Browser, { at: string | null; press: string; then: string }> = {
	chrome: {
		at: "https://chromewebstore.google.com/search/beanemachine",
		press: "Add to Chrome",
		then: "Add extension"
	},
	edge: {
		at: "https://chromewebstore.google.com/search/beanemachine",
		press: "Add to Chrome",
		then: "Add extension"
	},
	firefox: {
		at: "https://addons.mozilla.org/firefox/search/?q=beanemachine",
		press: "Add to Firefox",
		then: "Add"
	},
	"firefox-android": {
		at: "https://addons.mozilla.org/firefox/search/?q=beanemachine",
		press: "Add to Firefox",
		then: "Add"
	},
	safari: { at: null, press: "", then: "" },
	none: { at: null, press: "", then: "" }
}

export const Connect = ({
	ext,
	leagueName,
	freeAgents,
	readAt,
	onRead,
	onBack,
	failure,
	browser = browserOf()
}: {
	ext: ExtensionState
	/** What has already been read, for the receipt. Null before the first read. */
	leagueName: string | null
	freeAgents: number | null
	readAt: string | null
	onRead: () => void
	onBack: () => void
	failure: GrabFailure | null
	browser?: Browser
}): React.ReactElement => {
	const store = STORE[browser]
	const download = DOWNLOAD[browser]
	const firefoxish = browser === "firefox" || browser === "firefox-android"
	/** The address of this browser's own extensions page. Edge answers `edge://`, not
	 *  `chrome://`, and a reader typing the wrong one gets a blank page. */
	const extensionsUrl =
		firefoxish ? "about:debugging#/runtime/this-firefox"
		: browser === "edge" ? "edge://extensions"
		: "chrome://extensions"
	/* Once it is there, the steps are history: a reader who has installed it does not need
	   to be told how, and a screen that keeps showing him is a screen that has not noticed
	   he did the thing it asked. */
	const [showSteps, setShowSteps] = useState(!ext.present)
	useEffect(() => {
		if (ext.present) setShowSteps(false)
	}, [ext.present])

	if (ext.present)
		return (
			<div className="connect connected">
				<h2>
					<Tick /> It can read your league
				</h2>
				{leagueName ?
					<p className="sub">
						Last read <b>{leagueName}</b>
						{freeAgents !== null ? <> &mdash; {freeAgents} free agents</> : null}
						{readAt ? <> &mdash; {ago(readAt)}</> : null}.
					</p>
				:	<p className="sub">
						Open your team on Yahoo in another tab, then press the button. Your scoring,
						your seats and who is free all come across.
					</p>
				}
				{/* THE TWO HALVES BEING ON DIFFERENT VERSIONS is said here rather than at the
				    first thing that fails, because an older reader that still answers every ask
				    it knows never produces a failure to hang a sentence on — and that is exactly
				    the case a reader cannot work out for himself. It sits above the button
				    because it changes what pressing the button will do. */}
				{ext.skew && (
					<p className="connect-snag">
						{ext.skew.what}
						{ext.skew.fix ? <> &mdash; {ext.skew.fix}</> : null}
					</p>
				)}
				{failure && (
					<p className="connect-snag">
						{failure.what}
						{failure.fix ? <> &mdash; {failure.fix}</> : null}
					</p>
				)}
				<p className="onboard-go">
					<button type="button" className="primary" onClick={onRead} disabled={ext.busy}>
						{ext.busy ? "Reading…" : leagueName ? "Read it again" : "Read my league"}
					</button>
					{!ext.yahooOpen && (
						<button type="button" onClick={() => ext.openYahoo()}>
							Open Yahoo
						</button>
					)}
				</p>
				{/* The sweep's own words, verbatim. A progress bar over somebody else's site is
				    a promise about how long it will take, which nothing here can make. */}
				{ext.busy && ext.progress && <p className="sub connect-progress">{ext.progress}</p>}
				<p className="connect-back">
					<button type="button" className="as-link" onClick={onBack}>
						Type my team in instead
					</button>
				</p>
			</div>
		)

	/*
	   A BROWSER THAT TAKES THE READER AND HAS NO WAY TO GET IT.
	
	   `takesExtension` answers what the BROWSER can run, and Firefox for Android can run this
	   perfectly well — from the add-ons site, which is the only route it has: there is no
	   about:debugging on a phone and no folder to point at. With no listing yet, the install
	   route for that reader does not exist at all, and he was being shown the store walkthrough
	   with the note "it is not in the add-ons site yet, so it comes from here instead" directly
	   above a button sending him to a search of that site — which returns two add-ons that are
	   not this one.
	
	   So he is told the truth instead, and it is the same truth the phone branch below tells:
	   on a computer this reads his league, and typing his team in works everywhere including
	   here. The condition is the missing DOWNLOAD rather than the browser, so a browser that
	   gains a route gains the walkthrough with it.
	*/
	if (!takesExtension(browser) || (!IN_STORE && !download))
		return (
			<div className="connect">
				<h2>On a computer, it can read your Yahoo league</h2>
				<p className="sub">
					{browser === "safari" ?
						"Not in this browser yet. On a computer, in Chrome or Firefox, it reads your league off Yahoo for you — until then, typing your team in takes about a minute."
					: browser === "firefox-android" ?
						"Firefox on a phone can only add it from Mozilla’s add-ons site, and it is not there yet. On a computer, in Chrome or Firefox, it reads your league off Yahoo for you — until then, typing your team in takes about a minute."
					:	"Phones don’t take the reader yet. On a computer, in Chrome or Firefox, it reads your league off Yahoo for you — until then, typing your team in takes about a minute."}
				</p>
				<p className="onboard-go">
					<button type="button" className="primary" onClick={onBack}>
						Type my team in
					</button>
				</p>
			</div>
		)

	return (
		<div className="connect">
			<h2>Let it read my Yahoo league</h2>
			{/* Two lines, not four. Measured at 390x844: the card came to 623px inside a sheet
			    capped at 591px, so the third step and the way back were below the fold — the
			    exact defect this file's own header warns about, arriving in the file that warns
			    about it. What was cut is the part a reader does not need before he presses
			    anything; what stays is the one thing he might be worried about.
			
			    AND THE FOUR-STEP WALKTHROUGH BELOW DOES NOT FIT EITHER, which this comment used
			    to be read as claiming. Measured on the published build at 390x844 with the store
			    listing absent: the steps run 320..979, so the third ends at the fold and the
			    fourth is under it. That is not the same defect. A numbered list of four says how
			    many there are and that more follow, a reader works down it one step at a time
			    with his browser's own settings open beside it, and the two things this comment
			    was about — the way back, and the sentence he might be worried about — are both
			    above the fold. What is not allowed is a single required action hidden with
			    nothing indicating it; what is here is a list that continues. */}
			<p className="sub">
				It reads your league in your own browser. Nothing is sent anywhere else.
			</p>
			{!IN_STORE && (
				/* SAID FIRST, because it changes what every step below is. He is about to be asked
				   to do something more fiddly than pressing Add, and being told why is the
				   difference between a walkthrough and a runaround. */
				<p className="connect-note">
					It is not in the {firefoxish ? "Firefox add-ons site" : "Chrome Web Store"} yet, so
					it comes from here instead. Four steps, about a minute.
				</p>
			)}
			<ol className="steps">
				{!IN_STORE && download ?
					<>
						<li className="step">
							<span className="step-n">1</span>
							<div className="step-body">
								{/* The headline said "then unzip the file" for everybody while the aside
								    under it told a Firefox reader not to — two instructions, one line
								    apart, in opposite directions. Firefox takes the zip as it is. */}
								<p className="step-say">
									{firefoxish ? "Download it." : "Download it, then unzip the file."}
								</p>
								<p>
									<a className="chip-btn" href={download} download>
										Download it
									</a>
								</p>
								<p className="step-aside">
									{firefoxish ?
										"Firefox takes the zip as it is — nothing to unzip."
									:	/* "Double-click and it becomes a folder" is a Mac sentence. Windows
									     opens a zip as a window you can look into and Load unpacked will
									     not take it, so the instruction has to be the one that works on
									     both: get a real folder out of it, however this machine does that. */
										"Unzip it — on a Mac, double-click it; on Windows, right-click and Extract All. You want the folder it produces, not the zip."}
								</p>
							</div>
						</li>
						<li className="step">
							<span className="step-n">2</span>
							<div className="step-body">
								{/* IN A NEW TAB, because the closing line of this walkthrough promises this
								    page is watching and will notice the moment the add-on arrives — and it
								    cannot notice anything if the reader has just navigated it to his
								    browser's settings. He would come back to a page that had never seen
								    the install and a walkthrough still asking him to do it. */}
								<p className="step-say">
									Open a new tab, type this in the address bar and press enter.
								</p>
								{/* A browser will not let a page link to its own settings, so this is
								    text he copies rather than a button he presses — and it says so,
								    because a reader who tries to click it and nothing happens has been
								    told by the screen that the screen is broken.
								
								    EDGE IS NOT CHROME HERE. Edge runs the same add-on and does not open
								    `chrome://extensions` — it answers `edge://extensions`, and a reader
								    typing the address this screen gave him gets nothing. The address is
								    the one thing on this step, so getting it wrong is the whole step. */}
								<span className="step-point">
									<Arrow label={`pointing at the address ${extensionsUrl}`} />
									<span className="step-target step-address">{extensionsUrl}</span>
								</span>
								<p className="step-aside">
									{firefoxish ?
										"Nothing here can open that page for you — browsers only let you type it."
									:	"Then turn on Developer mode, the switch at the top right."}
								</p>
							</div>
						</li>
						<li className="step">
							<span className="step-n">3</span>
							<div className="step-body">
								<p className="step-say">
									Press <b>{firefoxish ? "Load Temporary Add-on" : "Load unpacked"}</b> and choose
									{firefoxish ? " the file you downloaded" : " the folder you unzipped"}.
								</p>
								<span className="step-point">
									<Arrow label={`pointing at the words ${firefoxish ? "Load Temporary Add-on" : "Load unpacked"}`} />
									<span className="step-target" aria-hidden="true">
										{firefoxish ? "Load Temporary Add-on…" : "Load unpacked"}
									</span>
								</span>
								{firefoxish && (
									/* NOT A FOOTNOTE. A temporary add-on is gone when Firefox closes, and a
									   reader who finds it missing tomorrow will think it broke. */
									<p className="step-aside step-warn">
										Firefox drops it when you quit, so it has to be loaded again next time.
										On Chrome it stays.
									</p>
								)}
							</div>
						</li>
						<li className="step">
							<span className="step-n">4</span>
							<div className="step-body">
								<p className="step-say">Open your Yahoo team once, then come back here.</p>
								<p>
									<button type="button" className="chip-btn" onClick={() => ext.openYahoo()}>
										Open Yahoo
									</button>
								</p>
							</div>
						</li>
					</>
				:	<>
				<li className="step">
					<span className="step-n">1</span>
					<div className="step-body">
						<p className="step-say">Open the page below.</p>
						{store.at && (
							<p>
								<a className="chip-btn" href={store.at} target="_blank" rel="noreferrer noopener">
									Get it for {browser === "firefox" || browser === "firefox-android" ? "Firefox" : "this browser"}
								</a>
							</p>
						)}
					</div>
				</li>
				<li className="step">
					<span className="step-n">2</span>
					<div className="step-body">
						<p className="step-say">
							Press <b>{store.press}</b>, then <b>{store.then}</b>.
						</p>
						{/* OUR drawing of the words he is looking for, with the arrow pointing INTO
						    them. Not a screenshot: this is what the button SAYS, which is the part
						    that does not change when somebody restyles a browser.
						
						    The arrow is drawn first and the words second, because the arrow's head is
						    at its bottom-right and an arrow that ends where nothing is reads as a
						    doodle — which is what the first version was: measured at 390px, the head
						    landed 40px to the right of the facsimile with the facsimile to its left. */}
						<span className="step-point">
							<Arrow label={`pointing at the words ${store.press}`} />
							<span className="step-target" aria-hidden="true">
								{store.press}
							</span>
						</span>
					</div>
				</li>
				<li className="step">
					<span className="step-n">3</span>
					<div className="step-body">
						<p className="step-say">Open your Yahoo team once, then come back here.</p>
						<p>
							<button type="button" className="chip-btn" onClick={() => ext.openYahoo()}>
								Open Yahoo
							</button>
						</p>
					</div>
				</li>
					</>
				}
			</ol>
			<p className="sub connect-watch">
				This page notices the moment it is added &mdash; nothing to press here.
			</p>
			<p className="connect-back">
				<button type="button" className="as-link" onClick={onBack}>
					Type my team in instead
				</button>
			</p>
			{showSteps ? null : null}
		</div>
	)
}

/** "6h ago", "just now" — the same shape the rest of the app uses for an age, written here
 *  rather than imported to keep this component free of the stores. */
const ago = (iso: string): string => {
	const ms = Date.now() - Date.parse(iso)
	if (!Number.isFinite(ms) || ms < 0) return "just now"
	const mins = Math.floor(ms / 60_000)
	if (mins < 2) return "just now"
	if (mins < 60) return `${mins}m ago`
	const hours = Math.floor(mins / 60)
	if (hours < 24) return `${hours}h ago`
	return `${Math.floor(hours / 24)}d ago`
}
