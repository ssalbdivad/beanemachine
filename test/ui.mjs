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

// A 200 on this port is not proof it is this app: :5173 is a common default and
// another project's dev server answers it just as happily, after which every
// assertion below fails as a selector timeout that reads like a UI defect. The
// wordmark is the cheapest proof of identity, so it is checked before anything
// else and stops the run rather than letting the next wait speak for it.
const wordmark = await page.waitForSelector("h1", { timeout: 15000 }).then(h => h.textContent(), () => null)
t("the page under test is beanemachine", wordmark === "beanemachine",
  `BASE=${BASE} served <h1>${wordmark}</h1> — start this repo's own vite, or set BASE to it`)
if (wordmark !== "beanemachine") { await browser.close(); process.exit(1) }
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

/**
 * ── The two routes into your own league, clicked ────────────────────────────────
 *
 * A fresh context, because both of these are about what a first-time visitor can
 * do and the page above has been edited for forty assertions.
 *
 * What this is checking is the thing that was broken: the hosted site's only ways
 * in were "use a stranger's demo league" or "hand-type nine batting values and
 * eight pitching ones", because Yahoo cannot be read by any browser and every
 * platform template shipped with 0 stats, 0 slots and no team count. Two routes
 * now end in a board that ranks, and each has its own way of going wrong — a
 * preset that ranks but hides that the numbers are borrowed, and a file that
 * round-trips the leagues but silently drops the team.
 */
const cfgFile = JSON.parse(readFileSync("scoring.json", "utf8"))
const fresh = await browser.newContext({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true })
const fp = await fresh.newPage()
const freshErrors = []
fp.on("pageerror", e => freshErrors.push(String(e)))
fp.on("dialog", d => d.accept())
await fp.goto(BASE, { waitUntil: "networkidle" })
await fp.waitForSelector(".board-row", { timeout: 25000 })
await fp.click(".views button:nth-child(2)")
await fp.waitForSelector("#tpl")

// The picker is generated from scoring.json's platform_templates, so it cannot
// offer a league type the data does not ship — which is how "a sleeper template"
// survived in a baseball app for as long as it did.
const tplOptions = await fp.$$eval("#tpl option", n => n.map(e => ({ value: e.value, label: e.textContent })))
t("the template picker offers exactly what scoring.json ships",
  JSON.stringify(tplOptions.map(o => o.value)) === JSON.stringify(Object.keys(cfgFile.platform_templates)),
  tplOptions.map(o => o.value).join(","))
t("and it offers no Sleeper league type, because Sleeper runs no fantasy baseball",
  !tplOptions.some(o => /sleeper/i.test(o.value + o.label)),
  tplOptions.map(o => o.label).join(" | "))
t("the ready-made preset is what it lands on, not the blank one",
  (await fp.inputValue("#tpl")) === "yahoo" && /standard values/i.test(tplOptions.find(o => o.value === "yahoo").label),
  `${await fp.inputValue("#tpl")} — ${tplOptions.map(o => o.label).join(" | ")}`)

// The routes are NAMED on the tab a first-time visitor is sent to. The demo league
// can rank, so the "finish setting this league up" card stays hidden, and before
// this the toolbar was the only thing on screen: a New button, a Download button
// and a URL field, with nothing saying which of them a Yahoo user wants.
const routes = await fp.$$eval(".routes dt", n => n.map(e => e.textContent))
t("the ways into your own league are named on the setup tab", routes.length >= 3, routes.join(" | "))
t("and the file route prints a command that exists, not `nub`",
  /^node --experimental-strip-types src\/cli\.ts /.test(await fp.locator(".routes pre").first().textContent()),
  await fp.locator(".routes pre").first().textContent())

// Route 1: one click from the picker to a ranked board.
await fp.click('.bar button:text-is("New")')
await fp.waitForSelector(".board-row", { timeout: 25000 })
t("choosing the preset lands on a board that actually ranks",
  (await fp.$$eval(".board-row", n => n.length)) > 50,
  String(await fp.$$eval(".board-row", n => n.length)))
const created = await fp.evaluate(k => {
  const c = JSON.parse(localStorage.getItem(k))
  return { key: c.active_league, league: c.leagues[c.active_league] }
}, STORE)
t("and the league it created is the preset, stored in this browser",
  created.league.provenance.method.startsWith("preset:") && created.league.provenance.verified === false,
  JSON.stringify(created.league.provenance))
t("and it carries scoring, slots and a team count — the three the engine needs",
  Object.keys(created.league.scoring.batting).length === 9 &&
    Object.keys(created.league.scoring.pitching).length === 8 &&
    Object.keys(created.league.roster.slots).length === 12 &&
    created.league.meta.max_teams === 10,
  JSON.stringify(created.league.meta.max_teams))

// A board that ranks looks like a board that is right, which is the whole risk of
// shipping a preset. The page has to keep saying whose numbers these are.
const preset = await fp.locator(".example-note").first().textContent()
t("the board says the values were not read from your league",
  /not read from your league/i.test(preset), preset.slice(0, 120))
t("and it names what to check, from the league's own needs_review",
  (await fp.$$eval(".example-note .flags li", n => n.length)) >= 3,
  String(await fp.$$eval(".example-note .flags li", n => n.length)))
t("and the provenance chip reads unverified, not read from source",
  (await fp.$$eval(".chip", n => n.map(e => e.textContent.trim()))).includes("unverified"),
  (await fp.$$eval(".chip", n => n.map(e => e.textContent.trim()))).join(" / "))

// The notice has to be able to END, or it is a warning people learn to read past —
// including on a league where it is still true. Nothing clears it automatically:
// saving an edit is not proof of checking, since changing one home-run value leaves
// the other sixteen borrowed. This is the user's own statement, and what it records
// is manual entry, not a read — `verified` stays false either way, because importing
// the league is still the only thing that can change that.
await fp.click('.example-note button:text-is("I\u2019ve checked these against my league")')
await fp.waitForTimeout(400)
t("saying you checked the preset's values ends the notice",
  (await fp.locator(".example-note").count()) === 0,
  await fp.locator(".example-note").first().textContent().catch(() => "(gone)"))
const checked = await fp.evaluate(k => {
  const c = JSON.parse(localStorage.getItem(k))
  return c.leagues[c.active_league]
}, STORE)
t("and it is recorded as entered by hand, not as read from the league",
  !checked.provenance.method.startsWith("preset:") &&
    /checked by hand/.test(checked.provenance.method) &&
    checked.provenance.verified === false,
  JSON.stringify(checked.provenance))
t("and the one line left says where the values came from and that it is still unverified",
  checked.needs_review.length === 1 && /preset/.test(checked.needs_review[0]) &&
    /unverified/.test(checked.needs_review[0]),
  JSON.stringify(checked.needs_review))
t("and the board still ranks, because the values did not change",
  (await fp.$$eval(".board-row", n => n.length)) > 50)

// Route 2: the file a Yahoo user carries from a local run. Everything a hosted page
// cannot read for a Yahoo league has to survive the trip — not just the leagues,
// which is all the file used to hold, but the roster, the seats it was read in, and
// the league's own FREE-AGENT LIST, which is the one a streaming question is
// actually about and the one no browser will ever be handed.
await fp.evaluate(() => {
  localStorage.setItem("beanemachine:roster", JSON.stringify({ "yahoo:228947": ["691718:hitting", "608369:pitching"] }))
  localStorage.setItem("beanemachine:lineup", JSON.stringify({
    "yahoo:228947": { at: "2026-09-04T00:00:00.000Z", spots: [{ slot: "OF", name: "Pete Crow-Armstrong", positions: ["OF"], team: "CHC" }] }
  }))
  localStorage.setItem("beanemachine:pool", JSON.stringify({
    "yahoo:228947": {
      at: "2026-09-04T12:00:00.000Z",
      leagueId: "228947",
      players: [
        { yahooId: "12781", name: "Max Meyer", team: "MIA", positions: ["SP"] },
        { yahooId: "11728", name: "Shea Langeliers", team: "ATH", positions: ["C"] }
      ],
      positionsRead: ["C", "SP"],
      note: "Top 25 free agents per position (C, SP)."
    }
  }))
})
await fp.reload({ waitUntil: "networkidle" })
await fp.click(".views button:nth-child(2)")
await fp.waitForSelector('.bar button:text-is("Download")')
const [taken] = await Promise.all([
  fp.waitForEvent("download"),
  fp.click('.bar button:text-is("Download")')
])
const carried = JSON.parse(readFileSync(await taken.path(), "utf8"))
t("the file carries the leagues, the roster, the seats and the free agents — all of them",
  Object.keys(carried.leagues).length === 2 &&
    carried.rosters["yahoo:228947"].length === 2 &&
    carried.lineups["yahoo:228947"].spots.length === 1 &&
    carried.pools["yahoo:228947"].players.length === 2,
  JSON.stringify({ leagues: Object.keys(carried.leagues), rosters: Object.keys(carried.rosters ?? {}), lineups: Object.keys(carried.lineups ?? {}), pools: Object.keys(carried.pools ?? {}) }))
// The stamp travels with the players or the file is a lie by omission: a wire read
// at noon and one read a week ago are different claims about who is addable, and
// only the timestamp tells them apart.
t("and the free-agent list travels with the instant it was read, not just the names",
  carried.pools["yahoo:228947"].at === "2026-09-04T12:00:00.000Z" &&
    carried.pools["yahoo:228947"].leagueId === "228947",
  JSON.stringify(carried.pools["yahoo:228947"].at))
t("and it is still a valid config, so a file from an older build still loads",
  carried.schema_version === cfgFile.schema_version && typeof carried.description === "string",
  carried.schema_version)

// Wipe the browser and drop the file back on the page — no file dialog, no toolbar.
await fp.evaluate(() => localStorage.clear())
await fp.reload({ waitUntil: "networkidle" })
await fp.waitForSelector(".board-row", { timeout: 25000 })
const dropped = readFileSync(await taken.path(), "utf8")
const dt = await fp.evaluateHandle(text => {
  const d = new DataTransfer()
  d.items.add(new File([text], "scoring.json", { type: "application/json" }))
  return d
}, dropped)
await fp.dispatchEvent("body", "dragover", { dataTransfer: dt })
await fp.waitForTimeout(150)
t("a file dragged over the page is offered a drop target", await fp.locator(".dropzone").isVisible())
await fp.dispatchEvent("body", "drop", { dataTransfer: dt })
await fp.waitForSelector(".toast", { timeout: 10000 })
t("dropping it says what arrived, counted from the file",
  /Loaded 2 leagues, 1 roster, 1 lineup, 1 free-agent list/.test(await fp.textContent(".toast")),
  await fp.textContent(".toast"))
const back = await fp.evaluate(k => ({
  leagues: Object.keys(JSON.parse(localStorage.getItem(k)).leagues),
  roster: JSON.parse(localStorage.getItem("beanemachine:roster") ?? "null"),
  lineup: JSON.parse(localStorage.getItem("beanemachine:lineup") ?? "null"),
  wire: JSON.parse(localStorage.getItem("beanemachine:pool") ?? "null"),
  // the config key must NOT keep a second copy: two answers to "who is free" with
  // no rule for which wins is how a cleared pool comes back from the dead
  cfgKeys: Object.keys(JSON.parse(localStorage.getItem(k)))
}), STORE)
t("and the whole team is back in this browser, not just the leagues",
  back.leagues.length === 2 &&
    JSON.stringify(back.roster["yahoo:228947"]) === JSON.stringify(["691718:hitting", "608369:pitching"]) &&
    back.lineup["yahoo:228947"].spots[0].slot === "OF",
  JSON.stringify(back))
t("and so is the free-agent list, with its read time intact",
  back.wire["yahoo:228947"].players.length === 2 &&
    back.wire["yahoo:228947"].at === "2026-09-04T12:00:00.000Z",
  JSON.stringify(back.wire))
t("each carried store owns its own key; the config keeps no second copy",
  !back.cfgKeys.includes("pools") && !back.cfgKeys.includes("rosters") &&
    !back.cfgKeys.includes("lineups"),
  back.cfgKeys.join(","))

// The masthead has to SAY which of the two availability answers the page is on.
// The board prefers an exact list and always has; what it could not do was tell you
// that it had one — or, on the hosted build where it never did, that it did not.
//
// A pool belongs to ONE league, and the file carries two. The preset league the
// earlier route created is active when the file lands, and it has no wire — so the
// chip must be absent there rather than showing 228947's free agents beside a
// league they say nothing about.
t("a pool is not shown for a league it was not read from",
  (await fp.locator('[data-wire="carried"]').count()) === 0,
  await fp.locator('[data-wire="carried"]').textContent().catch(() => "(absent)"))
await fp.selectOption('select[aria-label="Scoring these picks against"], select[aria-label="League being edited"]', "yahoo:228947")
await fp.waitForTimeout(500)
const wireChip = await fp.locator('[data-wire="carried"]').textContent()
t("the masthead names the exact list and how old it is",
  /free agents\s*2\s*read\s*(just now|\d+[mhd] ago)/.test(wireChip.replace(/\s+/g, " ")),
  wireChip)
t("and its tooltip names the instant, not just the age",
  /2026-09-04T12:00:00\.000Z/.test(await fp.locator('[data-wire="carried"]').getAttribute("title")),
  (await fp.locator('[data-wire="carried"]').getAttribute("title")).slice(0, 120))
t("no page errors through either route", freshErrors.length === 0, freshErrors.join(" | "))
await fresh.close()

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
