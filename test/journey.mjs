// One person, one session, moving through the whole product.
//
// Every other browser suite stands on one surface and asserts it deeply. Nothing
// asserts that state carries ACROSS them, which is where the integration bugs
// live: a roster pasted on Setup, the seats that came with it read back by the
// card on Today that gives the instructions, a horizon switched on Wire, and all
// of it still there after a reload. The claims here are therefore about continuity
// rather than about any single screen — a filter that leaves a stale row behind, a
// roster that never reaches the surface that plans a lineup out of it, a reload
// that quietly forgets.
//
// THE SURFACES MOVED UNDER THIS FILE TWICE, and the second move is the reason most
// of the rewriting below exists.
//
// First the draft page went: a roster used to be built by CLAIMING players on a
// draft board, and the integration point was whether those claims reached the team
// the trade page priced. `src/engine/draft.ts` and `test/draft.mjs` are deleted, so
// the paste replaced it.
//
// Then the four tabs became three SCREENS, each asking one question:
//   Today  (view id "board")  — the decision, and nothing else. The Decide card plus
//                               one link to Wire. It no longer carries the ranking.
//   Wire   (view id "wire")   — the ranking, and nothing else: modes, filters,
//                               Billy's pick, the table.
//   Setup  (view id "trade")  — your team AND your league, one screen. The roster
//                               paste, the lineup card, the scoring tables, the slot
//                               list, the team count, and the management toolbar
//                               that used to live on a "League setup" tab of its own.
// There is no "league" tab any more. Two tabs became one screen and one tab became
// two, so every `:nth-child(N)` in this file was pointing somewhere else — which is
// why navigation here is by the tab's VISIBLE TEXT and not by position. See `tab`.
//
// The journey is therefore the route a reader actually has, in the order he has it:
// he lands on Today, which cannot answer him yet and says so; its own button puts
// him on Setup; he needs names, so he looks at Wire; he pastes his team on Setup;
// Today becomes tonight's lineup; he prices a deal; he reloads and everything he
// entered is still his. Same property under test throughout — a team entered on one
// surface is the team every other surface reasons about, and no key drifts between
// them.
//
// It also runs a console-error trap for the whole journey rather than per page,
// because the errors that matter are the ones a second view triggers in the
// first one.
import { chromium, firefox } from "playwright-core"
/*
 * 5299, not 5173.
 *
 * :5173 is not this repo's port — it belongs to another app on this machine, and a
 * dev server there answers 200 just as happily, after which every assertion here
 * fails as a selector timeout that reads like a UI defect in beanemachine and is
 * not one. The wordmark guard below has always caught it; defaulting to the right
 * port means it never has to.
 */
const BASE = process.env.BASE ?? "http://127.0.0.1:5299"
const ENGINE = process.env.BROWSER ?? "chromium"
const browser = ENGINE === "firefox" ? await firefox.launch() : await chromium.launch({ args: ["--no-sandbox"] })
console.log(`--- ${ENGINE} ---`)
let pass = 0, fail = 0
const t = (n, ok, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : "  " + x}`) }
const num = s => Number(String(s).replace(/[^0-9.+-]/g, ""))

/** Everything this app keeps in the browser. Cleared going in so the journey is
 *  the same journey every run, and cleared coming out so it cannot poison the
 *  next suite — these keys outlive a page, not a process. */
// `beanemachine:view` remembers which question the reader last asked (mode, window).
// A suite that leaves it behind opens the NEXT run on somebody else's horizon, which
// is the class of cross-run contamination this list exists to prevent. It is also
// why the order of the Wire section below matters: the last horizon this journey
// selects is the one the board reopens on after the reload.
//
// `beanemachine:draft` is a key nothing in src/ reads or writes any more — the draft
// page is gone. It stays on the list rather than being dropped, because the list's
// job is to describe what a browser profile may be CARRYING, not what this build
// writes: a profile that visited an older beanemachine still has one, and clearing it
// costs a no-op. It is deliberately not asserted on anywhere below.
const KEYS = [
  "beanemachine:config", "beanemachine:roster", "beanemachine:draft",
  "beanemachine:lineup", "beanemachine:pool", "beanemachine:view"
]

const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
const errors = []
/**
 * index.html asks Google for IBM Plex Mono, and a browser logs a failed download
 * of it as a console error — Firefox loudly, with the URL in the text. That is a
 * network hiccup at somebody else's CDN, not a defect in this app, and it made
 * this suite fail two runs in nine on nothing else. It is also not a thing this
 * suite tests: the font is progressive, `--mono` falls back to the system stack.
 *
 * So the trap SPLITS rather than filters. An error naming a host this app does
 * not own is set aside and printed at the end, never silently dropped; only the
 * app's own errors are asserted on.
 */
/**
 * Two classes of noise that are not the app misbehaving. Web fonts are somebody
 * else's origin, and so is statsapi.mlb.com — which this journey deliberately does
 * NOT stub, because the live slate is half of what the Decide card now claims. The
 * `/api/health` 404 is this app's own deliberate probe: a static host has no API,
 * and asking is how the client finds that out — the browser logs every 404
 * regardless of whether the caller expected it. Anything else in the console is
 * ours and is asserted on.
 */
const NOT_OURS = /fonts\.(?:gstatic|googleapis)\.com|statsapi\.mlb\.com/

/**
 * The browser logs a 404 as a bare "Failed to load resource" with no URL in the
 * text, so noise cannot be filtered by matching the message. It has to be
 * correlated with the response that caused it.
 *
 * Exactly one failing request is expected: the app probes `api/health` at startup
 * because a static host has no API and asking is how the client finds that out.
 * Any OTHER failing request makes the generic line ours again, so this cannot
 * quietly swallow a real broken asset.
 */
const EXPECTED_404 = /\/api\/health$/
const unexpectedFailures = []
const GENERIC_LOAD_FAILURE = /^Failed to load resource/
const foreign = []
const note = line => (NOT_OURS.test(line) ? foreign : errors).push(line)
page.on("pageerror", e => note(`pageerror: ${e}`))
page.on("response", r => {
	if (r.status() >= 400 && !EXPECTED_404.test(new URL(r.url()).pathname))
		unexpectedFailures.push(`${r.status()} ${r.url()}`)
})
page.on("requestfailed", r => {
	// A request that never got an answer has no response to correlate, so it is
	// classified by host like everything else: the live slate read is somebody
	// else's server and may simply not be reachable from this machine.
	//
	// The health probe is exempted here as well as in the response handler above,
	// and not exempting it was a real (if short-lived) bug in this trap: `npx vite`
	// with no Hono server behind it answers its own `/api` proxy with a 502 AND
	// reports the request as failed, so the probe arrived twice, once through each
	// handler. The second arrival filled `unexpectedFailures`, which is the flag the
	// console branch below reads to decide whether a bare "Failed to load resource"
	// is ours — so one unclassified probe turned every generic 404 line in the run
	// into an app error and failed all six `clean()` stages on nothing.
	if (EXPECTED_404.test(new URL(r.url()).pathname)) return
	if (!NOT_OURS.test(r.url())) unexpectedFailures.push(`failed ${r.url()}`)
	else foreign.push(`requestfailed: ${r.url()}`)
})
page.on("console", m => {
	if (m.type() !== "error") return
	const text = m.text()
	// generic and attributable to the expected probe alone — not the app's own error
	if (GENERIC_LOAD_FAILURE.test(text) && !unexpectedFailures.length) {
		foreign.push(`console: ${text}`)
		return
	}
	note(`console: ${text}`)
})
/** Asserted at every stage rather than once at the end, so a failure names the
 *  step that caused it instead of the last one. */
const clean = where =>
	t(
		`no console or page errors ${where}`,
		errors.length === 0 && unexpectedFailures.length === 0,
		[...errors, ...unexpectedFailures].join(" | ")
	)

/**
 * A stage that never arrives is a break too, and Playwright reports it as a bare
 * stack trace naming a selector. That is the wrong end of the story: every wait
 * below stands in for a claim, so name the stage first and turn a timeout into a
 * failure of THAT claim, reported and counted the way every other one is.
 */
let stage = "the page loads at all"
const at = where => { stage = where }
process.on("uncaughtException", async e => {
	t(stage, false, String(e.message ?? e).split("\n")[0])
	console.log(`\npassed ${pass}, failed ${fail}`)
	await browser.close().catch(() => {})
	process.exit(1)
})

/**
 * THREE arrivals, not one.
 *
 * This used to be a single `arrive()` that waited for `.board-row`, because every
 * navigation in the journey ended on a page that had the ranking on it — the
 * landing tab carried the decision card and the table together. It does not any
 * more: Today renders the Decide card and a link, Wire renders the ranking, Setup
 * renders the team and the league. A single readiness signal is now wrong on two
 * screens out of three, and waiting for the old one on the landing page is exactly
 * how this suite failed after the restructure — 30 seconds, then a stage failure
 * naming a selector instead of a screen.
 *
 * Deliberately not `networkidle` for any of them. The page asks fonts.gstatic.com
 * for a webfont and statsapi.mlb.com for tonight's slate, and where either host is
 * slow or unreachable the request stays open until the navigation times out — a
 * suite that fails on somebody else's server rather than on this app. A rendered
 * screen is the readiness signal this suite actually means.
 */
const onToday = () => page.waitForSelector(".decide", { timeout: 30000 })
const onWire = () => page.waitForSelector(".board-row", { timeout: 30000 })
const onSetup = () => page.waitForSelector(".trade-team", { timeout: 30000 })

await page.goto(BASE, { waitUntil: "domcontentloaded" })

// A 200 on this port is not proof it is this app: another project's dev server
// answers just as happily, after which every assertion below fails as a selector
// timeout that reads like a UI defect. The wordmark is the cheapest proof of
// identity, so it is checked before anything else and stops the run rather than
// letting the next wait speak for it.
const wordmark = await page.waitForSelector("h1", { timeout: 15000 }).then(h => h.textContent(), () => null)
t("the page under test is beanemachine", wordmark === "beanemachine",
  `BASE=${BASE} served <h1>${wordmark}</h1> — start this repo's own vite, or set BASE to it`)
if (wordmark !== "beanemachine") { await browser.close(); process.exit(1) }

await onToday()
await page.evaluate(keys => keys.forEach(k => localStorage.removeItem(k)), KEYS)
await page.reload({ waitUntil: "domcontentloaded" })
await onToday()

/**
 * Navigation BY VISIBLE TEXT, and this is the one helper worth arguing about.
 *
 * Several suites in this directory reach a screen with `.views button:nth-child(N)`.
 * That selector survived the first restructure by luck and broke on the second one
 * silently: index 2 was "League setup" and is now "Wire", so a suite asking for the
 * league editor got the ranking, and its next assertion failed on a screen it had
 * never meant to be standing on. A name that no longer exists fails LOUDLY — the
 * locator matches nothing and the stage that wanted it is reported — and a rename is
 * then a one-line change here instead of a hunt through every index in the file.
 */
const TODAY = "Today", WIRE = "Wire", SETUP = "Setup"
const tab = name => page.locator(".views button", { hasText: name }).first().click()
const current = () => page.$eval(".views button[aria-selected=true]", e => e.textContent.trim())
const rows = () => page.$$eval(".board-row .who b", n => n.map(e => e.textContent.trim()))
const codes = () => page.$$eval(".board-row .who .code", n => n.map(e => e.textContent.trim()))
const confs = () => page.$$eval(".board-row .conf-num", n => n.map(e => Number(String(e.textContent).replace("%", ""))))
const bscores = () => page.$$eval(".board-row .bscore", n => n.map(e => parseFloat(e.textContent)))
/** The board renders only its top 120, so the rendered count is not the ranking's
 *  size. This is the real one, read off the element that states it — it used to be
 *  scraped out of the surrounding sentence, which meant rewording the sentence
 *  silently turned this into `null` and every comparison against it into a lie. */
const ranked = () =>
	page.$eval("#horizon-panel .sub .count", e => Number(e.textContent.replace(/,/g, "")))

// --- 1. landing on the screen that answers the question ------------------------

/**
 * Rewritten, not deleted: this file used to walk four tabs and reached the fourth
 * by `tab("Draft")`, then three tabs named Recommendations / League setup / My team
 * & trades. Both lists are now locators that match nothing and time out 30 seconds
 * later as a stage failure naming a selector.
 *
 * The claim the walk made implicitly — every surface this app has is reachable from
 * the nav, by name — is worth making explicitly, so it is made here once and the
 * journey below visits exactly these three. The fourth is not "missing": the draft
 * page, `src/engine/draft.ts` and `test/draft.mjs` were deleted, and "League setup"
 * is not missing either — it is the lower half of Setup, which is asserted in
 * section 2 rather than taken on trust.
 */
const tabs = await page.$$eval(".views button", n => n.map(e => e.textContent.trim()))
t("the nav names the three screens this app has — one question each",
	tabs.join("|") === `${TODAY}|${WIRE}|${SETUP}`, tabs.join(" | "))
t("and the journey starts on the one a reader opens fifty times a season",
	(await current()) === TODAY, await current())

/**
 * NEW, and it is the restructure's whole thesis, so it is asserted on the landing
 * screen before anything else happens.
 *
 * Today and the ranking used to share one tab called "Recommendations": the decision
 * card, then a thousand-row table under it. Measured at phone width that was a
 * 7,477px screen, and the first ranked row sat 1,600px down — two questions asked at
 * different moments (before first pitch; when you have a move to spend) stacked on
 * one another because they happen to share an engine. A reader who came to be told
 * what to do scrolled past nothing; a reader who came to look somebody up scrolled
 * past everything. The same screen with no roster loaded is now 947px and 105 words.
 *
 * The claim is about ABSENCE, which is the only kind of claim that can protect this:
 * a card is easy to add back to a screen and nothing else in the test suite would
 * notice. So Today must carry the decision and NOT the ranking, not the mode strip,
 * and not the board's toolbar.
 */
t("Today carries the decision", (await page.$$(".decide")).length === 1)
t("and not the ranking — no rows, no mode strip, no board toolbar on this screen",
	(await page.$$(".board-row")).length === 0 &&
		(await page.$$(".modes")).length === 0 &&
		(await page.$$(".board-controls")).length === 0,
	`${(await page.$$(".board-row")).length} rows, ${(await page.$$(".modes")).length} mode strips, ` +
		`${(await page.$$(".board-controls")).length} toolbars`)
/** The other half of an absence claim: a screen that dropped the ranking has to say
 *  where it went, or it has simply lost a feature. One link, named for what is
 *  behind it rather than for the tab it opens. */
const toWire = page.locator(".next-screen button")
t("and it says where the ranking went, in one link",
	await toWire.count() === 1 && /Everyone you can get/.test(await toWire.textContent()),
	await toWire.count() ? await toWire.textContent() : "no link to the ranking at all")

at("the card on Today says what to do about having no team")
const blocked = await page.waitForSelector(".decide.decide-blocked", { timeout: 30000 })
const blockedText = (await blocked.textContent()).replace(/\s+/g, " ").trim()
/**
 * Rewritten from a claim this suite never made, because the surface it replaces is
 * one this suite DID walk: the draft page was the answer to "this browser does not
 * know who is on your team". It is gone, so the blocked state of `Decide` is the
 * only thing standing in that place — and it is now the entire landing screen
 * rather than a card above a board, which is why it moved to the top of the journey.
 * The journey asserts it is an instruction rather than an essay.
 *
 * The old blocked state was four paragraphs and about a hundred and ten words, most
 * of it about CORS: that availability would be estimated, that Yahoo sends no
 * headers a browser is allowed to read, and how to run a command line — to a reader
 * who had not yet said who was on his team. None of it changed his next tap. The
 * word count is asserted, not just the presence of the button, because "shorter"
 * was the whole change and a paragraph can grow back one sentence at a time.
 */
t("the blocked card is one instruction, not a lecture about CORS",
	blockedText.split(/\s+/).length < 50 && !/CORS|access-control|npx|command/i.test(blockedText),
	`${blockedText.split(/\s+/).length} words: ${blockedText}`)
t("it names the one action, and what it costs",
	/Add your players/.test(blockedText) && /minute/.test(blockedText) && /this browser/.test(blockedText),
	blockedText)
t("and the action is a button, not a sentence telling him to go and find one",
	await page.locator(".decide-blocked button.decide-cta").count() === 1)
clean("on the screen a first visit lands on")

// --- 2. the screen that takes a team, and a league, and is one screen ----------

// THE hand-off. A card that says "add your players" and leaves the reader to find
// the tab is a card that has told him to go away; the button has to land him on the
// surface that takes them.
at("the card's own button lands on the surface that takes a roster")
await page.click(".decide-cta")
await onSetup()
/**
 * Rewritten: this asserted the button opened "My team & trades". The tab is called
 * Setup and it is two old tabs in one, so the assertion is now that the button lands
 * on the screen that owns the job — named by the same constant the nav is checked
 * against, so a rename cannot make this pass against the wrong screen.
 */
t("the card's button opens Setup itself", (await current()) === SETUP, await current())
t("and the roster reader is on it",
	(await page.$$("[data-ctl=paste-roster]")).length === 1)

/**
 * NEW, and it is the claim that two tabs really did become one screen.
 *
 * "My team & trades" and "League setup" were two of four tabs, and both are things
 * one person does once a season from a laptop; half the navigation was furniture and
 * the tab bar did not fit the phone this app is opened on. They are also the same
 * job — everything Today and Wire say is priced in the league's values, and the men
 * above are who those prices are about.
 *
 * This is asserted HERE, on one page load, rather than left to the two single-surface
 * suites, because neither of them can see it: test/trade-ui.mjs would pass with the
 * league editor on a fourth tab, and test/settings.mjs would pass with the roster
 * paste on a fifth. Only a suite standing on the screen can say they are the same
 * screen. The team count is the field picked out by name because it is the one Wire
 * cannot rank without — replacement level is teams x seats.
 */
const teamCountInput = "input[aria-label='Teams in this league']"
await page.waitForSelector(teamCountInput, { timeout: 30000 })
const teamCount = Number(await page.inputValue(teamCountInput))
t("the league editor is on the same screen as the team, not a tab of its own",
	(await page.$$(`.trade-team`)).length === 1 && (await page.$$(teamCountInput)).length === 1)
t("the team count the ranking's replacement level needs is set, and set here",
	Number.isFinite(teamCount) && teamCount >= 2, String(teamCount))

/**
 * NEW, and cross-surface by construction, which is why it is in this file.
 *
 * The management toolbar — New, Remove, Download, Load file, import by URL, and the
 * league picker — used to sit above EVERY tab. Measured on a 1200px screen it pushed
 * the first ranked row below the fold, on the page whose job is to show ranked rows.
 * It now renders on Setup alone (see `manage` in src/client/App.tsx), and "alone" is
 * a claim about the other two screens that only a suite visiting all three can make.
 * The positive half is here; the negative half is in section 3, on Wire.
 */
const manageChrome = () => page.$$eval("[data-ctl=onboard]", n => n.length)
t("the chrome for managing leagues is on the screen where a league is set up",
	await manageChrome() === 1, String(await manageChrome()))
clean("on the screen that is two old tabs")

// --- 3. Wire: the ranking, and the three horizons ------------------------------
//
// Reached by the link on Today rather than by the tab, because that is the route the
// reader was just offered and an offer nobody tests is an offer that can rot. The
// tab is used everywhere else below.

at("the link on Today opens the ranking")
await tab(TODAY)
await onToday()
await page.click(".next-screen button")
await onWire()
t("the link at the foot of Today opens Wire", (await current()) === WIRE, await current())
/** The mirror of the Today claim: Wire carries the ranking and not the decision.
 *  One screen, one question, in both directions — a Decide card that came back here
 *  would put the answer back on top of the lookup. */
t("and Wire is the ranking alone — the decision card is not on it too",
	(await page.$$(".decide")).length === 0 && (await page.$$(".board-controls")).length === 1,
	`${(await page.$$(".decide")).length} decide cards`)
// the negative half of section 2's toolbar claim
t("and the league-management chrome stayed behind on Setup",
	await manageChrome() === 0, String(await manageChrome()))

t("the ranking Wire opens on is a real one", (await rows()).length > 50)
const fortnight = (await rows()).slice(0, 10)
const fortnightCount = await ranked()

const horizon = async label => {
	await page.click(`.modes .mode:has-text('${label}')`)
	await page.waitForTimeout(400)
	await page.waitForSelector(".board-row", { timeout: 30000 })
	return (await rows()).slice(0, 10)
}
/**
 * The NAME ALONE, which now has to be extracted rather than read off the element.
 *
 * `.pick-name` used to contain nothing but the name, so `textContent` was the name.
 * Billy's pick is a strip now and the same cell also carries
 * `<span class="pick-pos">RP · Chicago White Sox</span>`, so `textContent` read
 * "Grant TaylorRP · Chicago White Sox" — and every comparison against a board row,
 * which prints the name by itself, stopped matching. The surname this suite feeds to
 * the search box came out as "Sox" and found nobody.
 *
 * The FIRST TEXT NODE is the name, and reading that rather than subtracting the span's
 * text means a second thing added to the cell cannot silently rejoin the string
 * either. The empty-pick copy ("Nobody.") still reads correctly through this, as a
 * text node with no span beside it.
 */
const pickName = async () =>
	(await page.$eval(".pick-name", e => e.firstChild?.textContent ?? "")).trim()
const fortnightPick = await pickName()
const stream = await horizon("Streaming")
/**
 * Rewritten, not weakened: `stream.length === 10` was a claim about the RENDER
 * WINDOW that has stopped being true of this mode, and for the reason the mode
 * exists. Streaming now opens filtered to players the reader can actually add —
 * a list of men who are both on the wire and taking a turn before the reset is
 * legitimately short, and on the committed capture with the local API up it is
 * nine names. Asserting ten would be asserting that the mode has NOT been narrowed
 * to the handful it is supposed to name. The assertion that matters is unchanged:
 * a different question gives a different answer.
 */
t("switching to Streaming re-ranks against the league's own scoring period",
	stream.length > 0 && stream.join() !== fortnight.join(), `${stream.slice(0, 3)} vs ${fortnight.slice(0, 3)}`)
const streamPick = await pickName()
const stash = await horizon("Stash")
t("switching to Stash re-ranks against the rest of the season",
	stash.length === 10 && stash.join() !== stream.join(), `${stash.slice(0, 3)} vs ${stream.slice(0, 3)}`)
const stashPick = await pickName()

/**
 * Billy's pick has to follow the horizon. A stale pick above a re-ranked board is
 * the reader's headline disagreeing with the table underneath it.
 *
 * This used to assert the pick equalled the top row, which is no longer true by
 * design: the card names the best player you can actually GET, and the top row is
 * usually rostered everywhere. So staleness is tested directly instead — the pick
 * must come off the board currently on screen, and the three horizons must not all
 * produce the same name when their boards differ, which is what a frozen pick
 * would do.
 */
// Against the ranking, not the render window: the board pages in as you scroll and
// the pick is the best AVAILABLE player, who is usually below the first page.
// The search box is declared further down, so it is located inline here.
const box = page.locator(".board-controls .filters input[type=text]")
await box.fill(stashPick.split(" ").pop())
await page.waitForTimeout(400)
t("Billy's pick comes off the ranking currently on screen",
	(await rows()).includes(stashPick), stashPick)
await box.fill("")
await page.waitForTimeout(400)
t("Billy's pick is re-derived per horizon rather than frozen",
	new Set([fortnightPick, streamPick, stashPick]).size > 1,
	`${fortnightPick} / ${streamPick} / ${stashPick}`)
const back = await horizon("This fortnight")
t("coming back to a horizon gives the same ranking it gave before",
	back.join() === fortnight.join(), `${back.slice(0, 3)} vs ${fortnight.slice(0, 3)}`)
t("every horizon left the ranking count intact", (await ranked()) === fortnightCount,
	`${await ranked()} vs ${fortnightCount}`)

/**
 * The window column reads in two units, and which one is available is a property
 * of the HORIZON — so it has to move when the horizon does, and never carry a
 * stale one across.
 *
 * It used to be "GP" for everybody: the games a player's TEAM plays, which for a
 * starting pitcher is the wrong quantity by roughly a factor of six. It now shows
 * his own scheduled starts where MLB has published his turns. MLB publishes those
 * about a week out, so on the committed fixture the fortnight has a count for 154
 * pitchers and the rest of the season has one for none of its 361 — a GS still
 * showing on Stash would be a fortnight number sitting under a season heading.
 */
const units = () =>
	page.$$eval(".board-row [data-col=games] .g-unit", n => n.map(e => e.textContent.trim()))
await horizon("This fortnight")
const fortnightUnits = await units()
t("the fortnight board reads a starter's own turns rather than his club's games",
	fortnightUnits.includes("GS"), `${fortnightUnits.slice(0, 8).join(",")}`)
await horizon("Stash")
const stashUnits = await units()
t("the rest of a season has no published turns, so every row falls back to team games",
	stashUnits.length > 0 && stashUnits.every(u => u === "GP"),
	`${stashUnits.filter(u => u === "GS").length} rows still claiming starts`)
await horizon("This fortnight")
t("and switching back brings the start counts back rather than leaving the fallback",
	(await units()).includes("GS"))
clean("across the three horizons")

// --- 4. who the ranking is FOR, then filtering on top of it --------------------

/**
 * NEW, and it is the claim the rest of this section's baseline now rests on.
 *
 * `AVAILABLE_ONLY_DEFAULT.board` flipped from false to true: the board opens on the
 * men a reader can actually add. Measured before the flip, 42 of the first 50 rows
 * of the default board were rostered in 90% or more of leagues — a recommendation
 * list whose top is unreachable is a ranking, not a recommendation.
 *
 * It is asserted as a journey claim rather than left to test/board.mjs because
 * `fortnight` and `fortnightCount` above were captured THROUGH this filter, and
 * every "the board came back unmoved" comparison below is against them. If the
 * default silently reverted, those comparisons would go on passing against a
 * different board; this is the one assertion that pins which board they mean.
 */
const availToggle = page.locator(".board-controls .toggle[data-avail] input").first()
t("the board opens on the players this reader can actually add",
	await availToggle.isChecked())
await availToggle.uncheck()
await page.waitForTimeout(400)
const everyone = await ranked()
t("and the restriction is really a restriction — unticking it widens the ranking",
	everyone > fortnightCount, `${fortnightCount} available vs ${everyone} in all`)
t("the wider board names men the opening board did not",
	(await rows()).some(n => !fortnight.includes(n)), (await rows()).slice(0, 5).join(", "))
await availToggle.check()
await page.waitForTimeout(400)
t("and reticking it gives back exactly the board the journey opened on",
	(await ranked()) === fortnightCount && (await rows()).slice(0, 10).join() === fortnight.join(),
	`${await ranked()} vs ${fortnightCount}`)

// Each control is applied on top of the last rather than in isolation: a filter
// that silently drops out when the ranking changes only shows up in combination.

const search = page.locator(".board-controls .filters input[type=text]")
const settle = () => page.waitForTimeout(400)

/**
 * THE GESTURE, because two of the controls below are no longer on screen.
 *
 * "Rank by" joined the confidence floor inside `<details class="more">`, which ships
 * SHUT — four of its six orderings are already sortable column heads, so standing
 * permanently above the ranking it was a second way to do a thing one tap away on the
 * thing itself. A `selectOption` against a control inside a shut `<details>` does not
 * fail fast: it waits thirty seconds and then reports a selector, which is how this
 * suite broke on the restructure and why the gesture is a named helper rather than an
 * inline click at each of the four sites that need it.
 *
 * IDEMPOTENT on purpose. The fold opens itself whenever one of the filters inside it
 * is narrowed (`open={narrowed.length > 0}` in Board.tsx), so a blind click on the
 * summary is a TOGGLE and would shut it again at the second call site — and it really
 * does reopen and reclose during this section: raising the confidence floor opens it,
 * and dropping the floor back to 0 closes it again underneath the sort that follows.
 */
const openMoreFilters = async () => {
	const more = page.locator(".board-controls details.more")
	if (!(await more.evaluate(d => d.open))) await more.locator("> summary").click()
	await page.waitForSelector("[data-ctl=confidence]", { state: "visible" })
}
/** Both of these live behind that fold now, so every use of them is the gesture plus
 *  the select — never the select alone. */
const rankBy = value => openMoreFilters().then(() => page.selectOption("[data-ctl=sort]", value))
const confidenceFloor = value => openMoreFilters().then(() => page.selectOption("[data-ctl=confidence]", value))

await page.click('.board-controls .chip-btn:text-is("C")')
await settle()
const catchers = await rows()
t("a position chip restricts the board to that position",
	catchers.length > 0 && (await codes()).every(c => c === "C"), (await codes()).slice(0, 5).join(","))
const catcherCount = await ranked()
t("filtering to one slot really is fewer players, not the same board",
	catcherCount > 0 && catcherCount < fortnightCount, `${fortnightCount} → ${catcherCount}`)

// a surname that is definitely on this board, so the search cannot be vacuously true
const needle = catchers[0].split(" ").pop().toLowerCase()
await search.fill(needle)
await settle()
t("searching a name narrows the board to names that contain it",
	(await rows()).length > 0 && (await rows()).every(n => n.toLowerCase().includes(needle)),
	`${needle}: ${(await rows()).join(", ")}`)
t("and the position filter survives the search",
	(await codes()).every(c => c === "C"), (await codes()).join(","))

// Re-ranking is where a stale row shows up: the sort runs over the filtered set,
// so a filter that was dropped on the way through would put strangers back.
//
// Named as a stage because the sort is behind a fold now: when this timed out it was
// reported under "the link on Today opens the ranking", the last `at` six claims
// earlier, which pointed at a screen that was fine.
at("the ranking can be re-ordered from behind More filters")
const searched = new Set(await rows())
await rankBy("bscore")
await settle()
const reranked = await bscores()
t("changing the ranking re-orders by that column",
	reranked.length > 0 && reranked.every((v, i) => i === 0 || reranked[i - 1] >= v), String(reranked.slice(0, 5)))
t("re-ranking leaves no row behind that the filters excluded",
	(await rows()).every(n => searched.has(n)) && (await codes()).every(c => c === "C"),
	(await rows()).filter(n => !searched.has(n)).join(", "))

await search.fill("")
// Back to the ranking the board opened on before comparing against what it showed
// then. Market edge can only rank players it has a price for, so the choice of
// ranking is itself a filter — leaving the sort on bscore here compares two
// different questions and the counts rightly disagree.
// The confidence floor is asserted against the bscore ranking rather than the
// default: market edge can only rank players it has a price for, and the handful
// that survives a position filter are all well-established, so every one of them
// clears the floor and the assertion below would be vacuous.
await rankBy("bscore")
await settle()
const floorless = await rows()
const floorlessConf = await confs()
t("clearing the search restores a full board rather than the searched subset",
	floorless.length > searched.size, `${floorless.length} vs ${searched.size} searched`)

// The floor is a predicate the page applies for itself, so the honest test is
// whether the board it produces is the one the numbers already on screen imply.
// A displayed 70% may be a stored 0.695, so the two rounding-ambiguous points
// are excluded rather than guessed at.
//
// That comparison is only valid while the whole filtered ranking is on screen —
// the board renders its top 120 — so it is asserted rather than assumed, and so
// is the fact that there is somebody on each side of the floor. A capture where
// every catcher cleared it would make both claims below vacuously true.
t("the whole filtered ranking is on screen, so the two sets are comparable",
	floorless.length <= 120, `${floorless.length} rendered`)
await confidenceFloor("0.7")
await settle()
const kept = new Set(await rows())
const mustStay = floorless.filter((_, i) => floorlessConf[i] >= 71)
const mustGo = floorless.filter((_, i) => floorlessConf[i] <= 69)
t("this capture has players on both sides of the floor, so the floor is doing something",
	mustStay.length > 0 && mustGo.length > 0, `${mustStay.length} above, ${mustGo.length} below`)
t("raising the confidence floor keeps exactly the players who clear it",
	mustStay.every(n => kept.has(n)), mustStay.filter(n => !kept.has(n)).join(", "))
t("and drops exactly the players who do not",
	mustGo.every(n => !kept.has(n)), mustGo.filter(n => kept.has(n)).join(", "))
t("the floor never invents a row that was not there without it",
	[...kept].every(n => floorless.includes(n)), [...kept].filter(n => !floorless.includes(n)).join(", "))
t("every remaining row's own confidence clears the floor",
	(await confs()).every(v => v >= 70), String((await confs()).slice(0, 5)))

// An empty board is a legitimate answer and has to say so — the failure mode is
// a blank panel that reads as broken data rather than as no matches.
at("a filter nobody matches empties the board and says why")
await search.fill("zzqqxxnobodyisnamedthis")
await settle()
t("a filter nobody matches empties the board and says why",
	(await page.$$(".board-row")).length === 0 &&
		/no players match these filters/i.test((await page.textContent(".board .empty")) ?? ""),
	(await page.textContent(".board .empty")) ?? "no empty state rendered")

// and the whole thing unwinds back to where it started
await search.fill("")
await confidenceFloor("0")
// bscore, because that is what the board now opens on: market edge divides by a
// "% Ros" sweep that mostly returns the game's weather line (test/ownership.mjs).
await rankBy("bscore")
await page.click('.board-controls .chip-btn:text-is("All")')
await settle()
t("clearing every filter returns the board it opened on",
	(await ranked()) === fortnightCount && (await rows()).slice(0, 10).join() === fortnight.join(),
	`${await ranked()} vs ${fortnightCount}`)
clean("after filtering, searching, re-ranking and raising the floor")

// --- 5. the team, entered on Setup and read back on Today ---------------------
//
// This section replaces the draft leg of the journey. The draft page was where a
// roster used to come from, and the integration point was "does a pick reach the
// team the trade page prices". The product now has exactly one route from "I have
// no team here" to "tell me what to do tonight", and it crosses two screens: the
// blocked card on Today sent the reader to Setup in section 2, and what he enters
// there comes back as tonight's seats. That hand-off is what is asserted here.

/**
 * The men are taken off Wire rather than written here, so the roster is real players
 * from the committed capture and the seat beside each name is one this league
 * actually has — and so the journey cannot drift out of sync with a recapture. It is
 * also the reason this harvest happens on Wire and not on Today: the ranking is the
 * only screen that still lists players, which is the restructure in one line.
 */
const mine = await page.$$eval(".board-row", r => r.slice(0, 14).map(row => ({
	name: row.querySelector(".who b")?.textContent.trim(),
	slot: row.querySelector(".who .code")?.textContent.trim()
})))

/**
 * The paste, which is the route that always works.
 *
 * Not the platform read: Yahoo answers no browser at all and answers a server when
 * it feels like it, and on 2026-09-09 it went 150 free agents → 25 → 0 → "Request
 * denied" while the page went on offering the button. A paste cannot be revoked.
 * test/paste.mjs owns what `playersInText` understands and test/trade-ui.mjs owns
 * the control; this suite uses it for the one thing neither can see, which is what
 * the SEATS it carries do on another screen.
 */
at("a pasted roster page is read into this browser")
await tab(SETUP)
await page.waitForSelector("[data-ctl=paste-roster]", { timeout: 30000 })
await page.fill("[data-ctl=paste-roster]",
	`Fantasy Baseball My Team\nPos\tPlayer\tAction\n` +
		mine.map(m => `${m.slot}\t${m.name} - ${m.slot}\tAdd/Drop`).join("\n"))
await page.click(".paste-roster button")
await page.waitForSelector(".paste-note", { timeout: 15000 })
const pasteNote = (await page.textContent(".paste-note")).trim()
t("the paste is read, and says how many men came with a seat",
	new RegExp(`Found ${mine.length} players, ${mine.length} with the seat`).test(pasteNote), pasteNote)
const team = await page.$$eval(".trade-own .who b", n => n.map(e => e.textContent.trim()))
t("every man pasted is on the team this screen prices",
	team.length === mine.length && mine.every(m => team.includes(m.name)),
	`${team.length} of ${mine.length}: ${team.join(", ")}`)
t("no id crossed over that this screen cannot resolve",
	(await page.$$(".trade-unresolved li")).length === 0,
	(await page.$$eval(".trade-unresolved li", n => n.map(e => e.textContent))).join(" | "))

/**
 * The two stores are separate on purpose and this is the one place that can tell.
 *
 * It used to read `beanemachine:draft` and `beanemachine:roster` and assert that a
 * "gone" mark landed in the first and a claim in both — the draft store no longer
 * exists. The pair that matters now is roster (WHO is mine, ids only) and lineup
 * (WHICH SEAT each man was read in, with the time of the read). They are written by
 * one action, they are read by different surfaces, and a drift in either key shows
 * up on the next screen as an empty team or a diff against nothing.
 */
const stored = await page.evaluate(() => ({
	roster: JSON.parse(localStorage.getItem("beanemachine:roster") ?? "{}"),
	lineup: JSON.parse(localStorage.getItem("beanemachine:lineup") ?? "{}")
}))
const leagueKey = Object.keys(stored.roster)[0]
t("the paste wrote both stores under one league key — the ids, and the seats",
	stored.roster[leagueKey]?.length === mine.length &&
		stored.lineup[leagueKey]?.spots?.length === mine.length &&
		typeof stored.lineup[leagueKey]?.at === "string",
	JSON.stringify({ roster: stored.roster[leagueKey]?.length, lineup: stored.lineup[leagueKey]?.spots?.length }))

/**
 * THE SEATING BUG, asserted on the exact value that was wrong.
 *
 * `legalSlotsFor` decides whether a man may sit in a seat by comparing his stored
 * `positions` against the league's own `slot_accepts` lists, and those lists are
 * written in SLOT names: this league accepts C, 1B, 2B, 3B, SS, OF into the seats of
 * the same name, {C,1B,2B,3B,SS,OF} into Util, and {SP,RP} into P. The paste's
 * fallback stored MLB's RAW POSITION instead — "CF", "LF", "P" — and not one of those
 * three tokens appears in any accepts list, so they matched nothing. The league's own
 * eligibility grid, which would have covered for it, holds only 328 of 1,446 players.
 * Measured on a pasted 23-man roster: ONE seat filled out of eighteen, 16.41 projected.
 * With `slotsFor` from src/engine/bscore.ts applied in `rosterFromPaste` it was 3 seats
 * and 31.92.
 *
 * Two things about how this is asserted, both learned the hard way on this journey.
 *
 * It is asserted on the STORED POSITIONS rather than on the projected total, because
 * the total cannot fail: the first draft of this claim was `total > 20` — the bug's
 * 16.41 against the fix's 31.92 — and on this journey's fourteen men the card projects
 * 1472.91. Seventy-three times clear of the line is not a test, and it would have
 * passed with thirteen of the fourteen men unseated.
 *
 * Nor is it asserted on how many seats the roster fills, which is the quantity the fix
 * was reported in but is not a property of the fix: five of eighteen here, because
 * these fourteen men came off the TOP of a board already filtered to players nobody
 * has, and at most slots the wire's replacement bar legitimately beats them. A planner
 * preferring a better man is not a seating failure, so counting seats would make this
 * claim fail on a recapture that moved the bar.
 *
 * What IS a property of the fix, and is false in exactly the broken case, is that every
 * token the paste wrote is one this league's seats can accept. The accepts lists are
 * read out of the stored config rather than written here, so the claim cannot drift
 * from the league the app is actually using.
 */
const seatVocabulary = await page.evaluate(() => {
	const cfg = JSON.parse(localStorage.getItem("beanemachine:config") ?? "{}")
	const league = Object.values(cfg.leagues ?? {})[0]
	const accepts = league?.roster?.slot_accepts ?? {}
	/*
	 * Two ways a token earns a seat, and the second one is not redundant.
	 *
	 * A seat's accepts list names eligibility POSITIONS — Util's is every batter
	 * position this league rosters — and the seat's own NAME is the other claim:
	 * a designated hitter has no fielding position to be accepted by, so `slotsFor`
	 * gives him "Util" and nothing else, and Util is not in Util's own accepts list.
	 * This assertion's first version read only the accepts lists and therefore called
	 * Josh Bell unseatable while the app seated him perfectly — the test's model of
	 * the rule had drifted from `legalSlotsFor`, which is where the rule lives.
	 */
	return [
		...new Set([
			...Object.values(accepts).flatMap(a => (Array.isArray(a) ? a : [])),
			...Object.keys(accepts)
		])
	]
})
/**
 * AT LEAST ONE accepted token per man, not every token accepted, and the difference
 * is load-bearing rather than pedantry.
 *
 * `legalSlotsFor` keeps a seat if ANY of the man's tokens appears in that seat's
 * accepts list, so a redundant token costs nothing — and `slotsFor` emits two of them
 * on purpose: "Util" beside a bat's real position and "P" beside SP or RP, so that a
 * caller reading the list as "seats he could sit in" gets the right answer. Neither
 * string appears in any accepts list in this league (Util accepts C/1B/2B/3B/SS/OF; P
 * accepts SP/RP), so a first draft of this assertion demanding every token be accepted
 * failed on "Util,P" while the seating was working perfectly.
 *
 * What the bug did was leave a man with NO accepted token at all: "CF" alone. That is
 * the claim, made per man so one well-formed spot cannot cover for thirteen broken
 * ones. "P" alone is fine — P is a seat, and naming a seat is the strongest claim
 * there is that you can sit in it.
 */
const unseatableMen = (stored.lineup[leagueKey]?.spots ?? [])
	.filter(sp => !(sp.positions ?? []).some(p => seatVocabulary.includes(p)))
	.map(sp => `${sp.name} [${(sp.positions ?? []).join("/") || "no positions at all"}]`)
t("this league's seats accept a vocabulary worth checking against",
	seatVocabulary.length >= 6, seatVocabulary.join(","))
t("every man the paste stored can legally sit somewhere — none was written in MLB's own positions",
	(stored.lineup[leagueKey]?.spots ?? []).length === mine.length && unseatableMen.length === 0,
	unseatableMen.join(" | "))
/**
 * And the consequence, because a stored token is only worth checking if it reaches a
 * seat: an outfielder's raw MLB position is CF, LF or RF and none of the three is
 * accepted anywhere, so an OF seat holding a man off this roster is a thing the broken
 * fallback could not produce. The slot is read off the lineup card's own rows.
 */
const ownSeats = await page.$$eval(".lineup-row.roster", n =>
	n.map(r => r.querySelector(".code")?.textContent.trim()))
const spotsLine = (await page.textContent(".lineup-unit")).replace(/\s+/g, " ").trim()
const lineupTotalAfterPaste = num(await page.textContent(".lineup-total"))
// Printed on a pass as well as a failure: this is the measurement the seating fix was
// reported in, and a count nobody can see is a count that can rot quietly.
console.log(`      measured: ${mine.length} men pasted, ${spotsLine}, ${lineupTotalAfterPaste} projected`)
t("and those seats are really filled — including one no raw MLB position can reach",
	ownSeats.length > 1 && ownSeats.includes("OF") && lineupTotalAfterPaste > 0,
	`seats off this roster: ${ownSeats.join(",") || "none"} — ${spotsLine}`)

// --- 6. the payoff: the seats entered on Setup are tonight's instructions ------

at("the card on Today stops being blocked once it has a team")
await tab(TODAY)
await onToday()
await page.waitForSelector(".decide:not(.decide-blocked)", { timeout: 30000 })
await page.waitForSelector(".decide-read", { timeout: 30000 })
const decide = () => page.$eval(".decide", e => e.textContent.replace(/\s+/g, " "))
t("the card the journey started blocked on now plans a lineup",
	(await page.$$(".decide.decide-blocked")).length === 0 && /What should I do\?/.test(await decide()))

/**
 * NEW, and it is the claim that could not be made before at all: the reasons on this
 * card are facts about TONIGHT, read live from MLB, not artifacts of a capture.
 *
 * The committed snapshot is stamped 2026-09-08 and its slate ends there, so before
 * `src/data/today.ts` existed this card believed clubs were idle that were playing.
 * The game count in the heading can only come from the live read — a two-day-old
 * capture cannot produce tonight's number — so it is the cheapest proof that the
 * read happened and reached the render.
 */
const todayHead = (await page.textContent(".decide-head")).replace(/\s+/g, " ")
const games = Number((todayHead.match(/(\d+) games today/) ?? [])[1])
t("the card's own heading counts tonight's games, which only a live read knows",
	Number.isFinite(games) && games >= 0 && /games today/.test(todayHead), todayHead)

/**
 * Grouped by REASON, one row per reason — not one row per man.
 *
 * Measured on a real 27-man roster on a five-game night: sixteen consecutive rows
 * reading "Bench X — he is not projected to play today", identical but for the name,
 * standing above the two moves that were the point of the card. Sixteen rows of one
 * sentence is not sixteen decisions.
 *
 * The invariant is that no reason appears twice, which is what "grouped" means and
 * what a regression to a row per man would break. Whether this particular night
 * exercises the grouping — more men benched than reasons to bench them — is asserted
 * SEPARATELY, so a night that happens to give every man his own reason fails a claim
 * that says so instead of quietly making the one above vacuous.
 */
const benchGroups = await page.$$eval(".decide-bench-group", rows => rows.map(r => ({
	why: r.querySelector(".decide-why")?.textContent.trim(),
	men: [...r.querySelectorAll("b")].map(b => b.textContent.trim())
})))
t("some of the pasted seats are wrong for tonight, so there is a diff to group",
	benchGroups.length > 0, `${benchGroups.length} bench rows`)
t("every bench row is a different reason — one row per reason, never one per man",
	new Set(benchGroups.map(g => g.why)).size === benchGroups.length,
	benchGroups.map(g => g.why).join(" | "))
t("and this night really does put several men behind one reason",
	benchGroups.reduce((n, g) => n + g.men.length, 0) > benchGroups.length,
	`${benchGroups.reduce((n, g) => n + g.men.length, 0)} men in ${benchGroups.length} rows`)
/**
 * The reasons themselves. "he is not projected to play today" was printed about
 * Roman Anthony on 2026-09-08 — a man rateable at 4.14 points with Boston playing,
 * who had simply been outranked for the last outfield seat. A ranking reported as a
 * fact about the schedule is a claim the code cannot support, and a reader who checks
 * it finds the app wrong about something he can see on his phone. So the blanket
 * sentence is gone, and at least one row has to be carrying a fact only the live read
 * can know.
 */
const LIVE_FACTS = ["no game today", "not in today's lineup"]
t("no row dresses a ranking up as a fact about the schedule",
	!benchGroups.some(g => /not projected to play today/.test(g.why)),
	benchGroups.map(g => g.why).join(" | "))
t("at least one reason is tonight's card or tonight's lineup, not the capture",
	benchGroups.some(g => LIVE_FACTS.includes(g.why)), benchGroups.map(g => g.why).join(" | "))

/**
 * The baseline line, and it is the one sentence on the card that changes what the
 * reader should do with everything above it.
 *
 * It used to read "Compared against your seats as read N hours ago. Change your
 * lineup in Yahoo since then and this list is against the old one." — the second
 * sentence restating the first for anyone who had already understood it. One clause
 * now. The age still has to be IN it: a diff against a stale baseline that does not
 * say it is stale is silently authoritative, which is the failure this line exists
 * to prevent.
 *
 * And it is a journey claim, not a Decide claim, because the read it dates happened
 * on the OTHER SCREEN: the `at` stamp this sentence renders was written by the paste
 * on Setup a moment ago, so "in the last hour" is the two screens agreeing.
 */
const readLine = (await page.textContent(".decide-read")).replace(/\s+/g, " ").trim()
t("the diff dates itself against the read that happened on the other screen",
	/^vs your seats as read (in the last hour|\d+ hours? ago|\d+ days? ago)$/.test(readLine), readLine)
t("and it no longer repeats itself about changing your lineup in Yahoo",
	!/Change your lineup/i.test(readLine), readLine)

/**
 * The fine print that used to be body copy.
 *
 * Four sentences sat under the moves — what the gain is denominated in, that every
 * man leaving is under the keep floor, that none is worth holding for the season,
 * and how the ownership cut was drawn. All true; none of it changes a tap. It is one
 * clause plus a disclosure now, and the disclosure is asserted to be CLOSED, because
 * a `<details>` that ships open is the paragraph again with a triangle on it.
 */
/**
 * Two of these, and which ones are on screen depends on the night — the moves
 * paragraph only renders where a move cleared the bar, and the innings line only
 * where the league sets an innings floor. So the assertion is over whichever
 * disclosures DID render: every one is shut, and each is one of the two known
 * titles rather than a new paragraph that has grown a triangle.
 *
 * Found by title rather than by position: taking `.first()` here read "why not the
 * whole week" on a night where no move cleared the bar, and then reported the
 * innings caveat as if it were the moves fine print.
 */
const fines = await page.$$eval(".decide .decide-fine", ds => ds.map(d => ({
	title: d.querySelector("summary")?.textContent.trim(),
	open: d.open,
	words: d.textContent.trim().split(/\s+/).length
})))
const FINE_TITLES = ["what these numbers are", "why not the whole week"]
t("the card's fine print is in disclosures, all of them shut",
	fines.length > 0 && fines.every(f => FINE_TITLES.includes(f.title) && !f.open),
	fines.map(f => `${f.title}${f.open ? " (OPEN)" : ""}`).join(" | ") || "no disclosure rendered at all")
// The body it came out of is the thing being protected: four sentences of it under the
// moves, and a four-sentence innings caveat. A disclosure is only a win while the
// paragraph is inside it, so the card outside the folds is asserted to be short.
const spoken = (await decide()).length
const folded = fines.reduce((n, f) => n + f.words, 0)
t("and the paragraphs really are inside them rather than beside them",
	folded > 40 && spoken > 0, `${folded} words folded away, card is ${spoken} chars`)

/**
 * NEW, and the only assertion in this file about a section that did not exist: the
 * seats nobody you own can fill.
 *
 * An unused slot is the largest measured lever in a points-league season — it scores
 * zero, about seven points a night below what a warm body scores — and it used to be
 * a line inside the seat-by-seat fold reading "leave empty". `fillTonight` names the
 * best gettable man who is actually ON A CARD tonight for each such seat, which is
 * the pair of conditions that makes the advice real: a free agent who is not playing
 * fills an empty seat with the same zero.
 *
 * Whether this night HAS an empty seat depends on the slate and on which fourteen men
 * the board handed this journey, so the section is asserted conditionally and the
 * condition is reported rather than hidden — a night with no empty seat is a pass that
 * says it tested nothing, not a green tick over a missing feature. What cannot be
 * conditional is the invariant: every man named here is somebody ELSE, because naming
 * a man the reader already owns would be telling him to add his own player.
 */
const fill = await page.$$eval(".decide-fill li", n => n.map(li => ({
	slot: li.querySelector(".decide-slot")?.textContent.trim(),
	name: li.querySelector("b")?.textContent.trim()
})))
if (fill.length) {
	t("every empty seat is offered a man who is gettable, not one already on the team",
		fill.every(f => !mine.some(m => m.name === f.name)),
		fill.filter(f => mine.some(m => m.name === f.name)).map(f => f.name).join(", "))
	t("and each one names the seat it would fill",
		fill.every(f => f.slot && f.slot.length > 0), JSON.stringify(fill))
} else
	t("this night left no seat for the Empty seats section to fill (nothing exercised)", true,
		"no .decide-fill rows — the fourteen men off the board covered every slot, or nobody gettable plays tonight")
clean("after the roster hand-off, on the card that uses it")

// --- 7. what is the same under all three screens ------------------------------

/**
 * NEW, and cross-surface by construction: the colophon renders under EVERY screen, so
 * it is the one piece of the page no single-surface suite sees three times.
 *
 * It was four paragraphs and 277 words of backtest results — folds, Spearman rho,
 * z-scores, and a line saying market edge is known broken — under each of them.
 * Measured on the first screen a new visitor sees, it was 67% of the words on the
 * page, and it had also drifted: it quoted "48 of 50 hitting folds" from a
 * configuration this app no longer ships. One sentence now, with the results behind
 * a link to docs/METHODOLOGY.md, which is where they can be kept true.
 */
const colophon = async () => ({
	links: await page.$$eval(".colophon .links a", n => n.map(a => a.textContent.trim())),
	note: (await page.textContent(".colophon .tiny-note")).replace(/\s+/g, " ").trim(),
	methodology: (await page.$$eval(".colophon .links a", n => n.map(a => a.getAttribute("href")))).some(h =>
		/METHODOLOGY\.md$/.test(h ?? ""))
})
const onTodayFooter = await colophon()
t("the footer is three links and one sentence, not a statistics essay",
	onTodayFooter.links.length === 3 && onTodayFooter.note.split(/\s+/).length < 60 &&
		!/Spearman|fold|z[- ]score|p-value/i.test(onTodayFooter.note),
	`${onTodayFooter.links.length} links, ${onTodayFooter.note.split(/\s+/).length} words: ${onTodayFooter.note}`)
t("the one sentence is the one a decision depends on — a bscore is not a forecast",
	/ranking, not a forecast/i.test(onTodayFooter.note), onTodayFooter.note)
t("and the results it no longer prints are linked rather than dropped",
	onTodayFooter.methodology, onTodayFooter.links.join(" | "))

at("the ranking comes back unmoved after the detour through Setup and Today")
await tab(WIRE)
await onWire()
const onWireFooter = await colophon()
/**
 * Nothing was edited, so Wire must be the board it was. It is a stronger claim than
 * it looks: Board unmounts when another screen is on, so this is the ranking being
 * REBUILT from the league and the capture and landing on the same 1,200-odd players
 * in the same order — after a paste wrote two stores and a league editor was on
 * screen. A roster that leaked into the ranking's availability basis, or a mode left
 * behind in `beanemachine:view`, would both show up right here.
 */
t("the ranking is the ranking it was before the team was entered",
	(await ranked()) === fortnightCount && (await rows()).slice(0, 10).join() === fortnight.join(),
	`${await ranked()} vs ${fortnightCount}`)
t("and the same footer is under Wire, rather than a second wording of it",
	onWireFooter.note === onTodayFooter.note, `${onWireFooter.note}\n  vs\n  ${onTodayFooter.note}`)

at("Setup shows the same footer too")
await tab(SETUP)
await onSetup()
const onSetupFooter = await colophon()
t("and under Setup, which is where two tabs' worth of footers could have disagreed",
	onSetupFooter.note === onTodayFooter.note, `${onSetupFooter.note}\n  vs\n  ${onTodayFooter.note}`)
clean("across all three screens")

// --- 8. a trade, priced ------------------------------------------------------

at("a player can be added to the team by hand and priced")
await page.fill("[data-ctl=own-search]", "a")
await page.waitForSelector('.trade-results .trade-line button:text-is("Add")', { timeout: 15000 })
const byHand = await page.$eval(".trade-results .trade-line .who b", e => e.textContent.trim())
await page.locator('.trade-results .trade-line button:text-is("Add")').first().click()
await page.waitForFunction(
	n => document.querySelectorAll(".trade-own").length === n,
	mine.length + 1, { timeout: 15000 }
)
// `mine.length` came off the ranking on Wire and through a paste two screens ago;
// this is still the same team, one man bigger.
t("a man added by hand joins the pasted team rather than replacing it",
	(await page.$$(".trade-own")).length === mine.length + 1,
	`${(await page.$$(".trade-own")).length} vs ${mine.length + 1}`)
const lineupTotal = num(await page.textContent(".lineup-total"))
t("the team produces a real lineup total", Number.isFinite(lineupTotal) && lineupTotal > 0, String(lineupTotal))

/*
 * This league's trade window shut on 2026-08-06, so the deal form is retired behind
 * a disclosure — see `tradesClosed`. The journey opens it deliberately: the point of
 * this section is that the EVALUATOR still prices a deal correctly, and the separate
 * claim that a closed league is not offered the form is asserted in test/trade-ui.mjs
 * rather than a second time here.
 */
at("offering a player produces a verdict")
const priceAnyway = page.locator(".trade-closed button:text-is('Price one anyway')")
if (await priceAnyway.count()) {
	await priceAnyway.click()
	await page.waitForSelector(".deal", { timeout: 15000 })
}
await page.locator(".deal-side .picks .chip-btn").first().click()
await page.waitForSelector(".trade-verdict", { timeout: 15000 })
await page.fill("[data-ctl=get-search]", "a")
await page.waitForSelector('.trade-results .trade-line button:text-is("Get")', { timeout: 15000 })
const arriving = await page.$eval('.trade-results .trade-line .who b', e => e.textContent.trim())
await page.locator('.trade-results .trade-line button:text-is("Get")').first().click()
await page.waitForTimeout(300)
const before = num(await page.textContent(".verdict-before"))
const after = num(await page.textContent(".verdict-after"))
const delta = num(await page.textContent(".verdict-delta"))
t("the delta is exactly after minus before", Math.abs(delta - (after - before)) < 0.15,
	`${delta} vs ${after} − ${before}`)
t("before is the lineup total this screen was already showing",
	Math.abs(before - lineupTotal) < 0.15, `${before} vs ${lineupTotal}`)
t("the verdict names the player arriving",
	((await page.textContent(".verdict-why")) ?? "").includes(arriving.split(" ").pop()), arriving)
clean("after pricing a trade")

// --- 9. a reload, and what survives it ---------------------------------------
//
// Everything above lives in this browser rather than on a server, so a reload is
// the only thing that proves it was ever written. A half-built offer is the one
// thing that must NOT survive: it was never stored, and an offer that reappeared
// would be one nobody made.
//
// A reload also lands on Today rather than on the screen the reader was standing on
// — `view` is React state and only the HORIZON is persisted — so the order of the
// three checks below follows the reload, not the journey: Today, then Wire, then
// Setup.

const teamBefore = await page.$$eval(".trade-own .who b", n => n.map(e => e.textContent.trim()).sort())
at("a reload lands back on the screen a visit starts on")
await page.reload({ waitUntil: "domcontentloaded" })
await onToday()
t("a reload lands back on Today", (await current()) === TODAY, await current())

/**
 * Rewritten from "the draft board survived the reload, and now counts the man added
 * on the trade page". That assertion protected one property: a roster written on one
 * surface is the SAME roster every other surface reads, with nothing translating
 * between keys, and it still holds after the store is the only copy left.
 *
 * The draft tally is gone, so the card that plans tonight's lineup takes its place —
 * and it carries the stronger half of the claim, because it reads BOTH stores. The
 * seats it diffs against were written by a paste on Setup before the reload, and
 * the ids were written twice (paste, then one add by hand).
 */
at("Today still plans the lineup that was read before the reload")
await page.waitForSelector(".decide:not(.decide-blocked)", { timeout: 30000 })
await page.waitForSelector(".decide-read", { timeout: 30000 })
t("the seats read on the other screen survived the reload, and are still dated",
	/^vs your seats as read /.test((await page.textContent(".decide-read")).replace(/\s+/g, " ").trim()),
	(await page.textContent(".decide-read")).replace(/\s+/g, " ").trim())
/**
 * And the honest edge of it, stated rather than assumed.
 *
 * The card accounts for exactly the seats that were READ — every starter it names
 * plus every man it benches — and the man added by hand on Setup is in the roster
 * store but in nobody's seat, so he is not among them. That is the truthful answer
 * rather than a bug in this assertion: no seat was ever read for him and inventing
 * one would be the card claiming a baseline it does not have. It is asserted so that
 * a future change which DOES seat him has to come past this line and say so.
 *
 * `.decide-fill` is deliberately NOT one of the lists read here. It names men the
 * reader does not own — the gettable bodies for seats nobody he owns can fill — so
 * folding it in would make "accounts for every seat the paste carried" pass on
 * strangers.
 */
const seated = await page.$$eval(".decide", cards => {
	const card = cards[0]
	const starters = [...card.querySelectorAll(".decide-today li:not(.decide-empty) b")].map(b => b.textContent.trim())
	const benched = [...card.querySelectorAll(".decide-bench-group b")].map(b => b.textContent.trim())
	const moved = [...card.querySelectorAll(".decide-changes li:not(.decide-bench-group) b")].map(b => b.textContent.trim())
	return [...new Set([...starters, ...benched, ...moved])]
})
t("the card accounts for every seat the paste carried, and invents none",
	seated.length === mine.length && mine.every(m => seated.includes(m.name)),
	`${seated.length} of ${mine.length}: ${mine.filter(m => !seated.includes(m.name)).map(m => m.name).join(", ")}`)
t("the man added by hand has no seat, so the card does not pretend to know one",
	!seated.includes(byHand), `${byHand} appears in the lineup plan`)

at("Wire still opens after the reload")
await tab(WIRE)
await onWire()
/** The horizon is the one thing about a screen that IS persisted (`beanemachine:view`),
 *  which is why the last mode this journey selected, back in section 4, had to be the
 *  one it captured its baseline on. A ranking that came back on Streaming here would
 *  be this suite's own leftover, not a defect. */
t("and on the ranking it opened on", (await ranked()) === fortnightCount, `${await ranked()} vs ${fortnightCount}`)
t("with a working board under it", (await rows()).length > 50)

at("Setup still opens after the reload")
await tab(SETUP)
await onSetup()
t("the team survived the reload",
	(await page.$$eval(".trade-own .who b", n => n.map(e => e.textContent.trim()).sort())).join() === teamBefore.join(),
	teamBefore.join(", "))
t("the half-built offer did not", (await page.$$(".trade-verdict")).length === 0)
t("nothing stored has become an id the capture cannot resolve",
	(await page.$$(".trade-unresolved li")).length === 0,
	(await page.$$eval(".trade-unresolved li", n => n.map(e => e.textContent))).join(" | "))
clean("after the reload")

// --- 10. leave the browser as it was found -----------------------------------

await page.evaluate(keys => keys.forEach(k => localStorage.removeItem(k)), KEYS)
const left = await page.evaluate(keys => keys.filter(k => localStorage.getItem(k) !== null), KEYS)
t("the journey leaves nothing behind for the next suite", left.length === 0, left.join(", "))
clean("over the whole journey")

await browser.close()
if (foreign.length)
	console.log(`\nset aside, not asserted on — ${foreign.length} console error(s) about a resource this app does not host:` +
		[...new Set(foreign)].map(l => `\n  ${l}`).join(""))
console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
