import { since } from "./ago.ts"
import type { GrabFailure } from "../data/extension.ts"
import type { ExtensionState } from "./extension.ts"

/**
 * HOW TO LET IT READ YOUR YAHOO LEAGUE, in three one-line steps.
 *
 * Everything else in this app is built around being TOLD — typed, pasted, carried in a
 * file — because Yahoo sends no header that would let a web page read a league. This is
 * the one screen that offers the other thing. It used to argue for itself (what it reads,
 * that nothing is sent anywhere, how long it takes); it instructs now, and the arguments
 * live in the comments below. See `Connect` for what was cut and what was measured.
 *
 * IT DRAWS ITS OWN TARGETS where it points at anything: the extensions-page address is
 * our own selectable text, not a screenshot of somebody else's browser, which would be out of
 * date the week that browser is restyled. (`Arrow` drew a hand-made arrow at those targets
 * and the walkthrough no longer needs one; it stays exported for any screen that does.)
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

/**
 * Whether the reader can be put in THIS browser today: the browser runs extensions and
 * there is somewhere to get it from — the store once `IN_STORE`, the site's own download
 * until then. Firefox for Android runs extensions and has neither (no store listing, no
 * about:debugging on a phone), so it is false there. The setup sheet uses this to decide
 * whether "Yahoo" leads to the reader or straight to typing a team; a browser that gains a
 * route gains the reader with it.
 */
export const readsHere = (b: Browser): boolean =>
	takesExtension(b) && (IN_STORE ? !!STORE[b].at : !!DOWNLOAD[b])

/**
 * THE YAHOO STEP OF THE SETUP SHEET, and nothing else.
 *
 * WHAT WAS CUT, measured 2026-09-22 on the published build at 390x844: the not-installed
 * walkthrough was 216 words and 1,246px — a privacy sentence ("It reads your league in your
 * own browser. Nothing is sent anywhere else."), "Four steps, about a minute.", four
 * numbered steps each with a paragraph-length aside (Mac vs Windows unzipping, where
 * Downloads are, what appears in the list), a Firefox warning, and a closing paragraph
 * explaining that the box would turn into a button. Every one of those sentences was the
 * app explaining itself.
 *
 * WHAT IS LEFT is three numbered steps, one line each: add the reader, open your team on
 * Yahoo, come back to this page (which then turns into the button). The first step needs the three things a browser actually asks
 * of a sideloaded extension (unzip, open the extensions page, load it) — without them the
 * download is a file nobody can use — so they are three one-line instructions inside it
 * rather than prose. When the store listing is live (`IN_STORE`) they collapse to "Press
 * Add to Chrome".
 *
 * INSTALLED, it is one line and the button. `useExtension` polls for the reader, so the
 * moment it arrives this component re-renders into that shape; nothing has to say it will.
 *
 * The heading, the install steps and the "type instead" link live here; the "Back" to the
 * platform question is the sheet's, above this. Classes the suites address: `.connect`,
 * `.connect.connected` once installed, `.step` for each install step, `.connect-back` for
 * the way out to typing.
 */
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
	/** "Type your players instead" — the sheet's team step. */
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
	const typeInstead = (
		<p className="connect-back">
			<button type="button" className="as-link" onClick={onBack}>
				Type your players instead
			</button>
		</p>
	)
	/* Said above the button because it changes what pressing it will do: an older reader
	   that still answers every ask it knows never produces a failure to hang a sentence on. */
	const snags = (
		<>
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
		</>
	)

	if (ext.present)
		return (
			<div className="connect connected">
				<h2>Read your league from Yahoo</h2>
				{leagueName ?
					/* The receipt: the league's NAME, the free agents and when. The one line on
					   this screen he reads twice, so it is a fact rather than a sentence. */
					<p className="sub connect-got">
						<Tick /> Read <b>{leagueName}</b>
						{freeAgents !== null ? <> &mdash; {freeAgents} free agents</> : null}
						{readAt ? <> &mdash; {ago(readAt)}</> : null}.
					</p>
				:	<p className="sub">Open your team on Yahoo, then press Read my league.</p>
				}
				{snags}
				<p className="connect-go">
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
				{typeInstead}
			</div>
		)

	/* Never drawn by the setup sheet, which sends such a reader to typing instead (see
	   `readsHere`). Kept safe for any other caller: no sentence about the device, just the
	   way on. */
	if (!readsHere(browser)) return <div className="connect">{typeInstead}</div>

	return (
		<div className="connect">
			<h2>Read your league from Yahoo</h2>
			<ol className="steps">
				<li className="step">
					<span className="step-n">1</span>
					<div className="step-body">
						{IN_STORE && store.at ?
							<>
								<p className="step-say">
									Add the reader.
									<a className="chip-btn" href={store.at} target="_blank" rel="noreferrer noopener">
										Get it
									</a>
								</p>
								<p className="step-aside">
									Press <b>{store.press}</b>, then <b>{store.then}</b>.
								</p>
							</>
						:	<>
								<p className="step-say">
									Add the reader.
									<a className="chip-btn" href={download ?? undefined} download>
										Download it
									</a>
								</p>
								{/* The three things a browser asks of a sideloaded extension, one line
								    each. Chrome and Edge want a FOLDER (so unzip), Firefox takes the
								    zip as it is. The address is selectable text because a page cannot
								    link to a browser's own settings. */}
								<ul className="step-how">
									{!firefoxish && <li>Unzip it.</li>}
									<li>
										In a new tab, open{" "}
										<span className="step-target step-address">{extensionsUrl}</span>
									</li>
									{firefoxish ?
										<li>
											Press <b>Load Temporary Add-on</b>, pick the file.
										</li>
									:	<li>
											Turn on <b>Developer mode</b>, press <b>Load unpacked</b>, pick the folder.
										</li>
									}
								</ul>
							</>
						}
					</div>
				</li>
				<li className="step">
					<span className="step-n">2</span>
					<div className="step-body">
						<p className="step-say">
							Open your team on Yahoo.
							<button type="button" className="chip-btn" onClick={() => ext.openYahoo()}>
								Open Yahoo
							</button>
						</p>
					</div>
				</li>
				<li className="step">
					<span className="step-n">3</span>
					<div className="step-body">
						{/* No button here: a greyed control he cannot use yet is the thing this file
						    promises never to draw. `useExtension` polls for the reader, and the moment it
						    answers this component re-renders into the installed shape, with the button.
						    So the step says only what is true on THIS screen. It used to say "Come back
						    and press Read my league." — naming a button that is not on it. */}
						<p className="step-say">Come back to this page.</p>
					</div>
				</li>
			</ol>
			{snags}
			{typeInstead}
		</div>
	)
}

/** "6h ago" — the app's one age label, from ./ago.ts. This file used to carry its own
 *  copy, with a comment explaining that it was written here rather than imported "to keep
 *  this component free of the stores"; the reason was sound and the fix was to move the
 *  function out of the store rather than to copy it. Floored against rounded, the two
 *  disagreed from ninety minutes upward. */
const ago = (iso: string): string => since(iso, Date.now()).label
