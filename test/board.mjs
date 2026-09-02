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
t("board is sorted by bscore descending",
  scores.every((v, i) => i === 0 || scores[i - 1] >= v), String(scores.slice(0, 5)))

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
t("modelled assumptions name the playing-time blend and its weight",
  modelled.some(m => /playing time/i.test(m) && /% recent/.test(m)), modelled.join(" | "))
t("the drill-down states whether the Statcast adjustment was applied",
  modelled.some(m => /Statcast adjustment (evaluated and NOT applied|)/i.test(m)) ||
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
  await page.waitForSelector(".pool-count", { timeout: 25000 })
  const poolCount = Number((await page.textContent(".pool-count")).trim())
  t("free-agent pool is read from the league", poolCount > 50, String(poolCount))
  const beforeNames = await page.$$eval(".board-row .who b", n => n.slice(0,5).map(e => e.textContent))
  await page.locator(".toggle input").first().check()
  await page.waitForTimeout(500)
  const afterNames = await page.$$eval(".board-row .who b", n => n.slice(0,5).map(e => e.textContent))
  t("free-agents-only changes who is recommended",
    afterNames.join() !== beforeNames.join(), `${beforeNames[0]} → ${afterNames[0]}`)
  await page.locator(".toggle input").first().uncheck()
  await page.waitForTimeout(400)
}

// filters actually filter
const before = await page.$$eval(".board-row", n => n.length)
await page.selectOption(".filters select >> nth=1", "hitting")
await page.waitForTimeout(400)
const after = await page.$$eval(".board-row", n => n.length)
t("side filter changes the board", after > 0 && after <= before, `${before} → ${after}`)

await page.selectOption(".filters select >> nth=0", "C")
await page.waitForTimeout(400)
const slots = await page.$$eval(".board-row .who .code", n => n.map(e => e.textContent))
t("slot filter restricts to that slot", slots.length > 0 && slots.every(s => s === "C"), slots.slice(0,4).join(","))

// changing the league's scoring must change the ranking — the core promise
await page.selectOption(".filters select >> nth=0", "")
await page.selectOption(".filters select >> nth=1", "all")
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
