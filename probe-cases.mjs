import { chromium } from "playwright-core"
import { readFileSync } from "node:fs"
const BASE = "http://127.0.0.1:5173/probe-trade.html"
const cfg = JSON.parse(readFileSync("/home/ssalb/beanemachine/scoring.json", "utf8"))
const b = await chromium.launch({ args: ["--no-sandbox"] })
const page = await b.newPage({ viewport: { width: 1280, height: 1400 } })
page.on("pageerror", e => console.log("PAGEERROR", String(e)))

const open = async () => {
  await page.goto(BASE, { waitUntil: "networkidle" })
  await page.locator(".views button", { hasText: /trade/i }).first().click()
  await page.waitForSelector(".trade-team", { timeout: 30000 })
}

// --- case 1: a rostered player with no projection ---
await page.goto(BASE)
await page.evaluate(([c, r]) => { localStorage.setItem("beanemachine:config", JSON.stringify(c)); localStorage.setItem("beanemachine:roster", JSON.stringify(r)) },
  [cfg, { "yahoo:228947": ["687394:hitting", "660271:hitting"] }])
await open()
console.log("--- CASE 1: unprojectable rostered player ---")
console.log("own rows:", await page.$$eval(".trade-own .who b", n => n.map(e => e.textContent)))
console.log("none-badges:", await page.$$eval(".trade-line .none", n => n.map(e => e.textContent)))
console.log("unprojectable notes:", await page.$$eval(".lineup-unprojectable li", n => n.map(e => e.textContent.trim())))
console.log("lineup total:", await page.textContent(".lineup-total"))
console.log("head unit:", await page.textContent(".lineup-unit"))

// give away the unprojectable one -> verdict
await page.locator(".deal-side .picks .chip-btn", { hasText: "Brannigan" }).first().click()
await page.waitForSelector(".trade-verdict")
console.log("delta:", await page.textContent(".verdict-delta"))
console.log("why:", await page.textContent(".verdict-why"))
console.log("missing:", await page.$$eval(".verdict-missing li", n => n.map(e => e.textContent.trim())))
console.log("idle notes:", await page.$$eval(".verdict-idle .tiny-note", n => n.map(e => e.textContent.trim())))

// --- case 2: a league with slots + team count but NO scoring ---
const bare = structuredClone(cfg)
const l = structuredClone(cfg.leagues["yahoo:228947"])
for (const k of Object.keys(l.scoring.batting)) l.scoring.batting[k] = 0
for (const k of Object.keys(l.scoring.pitching)) l.scoring.pitching[k] = 0
bare.leagues = { "bare:1": l }
bare.active_league = "bare:1"
await page.goto(BASE)
await page.evaluate(([c, r]) => { localStorage.setItem("beanemachine:config", JSON.stringify(c)); localStorage.setItem("beanemachine:roster", JSON.stringify(r)) },
  [bare, { "bare:1": ["660271:hitting", "592450:hitting"] }])
await open()
console.log("\n--- CASE 2: league with no scoring ---")
console.log("body text:", (await page.textContent(".trade-team")).replace(/\s+/g, " ").slice(0, 300))
console.log("lineup total:", await page.$eval(".lineup-total", e => e.textContent).catch(() => "(none)"))
console.log("lineup rows:", (await page.$$(".lineup-row")).length)
console.log("own line values:", await page.$$eval(".trade-own .r", n => n.map(e => e.textContent)))

// --- case 3: empty roster ---
await page.goto(BASE)
await page.evaluate(c => { localStorage.setItem("beanemachine:config", JSON.stringify(c)); localStorage.removeItem("beanemachine:roster") }, cfg)
await open()
console.log("\n--- CASE 3: empty roster ---")
console.log("lineup empty:", (await page.textContent(".trade-lineup .empty")).replace(/\s+/g," "))
console.log("lineup rows:", (await page.$$(".lineup-row")).length)
console.log("verdicts:", (await page.$$(".trade-verdict")).length)

// --- case 4: corrupt store ---
await page.goto(BASE)
await page.evaluate(c => { localStorage.setItem("beanemachine:config", JSON.stringify(c)); localStorage.setItem("beanemachine:roster", "{\"yahoo:228947\":[\"nope\"]}") }, cfg)
await open()
console.log("\n--- CASE 4: corrupt roster store ---")
console.log("store error:", (await page.$$eval(".trade-store-error li", n => n.map(e => e.textContent.trim()))).join(" | ").slice(0,200))
await b.close()
