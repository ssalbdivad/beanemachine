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
 * date the week that browser is restyled. (An `Arrow` component drew a hand-made arrow at
 * those targets. The walkthrough stopped needing one, and it was kept exported "for any
 * screen that does" — no screen ever did, so it was deleted on 2026-09-22. `Tick`, which
 * shares its two-pass stroke, is still used and stays.)
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

/*
 * A HAND-DRAWN ARROW stood here — one cubic path stroked twice, a ghost pass at a third
 * opacity and a pixel off true, then the real one over it, which is what makes a line look
 * drawn rather than plotted. Deleted on 2026-09-22 with its `.arrow` box rule in app.css;
 * it had no caller in src or test.
 *
 * The one thing in it worth carrying forward is the draw-on, and `Tick` below still carries
 * it: the animation is written so that KILLING it leaves a finished mark. This app's
 * reduced-motion rule is `*{animation:none!important}`, so a path that started at
 * `stroke-dashoffset: 140` and animated to 0 would be permanently invisible for exactly the
 * readers most likely to need the instruction. The base state is the finished state and the
 * keyframes only ever hide it first. Any new drawn mark here must be written the same way.
 */

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
 * HOW THIS BROWSER CAN ACTUALLY BE GIVEN THE READER, TODAY.
 *
 * This was two booleans and two tables — `IN_STORE`, `DOWNLOAD`, `STORE` — and the walkthrough
 * read them in a ternary. That was fine while there were two possible worlds. There are three,
 * and Firefox is about to be in the middle one:
 *
 *   unpacked  no signature and no listing. The site hands over a zip and the reader loads it
 *             by hand. Three lines, a Developer-mode switch, and on Firefox the add-on is
 *             forgotten at the next restart, because `Load Temporary Add-on` means temporary.
 *   signed    Mozilla has SIGNED the add-on but it is not listed — AMO's self-distribution
 *             route, which is free, needs no public listing, and returns an .xpi we host
 *             ourselves. A signed .xpi installs from an ordinary link: Firefox shows its own
 *             install panel. One press, and it survives a restart.
 *   store     a listing exists. One press, from the store's own page.
 *
 * Chrome has no middle state: outside the Web Store it will not install a packaged extension
 * at all on Windows or macOS, so it goes from `unpacked` straight to `store`.
 *
 * WHY THIS IS A CONSTANT AND NOT A PROBE. The page cannot ask whether a file exists without
 * fetching it, and a HEAD request on every render to decide what a button says is a request
 * this app has no business making. So the fact lives here, the build refuses to disagree with
 * it (extension/build.mjs checks the pair), and flipping it is a one-line commit with the
 * evidence in the message.
 *
 * WHAT TO FLIP, AND WHEN:
 *   · `FIREFOX_XPI` — set to the file name once AMO returns a signed .xpi and
 *     extension/build.mjs has copied it into `public/`. See extension/SUBMITTING.md.
 *   · `CHROME_LISTING` / `FIREFOX_LISTING` — set to the LISTING's own URL once each store
 *     has one. Not to a search for it: step 1 used to send every reader to a store search,
 *     and on 2026-09-18 the Chrome Web Store answered "It looks like there aren't any search
 *     results for your search" while Mozilla's API 404'd the id. A search page is how that
 *     bug was written in the first place.
 */
const FIREFOX_XPI: string | null = "beanemachine-firefox.xpi"
const CHROME_LISTING: string | null = null
const FIREFOX_LISTING: string | null = null

/** Kept exported because three screens and two suites still ask the same question in the
 *  old words: is a store listing live. It is now derived rather than declared. */
export const IN_STORE = CHROME_LISTING !== null || FIREFOX_LISTING !== null

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

/**
 * The one press, and what the browser will say after it — for the two states where there IS
 * one press. `press` is the button on the page the link opens; `then` is the browser's own
 * confirmation. Both are quoted so the walkthrough can name them rather than say "confirm".
 */
export type Install =
	| { kind: "store"; at: string; press: string; then: string }
	| { kind: "signed"; at: string; press: string; then: string }
	| { kind: "unpacked"; at: string }
	| null

/**
 * WHICH OF THE THREE APPLIES TO THIS BROWSER. One function, so a step and its button cannot
 * drift apart and so a browser nobody has shipped to yet has one obvious answer: null.
 *
 * Firefox for Android is deliberately null in every state. A self-distributed .xpi cannot be
 * installed there at all — Android Firefox takes add-ons from AMO and nowhere else — so the
 * signed route does not reach it and only a LISTING ever will.
 */
export const installFor = (browser: Browser): Install => {
	if (browser === "chrome" || browser === "edge")
		return CHROME_LISTING ?
				{ kind: "store", at: CHROME_LISTING, press: "Add to Chrome", then: "Add extension" }
			: DOWNLOAD[browser] ? { kind: "unpacked", at: DOWNLOAD[browser]! }
			: null
	if (browser === "firefox")
		return FIREFOX_LISTING ?
				{ kind: "store", at: FIREFOX_LISTING, press: "Add to Firefox", then: "Add" }
			: FIREFOX_XPI ?
				{ kind: "signed", at: asset(FIREFOX_XPI), press: "Add to Firefox", then: "Add" }
			: DOWNLOAD.firefox ? { kind: "unpacked", at: DOWNLOAD.firefox }
			: null
	if (browser === "firefox-android")
		return FIREFOX_LISTING ?
				{ kind: "store", at: FIREFOX_LISTING, press: "Add to Firefox", then: "Add" }
			:	null
	return null
}

/**
 * Whether the reader can be put in THIS browser today: the browser runs extensions and
 * there is somewhere to get it from — the store once `IN_STORE`, the site's own download
 * until then. Firefox for Android runs extensions and has neither (no store listing, no
 * about:debugging on a phone), so it is false there. The setup sheet uses this to decide
 * whether "Yahoo" leads to the reader or straight to typing a team; a browser that gains a
 * route gains the reader with it.
 */
export const readsHere = (b: Browser): boolean => takesExtension(b) && installFor(b) !== null

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
	waiting = false,
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
	/** True while the player list this read matches names against is still downloading.
	 *  `public/snapshot.json` is a megabyte, so on a phone there is a window in which this
	 *  walkthrough is fully drawn and the press does nothing at all — which is what it used
	 *  to do, silently, because `readLeague` opens `if (!snapshot) return`. Saying so on the
	 *  button is cheaper than a reader pressing it twice and concluding it is broken. */
	waiting?: boolean
	/** "Type your players instead" — the sheet's team step. */
	onBack: () => void
	failure: GrabFailure | null
	browser?: Browser
}): React.ReactElement => {
	const install = installFor(browser)
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
					<button
						type="button"
						className="primary"
						onClick={onRead}
						disabled={ext.busy || waiting}
					>
						{ext.busy ? "Reading…"
						: waiting ? "Loading players…"
						: leagueName ? "Read it again"
						: "Read my league"}
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
						{/*
						  ONE BRANCH PER STATE, because only one of them is true of this browser
						  today and showing two would be the menu the owner cut everywhere else.
						  See `installFor`: store, signed, or unpacked.
						*/}
						{install?.kind === "store" || install?.kind === "signed" ?
							<>
								<p className="step-say">
									Add the reader.
									{/*
									  A SIGNED .xpi INSTALLS FROM AN ORDINARY LINK. Firefox opens its own
									  install panel on a link to one — no extensions page, no Developer
									  mode, and it survives a restart, which `Load Temporary Add-on`
									  does not. `type` is stated because a host that serves the file as
									  octet-stream makes Firefox download it instead of offering to
									  install it, and the type is the only thing on this side that can
									  say what it is. See extension/SUBMITTING.md, which records that as
									  the one thing to check on the first deploy that carries the file.
									*/}
									<a
										className="chip-btn"
										href={install.at}
										{...(install.kind === "signed" ?
											{ type: "application/x-xpinstall" }
										:	{ target: "_blank", rel: "noreferrer noopener" })}
									>
										{install.press}
									</a>
								</p>
								<p className="step-aside">
									Press <b>{install.then}</b>.
								</p>
							</>
						:	<>
								<p className="step-say">
									Add the reader.
									<a className="chip-btn" href={install?.at ?? undefined} download>
										Download it
									</a>
								</p>
								{/* The three things a browser asks of a sideloaded extension, one line
								    each. Chrome and Edge want a FOLDER (so unzip), Firefox takes the
								    zip as it is. The address is selectable text because a page cannot
								    link to a browser's own settings — Firefox refuses to navigate to
								    `about:` from web content, and Chrome to `chrome://`, which is why
								    this reads "open" rather than being a link. */}
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
