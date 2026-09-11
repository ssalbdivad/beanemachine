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
 * Matching the visible label is what makes the next rename a one-line change here
 * rather than a silent skip somewhere else: `SCREEN` is the only thing in this file
 * that knows what the tabs are called and `toScreen` is the only thing that clicks
 * one. The match is anchored rather than loose, so a fourth tab whose name merely
 * CONTAINS one of these cannot quietly capture the clicks.
 */
const SCREEN = { today: "Today", wire: "Wire", setup: "Setup" }
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
	if (ok) await openClosedDeal()
	return ok
}

/**
 * The shipped league's trade window shut on 2026-08-06, so the deal is retired
 * behind a disclosure — see `tradesClosed`. The evaluator itself is unchanged and
 * everything below still has to hold, so the tests open it. That the DEFAULT is
 * closed is asserted separately, once, rather than fought here four times.
 */
const openClosedDeal = async () => {
	const button = page.locator(".trade-closed button:text-is('Price one anyway')")
	if (await button.count()) {
		await button.click()
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
t("Setup no longer answers the add/drop question at all",
  at(/add and drop/i) === -1, cardOrder.join(" | "))
t("and the lineup still comes before the deal — you price a trade against a lineup",
  at(/starting lineup/i) > -1 && at(/starting lineup/i) < at(/the deal/i),
  cardOrder.join(" | "))
t("the screen that does answer it is the first tab, so nothing has to point at it",
  (await page.$$eval(".views button", n => n.map(e => e.textContent.trim())))[0] === "Today",
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
 */
t("no card on Setup sends the reader to a screen by a name written in prose",
  !(await page.$("section.advice")) &&
    !/\bRecommendations\b|\bLeague setup\b/.test(await page.$eval(".wrap", e => e.innerText)),
  (await page.$eval(".wrap", e => e.innerText)).match(/.{0,40}(Recommendations|League setup).{0,40}/)?.[0] ?? "clean")

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
const unrated = groups.find(g => g.key === "give-unrated")
t("a player with no projection is called unknown rather than free",
  !unrated || /unknown, not zero/.test(unrated.label), unrated?.label ?? "none on this team")
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
  landed && (await page.$$eval(".views button", n => {
    const on = n.find(e => e.getAttribute("aria-selected") === "true")
    return on ? on.textContent.trim() : "(none selected)"
  })) === SCREEN.today,
  landed ? await page.$$eval(".views button[aria-selected=true]", n => n.map(e => e.textContent.trim()).join(",")) : "no decision card after the click")

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
t("an unreadable roster says what is wrong with it", /isn't a valid roster/i.test(complaint), complaint)
await page.click(".trade-store-error button")
await page.waitForSelector(".trade-store-error", { state: "detached", timeout: 10000 }).catch(() => {})
t("and clearing it really is the way out",
  (await page.evaluate(() => localStorage.getItem("beanemachine:roster"))) === null)

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
		const how = (await page.textContent(".paste-how")) ?? ""
		t("the paste route says which page to open and which keys to press",
			/My Team/.test(how) && /Ctrl/.test(how) && /A/.test(how) && /Read that/.test(how),
			how.replace(/\s+/g, " ").slice(0, 160))
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
 * "Set up my league" — which is indistinguishable from a no-op.
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
		t("the setup hovers over Setup rather than navigating off it",
			(await page.$$(".trade-team")).length === 1 &&
				(await page.$$eval(".views button[aria-selected=true]", n =>
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

await browser.close()
console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
