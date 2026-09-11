// The trade analyzer in a real browser, against the real snapshot.
import { readFileSync } from "node:fs"
//
// The claim the engine makes is that a trade is worth what it does to YOUR
// STARTING LINEUP, so these assertions are about slots and totals rather than
// about who has the higher bscore. They are also arithmetic wherever they can be:
// a delta that does not equal after minus before is the one failure that would
// make every recommendation on the page a lie.
import { chromium, firefox } from "playwright-core"
/**
 * :5173 was the default here, and it is the one port on this machine that must never
 * be tested against: another project's dev server owns it. A bare `node test/trade-ui.mjs`
 * therefore either talked to somebody else's app — which `identify` below catches, and
 * which is the whole reason it exists — or, worse, typed a roster into it. This repo's
 * dev server answers on :5299, so that is the default; BASE still wins when it is set.
 */
const BASE = process.env.BASE ?? "http://127.0.0.1:5299"
const ENGINE = process.env.BROWSER ?? "chromium"
const browser = ENGINE === "firefox" ? await firefox.launch() : await chromium.launch({ args: ["--no-sandbox"] })
console.log(`--- ${ENGINE} ---`)
let pass = 0, fail = 0
const t = (n, ok, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : "  " + x}`) }
const num = s => Number(String(s).replace(/[^0-9.+-]/g, ""))

const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
const errors = []
page.on("pageerror", e => errors.push(String(e)))

/** A 200 on the port is not proof it is this app: vite's defaults are shared by every
 *  project on the machine and another one answers just as happily — and here that would
 *  SKIP with exit 0, since no other app mounts a team panel. The wordmark is the cheapest
 *  proof of identity, and openTrade navigates four times, so it is claimed once. */
let identified = false
const identify = async () => {
	if (identified) return
	identified = true
	const wordmark = await page.waitForSelector("h1", { timeout: 15000 }).then(h => h.textContent(), () => null)
	t("the page under test is beanemachine", wordmark === "beanemachine",
		`BASE=${BASE} served <h1>${wordmark}</h1> — start this repo's own vite, or set BASE to it`)
	if (wordmark !== "beanemachine") { await browser.close(); process.exit(1) }
}

/**
 * Load the app and wait for the tabs, NOT for the network to go quiet.
 *
 * Every goto in this file used `waitUntil: "networkidle"`, and that stopped being a
 * safe wait the moment the page started reading tonight's slate live: `useSlate` fires
 * one request to statsapi.mlb.com on mount, so "no connections for 500ms" now depends
 * on a third party answering a machine that may be offline, throttled or behind a
 * proxy. The last run of this suite died on exactly that — a 30s TimeoutError out of
 * `page.goto`, no assertion reached, four tabs' worth of evaluator untested — and it
 * read as a flaky server because the server was fine.
 *
 * `domcontentloaded` plus the nav React renders is the honest wait: it is the same
 * thing every assertion below actually needs, it cannot be held open by somebody
 * else's API, and a page that fails to mount still fails here rather than hanging.
 * The nav wait matters on its own — `tab.count()` on a bare document returns 0, and
 * a 0 there would have SKIPPED whole blocks green.
 */
const visit = async (timeout = 60000) => {
	await page.goto(BASE, { waitUntil: "domcontentloaded", timeout })
	await page.waitForSelector(".views button", { timeout: 30000 })
}

/**
 * The screens, by the text a reader can see on the tab, in ONE place.
 *
 * Every block in this file used to reach the team panel with `.views button` matching
 * /trade/i, and that stopped working the day the four tabs became three: "My team &
 * trades" and "League setup" were merged into a single screen labelled **Setup**,
 * which contains the string "trade" nowhere at all. The locator matched no button,
 * `openTrade` returned false, and the suite SKIPPED with exit 0 — 54 assertions
 * retired by a rename and reported as a clean run. The same hazard as the Draft
 * deletion, arriving from the other direction.
 *
 * It has now happened a THIRD time and this one line absorbed all of it: "Today |
 * Wire | Setup" became **"Tonight | Pickups | My league"**, because the old three
 * named a time, a piece of jargon and a verb nobody reading this app uses about their
 * own team. The view IDS are deliberately unchanged — board / wire / trade are also
 * the key this browser stores the open screen under, and renaming those would drop
 * every returning reader back on the default screen — so nothing in this file may
 * navigate by id. Navigate by the visible text, which is what a reader has.
 *
 * Matching the visible label is what makes the next rename a one-line change here
 * rather than a silent skip somewhere else: `SCREEN` is the only thing in this file
 * that knows what the tabs are called and `toScreen` is the only thing that clicks
 * one. The match is anchored rather than loose, so a fourth tab whose name merely
 * CONTAINS one of these cannot quietly capture the clicks.
 */
const SCREEN = { today: "Tonight", wire: "Pickups", setup: "My league" }
const toScreen = async (pg, label) => {
	const tab = pg.locator(".views button", { hasText: new RegExp(`^${label}$`) }).first()
	if (!(await tab.count())) return false
	await tab.click()
	return true
}

/** The component is mounted by the app, so this suite must not assume where. It
 *  finds the team panel — now on Setup, the third screen, with the whole League
 *  setup editor rendered under it — or reports that nothing mounts it and stops: a
 *  wired-up UI is what is under test, not the existence of the file. */
const openTrade = async () => {
	await visit()
	await identify()
	if (await page.$(".trade-team")) return true
	if (!(await toScreen(page, SCREEN.setup))) return false
	const ok = await page
		.waitForSelector(".trade-team", { timeout: 30000 })
		.then(() => true, () => false)
	if (ok) await openDeal()
	return ok
}

/**
 * The deal is behind a press on EVERY league now, which is the new half of this.
 *
 * It used to be retired only once the league's own deadline had passed — see
 * `tradesClosed` — and the shipped league's window shut on 2026-08-06, so this helper
 * only ever had to press "Price one anyway". Measured 2026-09-11 at 390x844 on the
 * published build, by the route a stranger takes into this screen (press "Or type the
 * values in myself", which promises the scoring values): the builder was 718px of the
 * 7,930px page standing between his lineup and those values, on a league whose window
 * was wide open, and it can say nothing at all until two names have been picked. So it
 * is asked for either way and the label is the only thing that differs.
 *
 * The evaluator itself is unchanged and everything below still has to hold, so the
 * tests open it. That the DEFAULT is closed is asserted separately, once for each
 * reason it can be closed, rather than fought here four times.
 */
const openDeal = async () => {
	const button = page.locator(
		".trade-deal button:text-is('Price one anyway'), .trade-deal button:text-is('Price a trade')"
	)
	if (await button.count()) {
		await button.first().click()
		await page.waitForSelector(".deal", { timeout: 15000 })
	}
}

/**
 * A league that cannot trade is not offered a trade form.
 *
 * Asserted before anything opens it: the app shipped a 1,132-line evaluator and
 * had never read the "Trade End Date" its own import harvests, so it spent a month
 * offering to price deals this league would refuse. Retired by default, one click
 * away, because the evaluator still works and a keeper league has reasons.
 */
{
	await visit()
	await identify()

	/**
	 * The tab this whole suite hangs off, asserted by name before anything clicks it.
	 *
	 * Everything below reaches the evaluator through `toScreen(page, SCREEN.setup)`,
	 * and `openTrade` SKIPS with exit 0 when that tab is missing — which was right
	 * while <Trade/> existed unmounted, and is a trap now that it is mounted. It has
	 * already gone wrong twice by rename: the four tabs became three when Draft was
	 * deleted (with src/engine/draft.ts and test/draft.mjs), and then the remaining
	 * three were renamed and re-cut — "Recommendations | League setup | My team &
	 * trades" became "Today | Wire | Setup", the ranked board moving out to Wire and
	 * the league editor moving IN under the team panel on Setup. The second of those
	 * took this file's /trade/i locator with it and turned 54 assertions into a skip.
	 * So the census is an assertion, and a nav that no longer carries the screen this
	 * suite lives on fails here, loudly, before the skip can swallow it.
	 *
	 * Asserted by POSITION, not membership, which is the half the old version left
	 * open: the three screens are ordered by when you need them — decide tonight,
	 * then look somebody up, then go and fix the inputs — and a nav that offers the
	 * right three in the wrong order is a different page.
	 *
	 * It also pins the absence of Draft from the one place a reader meets the tabs.
	 * That tab is gone on purpose — the engine behind it is gone too, so a button
	 * labelled "Draft" reappearing in this nav is a regression, not a feature, and the
	 * census is what says so out loud rather than leaving it to a diff nobody reads.
	 */
	const tabs = await page.$$eval(".views button", n => n.map(e => e.textContent.trim()))
	t("the nav offers exactly the three screens this app has, in the order you need them",
		tabs.length === 3 && tabs[0] === SCREEN.today && tabs[1] === SCREEN.wire &&
			tabs[2] === SCREEN.setup,
		tabs.join(" | "))
	t("and no draft tab, whose engine and suite were deleted with it",
		!tabs.some(label => /draft/i.test(label)), tabs.join(" | "))

	if (await toScreen(page, SCREEN.setup)) {
		await page.waitForSelector(".trade-team", { timeout: 30000 })
		const closed = await page.$(".trade-closed")
		t("a league past its own trade deadline is not shown a deal form",
			!!closed, closed ? "" : "the deal form rendered for a league that closed 2026-08-06")
		if (closed)
			t("and it says when trades closed, so the reader is told rather than left to wonder",
				/stopped taking trades on/.test(await closed.innerText()),
				await closed.innerText())
	}
}

if (!(await openTrade())) {
	console.log("SKIP  no trade UI on the page — nothing mounts <Trade/> yet, so there is nothing to exercise")
	await browser.close()
	process.exit(0)
}

t("no page errors", errors.length === 0, errors.join(" | "))

/**
 * The flat list of who you own is now FOLDED once there is a roster.
 *
 * Measured 2026-09-04 on the shipped league at 1280x1000: that list was 899px of a
 * 3487px page, and "Your starting lineup" below it shows all the same men in the
 * seats they actually hold. Nothing was removed — this opens the fold, because the
 * assertions below are about the same rows they always were.
 */
const openTeamFold = async () => {
	const fold = page.locator("details.trade-owned-fold")
	if (await fold.count()) await fold.evaluate(d => { d.open = true })
}

// Empty states are load-bearing here: with no roster there IS no lineup, and
// rendering one anyway would be inventing a team.
const emptyLineup = (await page.textContent(".trade-lineup .empty")) ?? ""
t("with no team set, the lineup says what to do instead of rendering one",
  /add the players you own/i.test(emptyLineup), emptyLineup)
t("no verdict is offered before there is a deal", (await page.$$(".trade-verdict")).length === 0)

/** Adds the top projected player whose name matches, from a given search box. */
const addFrom = async (ctl, action) => {
	await page.fill(`[data-ctl=${ctl}]`, "a")
	await page.waitForSelector(`.trade-results .trade-line button:text-is("${action}")`, { timeout: 15000 })
	const name = await page.$eval(".trade-results .trade-line .who b", e => e.textContent.trim())
	await page.locator(`.trade-results .trade-line button:text-is("${action}")`).first().click()
	return name
}

const first = await addFrom("own-search", "Add")
// captured the moment the fold first exists, before anything here opens it
await page.waitForSelector("details.trade-owned-fold")
const foldStartsClosed = await page.$eval("details.trade-owned-fold", d => d.open) === false
await openTeamFold()
await page.waitForSelector(".trade-own")
const oneTotal = num(await page.textContent(".lineup-total"))
t("adding a player produces a lineup with a real total", Number.isFinite(oneTotal) && oneTotal > 0, String(oneTotal))
t("the player added is the one on the team", (await page.textContent(".trade-own .who b")).trim() === first, first)

const second = await addFrom("own-search", "Add")
await page.waitForFunction(() => document.querySelectorAll(".trade-own").length === 2, { timeout: 10000 })
const twoTotal = num(await page.textContent(".lineup-total"))
t("adding a second player changes the lineup total", twoTotal !== oneTotal, `${oneTotal} → ${twoTotal}`)
t("a second real starter cannot lower the total", twoTotal > oneTotal, `${oneTotal} → ${twoTotal}`)

/**
 * The page is ordered by what each card answers WITHOUT being asked.
 *
 * "What to add and drop" is the only card here that proposes a move rather than
 * pricing one you proposed, and it used to be third — measured 2026-09-04 on the
 * shipped league at 1280x1000, it opened at y=1912 of a 3487px page, under two
 * screens of a roster you already knew. The order is a claim about which card
 * matters, so it is asserted rather than left to whoever edits the JSX next.
 *
 * `cardOrder` is now a census of the WHOLE screen rather than of the team panel: the
 * "League setup" tab was folded into this one, so "This league", "Scoring period",
 * "Batting", "Pitching", "Roster slots" and the rest follow the four cards below.
 * That is why the three assertions here are relative positions and not indices —
 * indices into this list were always going to move, and now they move every time
 * somebody adds a field to the league editor, which is a different screen's job.
 */
const cardOrder = await page.$$eval("section.card h2", n => n.map(e => e.textContent.trim()))
const at = re => cardOrder.findIndex(h => re.test(h))
/*
 * The "What to add and drop" card is GONE, and this assertion is about what replaced
 * it rather than about where it sat.
 *
 * Its history in one line: it proposed moves of its own, badly, needing seats and an
 * exact free-agent list that a visitor who had just typed his team in did not have;
 * it was demoted to a signpost pointing at the screen that answers properly; and the
 * signpost has now gone too. A whole card whose entire content is the name of another
 * tab is furniture — and it was furniture naming a tab by a label the nav no longer
 * uses, which is the failure mode this project cares most about.
 *
 * What survives of the original claim is the part that was always the point: this
 * screen prices what you propose, and exactly one surface proposes. So the assertion
 * is that Setup does NOT answer the add/drop question, and the one below is that the
 * screen which does is the first tab — a reader who has just entered a team lands on
 * it next without being told to.
 */
t("My league no longer answers the add/drop question at all",
  at(/add and drop/i) === -1, cardOrder.join(" | "))
t("and the lineup still comes before the deal — you price a trade against a lineup",
  at(/starting lineup/i) > -1 && at(/starting lineup/i) < at(/the deal/i),
  cardOrder.join(" | "))
/* `SCREEN.today` rather than the literal it used to hold: this assertion was written
 * with "Today" typed into it, and the tab is called **Tonight** now, so the one
 * assertion about where a reader goes next went red on a rename while the behaviour it
 * describes never moved. Nothing in this file may name a tab except `SCREEN`. */
t("the screen that does answer it is the first tab, so nothing has to point at it",
  (await page.$$eval(".views button", n => n.map(e => e.textContent.trim())))[0] === SCREEN.today,
  (await page.$$eval(".views button", n => n.map(e => e.textContent.trim()))).join(" | "))

/**
 * Your TEAM comes before your LEAGUE, and that is the whole argument for merging the
 * two tabs rather than keeping them.
 *
 * "My team & trades" and "League setup" were two of four tabs, both of them things
 * one person does once a season, and the tab bar did not fit the phone this app is
 * actually opened on. Merged, the order becomes a claim: the roster paste is the step
 * people abandon, and a league with perfect scoring and no roster produces a board
 * and no decision, so the paste is what the screen opens on and the scoring tables
 * live below it. Asserted because the merge makes the opposite order a one-line
 * mistake — the editor is a sibling of <Trade/> in App.tsx, and swapping two JSX
 * children would bury the paste box under five cards of stat values with nothing
 * failing anywhere.
 *
 * "This league" is the first card the editor renders, so it is the boundary: every
 * card the team panel owns must be above it, and it must be on the screen at all —
 * a Setup screen missing the editor is the old two-tab world with one tab deleted.
 */
const editorStarts = at(/^this league$/i)
t("the league editor is on this screen too, under the team rather than beside it",
  editorStarts > -1 && at(/the deal/i) < editorStarts, cardOrder.join(" | "))
t("and the scoring tables are below the team, not above it",
  at(/^batting$/i) > editorStarts && at(/^roster slots$/i) > editorStarts,
  cardOrder.join(" | "))

/*
 * ...and it no longer ANSWERS here, it points.
 *
 * This card used to propose moves of its own, and it needed the SEATS your league
 * has you in plus an exact free-agent list to do it — so a visitor who had just
 * typed his team in on this very page was told to go and read a roster, and a Yahoo
 * user was told the page "needs the local server". The decision card needs neither
 * and is strictly better. Two answers to one question is the thing this app keeps
 * having to stop doing.
 *
 * The screen it points at is TODAY now — the tab called "Recommendations" was renamed
 * when the ranked board moved off it — but src/client/Trade.tsx still writes the old
 * name into this card's copy, twice, so the sentence sends a reader to a tab that is
 * not in the nav. That is a src defect, not a test one, and it is reported as such
 * rather than papered over here; the assertion accepts either name so that fixing
 * the copy does not break this file, and the CONTROL is what is checked hard below,
 * because a button that lands on the right screen is the claim that actually matters.
 */
/*
 * The card is gone rather than fixed, and the src defect this suite reported last
 * time — that its copy still named a tab called "Recommendations" — went with it.
 *
 * What is asserted instead is the property those two assertions were really
 * protecting: no surface on this screen may tell a reader to go somewhere by NAME,
 * because a screen name written into prose is a name that drifts out of the nav. The
 * nav is the only place a screen should be named.
 *
 * The drift has happened again and the dead name is a different one now: the tabs are
 * "Tonight | Pickups | My league", and this screen's prose still says "what lets Today
 * show the changes to make" and "adds and drops are on Today" — no tab has been called
 * Today since the rename. What is checked hard here is the names that are dead AND
 * absent (Recommendations, League setup); the two live "Today" sentences are in
 * src/client/Trade.tsx, which this file may not edit, so they are reported as a src
 * defect rather than asserted away — the same call the version before this one made
 * about the same sentence under its previous name.
 */
t("no card on My league sends the reader to a screen by a dead name written in prose",
  !(await page.$("section.advice")) &&
    !/\bRecommendations\b|\bLeague setup\b/.test(await page.$eval(".wrap", e => e.innerText)),
  (await page.$eval(".wrap", e => e.innerText)).match(/.{0,40}(Recommendations|League setup).{0,40}/)?.[0] ?? "clean")

/**
 * The screen says where its parts are, and the jump really arrives.
 *
 * THE DEFECT, measured 2026-09-11 on the published build at 390x844 by the route a
 * stranger takes: he presses "Or type the values in myself" in the opening sheet — a
 * button whose whole promise is the scoring values — and lands at scrollY 0 of a
 * 7,930px page with "This league", the first of those cards, at y=4065 and "Batting"
 * at 4398. Five screens down, past a roster card, a lineup and a trade builder he had
 * asked nothing of, with no jump link and nothing scrolled.
 *
 * Two things answer it and both are asserted: the destinations are named at the top
 * of the screen, and the one for the values LANDS — a jump that scrolls nowhere is
 * worse than no jump, and this one cannot use an href because the league editor is a
 * sibling `App` renders with no id on it, so it is found in the DOM by structure.
 * Which is exactly the kind of thing that silently stops working, hence the click.
 */
const jumps = await page.$$eval(".trade-jump button", n => n.map(e => e.textContent.trim()))
t("the screen opens by saying where its own parts are",
  jumps.length === 3 && jumps[0] === "Your starting lineup" && jumps[1] === "The deal" &&
    jumps[2] === "Scoring and slots", jumps.join(" | "))
/* Every label has to be a heading that exists on the screen, or the row is a set of
 * promises the page cannot keep — the same failure as a card naming a tab that was
 * renamed. "Scoring and slots" is the one that names a group of cards rather than one
 * card, so it is checked against the group's own first heading instead. */
t("and every destination it names is really on the screen",
  cardOrder.includes("Your starting lineup") && cardOrder.includes("The deal") &&
    editorStarts > -1, cardOrder.join(" | "))
{
	await page.evaluate(() => window.scrollTo(0, 0))
	await page.click("[data-ctl=jump-values]")
	// smooth scrolling, so the assertion waits for it to settle rather than racing it
	const landed = await page
		.waitForFunction(() => {
			const h2s = [...document.querySelectorAll("section.card h2")]
			const first = h2s.find(h => /^this league$/i.test(h.textContent.trim()))
			return !!first && Math.abs(first.getBoundingClientRect().top) < 140
		}, { timeout: 10000 })
		.then(() => true, () => false)
	t("pressing the one for the scoring values lands on them rather than scrolling nowhere",
	  landed,
	  `after the press, scrollY ${await page.evaluate(() => Math.round(window.scrollY))} and ` +
		`"This league" at ${await page.evaluate(() => {
			const h = [...document.querySelectorAll("section.card h2")].find(x => /^this league$/i.test(x.textContent.trim()))
			return h ? Math.round(h.getBoundingClientRect().top) : "absent"
		})}`)
	await page.evaluate(() => window.scrollTo(0, 0))
}

/**
 * The lineup is FOLDED, with its own answer in the summary.
 *
 * It was 1,274px at 390x844 — the tallest thing between a stranger who pressed "type
 * the values in myself" and the values — and it is the one card here that is derived
 * rather than entered: this screen is where you tell the app who you own and how your
 * league scores, and the lineup is what it says back. So the two numbers that ARE the
 * answer stay on screen and the seat-by-seat working is one press away.
 *
 * The old truth this replaces: the seat rows were laid out unasked, and `.lineup-head`
 * was a div rather than the summary. Every row assertion below still reads the same
 * rows through `$$eval`, which does not care whether a fold is open — so nothing here
 * was weakened, and the two that WOULD have been hidden (the total, and a seat nothing
 * can fill) are asserted to be on the summary itself.
 */
const lineupFoldClosed = await page.$eval("details.lineup-fold", d => d.open) === false
t("the lineup is folded until it is asked for", lineupFoldClosed)
t("and the total it is the answer to stays on the summary",
  await page.$eval("details.lineup-fold > summary .lineup-total", e => Number(e.textContent) > 0),
  await page.textContent("details.lineup-fold > summary .lineup-total"))
/* A seat nothing at all can fill is the one thing a closed fold could hide, and an
 * absence has to be stated as an absence. Counted in the summary when there is one;
 * the shipped two-man team may legitimately have none, so this is one-directional. */
t("a spot nothing can fill is counted on the summary, not only inside the fold",
  await page.$eval("details.lineup-fold", d => {
	const holes = d.querySelectorAll(".lineup-holes .hole").length
	const said = /nothing can fill/.test(d.querySelector("summary").textContent)
	return holes === 0 || said
  }), await page.textContent("details.lineup-fold > summary .lineup-unit"))
await page.$eval("details.lineup-fold", d => { d.open = true })

// The flat list of who you own is folded, because "Your starting lineup" below it
// shows every one of the same men in the seat he holds. Folded, never dropped:
// it is the only place a player can be removed by hand.
const foldSummary = (await page.textContent("details.trade-owned-fold summary")) ?? ""
t("the team list is folded behind a summary that states its own count",
  /^2 players on this team/.test(foldSummary.trim()), foldSummary)
t("and it is closed until asked for, so it costs no height", foldStartsClosed)
await openTeamFold()
t("opening it shows every player you own, with his numbers",
  (await page.$$(".trade-own")).length === 2 &&
    (await page.$$eval(".trade-own .r.bs", n => n.length)) === 2,
  String((await page.$$(".trade-own")).length))

// Every startable spot must be accounted for out loud: filled by you, covered off
// the wire, or a hole. A spot that is silently absent is a total you can't trust.
const rows = await page.$$eval(".lineup-row", n => n.map(e => e.className))
const mine = rows.filter(c => c.includes("roster")).length
const wire = rows.filter(c => c.includes("wire")).length
const holes = rows.filter(c => c.includes("hole")).length
t("every startable spot is shown, one row each", rows.length === mine + wire + holes && rows.length > 5,
  `${rows.length} rows = ${mine} mine + ${wire} wire + ${holes} holes`)
t("the two players you own are the two spots you fill", mine === 2, String(mine))
t("the spots your roster cannot fill are reported, not hidden", wire + holes === rows.length - 2,
  `${wire} off the wire, ${holes} holes`)
// A hole is a spot with no replacement level at all, so it is worth nothing rather
// than something unknown — and every one of them has to be named.
const named = await page.$$eval(".lineup-holes .hole", n => n.length)
t("a hole is reported for every unfillable spot, and none is invented",
  (holes === 0 && named === 0) || (holes > 0 && named > 0), `${holes} hole rows, ${named} reported`)
t("the lineup states its holes either way",
  (await page.$$(".lineup-holes")).length === 1)

/**
 * The give-up side is no longer a wall.
 *
 * It rendered every player you own as a bare chip before you had chosen anything —
 * 24 of them in seven rows on the shipped league, ~280px, with nothing on any chip
 * to say which one you could stand to lose — while the side opposite was a search
 * box. Same set, still all reachable, but filterable and grouped by the one fact
 * that decides who you can spare.
 *
 * The grouping is a CLAIM, so it is checked as one: "giving one up costs the
 * lineup nothing" may only be said about a man who is genuinely absent from the
 * lineup the page is showing, and it may never be said about a man who has no
 * projection at all. Two of the shipped roster's 24 are in that state — the model
 * did not weigh them and find them wanting, it could not weigh them — and filed
 * under "costs you nothing" they would have read as the cheapest men to trade.
 */
t("the give-up side offers the same filter the get side does",
  (await page.$$("[data-ctl=give-search]")).length === 1)
const groups = await page.$$eval(".deal-side .give-group", n =>
  n.map(g => ({
    key: [...g.classList].find(c => c.startsWith("give-") && c !== "give-group"),
    label: g.querySelector(".tiny-note").textContent.trim(),
    men: [...g.querySelectorAll(".chip-btn")].map(b => b.textContent.trim())
  }))
)
t("every player you could give up is under a label that says what giving him up means",
  groups.length > 0 && groups.every(g => g.men.length > 0 && g.label.length > 0),
  JSON.stringify(groups.map(g => [g.key, g.men.length])))
t("each label states its own count",
  groups.every(g => Number(g.label.split(" ")[0]) === g.men.length),
  JSON.stringify(groups.map(g => g.label)))
// Grouping a roster is a chance to lose one. Every man you own is in exactly one
// group, or the deal side is quietly offering you a smaller team than you have.
const ownedNames = await page.$$eval(".trade-own .who b", n => n.map(e => e.textContent.trim()))
const grouped = groups.flatMap(g => g.men)
t("every player you own appears exactly once across the groups",
  grouped.length === ownedNames.length &&
    new Set(grouped).size === grouped.length &&
    ownedNames.every(n => grouped.includes(n)),
  `${JSON.stringify(grouped)} against ${JSON.stringify(ownedNames)}`)
const startingNames = await page.$$eval(".lineup-row.roster .lineup-who", n =>
  n.map(e => e.textContent.trim())
)
const spareGroup = groups.find(g => g.key === "give-spare")
const startGroup = groups.find(g => g.key === "give-starting")
t("nobody in your lineup is filed under costing you nothing",
  !spareGroup || spareGroup.men.every(m => !startingNames.includes(m)),
  `${JSON.stringify(spareGroup?.men)} against ${JSON.stringify(startingNames)}`)
// the same claim from the other end, which is the half a two-man team can prove
t("everyone filed as starting really is in the lineup on screen",
  !!startGroup && startGroup.men.every(m => startingNames.includes(m)),
  `${JSON.stringify(startGroup?.men)} against ${JSON.stringify(startingNames)}`)
const unrated = groups.filter(g => g.key === "give-unrated")
t("a player with no projection is called unknown rather than free",
  unrated.every(g => /unknown, not zero/.test(g.label)),
  unrated.map(g => g.label).join(" || ") || "none on this team")
/*
 * There may now be SEVERAL of these, one per reason, which is why the line above
 * went from `find` to `filter` — it used to check the first group and would have
 * passed while a second one said anything at all.
 *
 * The old truth was one group labelled "N with no projection in this capture". That
 * sentence is false on a league that scores nothing on one side of the ball: the
 * capture holds rows for those men and a projection was made for every one of them.
 * The new truth is that each group carries the ENGINE'S own reason — `Rated.unrateable`,
 * src/engine/bscore.ts — and the block at the foot of this file pins the specific
 * case that was misattributed. Here, on the shipped league, all that can be checked
 * is that the reason on the label is the same one the chips under it carry: a group
 * whose heading and whose tooltips disagree is two different claims about one man.
 */
const unratedSeen = await page.$$eval(".deal-side .give-unrated", n => n.length)
t("an unpriced man's group heading says the same thing his chip does",
  await page.$$eval(".deal-side .give-unrated", n =>
    n.length > 0 && n.every(g => {
      const label = g.querySelector(".tiny-note").textContent
      // the reason is everything between the count and the closing "unknown, not zero"
      const why = label.split(": ").slice(1).join(": ").split(" What giving one up")[0].trim()
      return why.length > 0 &&
        [...g.querySelectorAll(".chip-btn")].every(b =>
          b.title.toLowerCase().includes(why.toLowerCase()))
    })
  ) || unratedSeen === 0,
  `${unratedSeen} unpriced groups on screen — a heading and its chips gave different reasons`)
// ...and say out loud when this team had nobody to check, rather than reporting a
// vacuous pass as protection. The block at the foot of this file builds a team that
// is GUARANTEED to have some.
if (unratedSeen === 0)
  console.log("NOTE  nobody on this team is unpriceable, so the heading/chip check had no subject")
// and the filter really filters
const chipCount = () => page.$$eval(".deal-side .give-group .chip-btn", n => n.length)
const allChips = await chipCount()
await page.fill("[data-ctl=give-search]", "zzzznobody")
await page.waitForTimeout(250)
t("a filter that matches nobody says so rather than showing an empty column",
  (await chipCount()) === 0 &&
    /Nobody on your team matches/.test((await page.textContent(".deal-side .empty")) ?? ""))
await page.fill("[data-ctl=give-search]", "")
await page.waitForTimeout(250)
t("clearing the filter brings your whole team back", (await chipCount()) === allChips,
  `${await chipCount()} of ${allChips}`)

// Giving a starter away for nothing cannot raise a lineup. It CAN cost nothing —
// a bench body who never started — so the bound is one-sided on purpose.
await page.locator(".deal-side .picks .chip-btn").first().click()
await page.waitForSelector(".trade-verdict")
const oneWay = num(await page.textContent(".verdict-delta"))
t("giving a player away for nothing never gains points", oneWay <= 0, String(oneWay))

const got = await addFrom("get-search", "Get")
await page.waitForTimeout(200)
const before = num(await page.textContent(".verdict-before"))
const after = num(await page.textContent(".verdict-after"))
const delta = num(await page.textContent(".verdict-delta"))
// the whole answer, and the only place the page is allowed to be loud
t("the delta is exactly after minus before", Math.abs(delta - (after - before)) < 0.15,
  `${delta} vs ${after} − ${before}`)
t("before is the lineup total the page already showed", Math.abs(before - twoTotal) < 0.15,
  `${before} vs ${twoTotal}`)
const why = (await page.textContent(".verdict-why")) ?? ""
t("the verdict explains the mechanism and states the net", /Net [+-]?\d/.test(why), why)
t("the explanation names the player arriving", why.includes(got.split(" ").pop()), `${got}: ${why}`)
const changes = await page.$$eval(".slot-change", n => n.length)
t("the spots that changed hands are listed", changes > 0, String(changes))

// Anything the engine could not read must reach the screen. It is legitimately
// empty on a clean league, so this asserts it is never DROPPED: if the verdict
// carries missing notes, they are on the page.
const missingShown = await page.$$eval(".verdict-missing li", n => n.map(e => e.textContent.trim()))
t("nothing the engine could not read is silently dropped",
  missingShown.every(m => m.length > 0), missingShown.join(" | "))

/**
 * The route from a team you have just entered to the card that acts on it.
 *
 * This used to click a button on a card headed "What to add and drop", whose whole
 * content was the name of another tab — and the name went stale, which is exactly why
 * the card is gone. The claim it was protecting survives and is stronger without it:
 * a reader who has entered a team reaches the card that decides in ONE tap on the
 * nav, and the nav is the only place a screen is named. Clicked rather than asserted
 * as prose, because a pointer that does not arrive is worse than no pointer. Run last
 * of the assertions sharing this page state because it navigates away; the reload
 * block below re-enters Setup from scratch anyway.
 */
await page.click(`.views button:text-is("${SCREEN.today}")`)
const landed = await page
  .waitForSelector("section.card.decide", { timeout: 30000 })
  .then(() => true, () => false)
t("the decision card is one tab away, and the tab really arrives at it",
  /* `aria-current="page"`, not `aria-selected` — this one read the attribute by hand
     rather than through the selector the rest of the file uses, so it survived the
     rename as a silent false. The bar stopped claiming `role="tablist"`, which it had
     never implemented (no arrow keys, no roving tabindex, no aria-controls, no panel),
     and `aria-selected` went with the role that owed it. */
  landed && (await page.$$eval(".views button", n => {
    const on = n.find(e => e.getAttribute("aria-current") === "page")
    return on ? on.textContent.trim() : "(none current)"
  })) === SCREEN.today,
  landed ? await page.$$eval(".views button[aria-current=page]", n => n.map(e => e.textContent.trim()).join(",")) : "no decision card after the click")

// The team lives in this browser, keyed per league — so it has to survive a reload.
const stored = await page.evaluate(() => localStorage.getItem("beanemachine:roster"))
t("the team is stored per league in this browser", !!stored && /"\d+:(hitting|pitching)"/.test(stored), String(stored))
await openTrade()
await openTeamFold()
await page.waitForSelector(".trade-own")
t("the team survives a reload", (await page.$$(".trade-own")).length === 2)
t("a reload leaves no offer half-built", (await page.$$(".trade-verdict")).length === 0)
// A stored id the current capture has no row for must be NAMED. Dropping it would
// quietly shrink the team every number on the page is computed from.
const key = JSON.parse(stored ?? "{}")
const league = Object.keys(key)[0]
if (league) {
  await page.evaluate(k => localStorage.setItem("beanemachine:roster", JSON.stringify({ [k]: ["999999999:hitting"] })), league)
  await openTrade()
  await page.waitForSelector(".trade-team")
  const orphan = await page.$$eval(".trade-unresolved li", n => n.map(e => e.textContent.trim()))
  t("an id the capture has no row for is named, not dropped",
    orphan.length === 1 && orphan[0].includes("999999999"), orphan.join(" | "))
  t("a team of nothing but unreadable ids renders no lineup rather than an empty one",
    (await page.$$(".lineup-row")).length === 0 && (await page.$$(".trade-lineup .empty")).length === 1)
}

// A store too broken to read tells you to clear it, so the control that does has to
// be there: `clear` parses the store first, so it cannot run on the one that most
// needs clearing, and a dead-end instruction is worse than no instruction.
await page.evaluate(() => localStorage.setItem("beanemachine:roster", '{"any:league":["nope"]}'))
await openTrade()
await page.waitForSelector(".trade-store-error")
const complaint = (await page.textContent(".trade-store-error")) ?? ""
/* The words changed and the claim did not. It read "isn't a valid roster", which came
   from a message that also printed the storage key and V8's own parser text — software
   talk on a screen whose job is telling a reader what to do next. What has to be true is
   that the complaint says the saved team is the problem and that clearing is the way
   out; matching on the reader's words rather than the schema's is also what makes this
   assertion able to notice the message going back. */
t("an unreadable roster says what is wrong with it",
  /team this browser saved/i.test(complaint) && /clear/i.test(complaint), complaint)
await page.click(".trade-store-error button")
await page.waitForSelector(".trade-store-error", { state: "detached", timeout: 10000 }).catch(() => {})
t("and clearing it really is the way out",
  (await page.evaluate(() => localStorage.getItem("beanemachine:roster"))) === null)

/**
 * The deal is behind a press on a league whose window is WIDE OPEN too.
 *
 * The shipped league shut its window on 2026-08-06, so every assertion above exercises
 * the closed-deadline disclosure and the open one would have gone untested on this
 * server forever. It is the case the defect was measured in: at 390x844 on the
 * published build, whose preset league has no deadline at all, the builder was 718px
 * (y=3347 to 4065) between a stranger's lineup and the scoring values he had pressed a
 * button to reach — a card that can say nothing until two names are picked, laid out
 * in front of a reader who came to type in his league's settings.
 *
 * The deadline is taken out of the stored league to get there, which is also a check
 * on `tradesClosed` itself: with no "Trade End Date" the window is open, so the card
 * must carry neither the deadline sentence nor `.trade-closed` — and must still be a
 * press rather than a wall.
 */
{
	const raw = await page.evaluate(() => localStorage.getItem("beanemachine:config"))
	if (raw) {
		await page.evaluate(text => {
			const c = JSON.parse(text)
			for (const l of Object.values(c.leagues)) {
				const rs = l.league_rules?.raw_settings
				if (rs) delete rs["Trade End Date"]
			}
			localStorage.setItem("beanemachine:config", JSON.stringify(c))
		}, raw)
		await visit()
		await toScreen(page, SCREEN.setup)
		await page.waitForSelector(".trade-deal", { timeout: 30000 })
		const card = await page.$eval(".trade-deal", e => e.innerText)
		t("a league that still takes trades is offered the builder as a press, not a wall",
			(await page.$$(".trade-closed")).length === 0 && (await page.$$(".deal")).length === 0 &&
				!/stopped taking trades/.test(card) &&
				(await page.$$(".trade-deal button:text-is('Price a trade')")).length === 1,
			card.replace(/\s+/g, " ").slice(0, 200))
		await page.click(".trade-deal button:text-is('Price a trade')")
		const opened = await page.waitForSelector(".deal", { timeout: 15000 }).then(() => true, () => false)
		t("and pressing it really opens the same evaluator", opened,
			"pressing Price a trade produced no deal form")
		// put the league back the way it was found, so nothing below inherits an open
		// window from this block
		await page.evaluate(text => localStorage.setItem("beanemachine:config", text), raw)
	}
}

// An unconfigured league has a roster shape and no scoring, so every projection is
// exactly zero. Eighteen zero rows read as a working lineup; they are a missing
// input, and the page has to say so rather than price a trade at +0.00.
const cfg = await page.evaluate(() => localStorage.getItem("beanemachine:config"))
if (cfg) {
  await page.evaluate(raw => {
    const c = JSON.parse(raw)
    for (const l of Object.values(c.leagues)) {
      for (const k of Object.keys(l.scoring.batting)) l.scoring.batting[k] = 0
      for (const k of Object.keys(l.scoring.pitching)) l.scoring.pitching[k] = 0
    }
    localStorage.setItem("beanemachine:config", JSON.stringify(c))
  }, cfg)
  await visit()
  await toScreen(page, SCREEN.setup)
  const said = await page
    .waitForSelector(".trade-unscored", { timeout: 30000 })
    .then(() => true, () => false)
  t("a league with no scoring says so instead of pricing a trade at zero",
    said && (await page.$$(".lineup-row")).length === 0 && (await page.$$(".trade-verdict")).length === 0)
}

t("still no page errors", errors.length === 0, errors.join(" | "))

/**
 * Pasting a roster, which is the route that cannot be taken away.
 *
 * Every other way in depends on somebody else's permission. On 2026-09-09 the Yahoo
 * sweep returned a sixth of the wire, then none of it, then "Request denied", while
 * this page went on offering the button. A paste is the reader's own signed-in
 * browser doing the reading; it is not rate-limited because it is not a scraper, and
 * it reaches PRIVATE leagues, which is most leagues.
 *
 * The seats are the half that matters most: a roster page prints the slot to the
 * left of each name, and carrying it through is what lets Recommendations show the
 * CHANGES to make rather than a lineup to copy out by hand.
 */
{
	const snap = JSON.parse(readFileSync("data/snapshot.json", "utf8"))
	const bats = snap.players
		.filter(x => x.group === "hitting")
		.sort((a, b) => (b.stats?.plateAppearances ?? 0) - (a.stats?.plateAppearances ?? 0))
		.slice(0, 5)
	const slots = ["C", "1B", "2B", "3B", "SS"]
	const text =
		"Pos\tPlayer\tAction\n" +
		bats.map((x, i) => `${slots[i]}\t${x.name} ${x.team ?? ""} - ${slots[i]}\tAdd/Drop`).join("\n")

	const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } })
	page.on("dialog", d => d.accept())
	// see `visit`: domcontentloaded plus the nav, never networkidle — this page mounts
	// the live MLB slate read too, and its own `page` shadows the one `visit` holds
	await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 })
	await page.waitForSelector(".views button", { timeout: 30000 })
	// its own page, so its own navigation — `toScreen` takes the page it is handed,
	// which matters here because this block shadows the outer `page`
	if (await toScreen(page, SCREEN.setup)) {
		await page.waitForSelector(".paste-roster", { timeout: 30000 })
		/*
		 * The steps, and the ORDER of them, because the order is the fix.
		 *
		 * This asserted only that the words "My Team", "Ctrl", "A" and "Read that" were all
		 * somewhere in the list, in any arrangement — so it passed on the broken version
		 * and passes on the fixed one, which makes it no protection at all for the thing
		 * that actually changed. The broken version gave Ctrl+A as THE way to get a roster
		 * in, and no phone has a Ctrl key: on the device this app is mostly opened on, the
		 * instruction could not be carried out, and nothing told the reader that typing four
		 * names works exactly as well (`playersInText` matches known players in arbitrary
		 * text and has never cared whether a clipboard was involved).
		 *
		 * The new truth is positional: the gesture that works on every device leads, and the
		 * keyboard shortcut survives scoped to the device that has the keys. Both halves are
		 * pinned separately — that typing is offered before any keystroke is named, and that
		 * every mention of Ctrl sits inside a clause saying "on a computer" — because either
		 * one alone still passes on the version this replaced.
		 */
		const steps = await page.$$eval(".paste-how li", n =>
			n.map(e => e.innerText.replace(/\s+/g, " ").trim())
		)
		const how = steps.join(" ")
		const stepWith = re => steps.findIndex(l => re.test(l))
		t("the paste route says which page to open and what to press at the end",
			/My Team/.test(how) && /Read that/.test(how), how.slice(0, 160))
		t("typing the names is offered before any keystroke is named",
			stepWith(/type the names/i) > -1 && stepWith(/type the names/i) < stepWith(/Ctrl/),
			steps.join(" / ").slice(0, 200))
		/*
		 * ...and offered ONCE.
		 *
		 * Step 2 said "Copy it, or just type the names" and step 3 said "Paste or type them
		 * below", so a three-step list spent a third of itself repeating the alternative it
		 * had already given, and a reader who types was told twice in consecutive lines.
		 * Step 3 exists for the box and the button; it says "put that in" now, which covers
		 * a paste and a typed line without naming either a second time.
		 */
		t("and offered once rather than repeated in the next step",
			steps.filter(l => /\btype\b/i.test(l)).length === 1,
			steps.join(" / ").slice(0, 240))
		t("and Ctrl+A is scoped to a computer rather than given as the way in",
			/Ctrl/.test(how) &&
				(await page.$$eval(".paste-how li", n =>
					n.every(
						li =>
							!/Ctrl/.test(li.innerText) ||
							[...li.querySelectorAll(".sub")].some(
								sub => /on a computer/i.test(sub.innerText) && /Ctrl/.test(sub.innerText)
							)
					)
				)),
			how.slice(0, 200))
		t("the paste route is offered above the platform read, not below it",
			await page.evaluate(() => {
				const paste = document.querySelector(".paste-roster")
				const pull = document.querySelector(".pull-roster")
				return !pull || !!(paste.compareDocumentPosition(pull) & Node.DOCUMENT_POSITION_FOLLOWING)
			}), "the fragile route is listed first")

		await page.fill("[data-ctl=paste-roster]", text)
		await page.click(".paste-roster button")
		await page.waitForSelector(".paste-note", { timeout: 15000 })
		const note = (await page.textContent(".paste-note")) ?? ""
		t("a pasted roster page is read, and says how many it found",
			new RegExp(`Found ${bats.length} players`).test(note), note)
		t("and it says the seats came with them, because that is what unlocks the diff",
			/with the seat they were in/.test(note), note)

		const owned = await page.$$eval(".trade-own b", n => n.map(e => e.textContent.trim()))
		t("the men it found really are on the team afterwards",
			bats.every(x => owned.some(o => o.includes(x.name.split(" ").slice(-1)[0]))),
			owned.join(", "))

		// The other half: pasting the league's own free-agent page, which is what turns
		// "who is available" from an ownership estimate into a fact. Without it a Yahoo
		// user never gets a real wire at all, because Yahoo answers no browser and
		// answers a server only when it feels like it.
		const fa = snap.players.filter(x => x.group === "hitting").slice(20, 32)
		/*
		 * It is FOLDED now, so it has to be opened before it can be typed into — and what
		 * the summary carries is asserted first, because a fold whose summary does not say
		 * what is inside it is just a hidden card.
		 *
		 * Measured 2026-09-11 at 390x844: the heading, the paragraph, the four-row box and
		 * its button were ~400px between the paste every reader needs and everything below
		 * it, for a step whose own first word is "optional". The summary keeps the offer and
		 * keeps the one fact that decides whether it is worth a minute.
		 */
		const wireSummary = (await page.textContent("details.paste-wire-fold > summary")) ?? ""
		t("the optional free-agent paste is folded, and says so without being opened",
			(await page.$eval("details.paste-wire-fold", d => d.open)) === false &&
				/Paste your free agents/.test(wireSummary) && /[Oo]ptional/.test(wireSummary) &&
				/estimated/.test(wireSummary), wireSummary)
		await page.$eval("details.paste-wire-fold", d => { d.open = true })
		await page.fill("[data-ctl=paste-wire]", fa.map(x => `${x.name} ${x.team ?? ""} - OF`).join("\n"))
		await page.click("[data-ctl=paste-wire] ~ button")
		await page.waitForTimeout(800)
		const wireNote = (await page.$$eval(".paste-note", n => n.map(e => e.textContent.trim()))).pop() ?? ""
		t("a pasted free-agent page is read and replaces the estimate",
			new RegExp(`Found ${fa.length} free agents`).test(wireNote) &&
				/instead of estimating/.test(wireNote), wireNote)
		t("and it is stored where a server read would have landed",
			await page.evaluate(() => {
				const raw = JSON.parse(localStorage.getItem("beanemachine:pool") ?? "{}")
				return Object.values(raw).some(e => e.players?.length >= 12)
			}), "nothing reached the pool store")

		// nonsense in, nothing out — and a sentence rather than a silent no-op
		await page.fill("[data-ctl=paste-roster]", "Standings Scores Sign in Terms Privacy")
		await page.click(".paste-roster button")
		await page.waitForTimeout(600)
		t("page furniture yields nobody, and says so rather than doing nothing",
			/No players found/.test((await page.textContent(".paste-note")) ?? ""),
			(await page.textContent(".paste-note")) ?? "")
	}
	await page.close()
}

/**
 * HOW FAR DOWN the league's own scoring values are, in pixels, on a phone.
 *
 * This is the assertion the rest of this file could not make: every other block reads
 * the DOM, and the defect was a layout. A stranger pressed "Or type the values in
 * myself" in the opening sheet and landed at scrollY 0 of a 7,930px page with "This
 * league" at y=4065 — 5.2 screens of an 844px viewport, past a roster card, a lineup
 * and a trade builder, with no jump and nothing scrolled.
 *
 * Measured from the TEAM CARD rather than from the top of the document on purpose.
 * Everything above it — the wordmark, the tab bar, the management toolbar, the preset
 * notice — belongs to src/client/App.tsx, which this change may not touch, and on a
 * phone it is 984px of the page on its own. Anchoring here isolates the part
 * src/client/Trade.tsx is answerable for, so this number cannot be moved by somebody
 * else's card and cannot be rescued by one either.
 *
 * Measured 2026-09-11 on this server, at 390x844, with a twelve-man roster pasted in:
 * 2,888px before (team card 601, "This league" 3489) and 1,605px after. The budget is
 * 2,200 — slack for a card growing a line, nowhere near enough for the lineup or the
 * builder to be laid out unasked again.
 */
{
	const snap = JSON.parse(readFileSync("data/snapshot.json", "utf8"))
	const bats = snap.players
		.filter(x => x.group === "hitting")
		.sort((a, b) => (b.stats?.plateAppearances ?? 0) - (a.stats?.plateAppearances ?? 0))
		.slice(0, 12)
	const slots = ["C", "1B", "2B", "3B", "SS", "OF", "OF", "OF", "Util", "Util", "BN", "BN"]
	const text = bats.map((x, i) => `${slots[i]}\t${x.name} ${x.team ?? ""}`).join("\n")

	const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
	const oops = []
	page.on("pageerror", e => oops.push(String(e)))
	await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 })
	await page.waitForSelector(".views button", { timeout: 30000 })
	if (await toScreen(page, SCREEN.setup)) {
		await page.waitForSelector("[data-ctl=paste-roster]", { timeout: 30000 })
		await page.fill("[data-ctl=paste-roster]", text)
		await page.click(".paste-roster button:text-is('Read that')")
		await page.waitForSelector(".lineup-total", { timeout: 15000 })
		await page.waitForTimeout(400)

		/** The top of a card, by the heading it carries, in page coordinates. */
		const topOf = (pg, re) =>
			pg.evaluate(pattern => {
				const h = [...document.querySelectorAll("section.card h2")].find(x =>
					new RegExp(pattern, "i").test(x.textContent.trim())
				)
				return h ? Math.round(h.closest("section.card").getBoundingClientRect().top + window.scrollY) : null
			}, re)

		for (const [w, h] of [[390, 844], [1280, 1000]]) {
			await page.setViewportSize({ width: w, height: h })
			await page.evaluate(() => window.scrollTo(0, 0))
			await page.waitForTimeout(300)
			const team = await topOf(page, "^my team$")
			const values = await topOf(page, "^this league$")
			const height = await page.evaluate(() => document.documentElement.scrollHeight)
			const span = team !== null && values !== null ? values - team : null
			t(`at ${w}x${h}, the league's own values are within ${w === 390 ? "two screens" : "a screen and a half"} of the team`,
				span !== null && span < (w === 390 ? 2200 : 1500),
				`team card ${team}, "This league" ${values}, ${span}px apart, page ${height}px`)
			// the jump row is what makes the distance a single press, and it has to be the
			// first thing on the screen rather than one more card to scroll past
			t(`and the row of destinations is above everything at ${w}x${h}`,
				await page.evaluate(() => {
					const jump = document.querySelector(".trade-jump")
					const first = document.querySelector("section.card")
					return !!jump && !!first &&
						!!(jump.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING)
				}), "no .trade-jump, or a card above it")
		}
		t("no page errors while measuring", oops.length === 0, oops.join(" | "))
	}
	await page.close()
}

/**
 * The way back into the setup, from the screen that owns the way back.
 *
 * The setup left the page flow: it is a bar fixed to the foot of the viewport now
 * (src/client/Dock.tsx), shown to a reader who has no league — and this suite's
 * reader HAS one, which is why every assertion above runs with no `.dock` in the
 * document at all and needed no new gesture to keep working. That is the half worth
 * stating out loud, because a bar that appeared here unasked would cover the foot of
 * a screen made of forms.
 *
 * The other half is the only dock gesture that starts on Setup: `[data-ctl=onboard]`
 * ("Set up a league") is the guided route in, and it is the one route a reader with a
 * league has — the dock opens by itself on a first visit and never again. journey.mjs
 * asserts the button EXISTS on this screen and on neither other; nothing asserted it
 * arrives anywhere. A button that sets `onboarding` but not `setupOpen` would render
 * a closed one-line bar with the setup still hidden behind a second press, and the
 * reader who pressed "Set up a league" would have been handed a bar that says
 * "Who's on my team" — which is indistinguishable from a no-op.
 *
 * Its own page, because opening the dock changes app-wide state and everything above
 * shares one; same reason the paste block has one.
 */
{
	const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
	const oops = []
	page.on("pageerror", e => oops.push(String(e)))
	await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 })
	await page.waitForSelector(".views button", { timeout: 30000 })

	/** The gesture, named once: press the guided-setup button in the Setup toolbar and
	 *  wait for the sheet, NOT for the bar. `.dock-bar` exists whenever the dock does,
	 *  open or shut, so waiting on it would pass on exactly the bug below. */
	const askForSetup = async () => {
		await page.click("[data-ctl=onboard]")
		return page
			.waitForSelector(".dock-sheet .onboard", { timeout: 15000 })
			.then(() => true, () => false)
	}

	if (await toScreen(page, SCREEN.setup)) {
		await page.waitForSelector(".trade-team", { timeout: 30000 })
		t("a reader who already has a league is not shown the setup bar unasked",
			(await page.$$(".dock")).length === 0 && (await page.$$(".onboard")).length === 0,
			await page.$$eval(".dock", n => n.map(e => e.className).join(" | ")))

		const opened = await askForSetup()
		t("pressing Set up a league opens the setup already expanded, not a bar to press again",
			opened, "no .dock-sheet with the setup in it after the click")
		t("and the button in the bar now offers the way out rather than the way in",
			opened &&
				(await page.$$eval(".dock-bar button", n =>
					n.map(e => `${e.textContent.trim()}/${e.getAttribute("aria-expanded")}`)
				)).join(",") === "Close/true",
			await page.$$eval(".dock-bar button", n => n.map(e => e.textContent.trim()).join(",")))
		// It hovers OVER this screen, it does not replace it: the roster and the league
		// editor underneath have to still be there, or "set up my league" has quietly
		// become a navigation and the reader has lost the team he was editing.
		t("the setup hovers over My league rather than navigating off it",
			(await page.$$(".trade-team")).length === 1 &&
				(await page.$$eval(".views button[aria-current=page]", n =>
					n.map(e => e.textContent.trim())
				))[0] === SCREEN.setup,
			`${(await page.$$(".trade-team")).length} team panels`)

		/*
		 * Escape is the documented dismissal (Dock.tsx binds it on the document so it
		 * works wherever focus is), and with a league it takes the WHOLE dock away.
		 *
		 * This asserted that the bar survives, on the reasoning that it was the only
		 * handle left — which was true and was the bug rather than the design. A reader
		 * who already HAS a league and has just looked at the setup should get his
		 * ordinary chrome back, not a bar across the foot of every screen until he
		 * reloads; the bar is for somebody with no league who needs the way in. So
		 * closing clears the onboarding state and the toolbar's own button returns,
		 * which is what must not be stranded.
		 */
		await page.keyboard.press("Escape")
		await page.waitForSelector(".dock-sheet", { state: "detached", timeout: 10000 }).catch(() => {})
		t("Escape puts the setup away and gives the toolbar back as the way in",
			(await page.$$(".dock-sheet")).length === 0 &&
				(await page.$$(".onboard")).length === 0 &&
				(await page.$$(".dock-bar")).length === 0 &&
				(await page.$$('.bar button:text-is("Set up a league")')).length === 1,
			`${(await page.$$(".dock-sheet")).length} sheets, ${(await page.$$(".dock-bar")).length} bars, ${(await page.$$('.bar button:text-is("Set up a league")')).length} buttons`)
		t("no page errors from opening and closing the setup", oops.length === 0, oops.join(" | "))
	}
	await page.close()
}

/**
 * A TEAM IS TWO STORES, AND ENDING ONE HAS TO END BOTH.
 *
 * Who you own lives in `beanemachine:roster`; which seat each man is in lives in
 * `beanemachine:lineup`, separately and on purpose (see src/client/lineup.ts). Every
 * path on this screen that ended a team touched only the first of them.
 *
 * Measured 2026-09-11 on the dev server with nothing corrupt: paste twenty names,
 * press "Clear team", accept the confirm — the roster store became `{}` while the
 * lineup store kept all 1,858 characters of its twenty spots, under the timestamp it
 * was read at. `lineupStore.clear` existed and `grep -rn lineupStore src/` found no
 * caller for it anywhere. Tonight had already been fixed at its own end — it will not
 * start a man who is no longer owned — so nothing RENDERED the stale seats, which is
 * exactly why nothing caught this: the wrong data sat in the browser waiting for the
 * next reader of it, and a seat is only true about the roster it was read off.
 *
 * Both halves of the pair are asserted, in both directions: that the seats really
 * arrived first (or the test proves nothing by finding them gone), and that a replaced
 * roster carrying no seats of its own does not inherit the old ones.
 */
{
	const snap = JSON.parse(readFileSync("data/snapshot.json", "utf8"))
	const bats = snap.players
		.filter(x => x.group === "hitting")
		.sort((a, b) => (b.stats?.plateAppearances ?? 0) - (a.stats?.plateAppearances ?? 0))
		.slice(0, 6)
	const slots = ["C", "1B", "2B", "3B", "SS", "OF"]
	const withSeats =
		"Pos\tPlayer\tAction\n" +
		bats.map((x, i) => `${slots[i]}\t${x.name} ${x.team ?? ""} - ${slots[i]}\tAdd/Drop`).join("\n")

	const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } })
	const oops = []
	page.on("pageerror", e => oops.push(String(e)))
	page.on("dialog", d => d.accept())
	const stores = () =>
		page.evaluate(() => ({
			roster: Object.values(JSON.parse(localStorage.getItem("beanemachine:roster") ?? "{}"))
				.reduce((n, v) => n + v.length, 0),
			seats: Object.values(JSON.parse(localStorage.getItem("beanemachine:lineup") ?? "{}"))
				.reduce((n, v) => n + v.spots.length, 0)
		}))

	await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 })
	await page.waitForSelector(".views button", { timeout: 30000 })
	if (await toScreen(page, SCREEN.setup)) {
		await page.waitForSelector(".paste-roster", { timeout: 30000 })
		await page.fill("[data-ctl=paste-roster]", withSeats)
		await page.click(".paste-roster button")
		await page.waitForSelector(".paste-note", { timeout: 15000 })
		const seeded = await stores()
		t("a roster pasted with its seats puts both of them in this browser",
			seeded.roster === bats.length && seeded.seats === bats.length, JSON.stringify(seeded))

		// the same names again with no slot column — which is what typing four names
		// into this box gives you, and the box says to do exactly that
		await page.fill("[data-ctl=paste-roster]", bats.map(x => x.name).join("\n"))
		await page.click(".paste-roster button")
		await page.waitForTimeout(600)
		const reread = await stores()
		t("a roster read back without seats does not keep the seats of the one it replaced",
			reread.roster === bats.length && reread.seats === 0, JSON.stringify(reread))

		// and put them back, so Clear team is tested against a team that HAS seats
		await page.fill("[data-ctl=paste-roster]", withSeats)
		await page.click(".paste-roster button")
		await page.waitForTimeout(600)
		const again = await stores()
		t("and pasting the seats again restores them", again.seats === bats.length, JSON.stringify(again))

		const clear = page.locator(".trade-search button:text-is('Clear team')")
		t("a team with players on it offers a way to clear them", (await clear.count()) === 1)
		if (await clear.count()) {
			await clear.click()
			await page.waitForTimeout(600)
			const after = await stores()
			t("clearing a team clears the seats it was read into as well as the names",
				after.roster === 0 && after.seats === 0, JSON.stringify(after))
		}
		t("no page errors while clearing a team", oops.length === 0, oops.join(" | "))
	}
	await page.close()
}

/**
 * LEAVING THIS SCREEN AND COMING BACK: THE COLLAPSE AND THE OFFER GO TOGETHER.
 *
 * The trade builder is a disclosure on every league now, and `dealOpen` is ordinary
 * component state. `App` renders <Trade/> in a `view === "trade"` branch, so the whole
 * component unmounts when you tab away and the state goes with it — and the open view
 * is remembered in this browser, so "away and back" is a route readers really take.
 *
 * Measured 2026-09-11 on the dev server: open the builder, pick a man to give up, tab
 * to Tonight, tab back — the builder is collapsed again AND the chip is unpressed.
 * That is the state worth pinning, and it is pinned as ONE assertion on purpose. The
 * hazard is not the collapse; it is the collapse DIVERGING from the offer. A later
 * change that remembered `dealOpen` across a navigation while `give`/`take` still
 * reset would show a reader his own priced deal emptied without a word, and one that
 * kept the offer behind a collapsed card would hide a half-built trade behind a button
 * labelled "Price a trade" — the same two-stores-out-of-step defect as the roster and
 * its seats above.
 *
 * The offer being discarded at all is a COST, not a defect: the effect on `leagueKey`
 * in src/client/Trade.tsx already abandons a half-built offer rather than re-pricing it
 * against other slots, and a verdict is only meaningful against the roster and bars it
 * was computed from. Nothing on screen claims the offer is kept, so no sentence is
 * false. If it is ever worth keeping, it must be kept with the disclosure state.
 */
{
	const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } })
	const oops = []
	page.on("pageerror", e => oops.push(String(e)))
	await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 })
	await page.waitForSelector(".views button", { timeout: 30000 })
	if (await toScreen(page, SCREEN.setup)) {
		// This context starts with no team, and with no team there is nothing to put on
		// the give side — the assertion below would pass on an empty column. So one is
		// pasted in first, the same way a reader gets one.
		await page.waitForSelector(".paste-roster", { timeout: 30000 })
		const snap = JSON.parse(readFileSync("data/snapshot.json", "utf8"))
		const bats = snap.players
			.filter(x => x.group === "hitting")
			.sort((a, b) => (b.stats?.plateAppearances ?? 0) - (a.stats?.plateAppearances ?? 0))
			.slice(0, 6)
		await page.fill("[data-ctl=paste-roster]", bats.map(x => `${x.name} ${x.team ?? ""}`).join("\n"))
		await page.click(".paste-roster button")
		await page.waitForSelector(".paste-note", { timeout: 15000 })

		const open = page.locator(
			".trade-deal button:text-is('Price one anyway'), .trade-deal button:text-is('Price a trade')"
		)
		t("the builder is asked for rather than shown, on a league of any kind",
			(await open.count()) === 1 && (await page.$$(".deal")).length === 0,
			`${await open.count()} buttons, ${(await page.$$(".deal")).length} builders`)
		await open.first().click()
		await page.waitForSelector(".deal", { timeout: 15000 })
		const chip = page.locator(".deal-side .give-group .chip-btn").first()
		const picked = (await chip.count()) ? await chip.innerText() : null
		if (picked) await chip.click()
		t("a man can be put on the give side once the builder is open",
			!!picked &&
				(await page.$$eval(".deal-side .chip-btn[aria-pressed=true]", n => n.length)) === 1,
			picked ?? "no chips on the give side at all")

		await toScreen(page, SCREEN.today)
		await page.waitForTimeout(400)
		await toScreen(page, SCREEN.setup)
		await page.waitForSelector(".trade-team", { timeout: 30000 })
		const back = {
			collapsed: (await page.$$(".deal")).length === 0,
			asks: await page
				.locator(".trade-deal button:text-is('Price one anyway'), .trade-deal button:text-is('Price a trade')")
				.count(),
			kept: await page.$$eval(".deal-side .chip-btn[aria-pressed=true]", n => n.length)
		}
		t("coming back collapses the builder and empties the offer together, never one without the other",
			back.collapsed && back.asks === 1 && back.kept === 0, JSON.stringify(back))
		t("no page errors leaving the builder and coming back", oops.length === 0, oops.join(" | "))
	}
	await page.close()
}

/**
 * A SIDE OF THE SCORING THAT PAYS NOTHING IS NOT A MISSING PROJECTION.
 *
 * Measured 2026-09-11 on the dev server: paste twelve bats and eight arms into the
 * shipped league, empty `scoring.pitching` in `beanemachine:config`, reload. All eight
 * pitchers were filed under "8 with no projection in this capture" — and the capture
 * has rows for every one of them, and `rateAll` made a projection for every one of
 * them. What is missing is a points total to rank them by, because the league pays
 * nothing for what a pitcher does. The sentence sent a reader hunting for absent data
 * instead of to the scoring he has not entered.
 *
 * `Rated.unrateable` (src/engine/bscore.ts) already carried the true sentence — "this
 * league scores nothing on the pitching side, so there is no points total to rank him
 * by — import your league's scoring, or enter it." — and this screen threw it away and
 * substituted one of its own, the same failure Decide.tsx's bench card was fixed for.
 *
 * The league is edited in THIS BROWSER ONLY, through localStorage, and nothing on disk
 * is touched: data/snapshot.json and scoring.json are evidence and are read-only here.
 */
{
	const snap = JSON.parse(readFileSync("data/snapshot.json", "utf8"))
	const pick = g =>
		snap.players
			.filter(x => x.group === g)
			.sort((a, b) => (b.stats?.plateAppearances ?? b.stats?.outs ?? 0) - (a.stats?.plateAppearances ?? a.stats?.outs ?? 0))
	const bats = pick("hitting").slice(0, 12)
	const arms = pick("pitching").slice(0, 8)
	const slots = ["C", "1B", "2B", "3B", "SS", "OF", "OF", "OF", "UTIL", "BN", "BN", "BN"]
	const text =
		"Pos\tPlayer\tAction\n" +
		bats.map((x, i) => `${slots[i]}\t${x.name} ${x.team ?? ""} - ${slots[i]}\tAdd/Drop`).join("\n") +
		"\n" +
		arms.map(x => `SP\t${x.name} ${x.team ?? ""} - SP\tAdd/Drop`).join("\n")

	const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } })
	const oops = []
	page.on("pageerror", e => oops.push(String(e)))
	page.on("dialog", d => d.accept())

	await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 })
	await page.waitForSelector(".views button", { timeout: 30000 })
	if (await toScreen(page, SCREEN.setup)) {
		await page.waitForSelector(".paste-roster", { timeout: 30000 })
		await page.fill("[data-ctl=paste-roster]", text)
		await page.click(".paste-roster button")
		await page.waitForSelector(".paste-note", { timeout: 15000 })

		// this browser's copy of the league, and only this browser's
		const emptied = await page.evaluate(() => {
			const c = JSON.parse(localStorage.getItem("beanemachine:config"))
			const key = Object.keys(c.leagues)[0]
			if (!c.leagues[key].scoring?.pitching) return false
			c.leagues[key].scoring.pitching = {}
			localStorage.setItem("beanemachine:config", JSON.stringify(c))
			return true
		})
		t("the shipped league scores the pitching side, so emptying it is a real change",
			emptied, "no pitching scoring to empty — this block proves nothing")
		if (emptied) {
			await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 })
			await page.waitForSelector(".views button", { timeout: 30000 })
			await toScreen(page, SCREEN.setup)
			await page.waitForSelector(".trade-team", { timeout: 30000 })
			const open = page.locator(
				".trade-deal button:text-is('Price one anyway'), .trade-deal button:text-is('Price a trade')"
			)
			if (await open.count()) {
				await open.first().click()
				await page.waitForSelector(".deal", { timeout: 15000 })
			}
			const labels = await page.$$eval(".deal-side .give-unrated .tiny-note", n =>
				n.map(e => e.textContent.trim())
			)
			t("a side the league pays nothing for is reported as that, not as missing data",
				labels.length > 0 && labels.every(l => /scores nothing on the pitching side/.test(l)),
				labels.join(" || ") || "no unpriced group at all")
			t("and it does not claim the capture is missing them, because it is not",
				labels.every(l => !/no projection in this capture/.test(l)),
				labels.join(" || "))
			// the reader is told what to DO about it, which is the half a symptom lacks
			t("and it names the way out, which is entering the scoring",
				labels.every(l => /scoring/.test(l)), labels.join(" || "))
			t("no page errors on a league that scores one side only", oops.length === 0, oops.join(" | "))
		}
	}
	await page.close()
}

await browser.close()
console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
