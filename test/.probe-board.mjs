import { chromium } from "playwright-core"
const browser = await chromium.launch({ args: ["--no-sandbox"] })
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
await page.goto(process.env.BASE, { waitUntil: "networkidle" })
await page.waitForSelector(".board-row", { timeout: 30000 })
await page.waitForTimeout(1500)
// luck column + undervaluation sort
console.log("luck cells", await page.$$eval(".board-row [data-col=luck]", n => n.slice(0,5).map(e => e.textContent.trim())))
await page.selectOption("[data-ctl=sort]", "undervaluation"); await page.waitForTimeout(600)
console.log("luck sorted", await page.$$eval(".board-row [data-col=luck]", n => n.slice(0,8).map(e => e.textContent.trim())))
await page.selectOption("[data-ctl=sort]", "contact"); await page.waitForTimeout(600)
console.log("contact ok rows", await page.$$eval(".board-row", n => n.length))
await page.selectOption("[data-ctl=sort]", "bscore"); await page.waitForTimeout(600)
// waiver points per slot
const waiverFor = async slot => {
  await page.click(`.chip-btn:text-is("${slot}")`); await page.waitForTimeout(600)
  await page.click(".board-row"); await page.waitForSelector(".detail")
  const v = await page.$$eval(".detail .pair", n => Object.fromEntries(n.map(e => [e.querySelector("dt").textContent.trim(), e.querySelector("dd").textContent.trim()])))
  const code = await page.$eval(".board-row .who .code", e => e.textContent.trim())
  await page.click(".board-row"); await page.waitForTimeout(200)
  return [code, v["waiver points"]]
}
console.log("C", await waiverFor("C"))
console.log("OF", await waiverFor("OF"))
console.log("SP", await waiverFor("SP"))
await page.click('.chip-btn:text-is("All")')
// header titles
console.log(await page.$$eval(".board-head .sort-head", n => n.map(e => [e.dataset.col, (e.getAttribute("title")||"").length])))
await browser.close()
