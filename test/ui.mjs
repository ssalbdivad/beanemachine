import { chromium, firefox } from "playwright-core"
import { readFileSync } from "node:fs"

// Defaults to THIS repo's dev port. It used to default to :5173, which is Vite's
// own default and therefore belongs to whichever project on the machine started
// first — here that is another live app, and pointing a suite that clears
// localStorage and types into forms at somebody else's running site is a real
// hazard, not just a wrong-port failure. The wordmark check below still exists
// because a 200 on any port is not proof of identity.
const BASE = process.env.BASE ?? "http://127.0.0.1:5299"
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

/**
 * Tonight's slate is STUBBED, in every page this suite opens.
 *
 * The app now reads MLB's schedule endpoint live — `src/data/today.ts`, called from
 * `src/client/useSlate.ts` — so that Decide can say "no game today" about tonight
 * rather than about a capture that is two days old. That request goes to
 * statsapi.mlb.com from inside the browser, and two things follow for this suite,
 * neither of them about the UI it exists to test:
 *
 *  - On a machine whose browser cannot reach the public internet the request never
 *    settles. It does not fail, it HANGS, so `waitUntil: "networkidle"` never fires.
 *    Measured: the reload after `localStorage.clear()` below timed out at 30s with
 *    exactly one request outstanding, the schedule one, and took the whole run down
 *    as an uncaught TimeoutError two thirds of the way through.
 *  - On a machine that CAN reach it, the answer is a different slate every day, and
 *    every wait in here would be paced by somebody else's server.
 *
 * An empty-but-valid schedule (`{"dates":[]}`) is what gets served instead:
 * `fetchSlate` reads it as a slate with no games and no error, which is the one
 * response that is both deterministic and not a failure state. Nothing in THIS suite
 * asserts on lineups — that is test/today.mjs and test/decide.mjs — so a real slate
 * buys this file nothing and costs it determinism.
 */
const stubSlate = target =>
  target.route("**statsapi.mlb.com/**", r =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ dates: [] }) }))

const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
await stubSlate(page)

/**
 * The console trap SPLITS rather than filters, because one failing request here is
 * the app working correctly.
 *
 * `detectMode` in src/client/api.ts probes `/api/health` on every dev load: the
 * Hono server may or may not be running behind `npx vite`, and asking is the only
 * way to find out whether this page can read a Yahoo league for itself. With no
 * server up, Vite's `/api` proxy answers 502 and the browser logs a bare "Failed to
 * load resource" — with no URL in the text, so it cannot be told apart by matching
 * the message. It has to be correlated with the response that caused it, which is
 * what the `PROBE` / `unexpectedFailures` pair below does. This is the same split
 * test/journey.mjs makes for the same probe, for the same reason.
 *
 * The important half is that this cannot quietly swallow a real broken asset: any
 * OTHER failing request makes the generic line ours again and fails the assertion.
 */
const PROBE = /\/api\/health$/
const errors = []
const unexpectedFailures = []
const GENERIC_LOAD_FAILURE = /^Failed to load resource/
page.on("pageerror", e => errors.push(`pageerror: ${e}`))
page.on("response", r => {
  if (r.status() >= 400 && !PROBE.test(new URL(r.url()).pathname))
    unexpectedFailures.push(`${r.status()} ${r.url()}`)
})
page.on("console", m => {
  if (m.type() !== "error") return
  if (GENERIC_LOAD_FAILURE.test(m.text()) && !unexpectedFailures.length) return
  errors.push(m.text())
})

await page.goto(BASE, { waitUntil: "networkidle" })

// A 200 on this port is not proof it is this app: a stale dev server for another
// project answers a goto just as happily, after which every
// assertion below fails as a selector timeout that reads like a UI defect. The
// wordmark is the cheapest proof of identity, so it is checked before anything
// else and stops the run rather than letting the next wait speak for it.
const wordmark = await page.waitForSelector("h1", { timeout: 15000 }).then(h => h.textContent(), () => null)
t("the page under test is beanemachine", wordmark === "beanemachine",
  `BASE=${BASE} served <h1>${wordmark}</h1> — start this repo's own vite, or set BASE to it`)
if (wordmark !== "beanemachine") { await browser.close(); process.exit(1) }
/**
 * ── Navigating by the tab's NAME, never by its index ─────────────────────────────
 *
 * Every click in this file used to be `.views button:nth-child(N)`, and the app just
 * went from four tabs to three: "Recommendations | League setup | My team & trades"
 * became "Today | Wire | Setup", the league editor this suite is almost entirely
 * about moved from the second tab to the THIRD — underneath the team panel — and the
 * tab that used to be second no longer exists. Every `nth-child(2)` in here silently
 * became a click on Wire, and the first one took the whole run down as a 30s selector
 * timeout that read like a broken editor.
 *
 * An index encodes a fact nobody promised: the order of the nav. A name encodes the
 * thing the assertion actually depends on — which screen owns the job. So navigation
 * goes through `screen()`, which matches the visible label exactly (`:text-is`, not
 * `:has-text`, so "Setup" cannot also match a future "Setup help"), and the next
 * rename is one line here instead of a dozen index bumps scattered through the file.
 */
const screen = async (pg, label) => {
  await pg.waitForSelector(".views button")
  await pg.click(`.views button:text-is("${label}")`)
}

/**
 * The league editor now SHARES its screen with the team panel, so "the first card in
 * the grid" no longer means what it did.
 *
 * Setup renders Trade's grid (My team, What to add and drop, your lineup, The deal),
 * then the editor's own two grids — This league / Scoring period, then batting,
 * pitching, slots, eligibility, needs-review, league rules. The old
 * `.grid section:nth-of-type(1)` matched the first section of EVERY grid on the page,
 * which on this screen is "My team", and `.code`/`input.val` reads through it came
 * back empty rather than wrong — the worst shape for a failure, because an empty list
 * makes `codes.indexOf("HR")` return -1 and every value assertion below it reads a
 * field that was never found.
 *
 * Addressing the card by its own heading is both narrower and stable: it survives the
 * cards being reordered, regrouped into a different number of grids, or moved onto
 * another screen again — all three of which have now happened once.
 */
const BATTING = 'section.card:has(h2:text-is("Batting"))'
const PITCHING = 'section.card:has(h2:text-is("Pitching"))'

// Setup is the third tab and the editor is the lower half of it; the wait is on a
// stat table rather than on the tab being marked current, because the team panel
// above it paints first and a click that landed on the wrong screen has to fail here
// rather than forty assertions later.
const toLeagueSetup = async pg => {
  await screen(pg, "Setup")
  await pg.waitForSelector(`${BATTING} .rows`)
}

/**
 * The league MANAGEMENT row — Set up a league, the template picker, New, Remove,
 * Download, Load file, import by URL — is on Setup too, and only there.
 *
 * It used to sit above whatever tab was open, which put five controls nobody on the
 * recommendations page needs between the masthead and the answer. `manage` in
 * src/client/App.tsx now renders it for `view === "trade"` (Setup), for a store with
 * no leagues at all, and for a store that could not be read — the three situations
 * where managing a league is the thing you came to do. So a test that wants the
 * toolbar has to be ON Setup, and waits for the toolbar itself rather than for the
 * stat tables, because the two halves of this screen mount independently and a wait
 * on the wrong half is a timeout that blames the wrong component.
 */
const toSetupBar = async pg => {
  await screen(pg, "Setup")
  await pg.waitForSelector("#tpl")
  await pg.waitForSelector('.bar button:text-is("Download")')
}

/**
 * ── The setup is a DOCK now, and reaching it is a GESTURE ────────────────────────
 *
 * `<Onboard/>` used to be a card in the page flow, so waiting for `.onboard` after a
 * load or a button press was enough to have it. It is now the contents of
 * `.dock-sheet` — a sheet over a bar fixed to the foot of the viewport, see
 * src/client/Dock.tsx — and while that sheet is CLOSED the card is not rendered at
 * all: `.onboard` does not exist and `.dock-bar` is the whole of it. A first visit
 * lands closed on purpose, because the ranked board is the argument for filling the
 * form in, and a form shown before the numbers asks for the two minutes first.
 *
 * So every route to the setup now ends in a gesture, and the gestures live here rather
 * than being clicked inline at each site: there are three callers below, and the next
 * time that button is relabelled it should be one line in this file.
 */
// The bar's single button both opens and closes the sheet, and its label flips between
// "Set up my league" and "Close" — so it is addressed by its place in the bar rather
// than by text that is only ever half of what you are looking for.
const DOCK_TOGGLE = ".dock-bar button"
/** The other way in, and with a league the only one: pressing it is what puts the
 *  dock on the page at all. See the exclusive-or assertion further down — the bar and
 *  this button are one switch, and exactly one of them is ever on screen. */
const TOOLBAR_SETUP = '.bar button:text-is("Set up a league")'
const openDock = async pg => {
  // With no league the bar is always there; with one it appears only after the
  // toolbar's button is pressed, and vanishes again when the sheet is closed. So the
  // helper takes whichever handle is on screen rather than assuming the bar.
  if (!(await pg.locator(".dock-bar").count())) {
    await pg.waitForSelector(TOOLBAR_SETUP)
    await pg.click(TOOLBAR_SETUP)
  }
  await pg.waitForSelector(DOCK_TOGGLE)
  // The button TOGGLES, so an open-it helper that clicks unconditionally closes the
  // sheet for any caller that already had it up — a silent wrong turn that would show
  // up forty lines later as a missing `.onboard`. It asks first.
  if ((await pg.locator(DOCK_TOGGLE).getAttribute("aria-expanded")) !== "true")
    await pg.click(DOCK_TOGGLE)
  // Waited for INSIDE the sheet. A bare `.onboard` would also be satisfied by the card
  // having drifted back into the page flow above the board, which is the exact
  // regression the dock exists to prevent and the one a screenshot would not show.
  await pg.waitForSelector(".dock-sheet .onboard")
}
const closeDock = async pg => {
  await pg.click(DOCK_TOGGLE)
  await pg.waitForSelector(".dock-sheet", { state: "detached" })
}
/**
 * The toolbar's "Set up a league" is the route back for a reader who already has one,
 * and it opens the sheet ALREADY EXPANDED rather than dropping a closed bar at the foot
 * of the page for him to notice — `onOnboard` in src/client/App.tsx sets both
 * `onboarding` (the bar exists at all) and `setupOpen` (the sheet is up). Waiting on
 * `.onboard` alone cannot tell those apart, so the wait is on the sheet: a press that
 * produced only the bar would be a reader who asked for the setup and got a sentence.
 */
const setupFromToolbar = async pg => {
  await pg.click('.bar button:text-is("Set up a league")')
  await pg.waitForSelector(".dock-sheet .onboard")
}

await toLeagueSetup(page)

await page.screenshot({ path: "/tmp/bc-light.png", fullPage: true })
t("no console/page errors on load", errors.length === 0, errors.join(" | "))
// The half of the old single assertion that the split above would otherwise have
// dropped: no request failed except the mode probe, which is allowed to.
t("nothing but the API probe failed to load", unexpectedFailures.length === 0,
  unexpectedFailures.join(" | "))
t("wordmark renders", (await page.textContent("h1")) === "beanemachine")
t("league selected", (await page.inputValue(".bar select")) === "yahoo:228947")

// chips reflect real imported data
const chips = await page.$$eval(".chip", n => n.map(e => e.textContent.trim()))
t("chip shows team", chips.some(c => c.includes("Mrs. Met's Harem")), chips.join(" / "))
t("chip shows provenance", chips.includes("read from source"), chips.join(" / "))

// scoring tables rendered with the real values
const codes = await page.$$eval(BATTING + " .code", n => n.map(e => e.textContent))
const vals = await page.$$eval(BATTING + " input.val", n => n.map(e => e.value))
t("batting has 9 stats", codes.length === 9, codes.join(","))
t("HR = 10.4", vals[codes.indexOf("HR")] === "10.4", vals.join(","))
const pvals = await page.$$eval(PITCHING + " input.val", n => n.map(e => e.value))
t("pitching ER = -3", pvals.includes("-3"), pvals.join(","))
t("negatives styled as penalties",
  (await page.$$eval(PITCHING + " input.val.neg", n => n.length)) === 4)

// roster totals
const totals = await page.$$eval(".tot", n => n.map(e => e.textContent))
t("roster totals 18/5/4/27",
  ["18active", "5bench", "4IL", "27total"].every(x => totals.some(v => v.replace(/\s/g, "") === x)),
  totals.join(" "))

// save bar hidden until an edit, then appears
t("save bar hidden initially", !(await page.locator(".savebar").evaluate(e => e.classList.contains("on"))))
const hr = page.locator(BATTING + " input.val").nth(codes.indexOf("HR"))
await hr.fill("11.5"); await hr.blur()
await page.waitForTimeout(150)
t("editing marks dirty", await page.locator(".savebar").evaluate(e => e.classList.contains("on")))

// revert restores
await page.click(".savebar button:not(.primary)"); await page.waitForTimeout(150)
const after = await page.$$eval(BATTING + " input.val", n => n.map(e => e.value))
t("revert restores value", after[codes.indexOf("HR")] === "10.4", after.join(","))
t("save bar hides after revert", !(await page.locator(".savebar").evaluate(e => e.classList.contains("on"))))

/**
 * A penalty must be typeable. `<input type=number>` reports an empty value with
 * validity.badInput while a lone "-" is on screen; a controlled field read that as
 * "cleared" and React restored the committed number over the keystroke, so typing
 * -3 produced 83. Most pitching categories ARE penalties, so the path this app
 * exists to serve could not express them. No suite saw it.
 */
const erIndex = (await page.$$eval(PITCHING + " .code", n =>
  n.map(e => e.textContent)
)).indexOf("ER")
if (erIndex >= 0) {
  const er = page.locator(PITCHING + " input.val").nth(erIndex)
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
const reloaded = await page.$$eval(BATTING + " input.val", n => n.map(e => e.value))
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
const first = page.locator(BATTING + " input.val").first()
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
// "League being edited" was the label when the editor had a tab of its own. The same
// select now sits on Setup, which is the team AND the league, and `LEAGUE_LABEL` in
// src/client/App.tsx says so per view ("Deciding for" on Today, "Scoring these picks
// against" on Wire, "League and team" here). The claim being protected is unchanged
// and is the reason the map exists: this control means a different thing on each
// screen, so it must never be an unlabelled box — a bare select next to New/Remove/
// Download reads as "pick a template", which is the control beside it.
t("dropdowns and URL field are labelled",
  labels.some(l => l.includes("league and team")) &&
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
await stubSlate(fresh)
const fp = await fresh.newPage()
const freshErrors = []
fp.on("pageerror", e => freshErrors.push(String(e)))
fp.on("dialog", d => d.accept())
await fp.goto(BASE, { waitUntil: "networkidle" })
// The app opens on Today, which is the Decide card and nothing else — the ranked
// board moved to Wire. This wait used to be for `.board-row` and was really only
// asking "has the app finished booting"; `.decide` is the same question asked of the
// screen that is actually in front of the reader now.
await fp.waitForSelector(".decide", { timeout: 25000 })
await toSetupBar(fp)

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

/**
 * The routes are NAMED where a person goes looking for them.
 *
 * They used to be listed on League setup, inside a card headed "Use your own
 * league" that rendered only while the SEEDED example league was active — and the
 * seed is gone: the deployed build ships no league and a first visit opens on the
 * guided setup instead. The claim is unchanged and is still the one that matters:
 * every way into your own league is named, in one place, and the file route prints
 * a command the reader could actually run.
 *
 * Reached here through the dock — the toolbar's "Set up a league" opened it a few
 * assertions up, which is the route back for somebody who already has one (the setup
 * opens by itself only on a first visit, and without that button a reader who set the
 * wrong league up had no way to it at all). The card is the same `<Onboard/>` it always
 * was; only its container moved, from the page flow into `.dock-sheet`.
 */
/**
 * ── The setup can be PUT AWAY, and got back ─────────────────────────────────────
 *
 * A new claim about a surface that did not exist when this file was last touched: the
 * setup is a dock, and a dock that cannot be dismissed is worse than the card it
 * replaced, because the card at least scrolled away. The whole bet of moving it here is
 * that a reader meets the ranking first and opens the form once the ranking has earned
 * it — which holds only if opening and closing are each one press, and if closing does
 * not cost him the way back. Every way that goes wrong is invisible in a screenshot: a
 * sheet that closes and takes its bar with it (no route back at all, which is what the
 * toolbar button was added to fix in the first place), a bar that reopens an empty
 * sheet, an Escape that does nothing, a close that leaves the page scroll-locked.
 *
 * Checked on the reader who ALREADY HAS A LEAGUE, because he is the one for whom this
 * is optional furniture — on a first visit the bar is simply part of the page.
 */
await setupFromToolbar(fp)
t("the toolbar's way back opens the setup inside the dock, already expanded",
  (await fp.locator(".dock.on .dock-sheet .onboard").count()) === 1 &&
    (await fp.locator(DOCK_TOGGLE).getAttribute("aria-expanded")) === "true" &&
    (await fp.locator(DOCK_TOGGLE).textContent()) === "Close",
  `${await fp.locator(".dock-sheet .onboard").count()} onboard in sheet, button "${await fp.locator(DOCK_TOGGLE).textContent()}"`)
// The sheet is not a modal and must not start behaving like one: it scrolls inside
// itself (`overscroll-behavior:contain` in app.css) precisely so the board goes on
// scrolling behind it, because "let me look at that row again" is the commonest thing a
// reader does half way through setting a league up. A page-level scroll lock is the
// cheapest possible way to break that and would look identical on screen.
t("and the page behind it still scrolls, because the sheet is not a modal",
  await fp.evaluate(() =>
    getComputedStyle(document.body).overflow !== "hidden" &&
    getComputedStyle(document.documentElement).overflow !== "hidden"))
await closeDock(fp)
t("closing it takes the form off the page entirely, not merely out of sight",
  (await fp.locator(".dock-sheet").count()) === 0 &&
    (await fp.locator(".onboard").count()) === 0,
  `${await fp.locator(".dock-sheet").count()} sheets, ${await fp.locator(".onboard").count()} onboard cards`)
/*
 * With a league, closing the sheet takes the WHOLE dock away and gives the toolbar
 * back, and that is a deliberate reversal of what this suite asserted first.
 *
 * The first version required the bar to outlive the sheet, because it was the only
 * handle left: `manage` was gated on `!onboarding`, so pressing the toolbar's "Set up
 * a league" removed the toolbar — that button included — and closing the sheet did
 * not bring it back. Measured the hard way here: reaching for the button a second
 * time timed out at 30s.
 *
 * The fix was not to keep the bar. A reader who already HAS a league and has just
 * finished looking at the setup should have his ordinary chrome back, not a bar
 * across the foot of every screen until he reloads — the bar is for somebody who has
 * no league and needs the way in. So closing the sheet clears the onboarding state,
 * the dock goes with it, and the route back is the SETUP TAB, which is one of three
 * and is called Setup. What has to hold is that the toolbar really does return.
 */
t("but the toolbar comes back, so there is still a way in",
  (await fp.locator(".dock-bar").count()) === 0 &&
    (await fp.locator('.bar button:text-is("Set up a league")').count()) === 1,
  `${await fp.locator(".dock-bar").count()} bars, ${await fp.locator('.bar button:text-is("Set up a league")').count()} buttons`)
await openDock(fp)
t("and that button opens it again, with the form in it",
  (await fp.locator(".dock-sheet .onboard").count()) === 1,
  String(await fp.locator(".dock-sheet").count()))
// Escape is the second way out, and it is bound on the document rather than on the
// sheet so that it works with focus anywhere — including left in the page behind, which
// is where a reader who was comparing rows will have put it.
await fp.click("h1")
await fp.keyboard.press("Escape")
await fp.waitForSelector(".dock-sheet", { state: "detached", timeout: 5000 })
t("Escape closes it too, from focus anywhere, and still leaves the way back",
  (await fp.locator(".dock-sheet").count()) === 0 &&
    (await fp.locator('.bar button:text-is("Set up a league")').count()) === 1)
/**
 * The dock and the toolbar are one switch, never two: they must never both be
 * offering the way in, and there must never be neither.
 *
 * That is the property worth pinning, because it is easy to break in either
 * direction — `manage` is gated on whether the dock is up, and the dock is gated on
 * whether the reader has a league or has asked for the setup, so a change to either
 * gate can leave a reader with two ways in or none. Asserted as an exclusive-or on
 * the two handles rather than on one of them.
 */
{
  const handles = async () => ({
    bar: await fp.locator(".dock-bar").count(),
    toolbar: await fp.locator('.bar button:text-is("Set up a league")').count()
  })
  const shut = await handles()
  t("with the sheet shut there is exactly one way back in, and it is the toolbar",
    shut.bar === 0 && shut.toolbar === 1, JSON.stringify(shut))
  await openDock(fp)
  const open = await handles()
  t("and with it open the toolbar is gone, so the two never both offer it",
    open.bar === 1 && open.toolbar === 0, JSON.stringify(open))
  await closeDock(fp)
}

// Back in for the route assertions below, through the only door there now is.
await openDock(fp)
await fp.click('.onboard .chip-btn:text-is("Yahoo")')
await fp.click(".onboard-alts summary")
const routes = await fp.$$eval(".onboard-alts dt", n => n.map(e => e.textContent))
t("the ways into your own league are named, in one place", routes.length >= 3, routes.join(" | "))
// It must be runnable by the person READING it, which is somebody on
// beanemachine.com with no clone. `node --experimental-strip-types src/cli.ts` was
// neither: the flag has not been needed since node 22.18, and the path only exists
// inside a checkout. The npx form is verified to work — `bin` in package.json points
// at a compiled bundle, because node refuses to strip types under node_modules and
// the .ts bin failed on its first line for everyone.
t("and the file route prints a command a visitor could actually run",
  /^npx --yes github:/.test(await fp.locator(".onboard-alts pre").first().textContent()),
  await fp.locator(".onboard-alts pre").first().textContent())
// The paste route leads, because it is the only one no platform can switch off.
t("and pasting the settings page leads, above every route that needs permission",
  await fp.evaluate(() => {
    const box = document.querySelector('textarea[data-ctl="paste-settings"]')
    const alts = document.querySelector(".onboard-alts")
    return !!box && !!alts &&
      !!(box.compareDocumentPosition(alts) & Node.DOCUMENT_POSITION_FOLLOWING)
  }))
// back out of the setup the way a reader does
await fp.click(".onboard-done button")
// `onDone` sends the reader to Today, so the toolbar has to be walked back to rather
// than assumed: the management row lives only on Setup now.
await toSetupBar(fp)

// Route 1: one click from the picker to a ranked board.
await fp.click('.bar button:text-is("New")')
// `New` leaves you where you clicked it, which is Setup — the ranked board it makes
// possible is one screen over. The claim is unchanged (one click from the picker to a
// board that ranks) and the click it now takes to SEE that is part of the claim: if
// Wire came up empty for a freshly created preset league, the preset would be useless
// no matter how complete its stored values were.
await screen(fp, "Wire")
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
const preset = await fp.locator(".preset-note").first().textContent()
t("the board says the values were not read from your league",
  /not read from your league/i.test(preset), preset.slice(0, 120))
t("and it names what to check, from the league's own needs_review",
  (await fp.$$eval(".preset-note .flags li", n => n.length)) >= 3,
  String(await fp.$$eval(".preset-note .flags li", n => n.length)))
t("and the provenance chip reads unverified, not read from source",
  (await fp.$$eval(".chip", n => n.map(e => e.textContent.trim()))).includes("unverified"),
  (await fp.$$eval(".chip", n => n.map(e => e.textContent.trim()))).join(" / "))

// The notice has to be able to END, or it is a warning people learn to read past —
// including on a league where it is still true. Nothing clears it automatically:
// saving an edit is not proof of checking, since changing one home-run value leaves
// the other sixteen borrowed. This is the user's own statement, and what it records
// is manual entry, not a read — `verified` stays false either way, because importing
// the league is still the only thing that can change that.
await fp.click('.preset-note button:text-is("I\u2019ve checked these against my league")')
await fp.waitForTimeout(400)
t("saying you checked the preset's values ends the notice",
  (await fp.locator(".preset-note").count()) === 0,
  await fp.locator(".preset-note").first().textContent().catch(() => "(gone)"))
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
await toSetupBar(fp)
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
// Under `npx vite` the cleared store re-seeds from the committed scoring.json, so a
// league is back and the app opens on Today. Waiting for `.decide` rather than
// `.board-row` is not a weaker wait: what this needs is "the app has mounted and its
// window drop handler is registered", and Today is what mounts.
await fp.waitForSelector(".decide", { timeout: 25000 })
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
// The league select is in the masthead bar on every screen once there are two
// leagues to choose between, but its LABEL changes per screen (LEAGUE_LABEL), and
// after the drop the page is on Today — so it is addressed as "the one select in the
// bar that is not the template picker" rather than by a label that is a property of
// whichever tab happens to be open. `#tpl` is the only other select the bar ever has.
await fp.selectOption(".bar select:not(#tpl)", "yahoo:228947")
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
await stubSlate(dark)
const dp = await dark.newPage()
await dp.goto(BASE, { waitUntil: "networkidle" })
await toLeagueSetup(dp)
const bg = await dp.evaluate(() => getComputedStyle(document.body).backgroundColor)
t("dark mode background applied", bg === "rgb(20, 22, 26)", bg)

// mobile layout: no horizontal overflow
const mob = await browser.newContext({ viewport: { width: 390, height: 844 } })
await stubSlate(mob)
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
/**
 * ── There is no Draft tab, and the question its banner answered is still answered ──
 *
 * WHAT THIS USED TO ASSERT. A fourth tab, "Draft", rendered a pick-by-pick draft
 * board out of `src/engine/draft.ts`. Opened in September — which is when the
 * committed capture is from, 144 games deep — a draft board is worse than useless:
 * it is a confident plan for an event that happened in March. So the tab carried a
 * `.draft-underway` banner, and three assertions lived here:
 *
 *   1. "a draft board opened mid-season says so before anything else"
 *   2. "it says how far in, and points at the page that can still help"
 *      (matched /\d+ games into/ and /Recommendations/ in the banner)
 *   3. "and it does not remove the board underneath it" (.draft-pick still present)
 *
 * WHY THEY CHANGED. The tab is gone: `src/client/Draft.tsx`, `src/engine/draft.ts`
 * and `test/draft.mjs` are deleted and `VIEWS` in src/client/panels.tsx is down to
 * three entries. The whole class of failure those assertions guarded — a reader
 * taking a stale draft board seriously — cannot happen when there is no draft board,
 * and deleting a warning is the right move only if the thing it warned about went
 * with it. So (1) and (3) become ONE assertion that the surface is really gone
 * everywhere rather than merely unlinked, which is the way a removal like this
 * actually rots: the component stays, a tab stops pointing at it, and it comes back
 * on the next refactor.
 *
 * (2) is the one that protected something a reader still needs, and it survives
 * pointed at what now answers it. Two separate claims were packed into that regex:
 *
 *   - "how far in" — how current the data behind the numbers is. That is now the
 *     masthead chip, `player data <b>2d ago</b>`, which `freshness()` in panels.tsx
 *     marks `.warn` past 36 hours and which renders on EVERY tab rather than only on
 *     the one a person was least likely to open. It is a better home for the claim
 *     than the draft banner was.
 *   - "points at the page that can still help" — Recommendations. A banner is no
 *     longer needed to point at it: it is where the app opens.
 *
 * Asserted on a fresh context, because `page` has been clicked through forty
 * assertions of league editing and is no longer on the default view.
 */
{
  const look = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
  await stubSlate(look)
  const lp = await look.newPage()
  await lp.goto(BASE, { waitUntil: "networkidle" })
  await lp.waitForSelector(".views button")
  const tabs = await lp.$$eval(".views button", n => n.map(e => e.textContent.trim()))
  /**
   * THE NAV ITSELF, which is the thing three other assertions in this block navigate
   * by, so it is pinned rather than inferred.
   *
   * It read ["Recommendations", "League setup", "My team & trades"] — three tabs left
   * over from four, named after the machinery rather than after the moment they serve.
   * It is now ["Today", "Wire", "Setup"]: one question per screen, in the order a
   * season is actually lived — what to do before first pitch, who is out there to get,
   * and the once-a-season league-and-team setup both of those are priced in.
   *
   * The half of the old assertion that has not changed at all is the one that matters
   * most here: there are THREE, and none of them is a draft. A fourth tab reappearing
   * is how the deleted draft board would come back.
   */
  t("the tabs are the three screens that are left, and none of them is a draft",
    JSON.stringify(tabs) === JSON.stringify(["Today", "Wire", "Setup"]),
    tabs.join(" | "))
  /**
   * WHERE THE APP OPENS, and what it says there.
   *
   * This used to assert that the default tab was "Recommendations" and that it was
   * already rendering `.board-row`s — the ranked table — because the banner the draft
   * tab carried pointed a mid-season reader at that page, and the claim being kept
   * alive was "the thing the banner deferred to is still there, and still works".
   *
   * Both halves moved, in opposite directions. The default is Today, and Today no
   * longer ranks: it renders the Decide card alone. At phone width the old shared tab
   * was 7,477px, which put the first ranked row well past the fold and the decision a
   * reader came for underneath nothing; Today is now 947px and 105 words with no
   * roster loaded. The ranked board is Wire, one tap away.
   *
   * So the assertion is split in two, because the single claim has become two and
   * collapsing them would let either one rot unnoticed: Today is what opens and it
   * answers with a decision, and the ranking is still reachable and still ranks. Only
   * the second half is what the draft banner pointed at, and it is the one that would
   * have been quietly lost by deleting this.
   */
  t("the app opens on Today, with the decision rather than the table",
    (await lp.$eval(".views button.on", e => e.textContent.trim())) === "Today" &&
      (await lp.waitForSelector(".decide", { timeout: 25000 }).then(() => true, () => false)) &&
      (await lp.locator(".board-row").count()) === 0,
    `${await lp.$eval(".views button.on", e => e.textContent.trim()).catch(() => "(no tab marked current)")} — ${await lp.locator(".board-row").count()} board rows`)
  // The link is part of the claim: Today only gets to be this short because the thing
  // it dropped is one labelled tap away, and a reader who cannot find the table is no
  // better off than one who had to scroll past it.
  t("and it names the way to the ranked board, which still ranks",
    (await lp.locator('.next-screen button:text-is("Everyone you can get →")').count()) === 1 &&
      (await lp
        .click('.next-screen button:text-is("Everyone you can get →")')
        .then(() => lp.waitForSelector(".board-row", { timeout: 25000 }))
        .then(() => lp.$$eval(".board-row", n => n.length), () => 0)) > 50,
    `${await lp.locator(".board-row").count()} rows, tab ${await lp.$eval(".views button.on", e => e.textContent.trim()).catch(() => "?")}`)
  // Every screen, not just the default: a draft board that is merely unlinked is a
  // draft board. Walked by NAME — this loop was the worst of the `nth-child` callers,
  // because it derived its indices from `tabs` and so would have gone on passing while
  // visiting the wrong three screens if a fourth tab were ever inserted.
  const drafty = []
  for (const label of tabs) {
    await screen(lp, label)
    await lp.waitForTimeout(400)
    const found = await lp.evaluate(() =>
      document.querySelectorAll(".draft-pick, .draft-underway, .draft-board").length)
    if (found) drafty.push(`${label}:${found}`)
  }
  t("no draft surface renders on any of them, not merely unlinked from the nav",
    drafty.length === 0, drafty.join(" "))
  // What "how far in" became. Read on Today, the screen a person actually opens, and
  // it is in the masthead so it is on all three.
  await screen(lp, "Today")
  await lp.waitForSelector(".decide", { timeout: 25000 })
  const ageChip = await lp.locator(".chip", { hasText: /player data/ }).first()
  const ageText = (await ageChip.textContent()).replace(/\s+/g, " ").trim()
  t("the page still says how old the data behind the numbers is",
    /^player data (just now|\d+h ago|\d+d ago|age unknown)$/.test(ageText), ageText)
  // And it is FLAGGED, not just printed. The committed capture is stamped
  // 2026-09-08; anything past 36h is stale by `freshness()`'s own line, and a stale
  // age that renders in the same grey as a fresh one is the draft banner's failure
  // all over again — true on the page and invisible to the reader.
  const stale = /(\d+)d ago/.exec(ageText)
  if (stale) {
    t("and a capture this old is flagged, not printed in the same grey as a fresh one",
      await ageChip.evaluate(e => e.classList.contains("warn")),
      `${ageText} — classes: ${await ageChip.getAttribute("class")}`)
  } else {
    // Reached only against a freshly captured snapshot. The claim still has to be
    // checked, so it is checked in the other direction rather than skipped.
    t("and a fresh capture is not flagged as stale",
      !(await ageChip.evaluate(e => e.classList.contains("warn"))),
      `${ageText} — classes: ${await ageChip.getAttribute("class")}`)
  }
  await look.close()
}

/**
 * When something throws, the reader gets a page rather than nothing.
 *
 * React unmounts the whole tree on an uncaught render error, so before this any one
 * component could take the site down to white — and one did: `roster.of` throws on a
 * store it cannot parse, and reading it during render turned a corrupt localStorage
 * key into a blank screen with no way out and nothing to report. A blank page is the
 * worst failure a site opened to make a decision can have, because it reads as "the
 * site is gone" rather than "something went wrong".
 *
 * Forced with a snapshot that parses and is the wrong shape, which throws inside
 * `hydrate` during render — a real path, not a synthetic component that throws on
 * purpose.
 */
{
	const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
	await stubSlate(page)
	await page.route("**/snapshot.json", r =>
		r.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				season: 2026,
				capturedAt: "2026-09-09T00:00:00Z",
				horizon: { start: "2026-09-09", end: "2026-09-23" },
				players: 5
			})
		})
	)
	await page.goto(BASE, { waitUntil: "networkidle", timeout: 60000 })
	await page.waitForTimeout(2500)
	const shown = await page.$(".boundary")
	t("a render error shows a page rather than a blank screen", !!shown,
		(await page.$eval("body", e => e.innerText)).slice(0, 120) || "(the page was blank)")
	if (shown) {
		const text = await shown.innerText()
		t("it says what threw, so there is something to report",
			/TypeError|Error/.test(text) && text.length > 80, text.slice(0, 140))
		t("it offers the recovery that actually works, and names what it deletes",
			/Clear what this site stored/.test(text) && /your leagues, your roster/i.test(text),
			text.slice(0, 400))
		t("and offers a plain reload first, for a one-off",
			/reload/i.test(text), text.slice(-160))
	}
	await page.close()
}

await browser.close()
console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
