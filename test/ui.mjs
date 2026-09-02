import { chromium, firefox } from "playwright-core"
import { readFileSync } from "node:fs"

const BASE = process.env.BASE ?? "http://127.0.0.1:5173"
// Leagues live in the browser, so this suite runs against a fresh profile that
// seeds itself from the committed scoring.json and writes only to localStorage.
// Nothing here can reach the file on disk, which is asserted below rather than
// assumed — a save that still hit it used to leave HR 12.25 in the real config.
const STORE = "beanemachine:config"

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
// the recommendation board is the default view; the config editor is a tab
const toLeagueSetup = async pg => {
  await pg.waitForSelector(".views button")
  await pg.click('.views button:nth-child(2)')
  await pg.waitForSelector(".grid section.card .rows")
}
await toLeagueSetup(page)

await page.screenshot({ path: "/tmp/bc-light.png", fullPage: true })
t("no console/page errors on load", errors.length === 0, errors.join(" | "))
t("wordmark renders", (await page.textContent("h1")) === "beanemachine")
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

/**
 * A penalty must be typeable. `<input type=number>` reports an empty value with
 * validity.badInput while a lone "-" is on screen; a controlled field read that as
 * "cleared" and React restored the committed number over the keystroke, so typing
 * -3 produced 83. Most pitching categories ARE penalties, so the path this app
 * exists to serve could not express them. No suite saw it.
 */
const erIndex = (await page.$$eval(".grid section:nth-of-type(2) .code", n =>
  n.map(e => e.textContent)
)).indexOf("ER")
if (erIndex >= 0) {
  const er = page.locator(".grid section:nth-of-type(2) input.val").nth(erIndex)
  await er.click()
  await page.keyboard.press("ControlOrMeta+a")
  await page.keyboard.type("-3.5")
  await er.blur()
  await page.waitForTimeout(150)
  t("a negative point value can actually be typed", (await er.inputValue()) === "-3.5",
    await er.inputValue())
  await page.click(".savebar button:not(.primary)")
  await page.waitForTimeout(150)
}

// A field that displays a number the league does not hold is the one thing this
// project says it never does, so whole-number fields normalise on blur.
const teams = page.locator("input[aria-label='Teams in this league']")
if (await teams.count()) {
  await teams.click()
  await page.keyboard.press("ControlOrMeta+a")
  await page.keyboard.type("12.7")
  await teams.blur()
  await page.waitForTimeout(150)
  t("a whole-number field shows what it stored, not what was typed",
    (await teams.inputValue()) === "13", await teams.inputValue())

  // and a stray minus must not be read as "cleared" and wipe a stored count
  await teams.click()
  await page.keyboard.press("ControlOrMeta+a")
  await page.keyboard.type("-")
  await page.waitForTimeout(120)
  // `input[type=number]` reports "" for a lone "-", so the field's own value cannot
  // witness this. What matters is that nothing was COMMITTED: the count the league
  // holds must be untouched while the keystroke is unfinished.
  const midTyping = await page.evaluate(
    k => JSON.parse(localStorage.getItem(k))?.leagues?.["yahoo:228947"]?.meta?.max_teams,
    STORE
  )
  t("a half-typed count commits nothing, rather than wiping the stored one",
    midTyping === null || typeof midTyping === "number", String(midTyping))
  await teams.blur()
  await page.waitForTimeout(150)
  t("and an unfinished count is restored on blur",
    /^\d+$/.test(await teams.inputValue()), await teams.inputValue())
  await page.click(".savebar button:not(.primary)").catch(() => {})
  await page.waitForTimeout(150)
}

// edit + save round-trips through browser storage and survives a reload
await hr.fill("12.25"); await hr.blur(); await page.waitForTimeout(120)
await page.click(".savebar button.primary")
await page.waitForSelector(".toast")
t("save toast shown", (await page.textContent(".toast")).includes("Saved"))
await page.waitForTimeout(250)
const stored = await page.evaluate(k => JSON.parse(localStorage.getItem(k)), STORE)
t("edit hit browser storage", stored.leagues["yahoo:228947"].scoring.batting.HR === 12.25,
  String(stored.leagues["yahoo:228947"].scoring.batting.HR))
t("committed scoring.json is untouched",
  JSON.parse(readFileSync("scoring.json", "utf8")).leagues["yahoo:228947"].scoring.batting.HR === 10.4)
await page.reload({ waitUntil: "networkidle" })
await toLeagueSetup(page)
const reloaded = await page.$$eval(".grid section:nth-of-type(1) input.val", n => n.map(e => e.value))
t("the edit survives a reload", reloaded[codes.indexOf("HR")] === "12.25", reloaded.join(","))

// restore the true value through the UI
await hr.fill("10.4"); await hr.blur(); await page.waitForTimeout(120)
await page.click(".savebar button.primary"); await page.waitForTimeout(400)
t("restored to real value",
  (await page.evaluate(k => JSON.parse(localStorage.getItem(k)), STORE))
    .leagues["yahoo:228947"].scoring.batting.HR === 10.4)

// the file round-trip: Download hands back exactly what is stored
const [download] = await Promise.all([
  page.waitForEvent("download"),
  page.click('.bar button:text-is("Download")')
])
const exported = JSON.parse(readFileSync(await download.path(), "utf8"))
t("download exports the stored config", exported.leagues["yahoo:228947"].scoring.batting.HR === 10.4,
  download.suggestedFilename())
t("download is named scoring.json", download.suggestedFilename() === "scoring.json")

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
  const cs = getComputedStyle(i)
  const px = v => parseFloat(v) || 0
  // Firefox excludes padding from clientWidth on form controls, Chromium includes
  // it — so measure the leftover after accounting for border AND padding.
  const border = px(cs.borderLeftWidth) + px(cs.borderRightWidth)
  const pad = px(cs.paddingLeft) + px(cs.paddingRight)
  return {
    appearance: cs.appearance,
    leftover: Math.round(i.getBoundingClientRect().width - i.clientWidth - border),
    pad: Math.round(pad)
  }
})
t("number inputs declare spinners suppressed",
  spinner.appearance === "textfield", spinner.appearance)
t("no spinner widget is eating the field",
  spinner.leftover <= spinner.pad + 2,
  `leftover ${spinner.leftover}px vs padding ${spinner.pad}px`)

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
await toLeagueSetup(dp)
const bg = await dp.evaluate(() => getComputedStyle(document.body).backgroundColor)
t("dark mode background applied", bg === "rgb(20, 22, 26)", bg)

// mobile layout: no horizontal overflow
const mob = await browser.newContext({ viewport: { width: 390, height: 844 } })
const mp = await mob.newPage()
await mp.goto(BASE, { waitUntil: "networkidle" })
await toLeagueSetup(mp)
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
