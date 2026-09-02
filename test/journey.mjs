// One person, one session, moving through the whole product.
//
// Every other browser suite stands on one surface and asserts it deeply. Nothing
// asserts that state carries ACROSS them, which is where the integration bugs
// live: a horizon switched on the board, a player claimed on the draft page, a
// team read back on the trade page, and all of it still there after a reload.
// The claims here are therefore about continuity rather than about any single
// screen — a filter that leaves a stale row behind, a draft pick that never
// reaches the roster the trade page prices, a reload that quietly forgets.
//
// It also runs a console-error trap for the whole journey rather than per page,
// because the errors that matter are the ones a second view triggers in the
// first one.
import { chromium, firefox } from "playwright-core"
const BASE = process.env.BASE ?? "http://127.0.0.1:5173"
const ENGINE = process.env.BROWSER ?? "chromium"
const browser = ENGINE === "firefox" ? await firefox.launch() : await chromium.launch({ args: ["--no-sandbox"] })
console.log(`--- ${ENGINE} ---`)
let pass = 0, fail = 0
const t = (n, ok, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : "  " + x}`) }
const num = s => Number(String(s).replace(/[^0-9.+-]/g, ""))

/** Everything this app keeps in the browser. Cleared going in so the journey is
 *  the same journey every run, and cleared coming out so it cannot poison the
 *  next suite — these keys outlive a page, not a process. */
const KEYS = ["beanemachine:config", "beanemachine:roster", "beanemachine:draft"]

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
const NOT_OURS = /fonts\.(?:gstatic|googleapis)\.com/
const foreign = []
const note = line => (NOT_OURS.test(line) ? foreign : errors).push(line)
page.on("pageerror", e => note(`pageerror: ${e}`))
page.on("console", m => { if (m.type() === "error") note(`console: ${m.text()}`) })
/** Asserted at every stage rather than once at the end, so a failure names the
 *  step that caused it instead of the last one. */
const clean = where => t(`no console or page errors ${where}`, errors.length === 0, errors.join(" | "))

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
 * Not `networkidle`. The page asks fonts.gstatic.com for a webfont, and where
 * that host is slow or unreachable the request stays open until the navigation
 * times out — a suite that fails on somebody else's CDN rather than on this app.
 * A rendered board is the readiness signal this suite actually means, and it is
 * already asserted below, so every navigation here waits for that instead.
 */
const arrive = async () => {
	await page.waitForSelector(".board-row", { timeout: 30000 })
}
await page.goto(BASE, { waitUntil: "domcontentloaded" })
await arrive()
await page.evaluate(keys => keys.forEach(k => localStorage.removeItem(k)), KEYS)
await page.reload({ waitUntil: "domcontentloaded" })
await arrive()

const tab = name => page.locator(".views button", { hasText: name }).first().click()
const rows = () => page.$$eval(".board-row .who b", n => n.map(e => e.textContent.trim()))
const codes = () => page.$$eval(".board-row .who .code", n => n.map(e => e.textContent.trim()))
const confs = () => page.$$eval(".board-row .conf-num", n => n.map(e => Number(String(e.textContent).replace("%", ""))))
const bscores = () => page.$$eval(".board-row .bscore", n => n.map(e => parseFloat(e.textContent)))
/** The board renders only its top 120, so the rendered count is not the ranking's
 *  size. This is the real one, read off the sentence that states it. */
const ranked = async () => {
	const subs = await page.$$eval(".sub", n => n.map(e => e.textContent))
	const line = subs.find(s => /players ranked in/.test(s))
	return line ? Number(line.match(/(\d[\d,]*) players ranked/)?.[1]?.replace(/,/g, "")) : null
}

// --- 1. landing, and the three horizons ---------------------------------------

t("the journey starts on a board with a ranking on it", (await rows()).length > 50)
const fortnight = (await rows()).slice(0, 10)
const fortnightCount = await ranked()

const horizon = async label => {
	await page.click(`.modes .mode:has-text('${label}')`)
	await page.waitForTimeout(400)
	await page.waitForSelector(".board-row", { timeout: 30000 })
	return (await rows()).slice(0, 10)
}
const stream = await horizon("Streaming")
t("switching to Streaming re-ranks against the next seven days",
	stream.length === 10 && stream.join() !== fortnight.join(), `${stream.slice(0, 3)} vs ${fortnight.slice(0, 3)}`)
const stash = await horizon("Stash")
t("switching to Stash re-ranks against the rest of the season",
	stash.length === 10 && stash.join() !== stream.join(), `${stash.slice(0, 3)} vs ${stream.slice(0, 3)}`)
// Billy's pick is drawn from rows[0], so it has to follow the horizon too — a
// stale pick above a re-ranked board is the reader's headline disagreeing with
// the table underneath it.
t("Billy's pick follows the horizon rather than lagging it",
	(await page.textContent(".pick-name")).trim() === stash[0], `${await page.textContent(".pick-name")} vs ${stash[0]}`)
const back = await horizon("This fortnight")
t("coming back to a horizon gives the same ranking it gave before",
	back.join() === fortnight.join(), `${back.slice(0, 3)} vs ${fortnight.slice(0, 3)}`)
t("every horizon left the ranking count intact", (await ranked()) === fortnightCount,
	`${await ranked()} vs ${fortnightCount}`)
clean("across the three horizons")

// --- 2. filtering, searching, re-ranking, raising the floor --------------------
//
// Each control is applied on top of the last rather than in isolation: a filter
// that silently drops out when the ranking changes only shows up in combination.

const search = page.locator(".board-controls .filters input[type=text]")
const settle = () => page.waitForTimeout(400)

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
const searched = new Set(await rows())
await page.selectOption("[data-ctl=sort]", "bscore")
await settle()
const reranked = await bscores()
t("changing the ranking re-orders by that column",
	reranked.length > 0 && reranked.every((v, i) => i === 0 || reranked[i - 1] >= v), String(reranked.slice(0, 5)))
t("re-ranking leaves no row behind that the filters excluded",
	(await rows()).every(n => searched.has(n)) && (await codes()).every(c => c === "C"),
	(await rows()).filter(n => !searched.has(n)).join(", "))

await search.fill("")
await settle()
const floorless = await rows()
const floorlessConf = await confs()
t("clearing the search restores the whole filtered board",
	floorless.length === catchers.length, `${floorless.length} vs ${catchers.length}`)

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
	floorless.length === catcherCount, `${floorless.length} rendered of ${catcherCount} ranked`)
await page.selectOption("[data-ctl=confidence]", "0.7")
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
await page.selectOption("[data-ctl=confidence]", "0")
await page.selectOption("[data-ctl=sort]", "marketEdge")
await page.click('.board-controls .chip-btn:text-is("All")')
await settle()
t("clearing every filter returns the board it opened on",
	(await ranked()) === fortnightCount && (await rows()).slice(0, 10).join() === fortnight.join(),
	`${await ranked()} vs ${fortnightCount}`)
clean("after filtering, searching, re-ranking and raising the floor")

// --- 3. the draft, and whether it reaches the team the trade page prices -------

at("the draft page opens with a recommendation on it")
await tab("Draft")
await page.waitForSelector(".draft-pick .pick-who b", { timeout: 30000 })
const firstPick = (await page.textContent(".draft-pick .pick-who b")).trim()

// "Gone" is somebody else's pick: off the board, and NOT onto your team.
at("marking a player gone leaves a different recommendation behind")
await page.click(".draft-pick .pick-acts button.ghost")
await page.waitForFunction(
	name => document.querySelector(".draft-pick .pick-who b")?.textContent.trim() !== name,
	firstPick, { timeout: 15000 }
)
const secondPick = (await page.textContent(".draft-pick .pick-who b")).trim()
t("marking a player taken changes who you are told to take next",
	secondPick !== firstPick, `${firstPick} → ${secondPick}`)

// "I took him" is both: off the board AND mine.
at("claiming a player is counted as yours as well as gone")
await page.click(".draft-pick .pick-acts button.primary")
await page.waitForFunction(() => /·\s*1 yours/.test(document.querySelector(".draft-gone h3")?.textContent ?? ""),
	{ timeout: 15000 })
const tally = (await page.textContent(".draft-gone h3")).trim()
t("the draft counts both marks and separates them", /^2 off the board · 1 yours$/.test(tally), tally)
const drafted = await page.$$eval(".draft-mine .draft-picks .chip", n => n.map(e => e.textContent))
t("the player you claimed is on what you have drafted",
	drafted.some(c => c.includes(secondPick)), drafted.join(" | "))
t("the player somebody else took is not",
	!drafted.some(c => c.includes(firstPick)), drafted.join(" | "))

// The two stores are separate on purpose — who is gone, and who is yours — so
// the claim has to land in both and the strike in only one.
const stored = await page.evaluate(() => ({
	draft: JSON.parse(localStorage.getItem("beanemachine:draft") ?? "{}"),
	roster: JSON.parse(localStorage.getItem("beanemachine:roster") ?? "{}")
}))
const leagueKey = Object.keys(stored.draft)[0]
t("both marks are off the board, and only the claim is on the team",
	stored.draft[leagueKey]?.length === 2 && stored.roster[leagueKey]?.length === 1,
	JSON.stringify(stored))

// back to the board, which must be unmoved by any of it
at("the board comes back after the draft")
await tab("Recommendations")
await page.waitForSelector(".board-row", { timeout: 30000 })
t("the board is still the board after a detour through the draft",
	(await ranked()) === fortnightCount && (await rows()).slice(0, 10).join() === fortnight.join(),
	`${await ranked()} vs ${fortnightCount}`)

// THE integration point: the draft wrote a roster, and this page is the one that
// prices it. Nothing translates between them, so a drift in either key shows up
// here as a team that is empty or as an id nobody can resolve.
at("the trade page opens on the team the draft wrote")
await tab(/trade/i)
await page.waitForSelector(".trade-team", { timeout: 30000 })
const team = await page.$$eval(".trade-own .who b", n => n.map(e => e.textContent.trim()))
t("the player claimed in the draft is on the team the trade page prices",
	team.length === 1 && team[0] === secondPick, `${team.join(", ")} vs ${secondPick}`)
t("the player someone else drafted never reached your team",
	!team.includes(firstPick), team.join(", "))
t("no id crossed over that this page cannot resolve",
	(await page.$$(".trade-unresolved li")).length === 0,
	(await page.$$eval(".trade-unresolved li", n => n.map(e => e.textContent))).join(" | "))
clean("after the draft-to-team hand-off")

// --- 4. a trade, priced ------------------------------------------------------

at("a second player can be added to the team and priced")
await page.fill("[data-ctl=own-search]", "a")
await page.waitForSelector('.trade-results .trade-line button:text-is("Add")', { timeout: 15000 })
await page.locator('.trade-results .trade-line button:text-is("Add")').first().click()
await page.waitForFunction(() => document.querySelectorAll(".trade-own").length === 2, { timeout: 15000 })
const lineupTotal = num(await page.textContent(".lineup-total"))
t("a two-man team produces a real lineup total", Number.isFinite(lineupTotal) && lineupTotal > 0, String(lineupTotal))

at("offering a player produces a verdict")
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
t("before is the lineup total this page was already showing",
	Math.abs(before - lineupTotal) < 0.15, `${before} vs ${lineupTotal}`)
t("the verdict names the player arriving",
	((await page.textContent(".verdict-why")) ?? "").includes(arriving.split(" ").pop()), arriving)
clean("after pricing a trade")

// --- 5. a reload, and what survives it ---------------------------------------
//
// Everything above lives in this browser rather than on a server, so a reload is
// the only thing that proves it was ever written. A half-built offer is the one
// thing that must NOT survive: it was never stored, and an offer that reappeared
// would be one nobody made.

const teamBefore = await page.$$eval(".trade-own .who b", n => n.map(e => e.textContent.trim()).sort())
at("a reload lands back on a working board")
await page.reload({ waitUntil: "domcontentloaded" })
await arrive()
t("a reload lands back on a working board", (await rows()).length > 50)
t("and on the ranking it opened on", (await ranked()) === fortnightCount, `${await ranked()} vs ${fortnightCount}`)

at("the trade page still opens after the reload")
await tab(/trade/i)
await page.waitForSelector(".trade-team", { timeout: 30000 })
t("the team survived the reload",
	(await page.$$eval(".trade-own .who b", n => n.map(e => e.textContent.trim()).sort())).join() === teamBefore.join(),
	teamBefore.join(", "))
t("the half-built offer did not", (await page.$$(".trade-verdict")).length === 0)

at("the draft page still opens after the reload")
await tab("Draft")
await page.waitForSelector(".draft-gone h3", { timeout: 30000 })
const tallyAfter = (await page.textContent(".draft-gone h3")).trim()
t("the draft board survived the reload, and now counts the man added on the trade page",
	/^2 off the board · 2 yours$/.test(tallyAfter), tallyAfter)
const goneChips = await page.$$eval(".draft-gone .draft-picks .chip-btn", n => n.map(e => e.textContent.replace(/\s*×$/, "").trim()))
t("both players marked in the draft are still off the board",
	goneChips.includes(firstPick) && goneChips.includes(secondPick), goneChips.join(", "))
t("nothing marked has become an id the capture cannot resolve",
	(await page.$$(".draft-unresolved li")).length === 0,
	(await page.$$eval(".draft-unresolved li", n => n.map(e => e.textContent))).join(" | "))
clean("after the reload")

// --- 6. leave the browser as it was found ------------------------------------

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
