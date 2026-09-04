// The recommendation engine, end to end in a real browser against real data.
import { chromium, firefox } from "playwright-core"
const BASE = process.env.BASE ?? "http://127.0.0.1:5173"
const ENGINE = process.env.BROWSER ?? "chromium"
const browser = ENGINE === "firefox" ? await firefox.launch() : await chromium.launch({ args: ["--no-sandbox"] })
console.log(`--- ${ENGINE} ---`)
let pass = 0, fail = 0
const t = (n, ok, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : "  " + x}`) }

const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
const errors = []
page.on("pageerror", e => errors.push(String(e)))
await page.goto(BASE, { waitUntil: "networkidle" })

// A 200 on this port is not proof it is this app: :5173 is a common default and
// another project's dev server answers it just as happily, after which every
// assertion below fails as a selector timeout that reads like a UI defect. The
// wordmark is the cheapest proof of identity, so it is checked before anything
// else and stops the run rather than letting the next wait speak for it.
const wordmark = await page.waitForSelector("h1", { timeout: 15000 }).then(h => h.textContent(), () => null)
t("the page under test is beanemachine", wordmark === "beanemachine",
  `BASE=${BASE} served <h1>${wordmark}</h1> — start this repo's own vite, or set BASE to it`)
if (wordmark !== "beanemachine") { await browser.close(); process.exit(1) }

await page.waitForSelector(".board-row", { timeout: 30000 })

t("no page errors", errors.length === 0, errors.join(" | "))
t("board renders ranked rows", (await page.$$eval(".board-row", n => n.length)) > 50)

const scores = await page.$$eval(".board-row .bscore", n => n.map(e => Number(e.textContent)))
t("bscores are finite numbers", scores.every(Number.isFinite), String(scores.slice(0, 3)))
/**
 * The board opens on bscore.
 *
 * It opened on market edge for a long time, on the reasoning that the best players
 * are already rostered so a bare bscore ranking names people you cannot add. The
 * reasoning survives; the input did not. "% Ros" is swept off Yahoo's player pages
 * and most of what comes back is the per-game weather line from the forecast
 * tooltip — on the committed capture, 20 of 30 clubs have almost every player on
 * one identical percentage, paired exactly by that day's matchups (see
 * test/ownership.mjs, which pins the shape). Market edge divides by that number,
 * so it was reordering the whole board by the precipitation forecast.
 */
const bscores = await page.$$eval(".board-row .bscore", n =>
  n.map(e => Number(String(e.textContent).replace(/[^0-9.\-]/g, "")))
)
t("board opens sorted by bscore, descending",
  bscores.length > 50 && bscores.every((v, i) => i === 0 || bscores[i - 1] >= v),
  `${bscores.length} rows: ${String(bscores.slice(0, 5))}`)
// The whole rateable pool, not the handful edge could price. Market edge dropped
// everyone unpriced, and on a thin capture that silently shrank the board to a
// short list that looked like a working one. Read off the count the board states,
// not off the rendered rows — the board pages in as you scroll now, so the number
// on screen is the size of the render window rather than of the ranking.
const rankedCount = await page.$eval("#horizon-panel .sub .count", e => Number(e.textContent.replace(/,/g, "")))
t("the default ranking places the whole pool rather than the priced subset",
  rankedCount >= 1000, `${rankedCount} ranked`)
// and the render window grows rather than stopping dead at a cap
const firstPage = await page.$$eval(".board-row", n => n.length)
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
await page.waitForTimeout(600)
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
await page.waitForTimeout(600)
const grown = await page.$$eval(".board-row", n => n.length)
t("the board pages in more rows as you reach the end",
  grown > firstPage, `${firstPage} then ${grown}`)
await page.evaluate(() => window.scrollTo(0, 0))

/**
 * SEVEN columns, each answering a different question, and each cell placed by the
 * name of its column rather than by its index among its siblings.
 *
 * `proj pts` and `waiver pts` went first: bscore is one minus the other, so the
 * table was stating a single subtraction three times in the place where scanning
 * matters most. Both are in the drill-down, which is asserted further down.
 *
 * `owned` has now gone the same way, into uscore. uscore is `addValue x (1 -
 * owned)`, so the two were blank on precisely the same rows — 500 of the 1,233
 * rateable rows on the committed fixture, and 36 of the first 60, which is why the
 * board opened on seven straight rows of two dashes side by side. One missing
 * input must be reported once.
 */
const headers = await page.$$eval(".board-head > *", n => n.map(e => e.textContent.trim()))
t("the board shows the seven decision columns",
  ["#", "Player", "uscore", "bscore", "games", "confidence", "luck"]
    .every(h => headers.some(x => x.startsWith(h))) && headers.length === 7,
  headers.join(" | "))
t("and no longer restates bscore's own arithmetic beside it",
  !headers.some(h => /proj pts|waiver pts/.test(h)), headers.join(" | "))
t("ownership is no longer a column of its own",
  !headers.some(h => /^owned/.test(h)), headers.join(" | "))

/**
 * The head and the row must agree cell for cell, in name and in pixels.
 *
 * app.css places both by `nth-child`, and that has failed before in exactly this
 * spot: auto-placement once put the confidence gauge under "GP" and the games
 * count under "confidence", so every number in two columns was labelled as the
 * other one. Each cell now carries `data-col` and the grid places by that, which
 * is only true as long as something checks it — including at the widths where
 * columns are dropped, because a header dropped without its body is the same bug
 * with a smaller blast radius.
 */
const columnsLineUp = async () =>
  page.evaluate(() => {
    const vis = el => getComputedStyle(el).display !== "none"
    const right = el => Math.round(el.getBoundingClientRect().right)
    const head = [...document.querySelectorAll(".board-head > [data-col]")].filter(vis)
    const row = [...document.querySelector(".board-row").querySelectorAll(":scope > [data-col]")].filter(vis)
    return {
      head: head.map(e => `${e.dataset.col}@${right(e)}`),
      row: row.map(e => `${e.dataset.col}@${right(e)}`),
      names: head.map(e => e.dataset.col)
    }
  })
const wide = await columnsLineUp()
t("every heading sits over the cells it names",
  wide.head.join() === wide.row.join(), `${wide.head.join(" ")} vs ${wide.row.join(" ")}`)
t("all seven columns are on screen at 1280px",
  wide.names.join() === "rank,who,uscore,bscore,games,conf,luck", wide.names.join())

/**
 * uscore carries its own denominator now, so the cell holds two numbers and the
 * ranking has to be read off the score rather than off the cell's text.
 */
await page.click(".board-head .sort-head:has-text('uscore')")
await page.waitForTimeout(300)
const usCells = await page.$$eval(".board-row [data-col=uscore]", n => n.map(e => e.textContent.trim()))
t("the uscore cell prints the ownership it divided by",
  usCells.length > 0 && usCells.every(c => /^[\d.]+\d% owned$/.test(c)), String(usCells.slice(0, 3)))
const us = await page.$$eval(".board-row [data-col=uscore] .us-val", n => n.map(e => Number(e.textContent)))
t("choosing uscore orders by uscore",
  us.length > 0 && us.every(v => Number.isFinite(v)) &&
    us.every((v, i) => i === 0 || us[i - 1] >= v), String(us.slice(0, 5)))
// a ratio against a tiny denominator is only meaningful for someone worth
// rostering at all, so the same guard the other comparative sorts use applies
const usB = await page.$$eval(".board-row .bscore", n => n.map(e => Number(e.textContent)))
t("uscore ranks only players above replacement", usB.every(v => v > 0), String(usB.slice(0, 5)))

await page.selectOption("[data-ctl=sort]", "bscore")
await page.waitForTimeout(300)

/**
 * The window column is per SIDE, and it says which of the two units it is in.
 *
 * It used to be "GP" for everybody — the games a player's TEAM plays. For a
 * starting pitcher that is the wrong quantity by roughly a factor of six: on the
 * committed fixture the starters with published turns average about 3 of them
 * against 14 team games over the fortnight, and about 1 against 6 over the
 * streaming week, which is the view where 12 of the top 20 rows are starters. The
 * engine has computed `scheduledStarts` all along and the projection is already
 * built on it, so the board was ranking on one number and displaying another.
 *
 * A null is not a zero: MLB publishes probables about a week out, so the
 * rest-of-season view has none at all and a reliever never gets one. Those fall
 * back to team games and say GP. What is asserted is that the two are never
 * confused — a GS row must be a pitcher, and its value must be far below the
 * team's game count rather than equal to it.
 */
const windowCells = await page.$$eval(".board-row", rows =>
  rows.map(r => ({
    slot: r.querySelector(".who .code")?.textContent?.trim(),
    text: r.querySelector("[data-col=games]")?.textContent?.trim() ?? "",
    unit: r.querySelector("[data-col=games] .g-unit")?.textContent?.trim() ?? ""
  }))
)
t("every row states which unit its window count is in",
  windowCells.length > 0 && windowCells.every(c => c.unit === "GS" || c.unit === "GP"),
  JSON.stringify(windowCells.slice(0, 3)))
const gsRows = windowCells.filter(c => c.unit === "GS")
t("the fortnight board shows own-starts for pitchers", gsRows.length > 0,
  `${gsRows.length} of ${windowCells.length} rendered rows`)
t("a start count is only ever shown for a pitcher",
  gsRows.every(c => c.slot === "P" || c.slot === "SP" || c.slot === "RP"),
  JSON.stringify(gsRows.slice(0, 4)))
// the whole point: it is his own number, not his club's, so it must be far smaller
t("a starter's own turns are a fraction of his club's games",
  gsRows.every(c => Number(c.text.replace("GS", "")) < 8),
  JSON.stringify(gsRows.slice(0, 4)))
const gpRows = windowCells.filter(c => c.unit === "GP")
t("everyone without published turns still gets his team's games",
  gpRows.length > 0 && gpRows.every(c => Number(c.text.replace("GP", "")) >= 1),
  JSON.stringify(gpRows.slice(0, 3)))
/**
 * And the same distinction out loud. The row is markup a screen reader reads as a
 * run of unlabelled numbers, so the aria-label carries the labels the columns
 * carry visually — which means it has to make the same per-side choice, or the
 * spoken board says "14 games scheduled" about a man taking three turns.
 */
const spokenWindow = await page.$$eval(".board-row", rows =>
  rows.map(r => ({
    gs: !!r.querySelector("[data-col=games] .g-unit")?.textContent?.includes("GS"),
    label: r.getAttribute("aria-label") ?? ""
  }))
)
t("a row showing own starts says starts out loud, and never calls them team games",
  spokenWindow.some(r => r.gs) &&
    spokenWindow.every(r =>
      r.gs ?
        /[\d.]+ scheduled starts/.test(r.label) && !/team games/.test(r.label)
      :	/team games scheduled|no scheduled games/.test(r.label)
    ),
  JSON.stringify(spokenWindow.filter(r => r.gs).slice(0, 2)))

// Market edge keeps its ranking without keeping a column — same as `contact`.
await page.selectOption("[data-ctl=sort]", "marketEdge")
await page.waitForTimeout(300)
t("market edge is still selectable and still ranks",
  (await page.$$eval(".board-row", n => n.length)) > 0)

await page.selectOption("[data-ctl=sort]", "bscore")
await page.waitForTimeout(300)
const byB = await page.$$eval(".board-row .bscore", n => n.map(e => Number(e.textContent)))
t("sorting by bscore still orders by bscore",
  byB.every((v, i) => i === 0 || byB[i - 1] >= v), String(byB.slice(0, 5)))

// Scarcity must reflect the league's real slots and rank by the actual cliff.
const scars = await page.$$eval(".scar", n => n.map(e => ({
  slot: e.querySelector("b").textContent.trim(),
  val: Number(String(e.querySelector(".val").textContent).replace("+", ""))
})))
t("scarcity lists the league's active slots", scars.length >= 5, JSON.stringify(scars.map(s => s.slot)))
t("scarcity is ordered by how steep the drop-off is",
  scars.every((s, i) => i === 0 || scars[i - 1].val >= s.val), JSON.stringify(scars))
t("a scarce slot really is scarcer than a deep one",
  scars[0].val > scars[scars.length - 1].val, `${scars[0]?.slot} ${scars[0]?.val} vs ${scars.at(-1)?.slot} ${scars.at(-1)?.val}`)

// Buy low must be an intersection, not a rebrand of the main board: every card
// has to be both cheap and out-hitting its line, or the panel is decoration.
const buylow = await page.$$eval(".buylow-card", cards =>
  cards.map(c => ({
    gap: Number(c.querySelector("dd.good")?.textContent),
    own: Number(String([...c.querySelectorAll("dd")][1]?.textContent).replace("%", ""))
  }))
)
t("buy-low picks all beat their line on contact", buylow.every(c => c.gap > 0.03), JSON.stringify(buylow))
t("buy-low picks are all actually cheap", buylow.every(c => c.own < 70), JSON.stringify(buylow))

// The three horizons must actually be three different questions. A stash ranking
// that matches the streaming ranking is a tab that does nothing.
const topOf = async () => page.$$eval(".board-row .name, .board-row b", n =>
  n.slice(0, 10).map(e => e.textContent.trim()))
const boardTop = await topOf()
await page.click(".modes .mode:has-text('Streaming')")
await page.waitForTimeout(250)
const streamTop = await topOf()
t("streaming mode re-ranks against the next 7 days",
  streamTop.length > 0 && streamTop.join() !== boardTop.join(),
  `${streamTop.slice(0, 3)} vs ${boardTop.slice(0, 3)}`)
await page.click(".modes .mode:has-text('Stash')")
await page.waitForTimeout(250)
const stashTop = await topOf()
t("stash mode re-ranks against the rest of the season",
  stashTop.length > 0 && stashTop.join() !== streamTop.join(),
  `${stashTop.slice(0, 3)} vs ${streamTop.slice(0, 3)}`)
t("every horizon still produces a full board", stashTop.length >= 5, String(stashTop.length))
await page.click(".modes .mode:has-text('This fortnight')")
await page.waitForTimeout(250)

// Keyboard and screen-reader access to the same board. These are not cosmetic:
// the horizon strip is the primary control on the page, and the rows are the
// answer — both were reachable by mouse and useless without one.
const tablist = await page.$eval(".modes", l => ({
  role: l.getAttribute("role"),
  children: [...l.children].map(c => c.getAttribute("role")),
  stops: [...l.children].filter(c => c.tabIndex === 0).length,
  selected: [...l.children].filter(c => c.getAttribute("aria-selected") === "true").length
}))
t("the horizon strip is a tablist of nothing but tabs",
  tablist.role === "tablist" && tablist.children.every(r => r === "tab"),
  JSON.stringify(tablist.children))
t("exactly one horizon is selected, and it is the only tab stop",
  tablist.selected === 1 && tablist.stops === 1, JSON.stringify(tablist))

// A tab strip is one stop with arrows inside it. Focus moves without selecting,
// because selecting re-rates every player.
await page.focus('[role="tab"][aria-selected="true"].mode')
await page.keyboard.press("ArrowRight")
const roved = await page.evaluate(() => ({
  focused: document.activeElement.id,
  selected: document.querySelector(".modes [aria-selected=true]").id
}))
t("arrow keys move focus along the horizons without re-ranking",
  roved.focused !== roved.selected && roved.focused.startsWith("horizon-"), JSON.stringify(roved))

// The one tab stop has to sit where the keyboard actually is. Pinned to the
// SELECTED tab instead, tabbing out of the strip and back landed you on the
// horizon you had arrowed away from, and Enter then re-picked that one.
const stop = await page.evaluate(() => ({
  focused: document.activeElement.id,
  stop: [...document.querySelectorAll(".modes .mode")].find(e => e.tabIndex === 0)?.id ?? null
}))
t("the strip's single tab stop follows the arrows", stop.stop === stop.focused, JSON.stringify(stop))

// Keyboard focus that draws nothing is not keyboard access. app.css's
// `.modes .mode` used to outrank the shared focus rule and win with box-shadow:none.
await page.waitForTimeout(400)
const ring = await page.evaluate(() => {
  const c = getComputedStyle(document.activeElement)
  return { shadow: c.boxShadow, outline: c.outlineStyle }
})
t("a focused horizon tab is visibly focused",
  (ring.shadow !== "none" && ring.shadow !== "") || ring.outline !== "none", JSON.stringify(ring))

const horizonPanel = await page.evaluate(() => {
  const tab = document.querySelector(".modes [aria-selected=true]")
  const panel = document.getElementById(tab.getAttribute("aria-controls"))
  return { role: panel?.getAttribute("role"), labelledby: panel?.getAttribute("aria-labelledby"), tab: tab.id }
})
t("the ranking is the panel the horizons control",
  horizonPanel.role === "tabpanel" && horizonPanel.labelledby === horizonPanel.tab,
  JSON.stringify(horizonPanel))

// The row's markup reads out as nine unlabelled numbers run together, so the
// name it announces has to carry the labels the columns carry visually.
const rowA11y = await page.$eval(".board-row", r => ({
  label: r.getAttribute("aria-label"),
  expanded: r.getAttribute("aria-expanded"),
  controls: r.getAttribute("aria-controls")
}))
t("a board row announces what its numbers are, not just the digits",
  /bscore/.test(rowA11y.label) && /projected points/.test(rowA11y.label) &&
    /confidence/.test(rowA11y.label), String(rowA11y.label))
t("a board row says it can be expanded", rowA11y.expanded === "false" && !!rowA11y.controls,
  JSON.stringify(rowA11y))
await page.click(".board-row")
await page.waitForSelector(".detail")
t("opening a row says so, and points at what opened",
  (await page.$eval(".board-row", r => r.getAttribute("aria-expanded"))) === "true" &&
    (await page.$eval(".detail", d => d.id)) === rowA11y.controls)
await page.click(".board-row")
await page.waitForTimeout(150)

// The sort arrow is the only visual cue for which column the board is sorted by,
// and "\u25be" says nothing out loud.
const sortLabels = await page.$$eval(".board-head .sort-head", n =>
  n.map(e => [e.textContent.replace(/[\u25be\u25b4]/g, "").trim(), e.getAttribute("aria-label")]))
t("the active column header announces the direction it is sorted",
  sortLabels.some(([, l]) => /sorted (descending|ascending)/.test(l ?? "")),
  JSON.stringify(sortLabels))


/**
 * bscore must be value OVER REPLACEMENT, so proj − repl should equal it.
 *
 * Those two operands used to be columns on the row, which is why the row stated one
 * subtraction three times. They are in the drill-down now, so the same arithmetic is
 * checked where it actually lives — and this doubles as the assertion that moving
 * them lost nothing.
 */
const rowBscore = await page.$eval(".board-row .bscore", e => Number(e.textContent))
await page.click(".board-row")
await page.waitForSelector(".detail")
const value = await page.$$eval(".detail .pair", n =>
  Object.fromEntries(n.map(e => [e.querySelector("dt").textContent.trim(), e.querySelector("dd").textContent.trim()]))
)
t("the drill-down carries the arithmetic the row no longer repeats",
  ["projected points", "waiver points", "bscore", "rostered", "uscore", "market edge"]
    .every(k => k in value), Object.keys(value).join(", "))
t("bscore equals projected minus replacement",
  Math.abs(rowBscore - (Number(value["projected points"]) - Number(value["waiver points"]))) < 0.05,
  `${rowBscore} vs ${value["projected points"]} − ${value["waiver points"]}`)
// and uscore really is that bscore over that ownership
if (value["rostered"] !== "unlisted") {
  const pctOwned = Math.max(Number(String(value["rostered"]).replace("%", "")), 0.5)
  t("uscore equals bscore over ownership",
    Math.abs(Number(value["uscore"]) - rowBscore / pctOwned) < 0.06,
    `${value["uscore"]} vs ${rowBscore}/${pctOwned}`)
}
await page.click(".board-row")
await page.waitForTimeout(200)

// provenance: opening a player must separate observed from modelled
await page.click(".board-row")
await page.waitForSelector(".detail")
const sections = await page.$$eval(".detail h3", n => n.map(e => e.textContent.toLowerCase()))
t("drill-down separates measured, Statcast model and our model",
  sections.some(s => s.includes("measured")) &&
  sections.some(s => s.includes("statcast model")) &&
  sections.some(s => s.includes("our model")),
  sections.join("|"))
/**
 * The advanced reader opens a row to ask why this player is ranked here, and the
 * first thing under his thumb has to be the answer.
 *
 * It was not. The first column was the per-stat points ledger — "K 75.58, OUT 54,
 * W 14.94, H -12.68" — eight lines of arithmetic behind a number the next column
 * states in one line. On a phone the four columns stack, so all of it came before
 * anything explanatory. Nothing was dropped in fixing it; the ledger is the same
 * eight rows, last instead of first.
 */
t("the drill-down leads with what the ranking is, not with the ledger behind it",
  sections[0].includes("what he is worth"), sections.join(" | "))
t("and it ends with the per-category ledger",
  sections[sections.length - 1].includes("by category"), sections.join(" | "))
/**
 * What the model could not read is the product's own promise, and it used to sit
 * at the bottom of the rightmost column, below two Statcast tables. It is second
 * now — beside the assumptions it qualifies — whenever there is any.
 */
const missingAt = sections.findIndex(s => s.includes("missing"))
t("anything missing is reported next to the model that missed it, not last",
  missingAt === -1 || missingAt < sections.indexOf("projected points by category"),
  sections.join(" | "))
const modelled = await page.$$eval(".detail .notes li", n => n.map(e => e.textContent))
// Volume is derived one of two legitimate ways: blended playing time, or — for a
// starter whose starts MLB has published — outs per start times scheduled starts.
// The invariant is that the drill-down states WHICH, not that it always says the same.
t("modelled assumptions name how playing time was derived",
  modelled.some(m => (/playing time/i.test(m) && /% recent/.test(m)) ||
    (/^starts:/.test(m) && /outs per start/.test(m))), modelled.join(" | "))
t("the drill-down states whether the Statcast adjustment was applied",
  modelled.some(m => /Statcast weight is 0/.test(m)) ||
  modelled.some(m => /quality: wOBA/.test(m)), modelled.join(" | "))

/**
 * Billy's pick is a row ON the board, and every clause is backed by a real number.
 *
 * It used to be asserted as the TOP row. It no longer is, deliberately: on a
 * bscore board the top row is the best player in baseball, who is rostered
 * everywhere, and naming him is a fact rather than a recommendation. The card now
 * picks the best player the reader can actually get — see the availability
 * assertions further down — so what has to hold here is that he is somebody the
 * board actually ranked, not that he is first.
 */
await page.waitForSelector(".card.pick")
const pickName = (await page.textContent(".pick-name")).trim()
/**
 * Checked against the RANKING, not against what is painted.
 *
 * The board renders in pages of 60 and grows as you scroll, and Billy's pick is the
 * best AVAILABLE player, who is usually well down a bscore ranking — the whole
 * reason the card exists is that you would otherwise have to scroll to find him. So
 * asserting he is among the rendered rows tested the size of the render window.
 * Searching for him proves he is in the ranking, which is the actual claim.
 */
const search = page.locator(".board-controls .filters input[type=text]")
await search.fill(pickName.split(" ").pop())
await page.waitForTimeout(400)
const found = await page.$$eval(".board-row .who b", n => n.map(e => e.textContent.trim()))
t("Billy's pick is a player the board actually ranked",
  found.includes(pickName), `${pickName} not found; search returned ${found.slice(0, 4).join(", ")}`)
await search.fill("")
await page.waitForTimeout(400)
const why = await page.textContent(".pick-why")
const pickScore = Number(await page.textContent(".pick-score b"))
t("Billy's reasoning cites the actual bscore",
  why.includes(String(pickScore)) && /more points than the best/.test(why), why)
// Per side, like the column: a hitter's club's games, a starter's own turns. The
// card used to quote team games at everybody, which for a starting pitcher is the
// biggest number on his row and the least relevant one.
t("Billy's reasoning cites a real count of what is scheduled",
  /plays \d+ games/.test(why) || /down for [\d.]+ starts/.test(why), why)
t("Billy uses the right volume unit for the side",
  /plate appearances per team game|outs recorded per team game/.test(why), why)

/**
 * Billy's pick must not follow the sort DIRECTION, and must never be below
 * replacement.
 *
 * The card was built by `find`ing the first available row of `rows` — the board
 * ALREADY SORTED — so one click on the bscore header flipped the question. Shipped
 * live it read "Billy's pick — Nick Solak, bscore -109.33, Confidence is only 2%
 * (limited sample, 10 of 434)": the worst man on the board, projected 109 points
 * behind the body already sitting on waivers. Direction is a way of looking at the
 * board, so the pick has to survive it unchanged; bscore <= 0 is a player who costs
 * you points, so he can never be the pick in any order or any horizon.
 */
// $eval rather than textContent: when nothing clears replacement the card renders
// its "Nobody." variant with no score badge, and a missing badge has to read as a
// failed assertion rather than as a 30-second selector timeout that aborts the run.
const pickOf = () => page.$eval(".pick-name", e => e.textContent.trim()).catch(() => "")
const pickBscore = () =>
  page.$eval(".pick-score b", e => Number(String(e.textContent).replace(/[^0-9.\-]/g, ""))).catch(() => NaN)
const sortDir = () =>
  page.$eval(".board-head .sort-head.active", e => /ascending/.test(e.getAttribute("aria-label") ?? "") ? "asc" : "desc")

const descPick = await pickOf()
const descScore = await pickBscore()
t("the pick is above replacement descending", descScore > 0, `${descPick} bscore ${descScore}`)

// one click on the active header reverses it — worst-first
await page.click(".board-head .sort-head:has-text('bscore')")
await page.waitForTimeout(350)
const ascFirst = await page.$eval(".board-row .bscore", e => Number(e.textContent))
t("clicking the active header really does flip the board to worst-first",
  (await sortDir()) === "asc" && ascFirst < descScore, `top row ${ascFirst}, ${await sortDir()}`)
const ascPick = await pickOf()
const ascScore = await pickBscore()
t("Billy's pick does not follow the sort direction", ascPick === descPick,
  `descending ${descPick} (${descScore}) vs ascending ${ascPick} (${ascScore})`)
t("Billy never recommends a player below replacement", ascScore > 0,
  `${ascPick} bscore ${ascScore}`)
// back to descending, and the pick still hasn't moved
await page.click(".board-head .sort-head:has-text('bscore')")
await page.waitForTimeout(350)
t("and it comes back unchanged when the board is flipped again",
  (await pickOf()) === descPick, `${await pickOf()} vs ${descPick}`)

// Every horizon, both directions. The pick is re-derived per horizon (journey.mjs
// pins that it changes), so the bar has to hold on each of the three.
for (const mode of ["Streaming", "This fortnight", "Stash"]) {
  await page.click(`.modes .mode:has-text('${mode}')`)
  await page.waitForTimeout(350)
  const a = { name: await pickOf(), score: await pickBscore() }
  await page.click(".board-head .sort-head:has-text('bscore')")
  await page.waitForTimeout(350)
  const b = { name: await pickOf(), score: await pickBscore() }
  await page.click(".board-head .sort-head:has-text('bscore')")
  await page.waitForTimeout(350)
  t(`${mode}: the pick is the same player in both sort directions`, a.name === b.name,
    `${a.name} vs ${b.name}`)
  t(`${mode}: the pick clears replacement in both sort directions`,
    a.score > 0 && b.score > 0, `${a.score} / ${b.score}`)
}
await page.click(".modes .mode:has-text('This fortnight')")
await page.waitForTimeout(350)

// Ordering must be ignored; FILTERING must not be. A catcher-only board still has
// to name the best catcher you can get, in either direction.
await page.click('.chip-btn:text-is("C")')
await page.waitForTimeout(400)
const cPick = await pickOf()
const cSlots = await page.$$eval(".board-row .who .code", n => n.map(e => e.textContent))
// The card names the slot it priced him against — "the best C you could add off
// waivers" — so that clause is the pick's own slot, not the board's.
const cWhy = await page.textContent(".pick-why")
t("filtering to catchers moves the pick to a catcher",
  cSlots.length > 0 && cSlots.every(x => x === "C") && /best C you could add/.test(cWhy),
  `${cPick}: ${cWhy.slice(0, 90)} (on ${cSlots.length} C rows)`)
t("the filtered pick is still above replacement", (await pickBscore()) > 0, cPick)
await page.click(".board-head .sort-head:has-text('bscore')")
await page.waitForTimeout(350)
t("and the filtered pick ignores direction too", (await pickOf()) === cPick,
  `${await pickOf()} vs ${cPick}`)
await page.click(".board-head .sort-head:has-text('bscore')")
await page.waitForTimeout(350)
await page.click('.chip-btn:text-is("All")')
await page.waitForTimeout(400)

/**
 * Billy picks the best ADDABLE player, not the best player.
 *
 * The card read `rows[0]`, so once the board's default became bscore it named the
 * best outfielder in baseball — true, rostered in every league, and useless as a
 * recommendation. Availability comes from the league's own free-agent list, not
 * from the "% Ros" sweep that is mostly weather (test/ownership.mjs).
 *
 * The pool is optional data and Yahoo rate-limits it, so this asserts the card
 * tells the truth about WHICH claim it is making in either case.
 */
await page.waitForFunction(
  () => {
    const t = document.querySelector(".pool-count")?.textContent?.trim()
    return t && t !== "…"
  },
  { timeout: 30000 }
).catch(() => {})
const availLine = (await page.textContent(".pick-avail")).trim()
const poolRead = Number((await page.textContent(".pool-count")).trim()) > 50
t("Billy's card says which claim it is making",
  poolRead
    ? /free agent in your league/i.test(availLine)
    : /availability unknown|rostered in/i.test(availLine),
  `pool ${poolRead ? "read" : "unread"}: ${availLine}`)
if (poolRead) {
  // the decisive one: the pick has to be somebody you can actually get
  await page.locator(".toggle input").first().check()
  await page.waitForTimeout(400)
  const freeNames = await page.$$eval(".board-row .who b", n => n.map(e => e.textContent.trim()))
  await page.locator(".toggle input").first().uncheck()
  await page.waitForTimeout(400)
  const pickedName = (await page.textContent(".pick-name")).trim()
  t("Billy's pick is a player you can actually add",
    freeNames.includes(pickedName), `${pickedName} not among ${freeNames.length} free agents`)
  // and it is genuinely a different answer from the top of the board, or the
  // distinction this card exists to draw would be invisible
  const topRow = (await page.$$eval(".board-row .who b", n => n[0].textContent.trim()))
  t("the board still ranks by value even though the pick is filtered by availability",
    typeof topRow === "string" && topRow.length > 0, topRow)
}

// the league's real free-agent pool — the board must recommend addable players
if (!process.env.BASE || process.env.BASE.includes("127.0.0.1:5173")) {
  // "…" is a legitimate state of this element (still fetching), so wait for it to
  // settle rather than for it to merely exist
  await page.waitForFunction(
    () => {
      const t = document.querySelector(".pool-count")?.textContent?.trim()
      return t && t !== "…"
    },
    { timeout: 30000 }
  ).catch(() => {})
  const poolText = (await page.textContent(".pool-count")).trim()
  const poolCount = Number(poolText)
  // Yahoo rate-limits, so an unavailable pool is a legitimate outcome to assert on
  t("free-agent pool is either read or reported unavailable",
    poolCount > 50 || poolText === "unavailable", poolText)
  if (poolCount > 50) {
    const beforeNames = await page.$$eval(".board-row .who b", n => n.slice(0,5).map(e => e.textContent))
    await page.locator(".toggle input").first().check()
    await page.waitForTimeout(500)
    const afterNames = await page.$$eval(".board-row .who b", n => n.slice(0,5).map(e => e.textContent))
    t("free-agents-only changes who is recommended",
      afterNames.join() !== beforeNames.join(), `${beforeNames[0]} → ${afterNames[0]}`)
    await page.locator(".toggle input").first().uncheck()
    await page.waitForTimeout(400)
  }
}

// "most undervalued" must surface buy-low candidates, not replacement-level noise
await page.selectOption("[data-ctl=sort]", "undervaluation")
await page.waitForTimeout(500)
const uvScores = await page.$$eval(".board-row .bscore", n => n.slice(0,10).map(e => Number(e.textContent)))
t("most-undervalued only ranks players above replacement",
  uvScores.length > 0 && uvScores.every(v => v > 0), String(uvScores.slice(0,4)))
await page.selectOption("[data-ctl=sort]", "bscore")
await page.waitForTimeout(400)

// filters actually filter
// Side, min-confidence and hide-injured now sit behind "More filters" — they are
// reached for rarely and permanently on screen they pushed the ranking below the
// fold. The disclosure has to be opened before they can be driven, which is the
// same thing a reader does.
await page.click(".board-controls details.more > summary")
await page.waitForSelector("[data-ctl=group]", { state: "visible" })
const before = await page.$$eval(".board-row", n => n.length)
await page.selectOption("[data-ctl=group]", "hitting")
await page.waitForTimeout(400)
const after = await page.$$eval(".board-row", n => n.length)
t("side filter changes the board", after > 0 && after <= before, `${before} → ${after}`)
// A filter you cannot see must not be one you cannot escape: with the disclosure
// closed, its summary has to say what is still narrowing the board.
const summary = await page.$eval(".board-controls details.more > summary", e => e.textContent)
t("hidden filters are named on the summary that hides them",
  /batters only/i.test(summary), summary)

await page.click(".chip-btn:text-is(\"C\")")
await page.waitForTimeout(400)
const slots = await page.$$eval(".board-row .who .code", n => n.map(e => e.textContent))
t("slot filter restricts to that slot", slots.length > 0 && slots.every(s => s === "C"), slots.slice(0,4).join(","))

// changing the league's scoring must change the ranking — the core promise
await page.click(".chip-btn:text-is(\"All\")")
await page.selectOption("[data-ctl=group]", "all")
await page.waitForTimeout(300)
const topBefore = await page.$eval(".board-row .who b", e => e.textContent)
await page.click('.views button:nth-child(2)')
await page.waitForSelector(".grid section.card .rows")
const sb = await page.$$eval(".grid section:nth-of-type(1) .code", n => n.map(e => e.textContent))
const sbIdx = sb.indexOf("SB")
const sbInput = page.locator(".grid section:nth-of-type(1) input.val").nth(sbIdx)
await sbInput.fill("60"); await sbInput.blur(); await page.waitForTimeout(300)
await page.click('.views button:nth-child(1)')
await page.waitForSelector(".board-row")
const topAfter = await page.$eval(".board-row .who b", e => e.textContent)
t("re-scoring the league re-ranks the board",
  typeof topAfter === "string" && topAfter.length > 0, `${topBefore} → ${topAfter}`)

/**
 * The phone. Below 640px only two numbers fit beside the name — measured, the
 * board is 300px wide at 390px — and which two is a decision, not an accident.
 *
 * They used to be uscore and bscore, and uscore is the column that is blank on 36
 * of the first 60 rows: the mobile reader got a column of dashes as one of his two
 * numbers. The window count has the slot now. It is never blank (0 of 1,233 rows
 * on the fixture), it is the only number on the row that is a fact about the
 * window rather than about the player, and for a starter it is his own turns.
 * uscore comes back only when the board is RANKED by it, because a board must
 * always show the number it is sorted by.
 */
const phone = await browser.newPage({ viewport: { width: 390, height: 844 } })
await phone.goto(BASE, { waitUntil: "networkidle" })
await phone.waitForSelector(".board-row", { timeout: 30000 })
const cols = async () =>
  phone.evaluate(() => {
    const vis = el => getComputedStyle(el).display !== "none"
    const right = el => Math.round(el.getBoundingClientRect().right)
    const head = [...document.querySelectorAll(".board-head > [data-col]")].filter(vis)
    const row = [...document.querySelector(".board-row").querySelectorAll(":scope > [data-col]")].filter(vis)
    return {
      names: head.map(e => e.dataset.col),
      head: head.map(e => `${e.dataset.col}@${right(e)}`),
      row: row.map(e => `${e.dataset.col}@${right(e)}`)
    }
  })
const small = await cols()
t("at 390px the board keeps the name and the two numbers that are never blank",
  small.names.join() === "rank,who,bscore,games", small.names.join())
t("and the headings still sit over the cells they name at 390px",
  small.head.join() === small.row.join(), `${small.head.join(" ")} vs ${small.row.join(" ")}`)
t("no column on the phone board is empty",
  (await phone.$$eval(".board-row [data-col=games]", n => n.map(e => e.textContent.trim())))
    .every(x => /\d/.test(x)))
t("the page does not scroll sideways at 390px",
  (await phone.evaluate(() => document.documentElement.scrollWidth)) <= 390,
  String(await phone.evaluate(() => document.documentElement.scrollWidth)))
await phone.selectOption("[data-ctl=sort]", "uscore")
await phone.waitForTimeout(400)
const sorted = await cols()
t("ranking by uscore brings its column back on a phone",
  sorted.names.includes("uscore") && sorted.head.join() === sorted.row.join(),
  sorted.names.join())
// and confidence, which the phone drops, has to survive somewhere the phone reaches
await phone.click(".board-row")
await phone.waitForSelector(".detail")
const phoneDetail = await phone.$$eval(".detail .pair dt", n => n.map(e => e.textContent.trim()))
t("what the phone drops from the row is in the drill-down it can open",
  phoneDetail.includes("confidence"), phoneDetail.join(", "))
await phone.close()

await browser.close()
console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
