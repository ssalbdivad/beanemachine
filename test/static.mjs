// Verifies the GitHub Pages build: no backend, a first visit that asks for YOUR
// league instead of lending somebody else's, editing and saving working exactly as
// they do with a server behind them, and — measured 2026-09-04 — a real ESPN league
// IMPORTING and its roster READING with no server at all, because ESPN sends CORS
// headers that let a page read it. Yahoo sends none, and that is the case this
// build exists to serve: a Yahoo user's routes to a ranked board are pasting the
// settings page, the preset, and a file dropped on the page.
//
// The first section is new and is the reason the rest of this file moved. The build
// used to ship a league — one real Yahoo league belonging to a real person — and
// seed it into every browser that had nothing stored, so a stranger's first screen
// was a fully ranked board denominated in somebody else's points, under a notice
// explaining that it was. `publishSnapshot` in vite.config.ts now strips `leagues`
// out of the published asset, so there is no board on a first visit and there is
// not meant to be one. Every section below that used to start from the seed now
// starts by SETTING A LEAGUE UP, through the same onboarding a reader walks.
import { chromium } from "playwright-core"
import { readFileSync } from "node:fs"
// The build's base is relative, so preview serves it at the root and the same
// artifact would work just as well under /beanemachine/ or at a custom domain's
// apex — which is the property this suite is checking on behalf of.
const BASE = process.env.STATIC_BASE ?? "http://127.0.0.1:4173/"
const b = await chromium.launch({ args: ["--no-sandbox"] })
const p = await b.newPage({ viewport:{width:1280,height:1000} })
/**
 * A hosted static build has no API behind it, and that is the whole subject of this
 * suite — so it is enforced here rather than assumed of the machine.
 *
 * It used to be assumed, and only held by accident: the build's base was
 * `/beanemachine/`, so the mode probe asked for `/beanemachine/api/health`, which
 * missed Vite's `/api` proxy prefix and fell through to the SPA handler. Once the
 * base became relative the probe asked for `/api/health`, the proxy matched, and a
 * dev API server that happened to be running on this machine answered 200 — so the
 * page came up in SERVER mode and every static-only assertion below failed. The
 * suite was measuring what else was running, not what it was built to test.
 */
await p.route("**/api/**", r => r.abort())
const errs = []
p.on("pageerror", e => errs.push(String(e)))
/** Every URL the page asks for. The headline claim of this suite is now that a
 *  league is read STRAIGHT FROM THE PLATFORM by the page, so it is proved by the
 *  request that went out rather than only by the toast that came back. */
const requested = []
p.on("request", r => requested.push(r.url()))
await p.goto(BASE, { waitUntil:"networkidle" })
/**
 * The app is UP when `.dock-bar` is up, not when `.onboard` is.
 *
 * The setup used to be a card in the page flow, so a browser holding no league
 * rendered `<Onboard/>` on the first paint and waiting for `.onboard` was the same
 * thing as waiting for the app. It is a DOCK now — a fixed bar across the foot of the
 * viewport, src/client/Dock.tsx — and on a first visit that bar is CLOSED, which means
 * `<Onboard/>` is not mounted at all. This is the no-league suite, so that is the
 * state of every page it opens, and this line is exactly where it died: 25s waiting
 * for a selector that the new first visit is defined by NOT having.
 */
await p.waitForSelector(".dock-bar", { timeout: 25000 })
/**
 * The gesture that reaches the setup, written once.
 *
 * Closed, the dock is one line of summary and one button; the `<Onboard/>` card only
 * enters the DOM when that button is pressed. Six blocks below this read the
 * onboarding and every one of them now has to ask for it first, so the gesture is a
 * named helper rather than a click repeated at each site — the next change to how the
 * setup is opened is one line here.
 *
 * Idempotent on purpose: `onboard()` is called from places that may already have the
 * sheet open, and pressing the bar button there would read "Close" and shut it.
 * Parameterised by page because the storage-promise block reads it off a second,
 * clean browser.
 */
const openDock = async (page = p) => {
  await page.waitForSelector(".dock-bar", { timeout: 25000 })
  if (!(await page.$(".onboard")))
    await page.click('.dock-bar button:text-is("Set up my league")')
  await page.waitForSelector(".onboard", { timeout: 25000 })
}
let pass=0, fail=0
const t=(n,ok,x="")=>{ok?pass++:fail++; console.log(`${ok?"PASS":"FAIL"}  ${n}${ok?"":"  "+x}`)}
t("no page errors", errs.length===0, errs.join(" | "))

/**
 * ── A first visit belongs to nobody ─────────────────────────────────────────────
 *
 * The published asset must carry no leagues, and the page must react to that by
 * asking rather than by lending. Both halves are asserted: the file itself, because
 * the build step is what strips it, and the screen, because a seed could also
 * arrive from a stale localStorage or a cached asset.
 */
const seed = await p.evaluate(async base => {
  const r = await fetch(new URL("scoring.json", base).href)
  return r.json()
}, BASE)
t("the published seed carries no league at all",
  Object.keys(seed.leagues).length === 0 && seed.active_league === null,
  `${Object.keys(seed.leagues).join(",")} active=${seed.active_league}`)
t("but it still carries the presets and the stat list, which are nobody's league",
  Object.keys(seed.platform_templates).length > 0 && seed.stat_keys.batting.length > 0,
  Object.keys(seed.platform_templates).join(","))
/*
 * A first visit shows a ranked board AND the setup, side by side.
 *
 * This assertion used to require the opposite — no board at all — and it was written
 * against the right defect and the wrong cure. The defect was that the build shipped
 * one real Yahoo league belonging to a real person and seeded it into every browser,
 * so a stranger's first screen was a full board denominated in somebody else's
 * points. The cure taken was to show nothing until a league arrives, and that asks a
 * stranger to fill in seventeen point values before he has seen what they buy.
 *
 * What ships now is the shipped PRESET: standard head-to-head points values, nobody's
 * team, nobody's roster, and the board says so on its own face. So the claim splits
 * into the two facts that were always underneath it — there is something ranked to
 * look at, and it is not anybody's league.
 */
t("a first visit ranks players, so a stranger can see what the setup buys him",
  (await p.$$eval(".board-row", n => n.length)) > 50,
  String(await p.$$eval(".board-row", n => n.length)))
t("and Billy's pick is on it, because a pick is the shortest demonstration there is",
  await p.locator(".card.pick").isVisible())
t("but the board says whose scoring it is on, on the board itself",
  /standard scoring, not yours/i.test(await p.$eval(".preview-note", e => e.innerText)),
  await p.$eval(".preview-note", e => e.innerText))
/*
 * The setup is UNDER the ranking now, not beside it.
 *
 * This used to read "and the setup is beside it, not behind it" and assert `.onboard`
 * was visible the moment the page arrived. That was the previous pass's truth: the
 * setup was a card in the page flow, so a first visit rendered the whole two-minute
 * form and the board together. It moved into the dock for the same reason the board
 * moved onto the first visit at all — the numbers are the argument for spending the
 * two minutes, so a form shown before them asks for the two minutes first.
 *
 * The claim splits into three, and all three are asserted, because any one of them on
 * its own would pass on a page that had lost the point: the form is not in the way
 * until it is asked for; the way to it is nonetheless on the page, saying what is
 * borrowed; and the ranking comes first.
 */
t("the setup is not in the way: the form is not even mounted until it is asked for",
  (await p.$$eval(".onboard", n => n.length)) === 0,
  `${await p.$$eval(".onboard", n => n.length)} onboarding cards on a first visit`)
t("but the way to it is on the page, in one line that says whose scoring is on the board",
  /standard scoring/i.test(await p.$eval(".dock-say", e => e.innerText)) &&
    /not your league/i.test(await p.$eval(".dock-say", e => e.innerText)),
  await p.$eval(".dock-say", e => e.innerText))
t("and the button next to it says what pressing it gets you",
  await p.locator('.dock-bar button:text-is("Set up my league")').isVisible(),
  await p.$eval(".dock-bar button", e => e.textContent))
/*
 * THE POINT OF THE WHOLE CHANGE, and until this assertion nothing checked it.
 *
 * "The ranked list has to be the first thing a first-time visitor sees" is a claim
 * about ORDER, and every other assertion in this file is about presence — the board
 * renders, the setup renders — so all of them would have gone on passing if the setup
 * went back above the board tomorrow.
 *
 * Pinned twice, because the two ways it can be wrong are different failures:
 *
 *  · In the DOCUMENT. A screen reader, a keyboard tab order and a no-CSS render all
 *    meet this page in source order, so the board has to come before the setup there.
 *    The dock is the last thing in `.wrap` (src/client/App.tsx) and that is what this
 *    holds in place.
 *  · On the SCREEN. `.dock` is `position:fixed`, so source order alone would also be
 *    satisfied by a bar painted straight over the top of the board. The bar has to be
 *    at the FOOT of the viewport, and — the thing fixed bars get wrong — the page has
 *    to reserve its height instead of letting it cover the end of the page, which is
 *    what `--dock-h` in app.css is for.
 */
t("the ranking comes before the setup in the document, which is the entire point of the dock",
  await p.evaluate(() => {
    const row = document.querySelector(".board-row")
    const dock = document.querySelector(".dock")
    return !!row && !!dock &&
      !!(row.compareDocumentPosition(dock) & Node.DOCUMENT_POSITION_FOLLOWING)
  }))
t("and the bar sits at the foot of the viewport rather than over the rows",
  await p.evaluate(() => {
    const bar = document.querySelector(".dock-bar").getBoundingClientRect()
    return Math.abs(bar.bottom - window.innerHeight) <= 1
  }),
  JSON.stringify(await p.evaluate(() => ({
    bar: document.querySelector(".dock-bar").getBoundingClientRect().bottom,
    viewport: window.innerHeight
  }))))
/*
 * Measured as the gap the page leaves below its own last element, NOT by scrolling to
 * the end and looking.
 *
 * Scrolling to the end was the obvious way to check this and it cannot work here: the
 * board reveals its later rows through an IntersectionObserver (src/client/Board.tsx),
 * so scrolling to the bottom makes the page taller — measured, `.wrap` went from
 * 4,525px to 7,963px on one scroll — and the bottom is never where it was when it was
 * asked for. The claim does not need the scroll anyway: what must hold is that the
 * document is taller than its last in-flow element by at least the height of the bar
 * that hovers over it, which is `.wrap`'s bottom padding in app.css.
 */
t("and the page reserves the bar's height, so the end of the page is not stuck under it",
  await p.evaluate(() => {
    const last = document.querySelector(".colophon").getBoundingClientRect()
    const bar = document.querySelector(".dock-bar").getBoundingClientRect()
    const reserved = document.documentElement.scrollHeight - (last.bottom + window.scrollY)
    return reserved >= bar.height
  }),
  JSON.stringify(await p.evaluate(() => ({
    reserved: document.documentElement.scrollHeight -
      (document.querySelector(".colophon").getBoundingClientRect().bottom + window.scrollY),
    bar: document.querySelector(".dock-bar").getBoundingClientRect().height
  }))))
t("and this browser holds no league until the visitor puts one in it",
  await p.evaluate(() =>
    Object.keys(JSON.parse(localStorage.getItem("beanemachine:config")).leagues).length === 0))

/**
 * Three SCREENS, and the PUBLISHED bundle is where that has to be checked.
 *
 * There were four tabs — Recommendations / League setup / My team & trades, and
 * before them Draft. Draft went first (src/client/Draft.tsx, src/engine/draft.ts
 * and test/draft.mjs, all deleted). Then the remaining three were re-cut along the
 * question being asked rather than along the engine that answers it:
 *
 *   Today  (view id "board")  the Decide card alone — tonight's lineup changes, the
 *                            empty seats, the one add/drop — and a link to Wire.
 *   Wire   (view id "wire")   the ranked board alone: mode strip, filters, Billy's
 *                            pick, the table.
 *   Setup  (view id "trade")  your team, then the whole League setup editor under
 *                            it, plus the New / Remove / Download / Load file /
 *                            import-by-URL toolbar that used to live on its own tab.
 *
 * So "Recommendations" no longer owns the ranked board and "League setup" is not a
 * tab at all. Every assertion below that used to click a tab BY INDEX now names the
 * screen that owns the job it is about — see `go` — and this list is checked by NAME
 * and in ORDER anyway, for the reason it always was: this suite reads the published
 * asset rather than the source tree, which is the one place a stale bundle can be
 * caught. A hosted build still serving a Draft tab, or still serving a separate
 * League setup tab, after the source stopped having one is exactly the failure this
 * file exists for, and nothing else here would notice it.
 */
const TAB_LABELS = ["Today", "Wire", "Setup"]
const tabLabels = await p.$$eval(".views button", n => n.map(e => e.textContent))
t("the published build offers three screens, named and in the order a season uses them",
  JSON.stringify(tabLabels) === JSON.stringify(TAB_LABELS), tabLabels.join(" | "))
/**
 * Navigate by the tab's VISIBLE TEXT, never by position.
 *
 * This file used to hold six `.views button:nth-child(N)` clicks, and the
 * four-tabs-to-three re-cut moved every one of them: `nth-child(2)` was League
 * setup and is now Wire, so the block that edits a scoring table and the block that
 * reads `#tpl` both landed on the ranked board and failed a dozen assertions a
 * hundred lines away from their cause. An index is a fact about the nav bar; what
 * each assertion actually depends on is which SCREEN owns the thing it reads. So
 * the label is the address, and the next rename is a one-line change here.
 *
 * Each screen is waited for on a marker only it renders — `.decide` for Today and
 * `.board-row` for Wire — because a click that registers before React has swapped
 * the view reads the OLD screen's DOM, and that failure looks exactly like a
 * missing feature.
 */
/*
  Setup is waited for on the management toolbar's own button rather than on anything
  in the team panel. `.pull-roster` was the obvious choice and is wrong: that card
  only renders for a league whose platform a browser can actually read, so a Yahoo
  preset — which is half of what this file sets up — never shows it and the wait
  times out on a screen that came up perfectly. `[data-ctl="onboard"]` is rendered by
  the toolbar, and the toolbar is rendered for exactly one view: this one. That is
  itself worth pinning, because the toolbar moving off this screen is the change that
  would strand the Download, Load file and import-by-URL assertions below.
*/
const MARKER = { Today: ".decide", Wire: ".board-row", Setup: '.bar [data-ctl="onboard"]' }
const go = async label => {
  await p.click(`.views button:text-is("${label}")`)
  await p.waitForSelector(MARKER[label], { timeout: 25000 })
}
t("and the Draft tab is gone from the shipped bundle, not only from the source tree",
  !/draft/i.test(await p.$eval(".views", e => e.innerText)),
  await p.$eval(".views", e => e.innerText))

/**
 * ── The colophon says one thing, and the working is one click away ──────────────
 *
 * It used to say 277 words: four paragraphs of folds, Spearman rho, z-scores and
 * one-sided p-values, rendered under EVERY tab — 67% of the words on the screen a
 * first visitor sees, which is this one. It is three links and one sentence now,
 * and the results live in docs/METHODOLOGY.md.
 *
 * What those 277 words were protecting was never their own length. It was two
 * claims, and both are asserted here in the form they take now:
 *
 * - that this app does not present a bscore as a forecast. The surviving sentence
 *   is the one place that is still said, so it is read for the claim and not for
 *   the wording.
 * - that the measured results AND the admitted failures are reachable from the
 *   page, not only from the repo. So METHODOLOGY must be linked, and linked by
 *   ABSOLUTE URL — which is measured, not assumed: fetching `docs/METHODOLOGY.md`
 *   from this preview answers 200 with content-type text/html, because docs/ is
 *   not published with the build and the SPA fallback serves index.html for it. A
 *   relative link would have rendered the app again and silently lost the document
 *   on exactly the hosted build this file is about.
 *
 * The removal is asserted too, and not as tidiness: METHODOLOGY records that the
 * hitting-fold figure quoted here was measured on a configuration this app no
 * longer ships, and the human comparison's 63/111 was printed here without its
 * one-sided p of 0.064. Numbers a reader cannot act on and that have drifted from
 * the code are worse than no numbers, so their absence is part of the claim.
 */
const colophon = (await p.$eval(".colophon", e => e.innerText)).replace(/\s+/g, " ").trim()
t("the colophon is one sentence, not the 277-word statistics footer",
  colophon.split(" ").length < 90 && /ranking, not a forecast/i.test(colophon),
  `${colophon.split(" ").length} words: ${colophon.slice(0, 140)}`)
t("and it no longer quotes folds, rho, z-scores or p-values at a reader who cannot act on them",
  !/\bfolds?\b|spearman|\brho\b|z-score|p-value/i.test(colophon), colophon.slice(0, 200))
const colophonLinks = await p.$$eval(".colophon a", n => n.map(e => e.getAttribute("href") ?? ""))
t("but the measured results are still one click off the page, by absolute URL the static host cannot swallow",
  colophonLinks.some(h => /^https:\/\/github\.com\/.*METHODOLOGY\.md$/.test(h)) &&
    colophonLinks.some(h => /^https:\/\/github\.com\/.*GUIDE\.md$/.test(h)),
  colophonLinks.join(" | "))
// The tabs are all about a league. Highlighting one and then showing the same setup
// card reads as a broken button, so they say why instead.
/**
 * The route a Yahoo user can finish, asserted where importing is ATTEMPTED.
 *
 * The claim has not changed since it was written: a build that cannot read Yahoo
 * must name Yahoo, and must name a route that ends somewhere rather than a blanket
 * "importing needs the local server". What changed is where a person reads it —
 * the first screen, where somebody with a Yahoo league is standing when they are
 * stuck, rather than a card that only appeared while a stranger's demo league was
 * active.
 */
// The setup is a fold now, so this block asks for it — see `openDock`. It used to be
// on screen already, which is why none of these lines opened anything.
await openDock()
t("and the first question is which platform, with Yahoo among the answers",
  (await p.$$eval(".onboard .chip-btn", n => n.map(e => e.textContent))).includes("Yahoo"),
  (await p.$$eval(".onboard .chip-btn", n => n.map(e => e.textContent))).join(" | "))
await p.click('.onboard .chip-btn:text-is("Yahoo")')
const firstScreen = await p.$eval(".onboard", e => e.innerText)
t("a Yahoo user is given a route they can finish, on the screen where they are stuck",
  /settings/i.test(firstScreen) && /paste/i.test(firstScreen) && /private/i.test(firstScreen),
  firstScreen.slice(0, 260))
// The one thing that must not be said: that a browser can read a Yahoo league.
t("and it does not offer Yahoo a URL import a browser cannot perform",
  await p.evaluate(() => {
    const alts = document.querySelector(".onboard-alts")
    return !alts || !alts.querySelector('input[type=text]')
  }))
/*
 * The one-tap route to a league, visible.
 *
 * It was folded inside a disclosure called "Other ways in", 1,536px down, while the
 * only VISIBLE path was pasting a whole settings page — which needs Ctrl-A, a
 * desktop gesture, on an app that is opened on a phone. A first-time visitor who
 * could not paste had no visible way forward at all.
 *
 * It read "Show me a board first" then, and that sentence stopped being true the
 * moment the board moved onto the first visit: it is already below. What the control
 * actually does is keep the scoring the board is running on and make it his, so he
 * can add a team now and correct the values later — so that is what it says.
 * Asserted as VISIBLE without opening anything, because that is the whole point.
 */
t("a first visit can adopt the scoring it is already looking at, in one tap",
  await p.locator('.onboard-shortcut button:text-is("Start from these values")').isVisible())
t("and it says they were not read from the reader's league, on the button's own line",
  /not read from your league/i.test(await p.$eval(".onboard-shortcut", e => e.innerText)),
  await p.$eval(".onboard-shortcut", e => e.innerText))
// The card and the board must agree about whose scoring this is: two different
// answers on one screen is worse than either answer alone.
t("and the card and the board agree that the scoring is standard, not the reader's",
  /standard/i.test(await p.$eval(".onboard", e => e.innerText)) &&
    /standard scoring, not yours/i.test(await p.$eval(".preview-note", e => e.innerText)))
/*
 * The tabs work on a first visit now, and that is the same change as the one above.
 *
 * They were disabled because nothing could be ranked, and something can: the preset
 * board is on Wire, which is the screen a first visit lands on. Today still has
 * nothing to say without a roster and says so in its own card rather than through a
 * dead tab — a disabled control teaches nothing about why.
 */
t("the tabs work on a first visit, because there is something behind each of them",
  await p.$$eval(".views button", n => n.every(e => !e.disabled)),
  await p.$$eval(".views button", n => n.map(e => `${e.textContent}:${e.disabled}`).join(" ")))
t("and the visit lands on the screen that ranks",
  (await p.$$eval(".views button[aria-selected=true]", n => n.map(e => e.textContent.trim())))[0] === "Wire",
  (await p.$$eval(".views button[aria-selected=true]", n => n.map(e => e.textContent.trim()))).join(","))

/**
 * The route that cannot be revoked, on the build where it is the only one.
 *
 * Yahoo sends no `access-control-allow-origin` on any page, so nothing here will
 * ever be handed its settings page; the reader's own signed-in browser is the one
 * program that can see it. This pastes exactly what that page copies as — the
 * committed league's own settings rows and stat tables, tab-separated, which is
 * what a browser puts on the clipboard — and asserts that a whole league comes out
 * of it with every /api/** call aborted.
 */
const real = JSON.parse(readFileSync("scoring.json", "utf8")).leagues["yahoo:228947"]
const SETTINGS_PASTE = [
  "Setting\tValue",
  ...Object.entries(real.league_rules.raw_settings).map(([k, v]) => `${k}\t${v}`),
  "Batters Stat Category\tValue",
  ...Object.entries(real.scoring.batting).map(([c, v]) => `Some Stat (${c})\t${v}`),
  "Pitchers Stat Category\tValue",
  ...Object.entries(real.scoring.pitching).map(([c, v]) => `Some Stat (${c})\t${v}`)
].join("\n")

/** A league in this browser, got the way a reader gets one. Used wherever this
 *  suite used to be able to assume the seed had put one there. */
const onboard = async () => {
  // Opens the dock first. This was a bare wait on `.onboard`, which was on screen
  // whenever this browser held no league; the form is behind the dock's button now.
  await openDock()
  await p.click('.onboard .chip-btn:text-is("Yahoo")')
  await p.fill('textarea[data-ctl="paste-settings"]', SETTINGS_PASTE)
  await p.click('.onboard button:text-is("Read that")')
  await p.waitForSelector(".onboard-done button", { timeout: 15000 })
  await p.click(".onboard-done button")
  // Finishing the setup lands on TODAY, and Today is the Decide card and nothing
  // else — it used to be "Recommendations", which was the Decide card with the whole
  // ranked board under it, so this waited on `.board-row` and now times out there.
  // Waited on `.decide` instead: it is the card that screen exists to show, and it
  // renders even with no roster loaded (as `.decide-blocked`, naming what is missing),
  // which is exactly the state a freshly set-up league is in.
  await p.waitForSelector(".decide", { timeout: 25000 })
  return p.evaluate(() => JSON.parse(localStorage.getItem("beanemachine:config")).active_league)
}

const KEY = await onboard()
t("pasting the settings page builds a league, with no server anywhere",
  !!KEY, String(KEY))
const pasted = await p.evaluate(k =>
  JSON.parse(localStorage.getItem("beanemachine:config")).leagues[k], KEY)
t("and it holds the same scoring the fetched league holds",
  JSON.stringify(pasted.scoring.batting) === JSON.stringify(real.scoring.batting) &&
    JSON.stringify(pasted.scoring.pitching) === JSON.stringify(real.scoring.pitching),
  JSON.stringify(pasted.scoring.batting))
t("the same roster slots, in the order a lineup is set in",
  JSON.stringify(pasted.roster.slot_order) === JSON.stringify(real.roster.slot_order))
t("and the same team count, which is what replacement level is cut at",
  pasted.meta.max_teams === real.meta.max_teams, String(pasted.meta.max_teams))
// It came off the reader's screen, not off a fetch this page made and can cite.
t("but it is not marked read-from-source, because nothing here fetched that page",
  pasted.provenance.verified === false && /^paste:/.test(pasted.provenance.method),
  pasted.provenance.method)
/**
 * Everything from here to the config editor is about the RANKED BOARD, and the
 * ranked board is now the Wire screen rather than the first tab.
 *
 * This is the single biggest thing the re-cut moved. "Recommendations" rendered the
 * Decide card and then the whole table beneath it — at phone width that put the
 * first ranked row 1,600px down a 8,400px scroll — so every assertion below this
 * line used to pass without navigating anywhere at all. Today now renders the Decide
 * card and ONE link out of it, so `.board-row`, `.toggle`, `.card.pick`, the column
 * headers and the availability default are all on a screen this suite has to ask
 * for. Asserted right after arriving, because "the board renders with no server" is
 * the claim this whole file is about and it is worth knowing that the screen that
 * owns it came up at all.
 */
await go("Wire")
// A ranked board at all, which is what "with no server" is about. It is NOT about
// the default filter: the list is capped at 60 rows, so the filtered default and
// the unfiltered ranking both read 60 here and this number cannot tell them apart.
// The default is asserted below, where it can be seen.
t("the board renders with no server", (await p.$$eval(".board-row", n=>n.length)) > 50)
// Today is the other half of that split and nothing else in this file sees it: the
// screen a reader lands on must be the DECISION, not the lookup. A regression that
// put the table back under the Decide card would leave every other assertion here
// passing — the board would still render, just one screen too early — so the
// separation is pinned where it can be seen, on the screen that was measured at
// 947px with no roster loaded where it used to be 7,477px.
await go("Today")
t("and Today is the decision alone: the table is not hiding under the Decide card",
  (await p.$$eval(".decide", n => n.length)) === 1 &&
    (await p.$$eval(".board-row", n => n.length)) === 0,
  `${await p.$$eval(".board-row", n => n.length)} ranked rows on the Today screen`)
// and the way across to it is a link on Today, not a scroll — the one thing that
// screen offers besides the decision itself
t("with one link across to the ranking, named as what it leads to",
  /Everyone you can get/.test(await p.$eval(".next-screen", e => e.innerText)),
  await p.$eval(".next-screen", e => e.innerText))
await go("Wire")
/**
 * The availability toggle WORKS with no server now, which is the point of the whole
 * ownership estimate. It used to be asserted disabled, because "who can I add" read
 * the league's live free-agent list and that needs the API — so on the hosted build
 * the one control that answers "which starters should I stream" was dead, and this
 * assertion was pinning that deadness in place.
 *
 * A player's rostered share is in the snapshot, and ranking by it and cutting at
 * `teams x seats` estimates who is taken without any server at all. So the toggle
 * is live here, and what has to hold is that it is honest about being an estimate.
 */
t("the availability toggle works with no server", !(await p.$eval(".toggle input", e => e.disabled)))
t("and says the answer is estimated rather than read",
  /estimate|estimated/i.test(await p.$eval("body", e => e.innerText)),
  (await p.$eval("body", e => e.innerText)).slice(0, 160))
t("Billy's pick renders", await p.locator(".card.pick").isVisible())

/**
 * ── The board lost its supporting prose and kept its definitions ────────────────
 *
 * Gone from Board.tsx: the "Buy low" card, the "Where it hurts to wait" scarcity
 * card, <BoardPrimer>, and the <details class="legend"> disclosure headed "How this
 * ranking was built" — which also held a SECOND copy of the per-column glossary,
 * under a table whose headers already carried the first.
 *
 * Deleting a definition and deleting a duplicate of one are not the same act, and
 * this is where the difference is held. COLUMN_HELP survives as the `title=` on
 * every sortable header, so the question the legend answered — what a bscore is,
 * and what uscore is doing differently — is still answered ON the thing being
 * asked about rather than in a list below it. Both halves are asserted: the
 * disclosure is gone from the published bundle, and the definitions it carried are
 * still reachable there. The second half is the one that matters; a page that
 * dropped both would pass the first on its own.
 */
const boardText = await p.$eval("body", e => e.innerText)
t("the ranking legend and its second copy of the glossary are gone",
  (await p.$$eval(".legend", n => n.length)) === 0 &&
    !/How this ranking was built/i.test(boardText),
  String(await p.$$eval(".legend", n => n.length)))
t("and Buy low and the scarcity card no longer run beneath the table",
  !/Buy low|hurts to wait/i.test(boardText),
  (await p.$$eval("section.card h2, section.card h3", n => n.map(e => e.textContent))).join(" | "))
/**
 * The property the legend was protecting, asserted against what replaced it.
 *
 * Read for LENGTH as well as presence, because `title=""` is a header with a title
 * attribute and no definition in it, and that is precisely how this would rot: a
 * column added to COLUMN_HELP with a placeholder would leave the glossary gone and
 * nothing in its place, and a bare `hasAttribute` check would call that a pass.
 */
const heads = Object.fromEntries(await p.$$eval(".board-head .sort-head",
  n => n.map(e => [e.getAttribute("data-col"), e.getAttribute("title") ?? ""])))
t("but every column still defines itself, on the header instead of in a list below it",
  ["uscore", "bscore", "conf", "luck"].every(c => (heads[c] ?? "").length > 40),
  Object.entries(heads).map(([c, h]) => `${c}:${h.length}ch`).join(" "))
// The one definition a reader cannot do without, and the one the old primer got
// WRONG: it said "the best free agent at the same slot", and the engine draws the
// bar at the (teams x seats)-th of them — who is left once every team has filled
// that seat. The surviving copy has to be the correct one.
t("and bscore's definition still names the man it subtracts, which is the whole number",
  /teams\s*[x×]\s*seats/i.test(heads.bscore ?? "") && /minus/i.test(heads.bscore ?? ""),
  (heads.bscore ?? "(no title at all)").slice(0, 180))

/**
 * The board opens on players the reader can ADD.
 *
 * `AVAILABLE_ONLY_DEFAULT.board` was false, on the reasoning that the standing
 * board is the standing board. Measured on the committed capture: 42 of the first
 * 50 rows of that default were rostered in 90% or more of leagues, and not one was
 * under 50% — so the first ranked screen of the app this suite publishes was fifty
 * men nobody in the league could have.
 *
 * Asserted as a different HEAD rather than as a row count, because a row count
 * cannot see it. The list is capped at 60 rows, so filtered and unfiltered both
 * read 60 and the ">50 rows" assertions in this file are silent on which one a
 * reader is looking at — the exact blindness that let the old default ship.
 */
const availBox = p.locator(".toggle", { hasText: "Only players I can add" }).locator("input")
t("the default board is the one he can act on: only players I can add starts ticked",
  await availBox.isChecked())
const gettable = await p.$$eval(".board-row .who b", n => n.map(e => e.textContent.trim()))
await availBox.uncheck()
await p.waitForTimeout(600)
const everyone = await p.$$eval(".board-row .who b", n => n.map(e => e.textContent.trim()).slice(0, 6))
// Not "the two heads differ", which one drifting row would satisfy. The claim is
// that the default REMOVES men the full ranking puts at its very top — those are
// the 42-in-50 the measurement above counted, and if none of the unfiltered top six
// is missing from the whole 60-row default then the filter is not doing the thing
// the default was changed for.
t("and that default is doing work: the full ranking opens with men it keeps off the board",
  everyone.length === 6 && everyone.some(n => !gettable.includes(n)),
  `everyone: ${everyone.join(", ")} / can add: ${gettable.slice(0, 6).join(", ")}`)
await availBox.check()
await p.waitForTimeout(600)
// now switch to the config editor for the remaining assertions. It was its own tab,
// "League setup", reached as `nth-child(2)`; it is the bottom half of SETUP now,
// under the team panel, and `nth-child(2)` is the ranked board.
await go("Setup")
await p.waitForSelector(".grid section.card .rows", { timeout: 15000 })
/**
 * ── Where the storage reassurance went ──────────────────────────────────────────
 *
 * This read `.static-note` — a masthead line, "Your leagues are saved in this
 * browser.", rendered on every view of every page load. It is DELETED from the
 * source: the masthead was 199px on a desktop and 203px on a phone above a page
 * whose first ranked row was 1,229px down, and a reassurance that is read once does
 * not belong on every screen forever.
 *
 * What it was protecting is a real claim and it is asserted here in its new home:
 * before a stranger types a league into this page they must be told the league is
 * not going anywhere. That sentence is now on the FIRST-RUN SETUP — "it all stays in
 * this browser" — which is strictly the better place, because it is the screen where
 * somebody is deciding whether to trust this with their league rather than a line
 * above a board they have already committed to.
 *
 * Read off a clean browser rather than this one, because this one has a league in it
 * and the first-run setup is therefore not on screen. A second page is cheaper than
 * clearing and re-onboarding the page the next forty assertions depend on.
 *
 * WHAT IS NO LONGER PROTECTED ANYWHERE, and is recorded rather than dropped: there
 * is now no VISIBLE sentence about where LEAGUES (as opposed to the roster) are kept
 * once the setup has been dismissed. The Setup screen says it of the roster — "it is
 * saved in this browser, per league" — and the Download button says it of the leagues
 * in a `title=` nobody on a phone can open. A reader who arrives on a shared link,
 * dismisses the setup and then wonders whether their league went to a server has
 * nowhere on the page to find out.
 */
{
  const fresh = await b.newPage({ viewport: { width: 1280, height: 1000 } })
  await fresh.route("**/api/**", r => r.abort())
  await fresh.goto(BASE, { waitUntil: "networkidle" })
  // Same gesture on the second browser: the promise is inside the fold now, not on
  // the first paint. That it takes a gesture to read is worth saying out loud — see
  // the note below about what is no longer promised anywhere visible.
  await openDock(fresh)
  const note = (await fresh.$eval(".onboard", e => e.innerText)).replace(/\s+/g, " ")
  t("the first screen still promises the league stays in this browser",
    /stays in this browser/i.test(note), note.slice(0, 200))
  // The claim, not the wording. A blanket "importing needs the local server" was the
  // single sentence standing between a visitor and using this on their own league, and
  // it was false for ESPN, which imports here with no backend at all. It is equally
  // false the other way round: copy that only says the server is needed leaves a
  // Yahoo user — most of this app's users — with nothing to do. So wherever the server
  // is raised, Yahoo must be named as the reason, AND a route that ends somewhere must
  // be named with it: the preset, or a file carried over from a local read.
  t("and it does not claim the server is needed to import without naming Yahoo",
    !/server/i.test(note) || /yahoo/i.test(note), note.slice(0, 260))
  // The line it replaced is gone from the shipped bundle, not only from the source.
  t("and the every-view masthead banner it replaced is not still being shipped",
    (await fresh.$$eval(".static-note", n => n.length)) === 0 &&
      (await p.$$eval(".static-note", n => n.length)) === 0)
  await fresh.close()
}
/* The claim "a Yahoo user is given a route they can finish" is asserted up in the
   first-visit block now, against the onboarding, because that is where importing is
   attempted. It used to be checked here, on League setup, where a card headed "Use
   your own league" appeared for as long as the SEEDED example league was active —
   and the seeded league is gone. */
const codes = await p.$$eval(".grid section:nth-of-type(1) .code", n=>n.map(e=>e.textContent))
const vals = await p.$$eval(".grid section:nth-of-type(1) input.val", n=>n.map(e=>e.value))
t("the pasted scoring is what the editor renders", vals[codes.indexOf("HR")]==="10.4", vals.join(","))
t("and it was stored, not just rendered",
  await p.evaluate(() => localStorage.getItem("beanemachine:config") !== null))
t("roster totals render", (await p.$$eval(".tot b", n=>n.map(e=>e.textContent))).join("/")==="18/5/4/27")
t("the config can be taken out as a file", await p.locator('.bar button:text-is("Download")').isEnabled())
const hr = p.locator(".grid section:nth-of-type(1) input.val").nth(codes.indexOf("HR"))
await hr.fill("9.9"); await hr.blur(); await p.waitForTimeout(250)
t("editing works with no server", await p.locator(".savebar").evaluate(e=>e.classList.contains("on")))

// saving is no longer the thing that needs a backend — it writes this browser
await p.click(".savebar button.primary")
await p.waitForSelector(".toast")
t("saving works with no server", (await p.locator(".toast").textContent()).includes("Saved"))
t("the save landed in browser storage", await p.evaluate(k =>
  JSON.parse(localStorage.getItem("beanemachine:config")).leagues[k].scoring.batting.HR === 9.9, KEY))
await p.reload({ waitUntil:"networkidle" })
// Setup, not `nth-child(2)`: the scoring editor is the bottom half of Setup now.
await go("Setup")
await p.waitForSelector(".grid section.card .rows", { timeout: 15000 })
const kept = await p.$$eval(".grid section:nth-of-type(1) input.val", n=>n.map(e=>e.value))
t("the edit survives a reload with no server", kept[codes.indexOf("HR")]==="9.9", kept.join(","))
/**
 * ── Importing a real league, with no server anywhere ────────────────────────────
 *
 * This is the part of the product that used to be missing. Every /api/** call is
 * aborted above, so nothing below can reach a backend even if one is running on
 * this machine — whatever imports here imports because the PAGE read the platform.
 *
 * Measured 2026-09-04, each with `Origin: https://beanemachine.com` on the exact
 * endpoint the importer uses:
 *
 *   ESPN     lm-api-reads.fantasy.espn.com  access-control-allow-origin: https://beanemachine.com
 *   Yahoo    baseball.fantasysports.yahoo.com   no access-control headers at all
 *
 * Sleeper answered `*` and is no longer on the list: CORS was never why it failed a
 * baseball user. It runs no fantasy baseball at all, so what it readably returns is
 * another sport's league. It is refused by name below, and nothing is asked of it.
 *
 * The same reads from `http://127.0.0.1:4173` — this preview's own origin — were
 * checked too, because ESPN reflects whatever origin asks and a wildcard is not
 * what it sends: it answered `access-control-allow-origin: http://127.0.0.1:4173`.
 *
 * Politeness: two requests to ESPN per run, to the league that project publishes as
 * its own integration-test fixture — 81134470/2021 is the id the `espn-api` wrapper
 * uses and the one data/rosters.ts was verified against. The Sleeper URL below is
 * Sleeper's own documented example league and is never fetched at all now, because
 * the refusal happens before any request. No ids are enumerated and no stranger's
 * league is touched.
 */

/** Toasts dismiss themselves (2.6s for a success, 6.5s for a failure), so the
 *  previous one is waited out rather than read again as if it answered this
 *  import. A toast that never matches is returned anyway, so the assertion below
 *  reports what actually appeared instead of dying on a timeout. */
const importUrl = async (url, expect) => {
  await p.waitForSelector(".toast", { state:"detached", timeout: 12000 }).catch(() => {})
  // Scoped to the toolbar. It used to be the only `input[type=text]` on League setup,
  // and League setup is now the bottom half of SETUP — which renders the team panel
  // above it, carrying three more text inputs (add a man, the two trade sides). An
  // unscoped fill is ambiguous there, and the one it would reach first is the roster
  // box, so the import would silently never be attempted.
  await p.fill('.bar input[type=text]', url)
  await p.click(".bar button.primary")
  await p.waitForFunction(src => {
    const el = document.querySelector(".toast")
    if (!el) return false
    window.__toast = el.textContent || ""
    return new RegExp(src, "i").test(window.__toast)
  }, expect.source, { timeout: 45000 }).catch(() => {})
  return p.evaluate(() =>
    document.querySelector(".toast")?.textContent ?? window.__toast ?? "(no toast appeared)")
}
const stored = key => p.evaluate(k =>
  JSON.parse(localStorage.getItem("beanemachine:config")).leagues[k] ?? null, key)

// ESPN. teamId= is carried so the imported league knows which team is the user's,
// which is what the roster read at the bottom of this file then needs.
const espnMsg = await importUrl(
  "https://fantasy.espn.com/baseball/league?leagueId=81134470&seasonId=2021&teamId=1", /imported/i)
t("an ESPN league imports on the static build, with every /api/** call aborted",
  /^Imported /.test(espnMsg.trim()), espnMsg)
t("and the request went straight from the page to ESPN, not through any backend",
  requested.some(u => u.startsWith("https://lm-api-reads.fantasy.espn.com/")),
  requested.filter(u => !u.startsWith(BASE)).join(" | ") || "(no cross-origin request at all)")
const espn = await stored("espn:81134470")
t("what landed in this browser is the real league ESPN published",
  espn !== null && espn.meta.league_name === "Miami 8-Team H2H Points" &&
    espn.meta.season === 2021 && espn.meta.max_teams === 8 && espn.meta.team_id === "1",
  JSON.stringify(espn?.meta))
/**
 * This asserted the scoring table arrived "kept raw" under `scoring.unmapped`,
 * which was true and was the defect: a league whose every stat is a bare number
 * cannot be ranked, so the import succeeded and the board still said "this league
 * has no scoring yet". Both halves are named now — the stats from a map derived by
 * joining a public league's own season splits to MLB StatsAPI, the seats from the
 * baseball slot table already derived for the roster reader.
 *
 * Asserted as "named and rankable" rather than by exact count: this reads a live
 * API, and a league that changed its scoring is ESPN's news, not a broken import.
 */
const espnStats =
  Object.keys(espn?.scoring.batting ?? {}).length + Object.keys(espn?.scoring.pitching ?? {}).length
t("with ESPN's scoring read off its API and named, not left as bare stat ids",
  espnStats > 0 && (espn?.scoring.unmapped?.length ?? 0) === 0,
  `${espnStats} named stats (14 when measured), ${espn?.scoring.unmapped?.length ?? 0} unmapped`)
t("and its seats named too, so a replacement level can be computed at all",
  Object.keys(espn?.roster.slots ?? {}).every(k => !/^\d+$/.test(k)) &&
    Object.keys(espn?.roster.slots ?? {}).length > 0,
  Object.keys(espn?.roster.slots ?? {}).join(","))
t("and the scoring period read from ESPN's own scheduleSettings",
  espn?.scoring_period?.kind === "matchup" && espn?.scoring_period?.days === 7,
  JSON.stringify(espn?.scoring_period))
t("and the source it cites is ESPN's endpoint, so the provenance is not this origin",
  espn?.provenance.sources.every(u => u.startsWith("https://lm-api-reads.fantasy.espn.com/")),
  JSON.stringify(espn?.provenance.sources))

// Sleeper. This used to assert that a Sleeper league IMPORTED here — it did, over
// CORS headers Sleeper is happy to send, and what landed was an NFL league carrying
// a needs_review line saying so. That was a true assertion about a useless feature:
// Sleeper runs no fantasy baseball at all (`/v1/state/mlb` names no season), so
// every Sleeper import this app could ever do lands another sport's league in a
// baseball engine. It is refused by name now, and the refusal — not the import — is
// what is asserted, because a dead end with a button on it was the thing being
// shipped. No request to Sleeper is made at all, which is the other half of it.
const before = requested.length
const sleeperMsg = await importUrl("https://sleeper.com/leagues/289646328504385536", /baseball/i)
t("a Sleeper league URL is refused, and the refusal is about baseball",
  /fantasy baseball/i.test(sleeperMsg) && !/^Imported /.test(sleeperMsg.trim()), sleeperMsg)
t("and it tells a Sleeper user where a baseball league can live instead",
  /yahoo/i.test(sleeperMsg) && /espn/i.test(sleeperMsg), sleeperMsg)
t("and nothing was asked of Sleeper, because there was nothing there to ask for",
  !requested.slice(before).some(u => u.startsWith("https://api.sleeper.app/")),
  requested.slice(before).filter(u => !u.startsWith(BASE)).join(" | ") || "(no request at all)")

// Yahoo, the one platform that genuinely cannot be read here. The old sentence —
// "Importing a league needs the local server" — was true only about this case and
// was shown to everybody, which is what made the hosted build a demo of one
// stranger's team. It has to keep being said, and it has to say WHICH platform.
const yahooMsg = await importUrl(
  "https://baseball.fantasysports.yahoo.com/b1/228947/8", /server/i)
t("a Yahoo import still says it needs the local server", /local server/i.test(yahooMsg), yahooMsg)
t("and it names Yahoo, and the CORS headers Yahoo doesn't send, as the reason",
  /yahoo/i.test(yahooMsg) && /cors/i.test(yahooMsg), yahooMsg)
t("and it says ESPN imports here, so it can't be read as a blanket refusal",
  /espn/i.test(yahooMsg), yahooMsg)
// The refusal has to end somewhere a visitor can go. It used to end at "run a
// server", said to somebody who opened a hosted page precisely because they were
// not going to run one — and it named `nub`, a command that does not exist on a
// machine that just cloned this repo.
//
// It then named `node --experimental-strip-types src/cli.ts <url>`, which is what
// this assertion pinned, and that was no better: the flag has not been required
// since node 22.18 and the path only resolves inside a checkout of the repository.
// test/leagues.mjs had forbidden that exact string since IMPORT_COMMAND was
// written; this copy escaped it by being a second, hand-written copy of the same
// sentence, inside the one message a Yahoo user is the only reader of.
//
// So the claim is now asserted against the SHARED constant rather than against a
// path: whatever src/client/command.ts says is what the refusal has to say, and
// leagues.mjs is what keeps that constant runnable.
{
  const { IMPORT_COMMAND } = await import("../src/client/command.ts")
  t("and it names the route that works for Yahoo: read it locally, carry the file back",
    yahooMsg.includes(IMPORT_COMMAND) && /drop that file/i.test(yahooMsg) && !/\bnub\b/.test(yahooMsg),
    yahooMsg)
  t("and the command it names is one a visitor with no clone could actually run",
    /^npx --yes github:/.test(IMPORT_COMMAND) && !/experimental-strip-types/.test(IMPORT_COMMAND),
    IMPORT_COMMAND)
}

// A URL that is no league at all must not be blamed on Yahoo either — that is the
// shape the message took when the static build had one refusal for everything.
const junkMsg = await importUrl("https://example.com/my-league", /unrecognized/i)
t("an unrecognized URL is told it is unrecognized, not that Yahoo needs a server",
  /Unrecognized league URL/i.test(junkMsg) && !/local server/i.test(junkMsg), junkMsg)

/**
 * ── Reading the roster off ESPN, also with no server ────────────────────────────
 *
 * The store is edited by hand first, and that is a GAP being recorded, not a
 * convenience. A freshly imported ESPN league carries its scoring as ESPN's numeric
 * stat ids under `scoring.unmapped`, with `scoring.batting` and `scoring.pitching`
 * empty — deliberately, since guessing what stat id 5 means would corrupt every
 * lineup below it. But the League setup editor renders NO row for an empty table:
 * measured on this build, an ESPN league shows 0 `.code` cells and 0 value inputs.
 * So there is currently no way to make an imported ESPN league rateable from the
 * UI at all, and the Trade tab refuses it — correctly — before the roster card is
 * ever rendered. That is the next thing to fix, and it is in panels.tsx, not here.
 *
 * The shipped league's own scoring and roster shape are grafted on to get past that
 * refusal. Nothing the assertion below is about comes from the graft: the league id,
 * the team number and the fetch are all ESPN's.
 */
await p.evaluate(k => {
  const c = JSON.parse(localStorage.getItem("beanemachine:config"))
  const known = c.leagues[k], espn = c.leagues["espn:81134470"]
  espn.scoring = JSON.parse(JSON.stringify(known.scoring))
  espn.roster = JSON.parse(JSON.stringify(known.roster))
  c.active_league = "espn:81134470"
  localStorage.setItem("beanemachine:config", JSON.stringify(c))
}, KEY)
await p.reload({ waitUntil:"networkidle" })
// A reload opens on Today, which has no `.board-row` on it any more.
await p.waitForSelector(".decide", { timeout: 25000 })
// This searched the tab labels for /my team/ — "My team & trades" — and that tab is
// gone: the team panel is the TOP half of Setup, above the league editor. Named
// rather than matched, because `go` already holds the one place a label lives.
await go("Setup")
await p.waitForSelector(".pull-roster", { timeout: 15000 })
// Located by what it says rather than by `.primary`, which it no longer is. That
// class was removed deliberately: this route works when the platform allows it and
// stops when it does not — Yahoo answered a sweep with a sixth of the wire, then
// nothing, then "Request denied" — and styling it as the main way in made a promise
// the app cannot keep. Pasting leads now. The route still works and is still
// asserted; it is just not the headline.
const readButton = p.locator(".pull-roster button", { hasText: /Read my roster/ })
t("the roster card offers to read from ESPN, naming the platform the league is on",
  /Read my roster from ESPN/.test((await readButton.textContent()) ?? ""))
t("and the paste route, which no platform can switch off, is offered above it",
  await p.evaluate(() => {
    const paste = document.querySelector(".paste-roster")
    const pull = document.querySelector(".pull-roster")
    return !!paste && !!pull &&
      !!(paste.compareDocumentPosition(pull) & Node.DOCUMENT_POSITION_FOLLOWING)
  }))
await readButton.click()
// the note is the reader's own, and it only appears once the fetch has come back
await p.waitForFunction(
  () => !/^This league|^Only publicly/.test(document.querySelector(".pull-roster .sub")?.textContent ?? ""),
  null, { timeout: 45000 }).catch(() => {})
const pullNote = await p.locator(".pull-roster .sub").textContent()
// 25 is not a round number picked to pass: it is what team 1 of this league holds,
// the same count src/data/rosters.ts records from its own verification of it.
t("the roster is read off ESPN by the page itself, seats and all, with no server",
  /Read 25 players off ESPN team 1, seats included\./.test(pullNote), pullNote)
t("and the seats it read were stored, which is what the add/drop planner runs on",
  await p.evaluate(() => {
    const l = JSON.parse(localStorage.getItem("beanemachine:lineup") ?? "{}")["espn:81134470"]
    return !!l && l.spots.length > 0 && l.spots.every(s => s.slot && s.name)
  }))
// Players the 2026 snapshot has no row for are NAMED, never dropped: this is a 2021
// league, so several of its men have since retired, and a roster that quietly shrank
// would misprice every lineup under it.
t("and anyone this capture cannot place is named rather than silently dropped",
  !/not in this capture/.test(pullNote) || /not in this capture, add by hand: \S/.test(pullNote),
  pullNote)

/**
 * ── The Yahoo user's two routes, on the build where they are the only ones ──────
 *
 * This is the case the hosted site failed at: Yahoo sends no CORS headers, so
 * nothing on this page can read a Yahoo league, and every platform template shipped
 * with 0 stats, 0 slots and no team count — so "new league from a yahoo template"
 * produced a league that ranked nothing. A Yahoo user's only real options here were
 * a stranger's demo league or typing seventeen point values by hand.
 */
await p.evaluate(() => localStorage.clear())
await p.reload({ waitUntil: "networkidle" })
// The preset is reached through the onboarding now, not through a toolbar: on a
// first visit the toolbar is hidden, because offering New / Remove / Download /
// Load file / a URL field to somebody who has no league is five unexplained
// buttons where one question belongs. It is folded under "Other ways in", which
// is the ranking this app believes: paste your own page first, borrow second.
await openDock()
await p.click('.onboard .chip-btn:text-is("Yahoo")')
await p.click(".onboard-alts summary")
await p.click('.onboard-alts button:text-is("Use the preset")')
// A preset that ranks lands on Today (src/client/App.tsx `create`), so the thing to
// wait for is the Decide card, not a board row.
await p.waitForSelector(".decide", { timeout: 25000 })
// `#tpl` — "Start a league from" — lives in the management toolbar, which used to be
// on the League setup tab and is now on SETUP, the third screen. This was
// `nth-child(2)`, which is Wire, where no toolbar renders at all.
await go("Setup")
await p.waitForSelector("#tpl", { timeout: 15000 })
t("the picker offers no Sleeper league type on the hosted build either",
  !(await p.$$eval("#tpl option", n => n.map(e => `${e.value}${e.textContent}`).join(" "))).match(/sleeper/i),
  await p.$$eval("#tpl option", n => n.map(e => e.textContent).join(" | ")))
// and the board, which is what a preset is FOR, is on Wire — `nth-child(1)` was the
// tab that used to carry it and is now the Decide card alone.
await go("Wire")
t("a Yahoo preset ranks a full board with no server and no import",
  (await p.$$eval(".board-row", n => n.length)) > 50,
  String(await p.$$eval(".board-row", n => n.length)))
const presetNote = await p.locator(".preset-note").first().textContent()
t("and the page says those values were not read from the visitor's league",
  /not read from your league/i.test(presetNote), presetNote.slice(0, 140))
t("and the league it made is marked unverified, not read-from-source",
  await p.evaluate(() => {
    const c = JSON.parse(localStorage.getItem("beanemachine:config"))
    const l = c.leagues[c.active_league]
    return l.provenance.verified === false && l.provenance.method.startsWith("preset:")
  }))

// The other route: the file a local run writes. Dropped straight onto the page,
// with the file dialog never opened — which is what makes this a route rather than
// a button in a toolbar on one tab.
const file = await p.evaluate(() => localStorage.getItem("beanemachine:config"))
const sent = Object.keys(JSON.parse(file).leagues)
await p.evaluate(() => localStorage.clear())
await p.reload({ waitUntil: "networkidle" })
// An emptied browser opens on the preset board with the setup docked SHUT, and the
// drop is asserted from exactly that state rather than from an opened sheet: somebody
// who ran the CLI locally arrives here with a file and nothing else, and has no reason
// to have pressed anything first. Waited on `.dock-bar`, which is all a first visit
// renders of the setup now.
await p.waitForSelector(".dock-bar", { timeout: 25000 })
p.on("dialog", d => d.accept())
const dt = await p.evaluateHandle(text => {
  const d = new DataTransfer()
  d.items.add(new File([text], "scoring.json", { type: "application/json" }))
  return d
}, file)
await p.dispatchEvent("body", "dragover", { dataTransfer: dt })
await p.waitForTimeout(150)
t("a dragged league file is offered a drop target on the hosted build",
  await p.locator(".dropzone").isVisible())
await p.dispatchEvent("body", "drop", { dataTransfer: dt })
await p.waitForSelector(".toast", { timeout: 10000 })
t("and dropping it loads the leagues it carries, with no server",
  /Loaded \d+ league/.test(await p.textContent(".toast")), await p.textContent(".toast"))
// Asserted as the SAME KEYS rather than as a count. The count used to be >= 2 and
// only reached 2 because the build re-seeded a league on every reload — so the
// assertion was partly measuring the seed. What it is about is the round trip.
t("which is the same leagues, back in this browser",
  JSON.stringify(
    await p.evaluate(() =>
      Object.keys(JSON.parse(localStorage.getItem("beanemachine:config")).leagues).sort())
  ) === JSON.stringify([...sent].sort()),
  sent.join(","))

/**
 * ── The question the hosted site could not answer ───────────────────────────────
 *
 * "I have two picks left this week; which starters should I stream over the next
 * three days?" is a question about players the reader can ADD. The Streaming tab,
 * the 3-day window, the start counts and the opponents all shipped, and the list
 * still opened with Tyler Glasnow (94% rostered), Blake Snell, Chris Sale (99%)
 * and Drew Rasmussen (95%) at its head — because the exact free-agent list is read
 * off Yahoo's own pages, Yahoo sends no `access-control-allow-*` headers, and this
 * build has no backend to read it for the page. The control that would have fixed
 * it was permanently disabled here.
 *
 * The file is the route, and this is where it is proved: a pool read on a machine,
 * carried in a JSON file, dropped on a page with EVERY /api/** call aborted, and
 * used to narrow the ranking to players who are actually on the wire.
 */
await p.evaluate(() => localStorage.clear())
await p.reload({ waitUntil: "networkidle" })
// A league of one's own, set up the way a reader sets one up, because there is no
// longer a seeded one to inherit.
const WIRE_KEY = await onboard()
const streamHead = async (n = 6) => {
  // Navigates first, every time. The mode strip, the filters and the table are all
  // on Wire now, and this helper is called from four places that arrive on Today —
  // straight out of `onboard()`, or after a reload, or after a dropped file. `go` is
  // idempotent: clicking the tab you are already on is a no-op plus a marker wait.
  await go("Wire")
  await p.click('.modes .mode:has-text("Streaming")')
  await p.waitForTimeout(400)
  return p.$$eval(".board-row .who b", els => els.map(e => e.textContent.trim()))
    .then(names => names.slice(0, n))
}
const estimated = await streamHead()
t("the streaming tab ranks somebody before any free-agent list is carried",
  estimated.length === 6, estimated.join(", "))
// Nothing is carried yet, so the masthead has to say so — and say it as the way to
// fix it, on every tab, rather than as a disabled checkbox three controls down.
t("with no pool carried, the masthead says so and offers the way to get one",
  await p.locator('[data-wire="none"]').isVisible(),
  await p.locator(".wrap > .chips").textContent())

/**
 * The carried pool. Its players are taken from DEEP in this same streaming list —
 * rows 15-22, well below anything on screen — for a reason: if the filter is doing
 * nothing, they cannot reach the head, so the assertions below cannot pass by
 * accident.
 */
// Read them off the UNFILTERED list. "Only players I can add" defaults on now and
// narrows the streaming tab to the handful the ownership estimate calls gettable —
// which is the feature working, and left eight rows where this needs twenty-two.
// Unticking is also truer to the intent: these have to be men the filter would
// exclude, or the assertions below could pass without it doing anything.
const avail = p.locator(".toggle", { hasText: "Only players I can add" }).locator("input")
await avail.uncheck()
await p.waitForTimeout(500)
const listed = await p.$$eval(".board-row .who b", els => els.map(e => e.textContent.trim()))
// Chosen for the property the assertions below need — men the ESTIMATE does not
// surface — rather than by a fixed slice that happened to have it. `listed.slice(14,
// 22)` held for one capture and stopped holding on the next, when a player the
// estimate calls gettable drifted into the teens: two failures about a wire that
// were really about today's ranking. Skipping the first ten keeps them deep enough
// to be off screen, which is the other half of the point.
const deep = listed.slice(10).filter(n => !estimated.includes(n)).slice(0, 8)
await avail.check()
await p.waitForTimeout(500)
t("the ranking runs deep enough to draw a pool from a part of it nobody would see",
  deep.length === 8 && !deep.some(n => estimated.includes(n)),
  `${listed.length} rows ranked; drew ${deep.join(", ")}`)
const READ_AT = new Date(Date.now() - 3 * 3_600_000).toISOString()
const withWire = JSON.parse(await p.evaluate(() => localStorage.getItem("beanemachine:config")))
withWire.pools = {
  [WIRE_KEY]: {
    at: READ_AT,
    leagueId: "228947",
    players: deep.map((name, i) => ({ yahooId: String(9000 + i), name, team: null, positions: ["SP"] })),
    positionsRead: ["SP"],
    note: "Top 25 free agents per position (SP)."
  }
}
await p.evaluate(() => localStorage.clear())
await p.reload({ waitUntil: "networkidle" })
// Waited on the dock BAR, not on the onboarding: an emptied browser renders the setup
// shut, and nothing here needs it opened — the file is dropped on the window.
await p.waitForSelector(".dock-bar", { timeout: 25000 })
const wireDt = await p.evaluateHandle(text => {
  const d = new DataTransfer()
  d.items.add(new File([text], "scoring.json", { type: "application/json" }))
  return d
}, JSON.stringify(withWire))
await p.dispatchEvent("body", "drop", { dataTransfer: wireDt })
await p.waitForSelector(".toast", { timeout: 10000 })
t("dropping the file says a free-agent list came with it",
  /free-agent list/.test(await p.textContent(".toast")), await p.textContent(".toast"))
await p.waitForTimeout(800)

// It is EXACT and it is OLD, and the page has to say both. A count on its own would
// be the failure this project refuses: a wire turns over whenever anybody in the
// league clicks Add, so 8 free agents with no read time is a claim about right now
// that nothing supports.
const carriedChip = (await p.locator('[data-wire="carried"]').textContent()).replace(/\s+/g, " ")
t("the masthead now states the exact list AND when it was read",
  /free agents 8 read 3h ago/.test(carriedChip), carriedChip)
t("and its tooltip names the instant itself, not only the age",
  (await p.locator('[data-wire="carried"]').getAttribute("title")).includes(READ_AT),
  (await p.locator('[data-wire="carried"]').getAttribute("title")).slice(0, 140))

// The control that was permanently dead on this build.
const wired = await streamHead()
const toggleText = (await p.$eval(".toggle", e => e.textContent)).replace(/\s+/g, " ").trim()
t("the availability control is live on the static build and counts the carried list",
  /8 free/.test(toggleText) && !(await p.$eval(".toggle input", e => e.disabled)), toggleText)
t("and the streaming list is now made only of players he can actually add",
  wired.length > 0 && wired.every(n => deep.includes(n)), wired.join(", "))
t("which is a different list from the one the estimate produced",
  !wired.some(n => estimated.includes(n)), `${estimated.join(", ")} → ${wired.join(", ")}`)

// A week-old wire is not this week's wire. The page must go on saying how old it is
// rather than quietly presenting it as live — this is the same rule `resolvePeriod`
// follows when it falls back to a Monday and says so.
await p.evaluate(() => localStorage.clear())
await p.reload({ waitUntil: "networkidle" })
// Waited on the dock BAR, not on the onboarding: an emptied browser renders the setup
// shut, and nothing here needs it opened — the file is dropped on the window.
await p.waitForSelector(".dock-bar", { timeout: 25000 })
withWire.pools[WIRE_KEY].at = new Date(Date.now() - 7 * 86_400_000).toISOString()
const staleDt = await p.evaluateHandle(text => {
  const d = new DataTransfer()
  d.items.add(new File([text], "scoring.json", { type: "application/json" }))
  return d
}, JSON.stringify(withWire))
await p.dispatchEvent("body", "drop", { dataTransfer: staleDt })
await p.waitForSelector(".toast", { timeout: 10000 })
await p.waitForTimeout(600)
// The chip is in the masthead and shows on every screen, but the availability toggle
// read below it is the board's, and the board is Wire. A drop lands you wherever you
// were — the first-run setup, on Today — so this has to ask for the screen. It used
// not to, because the board was the first tab and the first tab was where you were.
await go("Wire")
const staleChip = await p.locator('[data-wire="carried"]')
t("a week-old free-agent list is shown as a week old, and flagged",
  /read 7d ago/.test((await staleChip.textContent()).replace(/\s+/g, " ")) &&
    (await staleChip.getAttribute("class")).includes("warn"),
  `${(await staleChip.textContent()).replace(/\s+/g, " ")} [${await staleChip.getAttribute("class")}]`)
t("and it is still USED, because a stale exact list beats an estimate that is not one",
  /8 free/.test((await p.$eval(".toggle", e => e.textContent)).replace(/\s+/g, " ")),
  (await p.$eval(".toggle", e => e.textContent)).replace(/\s+/g, " ").trim())

/**
 * ── The way BACK to the setup, for a reader who already has a league ────────────
 *
 * New, because the dock is new and nothing else here reaches it from this direction.
 * The dock exists for the stranger, and it opens SHUT for him so the ranking is the
 * first thing he sees — which leaves the opposite reader, the one with a league who
 * wants the guided setup again, needing a way to open it deliberately. That is the
 * "Set up a league" button in the Setup toolbar, and what it must do is open the
 * sheet ALREADY EXPANDED: a button that only put a collapsed bar at the foot of the
 * screen would read as a button that did nothing.
 *
 * Escape is asserted in the same breath because it is the only way out of the sheet
 * that does not involve finding a particular button, and a fixed panel you cannot
 * dismiss without hunting is the failure this shape of UI has.
 *
 * Run last, on the league this file has already built, because opening the setup sets
 * `onboarding` — which hides the very toolbar the import assertions above fill in.
 */
await go("Setup")
await p.click('.bar [data-ctl="onboard"]')
await p.waitForSelector(".onboard", { timeout: 15000 })
t("a reader who has a league can ask for the setup back, and gets it already open",
  await p.locator(".dock.on .dock-sheet .onboard").isVisible())
t("and the button that opened it now offers to close it, so it is not a one-way door",
  /^Close$/.test((await p.$eval(".dock-bar button", e => e.textContent.trim()))),
  await p.$eval(".dock-bar button", e => e.textContent))
await p.keyboard.press("Escape")
await p.waitForSelector(".onboard", { state: "detached", timeout: 10000 })
t("and Escape closes the sheet without closing the way back to it",
  (await p.$$eval(".onboard", n => n.length)) === 0 &&
    (await p.$$eval(".dock-bar", n => n.length)) === 1)

t("no page errors after all of that", errs.length===0, errs.join(" | "))


/**
 * A static build asks for nothing it cannot have.
 *
 * `detectMode` probed `/api/health` unconditionally, and on beanemachine.com — a
 * static host, by design — that was a failed request and a red 404 in the console on
 * every single page load. To anyone who opens devtools that is what a broken site
 * looks like, and it is a request per visitor for an answer already known: a
 * production build with no `VITE_API_BASE` has no API by construction.
 */
{
  const page = await b.newPage()
  const errors = []
  const apiCalls = []
  page.on("console", m => { if (m.type() === "error") errors.push(m.text().slice(0, 120)) })
  page.on("request", r => { if (r.url().includes("/api/")) apiCalls.push(r.url()) })
  await page.goto(BASE, { waitUntil: "networkidle" })
  await page.waitForTimeout(1500)
  /*
   * "The API" here means THIS app's backend, which a static build does not have. It
   * was matched as any URL containing "/api/", and that now also catches the two
   * public MLB feeds the page reads directly — statsapi.mlb.com/api/v1/schedule for
   * tonight's posted lineups and /api/v1/transactions for who went on the injured
   * list. Those are the opposite of the defect this assertion guards: they are how a
   * page with no backend gets facts it would otherwise have to invent, and they are
   * CORS-open precisely so it can. The claim is unchanged and the match is now the
   * app's own origin.
   */
  t("a static build makes no request to a backend of its own",
    apiCalls.filter(u => u.startsWith(BASE)).length === 0,
    apiCalls.filter(u => u.startsWith(BASE)).join(", "))
  t("and what it does ask for off-origin is MLB's own public data, nothing else",
    apiCalls.every(u => u.startsWith(BASE) || u.startsWith("https://statsapi.mlb.com/")),
    apiCalls.join(", "))
  t("and logs no console errors on load", errors.length === 0, errors.join(" | "))
  await page.close()
}


await b.close()
console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
