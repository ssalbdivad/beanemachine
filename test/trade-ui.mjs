// The trade analyzer in a real browser, against the real snapshot.
import { readFileSync } from "node:fs"
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
	await page.goto(BASE, { waitUntil: "networkidle" })
	await identify()
	const tab = page.locator(".views button", { hasText: /trade/i }).first()
	if (await tab.count()) {
		await tab.click()
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
 */
const cardOrder = await page.$$eval("section.card h2", n => n.map(e => e.textContent.trim()))
const at = re => cardOrder.findIndex(h => re.test(h))
t("the recommendation comes before the lineup, and both before the deal",
  at(/add and drop/i) > -1 && at(/add and drop/i) < at(/starting lineup/i) &&
    at(/starting lineup/i) < at(/the deal/i),
  cardOrder.join(" | "))

/*
 * ...and it no longer ANSWERS here, it points.
 *
 * This card used to propose moves of its own, and it needed the SEATS your league
 * has you in plus an exact free-agent list to do it — so a visitor who had just
 * typed his team in on this very page was told to go and read a roster, and a Yahoo
 * user was told the page "needs the local server". The decision card on
 * Recommendations needs neither and is strictly better. Two answers to one question
 * is the thing this app keeps having to stop doing.
 */
const adviceCard = await page.$("section.advice")
t("but it defers to the card that owns the question rather than answering twice",
  !!adviceCard && /Recommendations/.test(await adviceCard.innerText()) &&
    !/needs the local server/.test(await adviceCard.innerText()),
  adviceCard ? (await adviceCard.innerText()).replace(/\n/g, " ").slice(0, 160) : "(no card)")
t("and offers a control that goes there, not an instruction to go looking",
  !!(await page.$("section.advice button")), "no control on the advice card")

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
	await page.goto(BASE, { waitUntil: "networkidle", timeout: 60000 })
	const tab = page.locator(".views button", { hasText: /trade/i }).first()
	if (await tab.count()) {
		await tab.click()
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

await browser.close()
console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
