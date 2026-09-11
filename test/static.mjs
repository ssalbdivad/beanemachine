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
  /* VISIBLE, not merely present. The sheet is mounted and `hidden` while closed now — it
     had to be, or closing it discarded everything the reader had typed — so `page.$`
     finds it either way and this helper stopped pressing the button that opens it. */
  if (!(await page.locator(".onboard").isVisible()))
    await page.click(".dock-bar button")
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
  /one real league.s scoring, not yours/i.test(await p.$eval(".preview-note", e => e.innerText)),
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
/* "not mounted" was the proxy and it stopped being the claim. The sheet stays mounted and
   `hidden` now, because unmounting it discarded everything the reader had typed — see the
   Back block at the foot of this file. What the claim was always about is whether the form
   is IN THE WAY, so that is what is asserted: nothing of it is visible, it is out of the
   accessibility tree, and it is out of the tab order, which `hidden` gives all three of. */
t("the setup is not in the way: none of the form is visible until it is asked for",
  (await p.$$eval(".onboard", n => n.filter(e => e.checkVisibility()).length)) === 0 &&
    (await p.evaluate(() => document.querySelector(".dock-sheet")?.hidden !== false)),
  `${await p.$$eval(".onboard", n => n.filter(e => e.checkVisibility()).length)} visible onboarding cards; sheet hidden: ${await p.evaluate(() => document.querySelector(".dock-sheet")?.hidden)}`)
/*
 * The bar says what the reader GETS, and the caveat lives on the numbers it is about.
 *
 * Both lines used to say the same thing: the bar read "Standard scoring — not your
 * league yet" and the board's own note read "Standard scoring, not yours." One screen,
 * one fact, twice — and the half that was missing was the only half that makes a
 * stranger press anything, which is what he gets for it. So the bar is the offer and
 * the board keeps the caveat, attached to the numbers it is a caveat about.
 *
 * Asserted as a pair, because either alone is the failure: an offer with the caveat
 * dropped is the demo-league mistake again, and a caveat with no offer is what was
 * there before.
 */
t("but the way to it is on the page, saying what pressing it gets you",
  /who.s on your team/i.test(await p.$eval(".dock-say", e => e.innerText)) &&
    /start tonight/i.test(await p.$eval(".dock-say", e => e.innerText)),
  await p.$eval(".dock-say", e => e.innerText))
t("and the borrowed-values caveat is on the board, attached to the numbers",
  /one real league.s scoring, not yours/i.test(await p.$eval(".preview-note", e => e.innerText)),
  await p.$eval(".preview-note", e => e.innerText))
/* Matched on a regex rather than `text-is`, and the apostrophe is why: this button
   ships a straight one ("Who's on my team", Dock.tsx) while every other string in the
   same flow ships a curly `&rsquo;` — "Who&rsquo;s on your team?", "That&rsquo;s my
   team". The claim is about the WORDS, so a typographic fix to either glyph must not
   read as this button disappearing. */
t("and the button asks the question it is about to ask, not for a chore",
  await p.locator(".dock-bar button", { hasText: /^Who.s on my team$/ }).isVisible(),
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
/*
 * Renamed again, and this is the second rename these three have had — so what the
 * list is for is worth restating. "Today | Wire | Setup" named the app's own parts:
 * a wire is jargon, and "setup" is a thing software has rather than a thing a
 * manager wants. They are now named for the question each one answers, in the words
 * a reader would use for it — Tonight, Pickups, My league.
 *
 * The view IDS are deliberately unchanged (board / wire / trade). They are the key
 * this browser stores the last-used screen under, so renaming them would drop every
 * returning reader onto the default screen — which is why this list is the only place
 * the new names appear, and why `go` navigates by visible text.
 */
const TAB_LABELS = ["Tonight", "Pickups", "My league"]
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
const MARKER = { Tonight: ".decide", Pickups: ".board-row", "My league": '.bar [data-ctl="onboard"]' }
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
 * - that this app does not present a bscore as a forecast. That claim has MOVED,
 *   and it is asserted below against where it went rather than dropped: the
 *   colophon's surviving sentence no longer explains the number at all, because a
 *   footer rendered under every screen was explaining a column that only two of the
 *   three horizons are sorted by. It is now generated under the column heads from
 *   the sort actually in force (`.board-legend`, Board.tsx), so it is asserted
 *   there, on the screen that has the table on it.
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
/*
 * The colophon POINTS now; it no longer explains.
 *
 * This asserted the footer still said "a ranking, not a forecast". It does not, and
 * the sentence did not merely get cut: it was the app's one explanation of its own
 * number, printed under every screen including the two with no table on them, and it
 * described the bscore column while the Streaming horizon ranks on raw projected
 * points by documented decision. One fixed sentence could not be true of all three
 * horizons, so the explanation moved to the table and is generated from the ordering
 * in force — asserted as `.board-legend` immediately below.
 *
 * What stays here is what a footer can honestly carry: the unit every number is in,
 * and the way to the working. Read for the POINTER rather than for the wording,
 * because a colophon that pointed nowhere is the failure this line is about.
 *
 * AND THE UNIT IS CONDITIONAL, which is the half this suite is in the right place to
 * hold. "Every number is in your league's own points" was unconditional, so on THIS
 * build — which ships no league at all — it sat a few inches under the board's own
 * banner reading "Standard scoring, not yours. Every number below is real and none of
 * it is about your league yet". The app contradicting itself on one screen, about the
 * one fact that decides whether any of the numbers apply to the reader. So the no-league
 * wording is what this file asserts, because no-league is the only state it has.
 */
t("the colophon is one sentence, and it points at the working rather than explaining it",
  colophon.split(" ").length < 90 && /methodology/i.test(colophon),
  `${colophon.split(" ").length} words: ${colophon.slice(0, 140)}`)
t("and with no league it does not claim the numbers are in the reader's own points",
  /borrowed from one real league/i.test(colophon) && !/your league.s own points/i.test(colophon),
  colophon.slice(0, 200))
/*
 * The claim the footer used to carry, asserted where it now lives.
 *
 * Generated from `sort`, so there is one legend per ordering and each one describes
 * the column the rows are actually in. On this screen — a first visit, the fortnight
 * board, sorted on bscore — it has to name the man the number is measured against AND
 * refuse to be read as a points forecast, which is the whole of what the deleted
 * sentence was protecting. Read off the rendered page rather than the source so a
 * legend that stopped rendering is a failure rather than an absence nobody notices.
 */
/*
 * Read as SUMMARY and BODY, because the legend is a disclosure.
 *
 * `.board-legend` is a `<details>`: the summary names the column the rows are sorted
 * by, and the caveat is one tap under it. That is deliberate and measured — three
 * lines of caveat above the table is a third of a phone screen spent on prose about
 * the thing the reader came to look at — so the assertion has to be about both halves,
 * and `innerText` only ever returns the summary while the disclosure is shut. The
 * body is read off `textContent`, which is what "present, one tap away" means here.
 */
const legendSummary =
  (await p.$eval(".board-legend summary", e => e.innerText)).replace(/\s+/g, " ").trim()
const legendAll =
  (await p.$eval(".board-legend", e => e.textContent)).replace(/\s+/g, " ").trim()
/* "best man still free" is gone, and it was FALSE — measured, not restyled. The bar is
   not the best free man, it is the (teams x seats)-th best eligible man: who is left
   once every club has filled that spot. Named on the shipped league with each man's
   Yahoo rostered-in percentage, five of the ten bars are set by somebody rostered in
   85-99% of leagues (Util Matt Olson 99%, 2B Ketel Marte 95%, SS Jeremy Peña 87%, RP
   Trevor Megill 85%). src/engine/trade.ts had already written down that this sentence
   was wrong; nobody had changed the sentence. What the summary must do is unchanged —
   name the column the rows are actually in — so that is what is asserted, plus the
   correction, so the old wording cannot come back. */
t("and the column the rows are sorted by is named under the heads, by the sort in force",
  /ahead by/i.test(legendSummary) && /once every team has filled it/i.test(legendSummary),
  legendSummary)
t("and it does not call that bar the best man still free, which he usually is not",
  !/best man still free/i.test(legendAll), legendAll.slice(0, 240))
t("and the not-a-forecast claim moved onto the table, one tap under that",
  /does not promise points/i.test(legendAll) && !/does not promise points/i.test(legendSummary),
  legendAll.slice(0, 200))
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
/*
 * ONE question, and it is about baseball.
 *
 * This asserted that "the first question is which platform, with Yahoo among the
 * answers", and the platform question is no longer asked at all on the required path.
 * It was asked for the app's benefit rather than the reader's, and the route it led to
 * was "select the whole page with Ctrl+A" — which no phone browser can do, on the
 * device this app is opened on. The only advertised way in was impossible for most of
 * the people being shown it.
 *
 * What replaced it is the question the app actually needs answered and the reader
 * actually has an answer to. Asserted as all three halves of "one question", because
 * any one alone would pass on a sheet that had quietly grown a second: the head asks
 * it, there is somewhere to answer it, and the button is about the answer rather than
 * about configuring software.
 */
t("the sheet asks one question, and it is who is on your team",
  /who.s on your team/i.test(await p.$eval(".onboard h2", e => e.innerText)) &&
    (await p.$$eval('.onboard textarea[data-ctl="onboard-team"]', n => n.length)) === 1 &&
    await p.locator(".onboard button", { hasText: /^That.s my team$/ }).isVisible(),
  await p.$eval(".onboard h2", e => e.innerText))
// The box has to TEACH the format, not describe it: four real men, one to a line, the
// position first. A placeholder naming somebody the capture has never heard of would
// teach a format that silently matches nobody — test/paste.mjs pins those four names
// against the shipped snapshot, and this pins that they reach the shipped page.
const PLACEHOLDER =
  await p.getAttribute('.onboard textarea[data-ctl="onboard-team"]', "placeholder")
t("and the box shows what an answer looks like rather than describing one",
  (PLACEHOLDER ?? "").split("\n").length >= 4 && /^[A-Z0-9]{1,3} \w+ \w+/.test(PLACEHOLDER ?? ""),
  JSON.stringify(PLACEHOLDER))
/*
 * Everything about platforms is behind a disclosure now, so reaching it is a gesture.
 *
 * Written as a named helper for the same reason `openDock` is: four blocks below this
 * need a platform chip, the chips are inside `<details class="onboard-alts">`, and a
 * closed `<details>` keeps its contents in the DOM while Playwright refuses to click
 * them — which is exactly how this file died, on a `.chip-btn:text-is("Yahoo")` that
 * resolved to an element and then timed out for 30s on "element is not visible".
 *
 * Idempotent, because a `<details>` toggles: clicking the summary of an open one shuts
 * it again, and these blocks run in sequence on the same sheet.
 */
const openAlts = async (page = p) => {
  if (!(await page.$(".onboard-alts[open]"))) await page.click(".onboard-alts summary")
  await page.waitForSelector(".onboard-alts[open]", { timeout: 10000 })
}
// The summary is the reader's own reason for opening it — "my league scores
// differently" is a thing a manager knows about his league. It used to be headed
// "Other ways in", which is a fact about the app's plumbing.
t("and the platform question is behind a fold named for the reader's reason to open it",
  /scores differently/i.test(await p.$eval(".onboard-alts summary", e => e.innerText)),
  await p.$eval(".onboard-alts summary", e => e.innerText))
await openAlts()
t("with Yahoo among the answers once it is opened",
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
 * The one-tap route to a league is not a button any more; it is the answer.
 *
 * This asserted a visible `.onboard-shortcut` reading "Start from these values", with
 * "not read from your league" on its own line. That control is DELETED, and so is the
 * "Use the preset" button inside the disclosure — both of them ways of saying "adopt
 * the scoring you are looking at", which is a sentence about configuration that a
 * reader who has not asked about scoring should never have to read.
 *
 * It happens on its own now. Typing a team into the box above and pressing the button
 * materialises the previewed preset as a real league FIRST and writes the roster
 * against it (`onAdoptPreset` in App.tsx, called from `readTeam`) — which is both
 * simpler and a bug fix: `leagueKey` is null on a first visit, `readTeam` used to open
 * `if (!leagueKey) return`, and the primary button at the highest-attrition step in the
 * whole product therefore did nothing at all. That whole route is asserted end to end
 * at the bottom of this file, under "a stranger gets from nothing to a stored team".
 *
 * What is asserted here is the half that has to be true BEFORE he types: the sheet
 * says what the board behind it is running on, and that answering the question is what
 * makes it his. Without that line the sheet is a box with no stated consequence.
 */
t("a first visit is told the board behind the sheet is already running, on borrowed values",
  /already running/i.test(await p.$eval(".onboard-done", e => e.innerText)) &&
    /makes it yours/i.test(await p.$eval(".onboard-done", e => e.innerText)),
  await p.$eval(".onboard-done", e => e.innerText))
/*
 * WHAT IS NO LONGER PROTECTED, recorded rather than dropped: nothing now checks that
 * the borrowed-values caveat sits on the CONTROL a reader presses to borrow them,
 * because there is no such control. The caveat survives in two other places and both
 * are asserted — on the board (`.preview-note`) and in the disclosure's own copy, the
 * line below — but a reader who types his team and presses the button has adopted
 * standard scoring without the button having said so. The board he lands on still says
 * it, which is why this is a note and not a failure.
 */
// The card and the board must agree about whose scoring this is: two different
// answers on one screen is worse than either answer alone.
/* "standard" was the word and it was false: the preset is league 228947's own settings
   page, copied, and Yahoo's own H2H-points default pays 1 for a run and 4 for a home run
   where this pays 1.9 and 10.4. What the assertion is for is unchanged — the card and the
   board must not give two different answers about whose scoring this is — so it now holds
   both to saying the values are borrowed and not the reader's. */
t("and the card and the board agree that the scoring is borrowed, not the reader's",
  /one real (Yahoo )?league/i.test(await p.$eval(".onboard", e => e.innerText)) &&
    /one real league.s scoring, not yours/i.test(await p.$eval(".preview-note", e => e.innerText)),
  `${(await p.$eval(".preview-note", e => e.innerText)).slice(0, 90)}`)
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
// "Pickups", not "Wire" — the tab was renamed in the plain-language pass and the
// view id behind it ("wire") was deliberately not, because it is the key this browser
// stores the last screen under. Read off the label, because the label is what a reader
// can see and the id is what nothing must change.
t("and the visit lands on the screen that ranks",
  (await p.$$eval(".views button[aria-current=page]", n => n.map(e => e.textContent.trim())))[0] === "Pickups",
  (await p.$$eval(".views button[aria-current=page]", n => n.map(e => e.textContent.trim()))).join(","))

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
  // And then the disclosure. Pasting a settings page is no longer the front door — it
  // is what "My league scores differently" opens onto — so the platform chip this
  // helper needs is inside a closed `<details>`, where a click waits 30s for an
  // element that is in the DOM and will never be visible. See `openAlts`.
  await openAlts()
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
await go("Pickups")
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
await go("Tonight")
t("and Today is the decision alone: the table is not hiding under the Decide card",
  (await p.$$eval(".decide", n => n.length)) === 1 &&
    (await p.$$eval(".board-row", n => n.length)) === 0,
  `${await p.$$eval(".board-row", n => n.length)} ranked rows on the Today screen`)
// and the way across to it is a link on Today, not a scroll — the one thing that
// screen offers besides the decision itself
t("with one link across to the ranking, named as what it leads to",
  /Everyone you can get/.test(await p.$eval(".next-screen", e => e.innerText)),
  await p.$eval(".next-screen", e => e.innerText))
await go("Pickups")
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
 * FOUR columns now, and that is the change this block had to be rewritten for.
 *
 * It required uscore, bscore, conf and luck to each carry a >40-character definition
 * on their own header. Three of those four columns are no longer on the board at all:
 * uscore, conf and luck left the row and the head together. Measured on the shipped
 * capture, confidence read 100% on 41 of the first 60 rows and took four distinct
 * values across all sixty, and luck is a contact percentile that feeds no ranking on
 * this screen — so three of the six numbers on every row were not decision columns,
 * and printing them beside the two that are lent them the same weight.
 *
 * What a row says now is: rank, who, how far ahead of a free pickup he is, and what he
 * gets out of the window — plus "for you" once a roster is entered, which is the same
 * subtraction taken against the reader's own bench. So the head is asserted as a SET
 * rather than by picking columns out of it: a column creeping back on is as much a
 * failure here as a definition going missing, and a per-column check cannot see it.
 */
const headCols = await p.$$eval(".board-head > [data-col]", n => n.map(e => e.getAttribute("data-col")))
t("the board is four columns with no roster: rank, player, ahead by, games",
  JSON.stringify(headCols) === JSON.stringify(["rank", "who", "bscore", "games"]),
  headCols.join(" | "))
/**
 * The property the legend was protecting, asserted against what replaced it.
 *
 * Read for LENGTH as well as presence, because `title=""` is a header with a title
 * attribute and no definition in it, and that is precisely how this would rot: a
 * column added to COLUMN_HELP with a placeholder would leave the glossary gone and
 * nothing in its place, and a bare `hasAttribute` check would call that a pass.
 *
 * `who` is exempt and named rather than filtered out: its definition is "Sort by
 * player name.", twenty characters, and a longer one would be padding — the column
 * whose content is a man's name needs no gloss.
 */
const heads = Object.fromEntries(await p.$$eval(".board-head .sort-head",
  n => n.map(e => [e.getAttribute("data-col"), e.getAttribute("title") ?? ""])))
t("and every column that is a number still defines itself, on the header itself",
  Object.entries(heads).every(([c, h]) => c === "who" ? h.length > 10 : h.length > 40),
  Object.entries(heads).map(([c, h]) => `${c}:${h.length}ch`).join(" "))
/*
 * The two numbers that left the row are still PRINTED, one tap down, and that is the
 * difference between moving a column and deleting a measurement. Confidence and uscore
 * are named in the drill-down — `.detail dt` — so the reader who wants to know how much
 * data stands behind a projection can still get it per player.
 *
 * WHAT IS NO LONGER PROTECTED ANYWHERE, recorded rather than dropped: their
 * DEFINITIONS. COLUMN_HELP still holds a sentence for confidence, uscore and luck, and
 * nothing on the page renders those three any more — they were only ever reachable as
 * the `title=` of a header that no longer exists. The drill-down prints the numbers
 * with no gloss on what they mean, and the glossary that would have explained them is
 * the `<details class="legend">` this pass deleted. So "confidence 100%" is on screen,
 * correct, and undefined.
 */
const firstRow = p.locator(".board-row").first()
await firstRow.click()
await p.waitForSelector(".detail", { timeout: 10000 })
const detailTerms = await p.$$eval(".detail dt", n => n.map(e => e.textContent.trim()))
t("and the numbers that left the row are still printed in the drill-down, per player",
  detailTerms.includes("confidence") && detailTerms.includes("uscore"),
  detailTerms.join(" | "))
await firstRow.click()
await p.waitForSelector(".detail", { state: "detached", timeout: 10000 })
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
await go("My league")
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
  /*
   * The promise is next to the BOX now, and it is about his team.
   *
   * This matched "stays in this browser", which was the sentence the setup carried
   * when the setup's first question was about a league. The sheet asks one question
   * now — who is on your team — and the promise moved to sit directly under the box he
   * types them into, which is where the question "where does this go?" is actually
   * asked: "Nothing leaves this phone. There is no account — your team is saved in this
   * browser and nowhere else."
   *
   * Read for BOTH halves, because either alone is the old failure: that nothing is
   * sent anywhere, and that the thing he typed is nonetheless kept. A promise of
   * privacy with no promise of persistence reads as "and we threw it away".
   */
  t("the screen he types his team into promises it goes nowhere and is kept anyway",
    /nothing leaves this phone/i.test(note) && /saved in this browser/i.test(note),
    note.slice(0, 220))
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
await go("My league")
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
  "https://baseball.fantasysports.yahoo.com/b1/228947/8", /any website/i)
/*
 * ONE SENTENCE, and it is about his league rather than about our software.
 *
 * This asserted four things of this message, and three of them are deliberately no
 * longer in it: "local server", "CORS", and ESPN by name. The old message was four
 * sentences and a shell command — access-control headers, what a browser is and is not
 * handed, ESPN's behaviour by contrast, and `npx --yes github:…` — read by somebody who
 * is on a hosted page precisely because he was never going to run a command. None of it
 * changed what he does next.
 *
 * The two facts he can act on are what is left, and both are asserted: nothing can read
 * a Yahoo league, and copying his own page does work. The refusal is STILL Yahoo's by
 * name, which is the original claim and the one that must not go — a blanket "importing
 * is not supported" was the sentence that made the hosted build useless, and it was
 * false for ESPN besides.
 */
t("a Yahoo import is refused, and the refusal is Yahoo's by name rather than this app's",
  /yahoo/i.test(yahooMsg) && /any website can do/i.test(yahooMsg), yahooMsg)
t("and it ends somewhere a reader can go: copying his own page, private leagues included",
  /copying your own/i.test(yahooMsg) && /private leagues included/i.test(yahooMsg), yahooMsg)
/*
 * The plain-language claim, asserted as a negative on the one message a Yahoo user is
 * the only reader of.
 *
 * Measured across the three screens before this pass: ten lines of developer vocabulary
 * in user-facing copy. This message carried four of them by itself. A negative
 * assertion is the only kind that can hold it, because the words come back one at a
 * time and each one looks harmless on its own.
 */
t("and it says none of it in software: no headers, no server, no command",
  !/cors|access-control|header|local server|npx|node |terminal/i.test(yahooMsg), yahooMsg)
/*
 * ── Where the command went, and the claim that went with it ─────────────────────
 *
 * The two assertions that used to live on the Yahoo toast — that it names a route which
 * works for Yahoo (read it locally, carry the file back) and that the command it names
 * is one a visitor with no clone could run — are still claims worth keeping. The
 * command has not been deleted; it survives exactly once, on My league, behind a
 * disclosure whose summary says who it is for. So they are asserted there.
 *
 * Read on a SECOND browser carrying a deliberately incomplete league, because that is
 * the state which renders that card (`Setup` in panels.tsx: a league that exists and
 * cannot rank) and this page's league is complete. The league is this file's own pasted
 * one with the team count taken out — one of the three inputs `leagueGaps` requires —
 * so nothing about it is invented, and the gap is the one a reader most often arrives
 * with.
 */
{
  const gapPage = await b.newPage({ viewport: { width: 1280, height: 1000 } })
  await gapPage.route("**/api/**", r => r.abort())
  await gapPage.goto(BASE, { waitUntil: "networkidle" })
  const incomplete = await p.evaluate(k => {
    const c = JSON.parse(localStorage.getItem("beanemachine:config"))
    const l = JSON.parse(JSON.stringify(c.leagues[k]))
    l.meta.max_teams = null
    return JSON.stringify({ ...c, leagues: { [k]: l }, active_league: k })
  }, KEY)
  await gapPage.evaluate(c => localStorage.setItem("beanemachine:config", c), incomplete)
  await gapPage.reload({ waitUntil: "networkidle" })
  await gapPage.waitForSelector(".flags li", { timeout: 25000 })
  t("a league that cannot rank says which input is missing, rather than ranking anyway",
    /how many teams/i.test(await gapPage.$eval(".flags", e => e.innerText)),
    await gapPage.$eval(".flags", e => e.innerText).then(s => s.replace(/\s+/g, " ").slice(0, 140)))
  // The card's own prose, which is where the ESPN-imports-here claim now lives: the
  // refusal toast no longer carries it, and without it somewhere a reader could still
  // read "Yahoo can't be read" as "no league can".
  const ways = (await gapPage.$eval("dl", e => e.innerText)).replace(/\s+/g, " ")
  t("and the page still says ESPN can be read from its URL, so Yahoo is not a blanket no",
    /espn/i.test(ways) && /yahoo does not let any website/i.test(ways), ways.slice(0, 300))
  // Folded, and the summary is the whole point of the fold: it names the reader it is
  // for. A command printed unconditionally is the app talking about itself to somebody
  // who came here about baseball, which is what the Yahoo toast was doing.
  const terminal = gapPage.locator("details", { hasText: /comfortable with a terminal/ })
  t("and the one command left in the product is folded behind who it is for",
    (await terminal.count()) === 1 &&
      !(await terminal.locator("pre").first().isVisible()),
    `${await terminal.count()} disclosures`)
  const { IMPORT_COMMAND } = await import("../src/client/command.ts")
  await terminal.locator("summary").first().click()
  const shown = (await terminal.locator("pre").first().textContent()) ?? ""
  t("and it names the route that works for Yahoo: read it locally, carry the file back",
    shown.trim() === IMPORT_COMMAND &&
      /drop that file/i.test((await terminal.innerText()) ?? "") && !/\bnub\b/.test(shown),
    shown)
  t("and the command it names is one a visitor with no clone could actually run",
    /^npx --yes github:/.test(IMPORT_COMMAND) && !/experimental-strip-types/.test(IMPORT_COMMAND),
    IMPORT_COMMAND)
  await gapPage.close()
}
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
/* The two assertions that stood here — that the refusal names the file route, and that
   the command is runnable by somebody with no clone — moved up into the block above,
   onto the card that now carries the command. They are not dropped; the toast simply is
   not where that sentence lives any more. */

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
await go("My league")
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
 * ── A stranger gets from nothing to a stored team by TYPING NAMES ────────────────
 *
 * THE POINT OF THE WHOLE PASS, and until this block nothing in this suite walked it.
 *
 * This is the case the hosted site failed at, and it failed at it twice. First
 * because Yahoo sends no CORS headers, so nothing on this page can read a Yahoo league
 * and every platform template shipped with 0 stats and no team count — a Yahoo user's
 * only real options were a stranger's demo league or typing seventeen point values by
 * hand. Then, once a preset fixed that, because the only advertised route in was
 * "select the whole settings page with Ctrl+A", a gesture no phone browser has.
 *
 * This block used to walk the fix for the first failure: open the sheet, pick Yahoo,
 * unfold "Other ways in", press "Use the preset". That BUTTON IS GONE — both it and the
 * `.onboard-shortcut` one, because "adopt these values" is a sentence about
 * configuration aimed at somebody who has not asked about scoring and does not know he
 * is being offered anything.
 *
 * What replaced it is one question and one answer: type your players, press the button.
 * Three things happen on that press and all three are asserted, because this is the
 * single highest-attrition step in the product and two of the three have been broken
 * inside it before:
 *
 *  · the previewed preset becomes a REAL league in this browser. `readTeam` used to
 *    open `if (!leagueKey || !snapshot) return`, and `leagueKey` is null on a first
 *    visit because the board a stranger is looking at is a preview that is never
 *    stored — so the primary button did nothing at all. Nothing on screen changed and
 *    nothing was saved.
 *  · the roster is stored against it, so tonight's lineup has something to rank.
 *  · every name is repeated back, and every line that matched NOBODY is quoted. A count
 *    cannot be checked — "18 players" reads the same whether it found yours or not —
 *    and a silent drop is the one failure a reader never notices: two mistyped names
 *    would be missing from every recommendation for the rest of the season.
 *
 * Typed through `page.type` on the real textarea rather than `fill`, because `fill`
 * sets the value in one event and this box's only control is React state driven by
 * `onChange` — a difference that has hidden a broken input before now.
 */
await p.evaluate(() => localStorage.clear())
await p.reload({ waitUntil: "networkidle" })
await openDock()
t("a cold first visit holds no league at all, which is the state this route starts in",
  await p.evaluate(() =>
    Object.keys(JSON.parse(localStorage.getItem("beanemachine:config")).leagues).length === 0 &&
      localStorage.getItem("beanemachine:roster") === null))
/*
 * The names are the shipped PLACEHOLDER, plus one line that is nobody.
 *
 * Taking them off the placeholder rather than hardcoding four more names is the point:
 * the placeholder is what the app teaches a stranger to type, so this walks the example
 * the product itself gives. If that example ever names somebody the capture has never
 * heard of, the front door teaches a format that silently matches nobody, and this
 * assertion is what would catch it.
 *
 * The junk line is deliberate and is not a typo: it is the only way to see the quoting
 * half of the answer block, and a reader's real paste always has one — a team name, a
 * header row, a man who retired.
 */
const JUNK = "Zzyzx Quimbleton"
await p.click('.onboard textarea[data-ctl="onboard-team"]')
await p.type('.onboard textarea[data-ctl="onboard-team"]', `${PLACEHOLDER}\n${JUNK}`)
await p.locator(".onboard button", { hasText: /^That.s my team$/ }).click()
await p.waitForSelector(".onboard-answer", { timeout: 15000 })
const typedKey = await p.evaluate(() =>
  JSON.parse(localStorage.getItem("beanemachine:config")).active_league)
t("typing a team on a first visit materialises a real league to hang it on",
  !!typedKey, String(typedKey))
t("and the team itself is stored in this browser, against that league",
  await p.evaluate(k => {
    const r = JSON.parse(localStorage.getItem("beanemachine:roster") ?? "{}")[k]
    return Array.isArray(r) && r.length === 4
  }, typedKey),
  await p.evaluate(() => localStorage.getItem("beanemachine:roster")))
// Named BACK, not counted. Four names can be checked in four seconds; "4 players"
// cannot be checked at all.
const got = await p.$eval(".onboard-got", e => e.innerText)
t("and every man it found is named back, so four of them can be checked in four seconds",
  PLACEHOLDER.split("\n").map(l => l.split(" ").slice(1).join(" ")).every(n => got.includes(n)),
  got)
t("and the line that matched nobody is quoted back verbatim, not silently dropped",
  (await p.$eval(".onboard-missed", e => e.innerText)).includes(JUNK),
  await p.$eval(".onboard-missed", e => e.innerText))
/*
 * A TYPO IS ONE TAP, not a retype.
 *
 * `rosterFromPaste` measures the one man a failed line is a single typo from — 99.1%
 * right and 0.0% wrong on real typos across the whole capture, and it refuses on
 * anything that says too little. The note has asked "Did you mean Juan Soto?" since that
 * landed, and the only way to answer was to retype the line on a phone keyboard, which
 * is where people quit.
 *
 * Three things have to hold together and any one alone would pass on a broken flow: the
 * name is OFFERED, tapping it puts the man in the ROSTER, and it puts him in the LINEUP
 * too — a man in the roster and absent from the seats is one `Decide` silently never
 * considers, so roster-only would have been worse than nothing. And afterwards his line
 * must stop being described as uncounted, because it is now counted.
 *
 * The junk line above must NOT produce an offer: it says too little to be answered, and
 * a suggestion that fires on anything is the silent correction this must never make.
 */
await p.fill("[data-ctl=onboard-team]", "OF Juan Sot\nSP Tarik Skubl")
await p.click(".onboard-go button")
await p.waitForSelector(".onboard-meant", { timeout: 15000 })
const meant = await p.$$eval(".onboard-meant .chip-btn", n => n.map(e => e.textContent.trim()))
t("a line one typo off is offered the name it is one typo from, as something to press",
  meant.join(",") === "Juan Soto,Tarik Skubal", meant.join(",") || "(nothing offered)")
const beforeTap = await p.evaluate(k => JSON.parse(localStorage.getItem("beanemachine:roster"))[k].length, typedKey)
await p.locator('.onboard-meant .chip-btn:text-is("Juan Soto")').click()
await p.waitForTimeout(400)
t("and pressing it puts that man in the team",
  (await p.evaluate(k => JSON.parse(localStorage.getItem("beanemachine:roster"))[k].length, typedKey)) ===
    beforeTap + 1,
  `${beforeTap} then ${await p.evaluate(k => JSON.parse(localStorage.getItem("beanemachine:roster"))[k].length, typedKey)}`)
t("and gives him a seat, because a man with none is one the card never considers",
  await p.evaluate(k => {
    const l = JSON.parse(localStorage.getItem("beanemachine:lineup") ?? "{}")[k]
    return !!l?.spots?.some(s => s.name === "Juan Soto" && s.slot === "BN")
  }, typedKey),
  await p.evaluate(k => JSON.stringify(JSON.parse(localStorage.getItem("beanemachine:lineup") ?? "{}")[k]?.spots?.map(s => `${s.slot} ${s.name}`)), typedKey))
t("and his line stops being described as counted nowhere, because it now is",
  !(await p.$$eval(".onboard-missed", n => n.map(e => e.innerText).join(" "))).includes("Juan Sot\u00bb"),
  await p.$$eval(".onboard-missed", n => n.map(e => e.innerText.slice(0, 90)).join(" | ")))
// and the offer never fires on text that says too little to be answered
await p.fill("[data-ctl=onboard-team]", JUNK)
await p.click(".onboard-go button")
await p.waitForTimeout(600)
t("but a line that says too little is refused with no guess attached",
  (await p.locator(".onboard-meant").count()) === 0,
  await p.$$eval(".onboard-answer > *", n => n.map(e => e.innerText.slice(0, 70)).join(" | ")))
// put the four typed names back, which is the state the rest of this walk assumes
await p.fill("[data-ctl=onboard-team]", PLACEHOLDER)
await p.click(".onboard-go button")
await p.waitForSelector(".onboard-got", { timeout: 15000 })
/*
 * The second question, and it only appears once there is a league to write it to. The
 * bar every player is measured against is the (teams x seats)-th best man, so the team
 * count moves every row on the board — which is why it is asked at all, and why it is a
 * chip row rather than a number field.
 *
 * Scoped to its own heading rather than to `.onboard-teams`, which is now two rows: the
 * lineup-lock question below shares the class and joined this census as
 * "8 10 12 14 16 Yes, every day No, it locks for the week".
 */
const teamChips = p.locator(".onboard-teams", { hasText: "How many teams" }).locator(".chip-btn")
t("and the one other question that moves every row is asked, as chips",
  JSON.stringify(await teamChips.allTextContents()) === JSON.stringify(["8", "10", "12", "14", "16"]),
  (await teamChips.allTextContents()).join(" "))
await teamChips.filter({ hasText: /^12$/ }).click()
await p.waitForFunction(() => {
  const c = JSON.parse(localStorage.getItem("beanemachine:config"))
  return c.leagues[c.active_league].meta.max_teams === 12
}, null, { timeout: 10000 }).catch(() => {})
t("and answering it is written to the league, not only to the chip",
  await p.evaluate(() => {
    const c = JSON.parse(localStorage.getItem("beanemachine:config"))
    return c.leagues[c.active_league].meta.max_teams === 12
  }),
  String(await p.evaluate(() => {
    const c = JSON.parse(localStorage.getItem("beanemachine:config"))
    return c.leagues[c.active_league].meta.max_teams
  })))
/**
 * THE THIRD QUESTION, AND THE ONE THE DOCK'S PROMISE RESTS ON.
 *
 * The bar reads "Tell it who's on your team and it will tell you who to start tonight"
 * and the button below reads "Show me tonight". Neither was true on this route.
 * `Decide`'s Today section renders only where `scoring_period.lineup_lock === "daily"`,
 * and the shipped preset carries no `scoring_period` at all — verified `undefined` in
 * public/scoring.json — so a first visit walked the whole sheet, landed on the card, and
 * got a scoring-period plan with no tonight in it. The app's one conversion sentence,
 * structurally unanswerable by the only route a stranger has.
 *
 * It cannot be read off a preset, because it is not a fact about a platform: Yahoo hosts
 * both kinds. It is one tap and only the reader has it, so it is asked. What is asserted
 * here is the whole chain, because any link alone would pass on a screen that still
 * cannot answer: the question is on the sheet, the answer reaches the league with a
 * source naming who said it, and the card that follows HAS a Today section.
 */
/*
 * AND IT IS REACHABLE. The button that ends setup is `position:sticky;bottom:0` once a
 * league exists, and it used to pin from that moment — on top of the two chip questions
 * that come AFTER it in the document. Measured on this build at 390x844: the button at
 * y=701, "How many teams" at 757, "Can you change your lineup every day?" at 894, fifty
 * pixels past the bottom of the screen. The natural gesture is to press the big button
 * you can see, and it skipped the question.
 *
 * It pins only once the questions are answered now, so this asserts the ORDER rather than
 * any particular pixel: everything the sheet still wants sits above the way out of it.
 */
const layout = await p.evaluate(() => ({
  exit: Math.round(document.querySelector(".onboard-done").getBoundingClientRect().top),
  questions: [...document.querySelectorAll(".onboard-teams h3")].map(e => [
    e.textContent.trim().slice(0, 30),
    Math.round(e.getBoundingClientRect().top)
  ])
}))
t("and every question it still wants sits above the button that ends it",
  layout.questions.length === 2 && layout.questions.every(([, y]) => y < layout.exit),
  `exit at ${layout.exit}, ${layout.questions.map(([t2, y]) => `${t2} at ${y}`).join(", ")}`)

t("the sheet asks the one thing a preset cannot know about tonight",
  /change your lineup every day/i.test(await p.$eval(".onboard", e => e.innerText)),
  (await p.$$eval(".onboard-teams h3", n => n.map(e => e.textContent.trim()))).join(" | "))
await p.click('.onboard-teams .chip-btn:text-is("Yes, every day")')
await p.waitForTimeout(500)
t("and the answer is stored as his, with the source saying so",
  await p.evaluate(() => {
    const c = JSON.parse(localStorage.getItem("beanemachine:config"))
    const sp = c.leagues[c.active_league].scoring_period
    return sp?.lineup_lock === "daily" && /you said/i.test(sp?.source ?? "")
  }),
  await p.evaluate(() => {
    const c = JSON.parse(localStorage.getItem("beanemachine:config"))
    return JSON.stringify(c.leagues[c.active_league].scoring_period)
  }))

// The way out of the sheet says what he is getting, and it says it differently once he
// has a team: "Show me the board" is a place, "Show me tonight" is an answer. It used
// to read "Done" either way.
t("and the way out names what the answer bought him",
  /show me tonight/i.test(await p.$eval(".onboard-done button", e => e.innerText)),
  await p.$eval(".onboard-done button", e => e.innerText))
await p.click(".onboard-done button")
// Finishing lands on Tonight (src/client/App.tsx `onDone`), so the thing to wait for is
// the Decide card, not a board row.
await p.waitForSelector(".decide", { timeout: 25000 })
// And the whole point of having typed it: the screen he lands on is about HIS men. It
// used to be `.decide-blocked`, naming the roster it did not have, because the button
// that was supposed to store one did nothing.
t("and the screen it lands on is about his own team rather than asking for one",
  (await p.$$eval(".decide-blocked", n => n.length)) === 0,
  await p.$eval(".decide", e => e.innerText.replace(/\s+/g, " ").slice(0, 160)))
/* And it answers the question the bar asked him in for, rather than a different one.
   The claim is that a Today section EXISTS and counts his men — not what it says about
   the schedule, because tonight's card is a live read of statsapi.mlb.com and a machine
   with no network still has to get a correct answer here. The card itself says which of
   the two it is working from, which is asserted in test/decide.mjs. */
const card = await p.$eval(".decide", e => e.innerText.replace(/\s+/g, " "))
t("and it really does tell him who to start tonight, which is what the bar promised",
  /\bToday\b/.test(card) && /of your men can score/i.test(card), card.slice(0, 220))
// `#tpl` — "Start a league from" — lives in the management toolbar, which used to be
// on the League setup tab and is now on SETUP, the third screen. This was
// `nth-child(2)`, which is Wire, where no toolbar renders at all.
await go("My league")
await p.waitForSelector("#tpl", { timeout: 15000 })
t("the picker offers no Sleeper league type on the hosted build either",
  !(await p.$$eval("#tpl option", n => n.map(e => `${e.value}${e.textContent}`).join(" "))).match(/sleeper/i),
  await p.$$eval("#tpl option", n => n.map(e => e.textContent).join(" | ")))
// and the board, which is what a preset is FOR, is on Wire — `nth-child(1)` was the
// tab that used to carry it and is now the Decide card alone.
await go("Pickups")
t("a Yahoo preset ranks a full board with no server and no import",
  (await p.$$eval(".board-row", n => n.length)) > 50,
  String(await p.$$eval(".board-row", n => n.length)))
const presetNote = await p.locator(".preset-note").first().textContent()
/* Same claim, the sentence now also says where they DID come from. "not read from your
   league" left a reader to assume they were Yahoo's defaults, which they are not: the
   preset is league 228947's settings page copied, paying 10.4 for a home run against
   Yahoo's own default of 4. */
t("and the page says those values were not read from the visitor's league",
  /not read from yours|not read from your league/i.test(presetNote) &&
    /one real Yahoo league/i.test(presetNote),
  presetNote.slice(0, 160))
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
  await go("Pickups")
  await p.click('.modes .mode:has-text("Streaming")')
  await p.waitForTimeout(400)
  return p.$$eval(".board-row .who b", els => els.map(e => e.textContent.trim()))
    .then(names => names.slice(0, n))
}
const estimated = await streamHead()
t("the streaming tab ranks somebody before any free-agent list is carried",
  estimated.length === 6, estimated.join(", "))
/* Nothing is carried yet, so the masthead has to say so — and say it as the way to fix
   it, on every tab, rather than as a disabled checkbox three controls down.

   The words and the destination both changed and the claim did not. It read "none
   carried — load a file" and opened a file picker, which is the route for somebody who
   has run this project's command line on a desktop — nobody arriving at the published
   build. To a reader with no file that is a dead end wearing a button, and "a file" is
   the app talking about itself. It now says the availability is an estimate and goes to
   the screen holding the paste control every reader can use. Asserted on the words a
   reader reads rather than on the class alone, because the class survived the old
   wording and would have survived a dead end too. */
t("with no pool carried, the masthead says so and offers the way to get one",
  (await p.locator('[data-wire="none"]').isVisible()) &&
    /estimated/i.test(await p.locator('[data-wire="none"]').textContent()) &&
    !/\bfile\b/i.test(await p.locator('[data-wire="none"]').textContent()),
  await p.locator(".wrap > .chips").textContent())
// and pressing it lands somewhere a reader can actually act
await p.locator('[data-wire="none"]').click()
await p.waitForSelector(".trade-team", { timeout: 20000 })
t("and pressing it reaches the screen that takes your league's own free-agent list",
  /paste your free agents/i.test(await p.textContent("main")),
  (await p.textContent("main")).replace(/\s+/g, " ").slice(0, 160))
await go("Pickups")
await p.waitForSelector(".board-row", { timeout: 20000 })

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
await go("Pickups")
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
await go("My league")
await p.click('.bar [data-ctl="onboard"]')
await p.waitForSelector(".onboard", { timeout: 15000 })
t("a reader who has a league can ask for the setup back, and gets it already open",
  await p.locator(".dock.on .dock-sheet .onboard").isVisible())
t("and the button that opened it now offers to close it, so it is not a one-way door",
  /^Close$/.test((await p.$eval(".dock-bar button", e => e.textContent.trim()))),
  await p.$eval(".dock-bar button", e => e.textContent))
await p.keyboard.press("Escape")
await p.waitForSelector(".onboard", { state: "detached", timeout: 10000 })
/*
 * Escape takes the whole dock away here, and gives the toolbar back.
 *
 * This required the bar to survive, on the reasoning that it was the only handle
 * left — which was true and was the bug. A reader who HAS a league and has just
 * looked at the setup should get his ordinary chrome back rather than a bar across
 * the foot of every screen until he reloads; the bar is for somebody with no league.
 * The property that matters is unchanged and is now stated as what it always was: at
 * any moment there is exactly one way in, and never none.
 */
t("and Escape closes the sheet, leaving exactly one way back — the toolbar",
  (await p.$$eval(".onboard", n => n.length)) === 0 &&
    (await p.$$eval(".dock-bar", n => n.length)) === 0 &&
    (await p.$$eval('.bar [data-ctl="onboard"]', n => n.length)) === 1,
  `${await p.$$eval(".dock-bar", n => n.length)} bars, ${await p.$$eval('.bar [data-ctl="onboard"]', n => n.length)} buttons`)

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


/**
 * ONE THUMB, at 390x844, on the build that actually ships.
 *
 * Nothing in this repo checked a touch target, and the CSS that was supposed to
 * guarantee them had been dead for as long as it had existed: `@media(max-width:640px)`
 * set `min-height:44px` on the tabs, the chips and every button, and an unconditional
 * `button,summary,.chip-btn,.views button,.modes .mode{min-height:32px}` sat eighty
 * lines LATER in the same stylesheet at the same specificity. A media query adds no
 * specificity, so the 32px rule won at 390px and the phone block was decoration under a
 * comment claiming it had fixed something — the comment even quoted the count it was
 * supposed to have ended ("30 of 94 were under 44x44").
 *
 * Measured before the reorder: 26 of 91 distinct visible controls under 44x44 across the
 * three screens — every navigation tab (82.7x35), every horizon tab, all eleven position
 * chips (the "C" chip 35 wide), both sort headers, "why him" (54x18) and the three
 * footer links (17px tall). After: 0 of 88 on Pickups, 0 of 10 on Tonight, 0 of 8 on My
 * league.
 *
 * The assertion is the COUNT rather than the stylesheet, because the stylesheet was
 * correct the whole time and the cascade was not.
 */
{
  const ctx = await b.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true
  })
  const page = await ctx.newPage()
  await page.goto(BASE, { waitUntil: "domcontentloaded" })
  await page.waitForSelector(".board-row", { timeout: 30000 })
  /* `checkVisibility` rather than a bounding box alone: an earlier pass counted the
     contents of shut <details> as visible, which made the number meaningless in the
     flattering direction. Deduped by tag+class+label so one list of 120 rows does not
     drown the controls. */
  const targets = () =>
    page.evaluate(() => {
      const seen = new Map()
      for (const e of document.querySelectorAll("button,summary,a,input,select,[role=button]")) {
        if (!e.checkVisibility?.({ contentVisibilityAuto: true })) continue
        const r = e.getBoundingClientRect()
        if (!r.width || !r.height) continue
        const key = `${e.tagName}.${e.className}|${(e.textContent ?? "").trim().slice(0, 22)}`
        if (!seen.has(key)) seen.set(key, { key, w: Math.round(r.width), h: Math.round(r.height) })
      }
      return [...seen.values()]
    })
  for (const label of ["Pickups", "Tonight", "My league"]) {
    if (label !== "Pickups") {
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.click(`.views button:text-is("${label}")`)
      await page.waitForTimeout(900)
    }
    const all = await targets()
    const under = all.filter(c => c.w < 44 || c.h < 44)
    t(`every control on ${label} is at least 44x44 under one thumb`,
      all.length > 0 && under.length === 0,
      `${under.length} of ${all.length}: ${under.map(c => `${c.w}x${c.h} ${c.key}`).slice(0, 6).join(" | ")}`)
  }

  /*
   * And the sort headings are reachable once the list has been scrolled.
   *
   * `.views` pins at top 0 with z-index 30 and `.board-head` pinned at top 0 with
   * z-index 2, so the column headings were painted UNDERNEATH the tab strip. Measured at
   * scrollY 1200: `document.elementFromPoint` at the centre of the "ahead by" heading
   * returned the "My league" tab, and a real tap there switched screens and threw away
   * the scroll position — the gesture that should reorder the list left the list. The
   * headings also simply vanished, so every number beside a name was unlabelled for the
   * whole rest of the board.
   */
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.click('.views button:text-is("Pickups")')
  await page.waitForSelector(".board-row")
  await page.evaluate(() => window.scrollTo(0, 1200))
  await page.waitForTimeout(400)
  const stuck = await page.evaluate(() => {
    const head = document.querySelector(".board-head [data-col=bscore]")
    const r = head?.getBoundingClientRect()
    if (!r) return { hit: "no heading rendered", navBottom: null, headTop: null }
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    const nav = document.querySelector("nav.views")?.getBoundingClientRect()
    return {
      hit: at ? `${at.tagName}.${at.className}` : "nothing",
      navBottom: nav ? Math.round(nav.bottom) : null,
      headTop: Math.round(r.top)
    }
  })
  t("a scrolled board still shows its headings, and a tap on one reaches the heading",
    /sort-head/.test(stuck.hit), JSON.stringify(stuck))
  t("and they sit below the tab strip rather than under it",
    stuck.navBottom !== null && stuck.headTop >= stuck.navBottom - 1, JSON.stringify(stuck))
  await page.close()
}

/**
 * WHAT THE READER TYPED SURVIVES THE SHEET CLOSING.
 *
 * The sheet was `{open && <div>…</div>}`, so closing it unmounted everything inside and
 * React discarded the state with it. Measured: eighteen lines typed, press Close, reopen —
 * an empty box. On a phone that is two minutes of typing gone to the gesture people use to
 * dismiss a keyboard.
 *
 * Back itself still leaves the site, and that is a known defect rather than an oversight —
 * see the long note in src/client/Dock.tsx for the shape that does not work and why. This
 * asserts the half that is fixed, which is the half that cost the typing.
 */
{
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await p.goto(BASE, { waitUntil: "domcontentloaded" })
  await p.waitForSelector(".board-row", { timeout: 30000 })
  await p.click(".dock-bar button")
  await p.waitForSelector("[data-ctl=onboard-team]")
  const typed = "OF Aaron Judge\nSP Tarik Skubal\nC Cal Raleigh"
  await p.fill("[data-ctl=onboard-team]", typed)
  await p.waitForTimeout(200)
  await p.click(".dock-bar button")
  await p.waitForTimeout(300)
  t("closing the sheet hides it rather than throwing it away",
    await p.evaluate(() => document.querySelector(".dock-sheet")?.hidden === true),
    String(await p.evaluate(() => document.querySelector(".dock-sheet")?.hidden)))
  await p.click(".dock-bar button")
  await p.waitForTimeout(300)
  t("and what he had typed is still in the box when he comes back to it",
    (await p.inputValue("[data-ctl=onboard-team]")) === typed,
    JSON.stringify(await p.inputValue("[data-ctl=onboard-team]")))
  await p.close()
}

await b.close()
console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
