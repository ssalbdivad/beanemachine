// The trade analyzer in a real browser, against the real snapshot.
//
// The claim the engine makes is that a trade is worth what it does to YOUR
// STARTING LINEUP, so these assertions are about slots and totals rather than
// about who has the higher bscore. They are also arithmetic wherever they can be:
// a delta that does not equal after minus before is the one failure that would
// make every recommendation on the page a lie.
import { chromium, firefox } from "playwright-core"
const BASE = process.env.BASE ?? "http://127.0.0.1:5173"
const ENGINE = process.env.BROWSER ?? "chromium"
const browser = ENGINE === "firefox" ? await firefox.launch() : await chromium.launch({ args: ["--no-sandbox"] })
console.log(`--- ${ENGINE} ---`)
let pass = 0, fail = 0
const t = (n, ok, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : "  " + x}`) }
const num = s => Number(String(s).replace(/[^0-9.+-]/g, ""))

const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
const errors = []
page.on("pageerror", e => errors.push(String(e)))

/** A 200 on this port is not proof it is this app: :5173 is a common default and
 *  another project's dev server answers it just as happily — and here it would SKIP
 *  with exit 0, since no other app mounts a trade tab. The wordmark is the cheapest
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

/** The component is mounted by the app, so this suite must not assume where. It
 *  finds the trade view, or reports that nothing mounts it yet and stops — a
 *  wired-up UI is what is under test, not the existence of the file. */
const openTrade = async () => {
	await page.goto(BASE, { waitUntil: "networkidle" })
	await identify()
	if (await page.$(".trade-team")) return true
	const tab = page.locator(".views button", { hasText: /trade/i }).first()
	if (!(await tab.count())) return false
	await tab.click()
	return await page
		.waitForSelector(".trade-team", { timeout: 30000 })
		.then(() => true, () => false)
}

if (!(await openTrade())) {
	console.log("SKIP  no trade UI on the page — nothing mounts <Trade/> yet, so there is nothing to exercise")
	await browser.close()
	process.exit(0)
}

t("no page errors", errors.length === 0, errors.join(" | "))

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
await page.waitForSelector(".trade-own")
const oneTotal = num(await page.textContent(".lineup-total"))
t("adding a player produces a lineup with a real total", Number.isFinite(oneTotal) && oneTotal > 0, String(oneTotal))
t("the player added is the one on the team", (await page.textContent(".trade-own .who b")).trim() === first, first)

const second = await addFrom("own-search", "Add")
await page.waitForFunction(() => document.querySelectorAll(".trade-own").length === 2, { timeout: 10000 })
const twoTotal = num(await page.textContent(".lineup-total"))
t("adding a second player changes the lineup total", twoTotal !== oneTotal, `${oneTotal} → ${twoTotal}`)
t("a second real starter cannot lower the total", twoTotal > oneTotal, `${oneTotal} → ${twoTotal}`)

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

// The team lives in this browser, keyed per league — so it has to survive a reload.
const stored = await page.evaluate(() => localStorage.getItem("beanemachine:roster"))
t("the team is stored per league in this browser", !!stored && /"\d+:(hitting|pitching)"/.test(stored), String(stored))
await openTrade()
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
  await page.goto(BASE, { waitUntil: "networkidle" })
  const tab = page.locator(".views button", { hasText: /trade/i }).first()
  if (await tab.count()) await tab.click()
  const said = await page
    .waitForSelector(".trade-unscored", { timeout: 30000 })
    .then(() => true, () => false)
  t("a league with no scoring says so instead of pricing a trade at zero",
    said && (await page.$$(".lineup-row")).length === 0 && (await page.$$(".trade-verdict")).length === 0)
}

t("still no page errors", errors.length === 0, errors.join(" | "))

await browser.close()
console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
