import { chromium, firefox } from "playwright-core"
import { readFileSync } from "node:fs"

const BASE = process.env.BASE ?? "http://127.0.0.1:5173"
const ENGINE = process.env.BROWSER ?? "chromium"
const browser =
  ENGINE === "firefox" ?
    await firefox.launch()
  : await chromium.launch({ args: ["--no-sandbox"] })
console.log(`--- ${ENGINE} ---`)
let pass = 0, fail = 0
const t = (n, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : "  " + extra}`) }

const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
const errors = []
page.on("pageerror", e => errors.push(String(e)))
page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })

await page.goto(BASE, { waitUntil: "networkidle" })
await page.waitForSelector(".grid section.card .rows")

await page.screenshot({ path: "/tmp/bc-light.png", fullPage: true })
t("no console/page errors on load", errors.length === 0, errors.join(" | "))
t("wordmark renders", (await page.textContent("h1")) === "beanecounter")
t("league selected", (await page.inputValue(".bar select")) === "yahoo:228947")

// chips reflect real imported data
const chips = await page.$$eval(".chip", n => n.map(e => e.textContent.trim()))
t("chip shows team", chips.some(c => c.includes("Mrs. Met's Harem")), chips.join(" / "))
t("chip shows provenance", chips.includes("read from source"), chips.join(" / "))

// scoring tables rendered with the real values
const codes = await page.$$eval(".grid section:nth-of-type(1) .code", n => n.map(e => e.textContent))
const vals = await page.$$eval(".grid section:nth-of-type(1) input.val", n => n.map(e => e.value))
t("batting has 9 stats", codes.length === 9, codes.join(","))
t("HR = 10.4", vals[codes.indexOf("HR")] === "10.4", vals.join(","))
const pvals = await page.$$eval(".grid section:nth-of-type(2) input.val", n => n.map(e => e.value))
t("pitching ER = -3", pvals.includes("-3"), pvals.join(","))
t("negatives styled as penalties",
  (await page.$$eval(".grid section:nth-of-type(2) input.val.neg", n => n.length)) === 4)

// roster totals
const totals = await page.$$eval(".tot", n => n.map(e => e.textContent))
t("roster totals 18/5/4/27",
  ["18active", "5bench", "4IL", "27total"].every(x => totals.some(v => v.replace(/\s/g, "") === x)),
  totals.join(" "))

// save bar hidden until an edit, then appears
t("save bar hidden initially", !(await page.locator(".savebar").evaluate(e => e.classList.contains("on"))))
const hr = page.locator(".grid section:nth-of-type(1) input.val").nth(codes.indexOf("HR"))
await hr.fill("11.5"); await hr.blur()
await page.waitForTimeout(150)
t("editing marks dirty", await page.locator(".savebar").evaluate(e => e.classList.contains("on")))

// revert restores
await page.click(".savebar button:not(.primary)"); await page.waitForTimeout(150)
const after = await page.$$eval(".grid section:nth-of-type(1) input.val", n => n.map(e => e.value))
t("revert restores value", after[codes.indexOf("HR")] === "10.4", after.join(","))
t("save bar hides after revert", !(await page.locator(".savebar").evaluate(e => e.classList.contains("on"))))

// edit + save round-trips to disk
await hr.fill("12.25"); await hr.blur(); await page.waitForTimeout(120)
await page.click(".savebar button.primary")
await page.waitForSelector(".toast")
t("save toast shown", (await page.textContent(".toast")).includes("Saved"))
await page.waitForTimeout(250)
const onDisk = JSON.parse(readFileSync("scoring.json", "utf8"))
t("edit hit scoring.json", onDisk.leagues["yahoo:228947"].scoring.batting.HR === 12.25,
  String(onDisk.leagues["yahoo:228947"].scoring.batting.HR))

// restore the true value through the UI
await hr.fill("10.4"); await hr.blur(); await page.waitForTimeout(120)
await page.click(".savebar button.primary"); await page.waitForTimeout(400)
t("restored to real value",
  JSON.parse(readFileSync("scoring.json", "utf8")).leagues["yahoo:228947"].scoring.batting.HR === 10.4)

// a blank field must restore the real value, never become 0
const first = page.locator(".grid section:nth-of-type(1) input.val").first()
const before = await first.inputValue()
await first.fill(""); await first.blur(); await page.waitForTimeout(150)
t("blank point value restores, doesn't become 0",
  (await first.inputValue()) === before && before !== "0", `${await first.inputValue()} vs ${before}`)
await first.evaluate(e => {
  e.value = "abc"
  e.dispatchEvent(new Event("change", { bubbles: true }))
})
await page.waitForTimeout(150)
t("non-numeric point value restores", (await first.inputValue()) === before,
  await first.inputValue())

// same trap on roster slot counts
const slot = page.locator(".slot input").first()
const slotBefore = await slot.inputValue()
await slot.fill(""); await slot.blur(); await page.waitForTimeout(150)
t("blank slot count restores, doesn't delete the slot",
  (await slot.inputValue()) === slotBefore && (await page.$$eval(".slot", n => n.length)) >= 12)

// and on eligibility thresholds
const elig = page.locator(".field input.val").first()
const eligBefore = await elig.inputValue()
await elig.fill(""); await elig.blur(); await page.waitForTimeout(150)
t("blank eligibility threshold restores", (await elig.inputValue()) === eligBefore)

t("nothing dirty after all rejections",
  !(await page.locator(".savebar").evaluate(e => e.classList.contains("on"))))

// needs-review surfaced
t("needs review listed", (await page.$$eval(".flags li", n => n.length)) >= 1)
// raw settings present
t("raw league rules shown", (await page.$$eval("dl dt", n => n.length)) > 20)

// Firefox paints persistent number-input spinners that eat the field and read as
// a stray scrollbar; they must be suppressed in every engine.
const spinner = await page.evaluate(() => {
  const i = document.querySelector("input.val")
  const r = i.getBoundingClientRect()
  return { box: Math.round(r.width), client: i.clientWidth }
})
t("number fields have no spinner widget",
  spinner.box - spinner.client <= 20, `box ${spinner.box} vs content ${spinner.client}`)

// every control in the toolbar says what it is
const labels = await page.$$eval(".ctl > span", n => n.map(e => e.textContent.trim().toLowerCase()))
t("dropdowns and URL field are labelled",
  labels.some(l => l.includes("league being edited")) &&
  labels.some(l => l.includes("start a league")) &&
  labels.some(l => l.includes("import a league")),
  labels.join(" | "))

// dark mode renders
const dark = await browser.newContext({ colorScheme: "dark", viewport: { width: 1280, height: 1000 } })
const dp = await dark.newPage()
await dp.goto(BASE, { waitUntil: "networkidle" })
await dp.waitForSelector(".grid section.card .rows")
const bg = await dp.evaluate(() => getComputedStyle(document.body).backgroundColor)
t("dark mode background applied", bg === "rgb(20, 22, 26)", bg)

// mobile layout: no horizontal overflow
const mob = await browser.newContext({ viewport: { width: 390, height: 844 } })
const mp = await mob.newPage()
await mp.goto(BASE, { waitUntil: "networkidle" })
await mp.waitForSelector(".grid section.card .rows")
const overflow = await mp.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth)
t("no horizontal overflow at 390px", overflow <= 0, `overflow ${overflow}px`)
const wide = await mp.evaluate(() => [...document.querySelectorAll(".grid > section")]
  .filter(c => c.scrollWidth > c.clientWidth + 1)
  .map(c => `${c.querySelector("h2")?.textContent}:${c.scrollWidth}>${c.clientWidth}`))
t("no card overflows its own width at 390px", wide.length === 0, wide.join(" "))

await dp.screenshot({ path: "/tmp/bc-dark.png", fullPage: true })
await mp.screenshot({ path: "/tmp/bc-mobile.png", fullPage: true })
await browser.close()
console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
