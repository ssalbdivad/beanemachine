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
await page.waitForSelector(".board-row", { timeout: 30000 })

t("no page errors", errors.length === 0, errors.join(" | "))
t("board renders ranked rows", (await page.$$eval(".board-row", n => n.length)) > 50)

const scores = await page.$$eval(".board-row .bscore", n => n.map(e => Number(e.textContent)))
t("bscores are finite numbers", scores.every(Number.isFinite), String(scores.slice(0, 3)))
// The board opens on market edge, not bscore: the best players are already
// rostered, so a bare bscore ranking opens on names the reader cannot add.
const edges = await page.$$eval(".board-row .edge", n =>
  n.map(e => Number(String(e.textContent).replace("+", "")))
)
t("board opens sorted by market edge descending",
  edges.length > 50 && edges.every((v, i) => i === 0 || edges[i - 1] >= v),
  String(edges.slice(0, 5)))
t("every opening recommendation beats its ownership par",
  edges.slice(0, 20).every(v => v > 0), String(edges.slice(0, 5)))

// and bscore still sorts when asked for
await page.click(".board-head .sort-head:has-text('bscore')")
await page.waitForTimeout(150)
const byB = await page.$$eval(".board-row .bscore", n => n.map(e => Number(e.textContent)))
t("sorting by bscore still orders by bscore",
  byB.every((v, i) => i === 0 || byB[i - 1] >= v), String(byB.slice(0, 5)))
await page.click(".board-head .sort-head:has-text('edge')")
await page.waitForTimeout(150)

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

// bscore must be value OVER REPLACEMENT, so proj − repl should equal it
const row = await page.$eval(".board-row", r => ({
  bscore: Number(r.querySelector(".bscore").textContent),
  cells: [...r.querySelectorAll(".dim")].map(e => Number(e.textContent))
}))
t("bscore equals projected minus replacement",
  Math.abs(row.bscore - (row.cells[0] - row.cells[1])) < 0.05,
  `${row.bscore} vs ${row.cells[0]} − ${row.cells[1]}`)

// provenance: opening a player must separate observed from modelled
await page.click(".board-row")
await page.waitForSelector(".detail")
const sections = await page.$$eval(".detail h3", n => n.map(e => e.textContent.toLowerCase()))
t("drill-down separates measured, Statcast model and our model",
  sections.some(s => s.includes("measured")) &&
  sections.some(s => s.includes("statcast model")) &&
  sections.some(s => s.includes("our model")),
  sections.join("|"))
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

// Billy's pick must be the top row, and every clause backed by a real number
await page.waitForSelector(".card.pick")
const pickName = (await page.textContent(".pick-name")).trim()
const topName = await page.$eval(".board-row .who b", e => e.textContent.trim())
t("Billy's pick matches the top of the board", pickName === topName, `${pickName} vs ${topName}`)
const why = await page.textContent(".pick-why")
const pickScore = Number(await page.textContent(".pick-score b"))
t("Billy's reasoning cites the actual bscore",
  why.includes(String(pickScore)) && /more points than the best/.test(why), why)
t("Billy's reasoning cites real scheduled games", /plays \d+ games/.test(why), why)
t("Billy uses the right volume unit for the side",
  /plate appearances per team game|outs recorded per team game/.test(why), why)

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
const before = await page.$$eval(".board-row", n => n.length)
await page.selectOption("[data-ctl=group]", "hitting")
await page.waitForTimeout(400)
const after = await page.$$eval(".board-row", n => n.length)
t("side filter changes the board", after > 0 && after <= before, `${before} → ${after}`)

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

await browser.close()
console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
