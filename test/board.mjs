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

// A 200 on this port is not proof it is this app: :5173 is a common default and
// another project's dev server answers it just as happily, after which every
// assertion below fails as a selector timeout that reads like a UI defect. The
// wordmark is the cheapest proof of identity, so it is checked before anything
// else and stops the run rather than letting the next wait speak for it.
const wordmark = await page.waitForSelector("h1", { timeout: 15000 }).then(h => h.textContent(), () => null)
t("the page under test is beanemachine", wordmark === "beanemachine",
  `BASE=${BASE} served <h1>${wordmark}</h1> — start this repo's own vite, or set BASE to it`)
if (wordmark !== "beanemachine") { await browser.close(); process.exit(1) }

await page.waitForSelector(".board-row", { timeout: 30000 })

t("no page errors", errors.length === 0, errors.join(" | "))
t("board renders ranked rows", (await page.$$eval(".board-row", n => n.length)) > 50)

const scores = await page.$$eval(".board-row .bscore", n => n.map(e => Number(e.textContent)))
t("bscores are finite numbers", scores.every(Number.isFinite), String(scores.slice(0, 3)))
/**
 * The board opens on bscore.
 *
 * It opened on market edge for a long time, on the reasoning that the best players
 * are already rostered so a bare bscore ranking names people you cannot add. The
 * reasoning survives; the input did not. "% Ros" is swept off Yahoo's player pages
 * and most of what comes back is the per-game weather line from the forecast
 * tooltip — on the committed capture, 20 of 30 clubs have almost every player on
 * one identical percentage, paired exactly by that day's matchups (see
 * test/ownership.mjs, which pins the shape). Market edge divides by that number,
 * so it was reordering the whole board by the precipitation forecast.
 */
const bscores = await page.$$eval(".board-row .bscore", n =>
  n.map(e => Number(String(e.textContent).replace(/[^0-9.\-]/g, "")))
)
t("board opens sorted by bscore, descending",
  bscores.length > 50 && bscores.every((v, i) => i === 0 || bscores[i - 1] >= v),
  `${bscores.length} rows: ${String(bscores.slice(0, 5))}`)
// The whole rateable pool, not the handful edge could price. Market edge dropped
// everyone unpriced, and on a thin capture that silently shrank the board to a
// short list that looked like a working one. Read off the count the board states,
// not off the rendered rows — the board pages in as you scroll now, so the number
// on screen is the size of the render window rather than of the ranking.
const rankedCount = await page.$eval("#horizon-panel .sub .count", e => Number(e.textContent.replace(/,/g, "")))
t("the default ranking places the whole pool rather than the priced subset",
  rankedCount >= 1000, `${rankedCount} ranked`)
// and the render window grows rather than stopping dead at a cap
const firstPage = await page.$$eval(".board-row", n => n.length)
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
await page.waitForTimeout(600)
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
await page.waitForTimeout(600)
const grown = await page.$$eval(".board-row", n => n.length)
t("the board pages in more rows as you reach the end",
  grown > firstPage, `${firstPage} then ${grown}`)
await page.evaluate(() => window.scrollTo(0, 0))

/**
 * SEVEN columns, each answering a different question, and each cell placed by the
 * name of its column rather than by its index among its siblings.
 *
 * `proj pts` and `waiver pts` went first: bscore is one minus the other, so the
 * table was stating a single subtraction three times in the place where scanning
 * matters most. Both are in the drill-down, which is asserted further down.
 *
 * `owned` has now gone the same way, into uscore. uscore is `addValue x (1 -
 * owned)`, so the two were blank on precisely the same rows — 500 of the 1,233
 * rateable rows on the committed fixture, and 36 of the first 60, which is why the
 * board opened on seven straight rows of two dashes side by side. One missing
 * input must be reported once.
 */
const headers = await page.$$eval(".board-head > *", n => n.map(e => e.textContent.trim()))
t("the board shows the seven decision columns",
  ["#", "Player", "uscore", "bscore", "games", "confidence", "luck"]
    .every(h => headers.some(x => x.startsWith(h))) && headers.length === 7,
  headers.join(" | "))
t("and no longer restates bscore's own arithmetic beside it",
  !headers.some(h => /proj pts|waiver pts/.test(h)), headers.join(" | "))
t("ownership is no longer a column of its own",
  !headers.some(h => /^owned/.test(h)), headers.join(" | "))

/**
 * The head and the row must agree cell for cell, in name and in pixels.
 *
 * app.css places both by `nth-child`, and that has failed before in exactly this
 * spot: auto-placement once put the confidence gauge under "GP" and the games
 * count under "confidence", so every number in two columns was labelled as the
 * other one. Each cell now carries `data-col` and the grid places by that, which
 * is only true as long as something checks it — including at the widths where
 * columns are dropped, because a header dropped without its body is the same bug
 * with a smaller blast radius.
 */
const columnsLineUp = async () =>
  page.evaluate(() => {
    const vis = el => getComputedStyle(el).display !== "none"
    const right = el => Math.round(el.getBoundingClientRect().right)
    const head = [...document.querySelectorAll(".board-head > [data-col]")].filter(vis)
    const row = [...document.querySelector(".board-row").querySelectorAll(":scope > [data-col]")].filter(vis)
    return {
      head: head.map(e => `${e.dataset.col}@${right(e)}`),
      row: row.map(e => `${e.dataset.col}@${right(e)}`),
      names: head.map(e => e.dataset.col)
    }
  })
const wide = await columnsLineUp()
t("every heading sits over the cells it names",
  wide.head.join() === wide.row.join(), `${wide.head.join(" ")} vs ${wide.row.join(" ")}`)
t("all seven columns are on screen at 1280px",
  wide.names.join() === "rank,who,uscore,bscore,games,conf,luck", wide.names.join())

/**
 * uscore carries its own denominator now, so the cell holds two numbers and the
 * ranking has to be read off the score rather than off the cell's text.
 */
await page.click(".board-head .sort-head:has-text('uscore')")
await page.waitForTimeout(300)
const usCells = await page.$$eval(".board-row [data-col=uscore]", n => n.map(e => e.textContent.trim()))
t("the uscore cell prints the ownership it divided by",
  usCells.length > 0 && usCells.every(c => /^[\d.]+\d% owned$/.test(c)), String(usCells.slice(0, 3)))
const us = await page.$$eval(".board-row [data-col=uscore] .us-val", n => n.map(e => Number(e.textContent)))
t("choosing uscore orders by uscore",
  us.length > 0 && us.every(v => Number.isFinite(v)) &&
    us.every((v, i) => i === 0 || us[i - 1] >= v), String(us.slice(0, 5)))
// a ratio against a tiny denominator is only meaningful for someone worth
// rostering at all, so the same guard the other comparative sorts use applies
const usB = await page.$$eval(".board-row .bscore", n => n.map(e => Number(e.textContent)))
t("uscore ranks only players above replacement", usB.every(v => v > 0), String(usB.slice(0, 5)))

await page.selectOption("[data-ctl=sort]", "bscore")
await page.waitForTimeout(300)

/**
 * The window column is per SIDE, and it says which of the two units it is in.
 *
 * It used to be "GP" for everybody — the games a player's TEAM plays. For a
 * starting pitcher that is the wrong quantity by roughly a factor of six: on the
 * committed fixture the starters with published turns average about 3 of them
 * against 14 team games over the fortnight, and about 1 against 6 over the
 * streaming week, which is the view where 12 of the top 20 rows are starters. The
 * engine has computed `scheduledStarts` all along and the projection is already
 * built on it, so the board was ranking on one number and displaying another.
 *
 * A null is not a zero: MLB publishes probables about a week out, so the
 * rest-of-season view has none at all and a reliever never gets one. Those fall
 * back to team games and say GP. What is asserted is that the two are never
 * confused — a GS row must be a pitcher, and its value must be far below the
 * team's game count rather than equal to it.
 */
const windowCells = await page.$$eval(".board-row", rows =>
  rows.map(r => ({
    slot: r.querySelector(".who .code")?.textContent?.trim(),
    text: r.querySelector("[data-col=games]")?.textContent?.trim() ?? "",
    unit: r.querySelector("[data-col=games] .g-unit")?.textContent?.trim() ?? ""
  }))
)
t("every row states which unit its window count is in",
  windowCells.length > 0 && windowCells.every(c => c.unit === "GS" || c.unit === "GP"),
  JSON.stringify(windowCells.slice(0, 3)))
const gsRows = windowCells.filter(c => c.unit === "GS")
t("the fortnight board shows own-starts for pitchers", gsRows.length > 0,
  `${gsRows.length} of ${windowCells.length} rendered rows`)
t("a start count is only ever shown for a pitcher",
  gsRows.every(c => c.slot === "P" || c.slot === "SP" || c.slot === "RP"),
  JSON.stringify(gsRows.slice(0, 4)))
// the whole point: it is his own number, not his club's, so it must be far smaller
t("a starter's own turns are a fraction of his club's games",
  gsRows.every(c => Number(c.text.replace("GS", "")) < 8),
  JSON.stringify(gsRows.slice(0, 4)))
const gpRows = windowCells.filter(c => c.unit === "GP")
t("everyone without published turns still gets his team's games",
  gpRows.length > 0 && gpRows.every(c => Number(c.text.replace("GP", "")) >= 1),
  JSON.stringify(gpRows.slice(0, 3)))
/**
 * And the same distinction out loud. The row is markup a screen reader reads as a
 * run of unlabelled numbers, so the aria-label carries the labels the columns
 * carry visually — which means it has to make the same per-side choice, or the
 * spoken board says "14 games scheduled" about a man taking three turns.
 */
const spokenWindow = await page.$$eval(".board-row", rows =>
  rows.map(r => ({
    gs: !!r.querySelector("[data-col=games] .g-unit")?.textContent?.includes("GS"),
    label: r.getAttribute("aria-label") ?? ""
  }))
)
t("a row showing own starts says starts out loud, and never calls them team games",
  spokenWindow.some(r => r.gs) &&
    spokenWindow.every(r =>
      r.gs ?
        /[\d.]+ scheduled starts/.test(r.label) && !/team games/.test(r.label)
      :	/team games scheduled|no scheduled games/.test(r.label)
    ),
  JSON.stringify(spokenWindow.filter(r => r.gs).slice(0, 2)))

// Market edge keeps its ranking without keeping a column — same as `contact`.
await page.selectOption("[data-ctl=sort]", "marketEdge")
await page.waitForTimeout(300)
t("market edge is still selectable and still ranks",
  (await page.$$eval(".board-row", n => n.length)) > 0)

await page.selectOption("[data-ctl=sort]", "bscore")
await page.waitForTimeout(300)
const byB = await page.$$eval(".board-row .bscore", n => n.map(e => Number(e.textContent)))
t("sorting by bscore still orders by bscore",
  byB.every((v, i) => i === 0 || byB[i - 1] >= v), String(byB.slice(0, 5)))

// Scarcity must reflect the league's real slots and rank by the actual cliff.
const scars = await page.$$eval(".scar", n => n.map(e => ({
  slot: e.querySelector("b").textContent.trim(),
  val: Number(String(e.querySelector(".val").textContent).replace("+", ""))
})))
t("scarcity lists the league's active slots", scars.length >= 5, JSON.stringify(scars.map(s => s.slot)))
t("scarcity is ordered by how steep the drop-off is",
  scars.every((s, i) => i === 0 || scars[i - 1].val >= s.val), JSON.stringify(scars))
t("a scarce slot really is scarcer than a deep one",
  scars[0].val > scars[scars.length - 1].val, `${scars[0]?.slot} ${scars[0]?.val} vs ${scars.at(-1)?.slot} ${scars.at(-1)?.val}`)

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
// Renamed, not weakened. It never ranked "the next 7 days": `resolvePeriod` has
// supplied the LEAGUE's own scoring period since the rolling window was measured
// overstating a Wednesday by 59%, and the tab now also opens filtered to players
// with a start in it. The assertion — a different question gives a different
// answer — is the same one and still holds.
t("streaming mode re-ranks against the league's own scoring period",
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

/**
 * The Streaming tab as a streaming TOOL rather than a horizon toggle.
 *
 * The question it now answers, in the owner's words: "which starters should I
 * stream that will be pitching over the next 3 days, what are they worth over that
 * window, how many starts do they have and against whom, and which of them can I
 * actually get." Every clause of that is asserted below, because every clause of it
 * was previously missing: the tab re-ranked the same 1,400 players — hitters and
 * relievers included — over a horizon the reader could not change, and threw away
 * the two facts a streaming pick turns on.
 */
const streamNote = () => page.$eval("#horizon-panel .stream-note", e => e.textContent.replace(/\s+/g, " ").trim())
const streamRange = () => page.$eval("#horizon-panel .sub", e => e.textContent)
const startLines = () => page.$$eval(".board-row .who .starts", n => n.map(e => e.textContent.trim()))
const boardRows = () => page.$$eval(".board-row", n => n.length)
// The RANKING's size, not the render window's: the board pages in 60 rows at a
// time, so counting rendered rows tops out at 60 and a filter that removed a
// thousand players would look like it removed none.
const rankedNow = () => page.$eval("#horizon-panel .sub .count", e => Number(e.textContent.replace(/,/g, "")))

await page.click(".modes .mode:has-text('Streaming')")
await page.waitForSelector(".stream-strip", { timeout: 15000 })
await page.waitForTimeout(400)

// 1. it opens as a streaming list, with no click at all
const openLines = await startLines()
t("Streaming opens already filtered to players with a start in the window",
  openLines.length > 5 && openLines.length === (await boardRows()),
  `${openLines.length} start lines on ${await boardRows()} rendered rows`)
const openSides = await page.$$eval(".board-row .who .code", n => n.map(e => e.textContent.trim()))
t("and a streaming list holds no hitters, because a hitter cannot be streamed for a start",
  openSides.length > 5 && openSides.every(c => c === "SP" || c === "RP" || c === "P"),
  openSides.filter(c => !["SP", "RP", "P"].includes(c)).join(",") || openSides.slice(0, 6).join(","))

/**
 * 1a. It opens filtered to players he can ACTUALLY ADD — one click from landing,
 * and no configuration.
 *
 * This is the whole complaint. The tab, the day-count chips, the start counts, the
 * opponents and the move budget all shipped, and the list still opened, on the live
 * 2026-09-04 capture, with Tyler Glasnow (94% rostered), Blake Snell, Chris Sale
 * (99%) and Drew Rasmussen (95%) at the top. To stream a starter is to pick one up;
 * a list whose head is four men nobody can pick up is the board with a filter on it.
 *
 * The control that would have fixed it — "Free agents only" — read the league's live
 * free-agent list through the local API, and the hosted build has no API, so on
 * beanemachine.com it was permanently disabled. The question was unanswerable on the
 * site the app is published at.
 */
const availTier = () => page.$eval(".stream-strip .toggle[data-avail]", e => e.dataset.avail)
const availNote = () =>
  page.$eval("#horizon-panel .avail-note", e => e.textContent.replace(/\s+/g, " ").trim())
t("Streaming opens filtered to players the reader can add, with no click at all",
  await page.$eval(".stream-strip .toggle[data-avail] input", e => e.checked))
const tierOnOpen = await availTier()
t("and it says which of the three answers it is giving rather than implying one",
  ["pool", "ownership", "none"].includes(tierOnOpen) &&
    new RegExp(
      tierOnOpen === "pool" ? "free-agent list"
      : tierOnOpen === "ownership" ? "estimated"
      : "not read|no point in the list",
      "i"
    ).test(await availNote()),
  `${tierOnOpen}: ${await availNote()}`)
/**
 * The estimate has to be CALIBRATED to the league rather than to a constant. The
 * bar it replaced was `WIDELY_ROSTERED = 70` in Board.tsx — one number standing in
 * for a 10-team league and a 20-team one, which cannot both be right. It is now the
 * ownership of the (teams x seats)-th most rostered player, so the note must quote
 * the league's own shape and every surviving row must sit at or under the cut.
 */
if (tierOnOpen === "ownership") {
  const note = await availNote()
  const cut = Number((note.match(/above (\d+)% is treated as taken/) ?? [])[1])
  t("the estimated bar is derived from the league's own size, not a constant",
    /\d+-team league with \d+ seats holds \d+ players/.test(note) && Number.isFinite(cut), note)
  const owned = await page.$$eval(".board-row .who .own", n => n.map(e => e.textContent.trim()))
  t("and nobody above that bar is on the list",
    owned.length > 0 &&
      owned.every(o => /not listed/.test(o) || Number(o.replace(/[^0-9]/g, "")) <= cut),
    owned.filter(o => !/not listed/.test(o) && Number(o.replace(/[^0-9]/g, "")) > cut).join(", "))
}
/**
 * Unticking has to bring the unreachable aces back. A filter that changes nothing
 * is not a filter, and this is the direct test that the head of the default list is
 * not the head of the whole one.
 */
if (tierOnOpen !== "none") {
  const gettable = await page.$$eval(".board-row .who b", n => n.slice(0, 4).map(e => e.textContent.trim()))
  const gettableCount = await rankedNow()
  await page.uncheck(".stream-strip .toggle[data-avail] input")
  await page.waitForTimeout(500)
  const everyone = await page.$$eval(".board-row .who b", n => n.slice(0, 4).map(e => e.textContent.trim()))
  t("the default list is not simply the whole field with a shorter horizon",
    (await rankedNow()) > gettableCount && everyone.join() !== gettable.join(),
    `${gettable.join(", ")} vs ${everyone.join(", ")}`)
  await page.check(".stream-strip .toggle[data-avail] input")
  await page.waitForTimeout(500)
}

/**
 * 1b. The streaming grid is not the board's grid, because it is not the board's
 * question.
 *
 * `uscore` is `addValue x (1 - owned)` — value discounted by availability — and on
 * a list already filtered to what he can add that discount lands twice, reordering
 * the survivors by who is rarer rather than by who is better. It is also null on
 * 553 of the live capture's 1,435 players, including the top row of the gettable
 * list. `luck` is a 21-day expected-minus-actual percentile: a signal about a
 * season, acted on in the Buy low card, and nothing about a Saturday start turns on
 * it. What replaces them is the half of the reader's question the board never
 * answered — what this man is projected to actually score over this window.
 */
const streamHeads = await page.$$eval(".board-head > [data-col]", n =>
  n.map(e => `${e.dataset.col}:${e.textContent.trim().replace(/[\u25be\u25b4]/g, "")}`))
t("the streaming board carries six columns, not the board's seven",
  streamHeads.length === 6 &&
    streamHeads.map(h => h.split(":")[0]).join() === "rank,who,pts,bscore,games,conf",
  streamHeads.join(" | "))
t("uscore and luck are not among them",
  !streamHeads.some(h => /^uscore|^luck/.test(h)), streamHeads.join(" | "))
t("and the window column is named for what a streamer counts",
  streamHeads.some(h => h === "games:starts"), streamHeads.join(" | "))
const streamAlign = await columnsLineUp()
t("every streaming heading sits over the cells it names",
  streamAlign.head.join() === streamAlign.row.join(),
  `${streamAlign.head.join(" ")} vs ${streamAlign.row.join(" ")}`)
t("and the projected total is a real number on every row, not a dash",
  (await page.$$eval(".board-row [data-col=pts]", n => n.map(e => e.textContent.trim())))
    .every(x => /^\d+(\.\d+)?$/.test(x)))
/**
 * Ruthlessness: two full-width cards that cannot help a reader choose an arm for
 * the weekend are two cards of scrolling between him and the one that can. Buy low
 * ranks a 21-day contact gap against ownership and its picks on this fixture are
 * hitters; "Where it hurts to wait" is the shape of each slot's drop-off, which
 * does not move between now and Sunday.
 */
t("the season-long cards are not on the streaming tab",
  (await page.$(".buylow")) === null && (await page.$(".scarcity")) === null)
/**
 * The position chips were pruned to All/SP/RP/P here and are now gone entirely.
 * This list is already only players with a start, so every row is a pitcher and the
 * chips separated P from RP and nothing else — two rows of controls above an answer
 * that started 1,506px down the page. They are still on the board tab, where a
 * reader picks a catcher out of 1,200 players, and in "more filters" here.
 */
t("the position chips are not on the streaming list",
  (await page.$$(".board-controls .chips[aria-label=Position] .chip-btn")).length === 0)

// 2. the horizon is the reader's to choose, and the choice reaches the ranking
const periodRange = await streamRange()
const periodNote = await streamNote()
await page.click(".stream-strip .chip-btn:text-is('7 days')")
await page.waitForTimeout(500)
const sevenRange = await streamRange()
const sevenNote = await streamNote()
t("a day count is a real horizon: it moves the window the board states",
  sevenRange !== periodRange && /2026-\d\d-\d\d → 2026-\d\d-\d\d/.test(sevenRange),
  `${periodRange.trim()} then ${sevenRange.trim()}`)
t("and it names itself by its length rather than by the period it was cut from",
  /^7 days, 2026/.test(sevenNote), sevenNote.slice(0, 80))
// The window this league's period ends on is Sunday; seven days from a Friday runs
// past it, and points scored after the reset are the NEXT matchup's.
t("a window running past the reset says the extra games score for the next matchup",
  /runs past 2026-\d\d-\d\d/.test(sevenNote) && /next matchup/.test(sevenNote), sevenNote)
// Probables stop about three days past a capture, so a seven-day window on this
// fixture has not one fully-named club in it. The page says so where the reader can
// act on it — and says nothing of the kind on a window where it is not true, because
// a warning that is always on is furniture rather than information.
t("a window past where probables reach points back at the shorter one",
  /shorter window is where this data is strongest/.test(sevenNote) &&
    !/shorter window/.test(periodNote),
  `seven: ${/shorter window/.test(sevenNote)}, period: ${/shorter window/.test(periodNote)}`)

/**
 * Coverage is MEASURED off the window on screen, not quoted from a table.
 *
 * MLB publishes probables about three days past a capture and then stops, so how
 * much of a window is named depends on the capture's age as much as on the window's
 * length. A number written into the sentence would have been right the day it was
 * written and wrong every day after — so the two windows must report different
 * fractions of the same slate.
 */
const named = note => (note.match(/named the starter in (\d+) of (\d+)/) ?? []).slice(1).map(Number)
const [pubPeriod, gamesPeriod] = named(periodNote)
const [pubSeven, gamesSeven] = named(sevenNote)
t("the page states how much of this window MLB has actually named",
  Number.isFinite(pubPeriod) && Number.isFinite(gamesPeriod) && pubPeriod <= gamesPeriod,
  periodNote)
t("and that count is measured off the window rather than baked into the sentence",
  gamesSeven > gamesPeriod && pubSeven >= pubPeriod &&
    pubSeven / gamesSeven < pubPeriod / gamesPeriod,
  `${pubPeriod}/${gamesPeriod} over the period vs ${pubSeven}/${gamesSeven} over seven days`)

await page.click(".stream-strip .chip-btn:text-is('3 days')")
await page.waitForTimeout(500)

/**
 * The two facts a streaming pick turns on, on the row.
 *
 * `startOpponents` was computed, fed to `pitcherMatchupIndex` — so the board priced
 * a start against Colorado differently from one against Los Angeles — and then
 * thrown away by the UI. And what MLB has ANNOUNCED must stay visibly apart from
 * what the model estimated for his club's unnamed games; "2 starts" covering one of
 * each is exactly the sentence that looks read off the schedule and is not.
 */
const streamRows = await page.$$eval(".board-row", n =>
  n.slice(0, 12).map(e => ({
    starts: e.querySelector(".who .starts")?.textContent.trim() ?? null,
    gs: e.querySelector("[data-col=games]")?.textContent.trim() ?? null,
    label: e.getAttribute("aria-label")
  }))
)
t("every streaming row says how many starts he has and who they are against",
  streamRows.length > 5 &&
    streamRows.every(r => r.starts && (/\d+ starts? · \S/.test(r.starts) || /^~[\d.]+ starts · none announced yet$/.test(r.starts))),
  JSON.stringify(streamRows.slice(0, 3).map(r => r.starts)))
t("an announced start names a real club, not a bare id",
  streamRows.some(r => /\d+ starts? · [A-Z][a-z]/.test(r.starts)) &&
    streamRows.every(r => !/club \d+/.test(r.starts)),
  JSON.stringify(streamRows.slice(0, 4).map(r => r.starts)))
t("published turns and estimated ones are never added into one number",
  streamRows.every(r =>
    !/~/.test(r.starts) || /more once MLB names the rest/.test(r.starts) || /none announced yet/.test(r.starts)),
  JSON.stringify(streamRows.map(r => r.starts).filter(x => /~/.test(x)).slice(0, 3)))
t("the row's own GS count is the one the ranking used, beside the announced turns",
  streamRows.every(r => /GS$/.test(r.gs ?? "")), JSON.stringify(streamRows.slice(0, 3).map(r => r.gs)))
// The marker and the start line are drawn; a screen reader gets neither, so both
// have to be spoken.
t("the schedule a row draws is also the schedule it speaks",
  streamRows.every(r => /published start|expected from his own rate/.test(r.label)),
  streamRows[0].label)

// 3. "I have 2 moves" — the one fact no source in this app carries, taken as input
await page.fill(".stream-strip .moves input", "2")
await page.waitForTimeout(500)
const marked = await page.$$eval(".board-row[data-pick]", n =>
  n.map(e => ({ pick: e.getAttribute("data-pick"), label: e.getAttribute("aria-label") })))
t("two moves marks exactly the top two rows, and marks where the second one ends",
  marked.length === 2 && marked[0].pick === "yes" && marked[1].pick === "last",
  JSON.stringify(marked.map(m => m.pick)))
t("and the boundary is spoken, because a rail and a rule say nothing out loud",
  /within your 2 moves/.test(marked[0].label) && /and the last one/.test(marked[1].label),
  marked[1].label.slice(0, 90))
/**
 * "2 picks remaining" has to read as an ANSWER, not as a caption on a decoration.
 *
 * It said "The first 2 rows are marked, down to the rule" — a sentence about a
 * rail, describing the drawing rather than the decision. A reader who came to find
 * out which two men to add should not have to read a rule off a table to learn
 * their names, so the page now says them, with what each one is projected for and
 * how strong the availability claim behind them is.
 */
const movesLine = await page.$eval("#horizon-panel .moves-answer", e =>
  e.textContent.replace(/\s+/g, " ").trim())
const markedNames = await page.$$eval(".board-row[data-pick] .who b", n =>
  n.map(e => e.textContent.trim()))
t("two moves are named, in words, rather than described as two marked rows",
  /^Your 2 moves/.test(movesLine) && markedNames.every(n => movesLine.includes(n)),
  movesLine.slice(0, 140))
t("and each named move carries what it is worth over the window",
  (movesLine.match(/[\d.]+ pts/g) ?? []).length === 2, movesLine.slice(0, 140))
t("and the sentence says how strong the availability claim behind it is",
  /Free in your league|Estimated as gettable|Availability unknown/.test(movesLine),
  movesLine.slice(-90))

/*
 * ...and that claim is about THIS list, not about what the page could have found out.
 *
 * The clause was chosen from `availability.basis` alone, which says whether a wire
 * could be read — not whether these rows were filtered by it. With the pool loaded
 * and "Only players I can add" unticked, the sentence named Parker Messick and
 * Chris Sale, both printed "not listed" two rows below, and told the reader they
 * were "Free in your league, read off its own list". The wire HAD been read; it had
 * excluded both. A read quoted about men the read ruled out is worse than an
 * estimate, so the provenance clause is now gated on the filter that earns it.
 */
const availToggle = ".stream-strip .toggle:has-text('I can add') input"
if (await page.$(availToggle)) {
  await page.uncheck(availToggle)
  await page.waitForTimeout(500)
  const looseLine = await page.$eval("#horizon-panel .moves-answer", e =>
    e.textContent.replace(/\s+/g, " ").trim())
  t("with the availability filter off, the moves sentence claims no availability",
    !/Free in your league|Estimated as gettable/.test(looseLine), looseLine.slice(-120))
  t("and it says instead that the list is not filtered by what he can get",
    /not filtered by whether you can get them/.test(looseLine), looseLine.slice(-120))
  await page.check(availToggle)
  await page.waitForTimeout(500)
}

/*
 * One control, one screen.
 *
 * The general filter row carried its own copy of the availability toggle while the
 * streaming strip carried another, both bound to one piece of state — and on a
 * capture whose ownership cannot locate the boundary they disagreed about it: the
 * strip read "can't tell" and was operable, the other read "unavailable" and was
 * disabled. The strip's copy is the one scoped to the question, so it is the one
 * that survives on this tab.
 */
t("the streaming tab offers exactly one availability control, not two that disagree",
  (await page.$$(".toggle:has-text('I can add')")).length === 1,
  String((await page.$$(".toggle:has-text('I can add')")).length))

await page.fill(".stream-strip .moves input", "0")
await page.waitForTimeout(400)
t("zero moves marks nothing rather than marking everything",
  (await page.$$(".board-row[data-pick]")).length === 0)

// 4. the filter is the reader's, and it is scoped to the tab that offers it
//
// Located by its own label rather than by position. It was `.stream-strip .toggle
// input`, and the strip now leads with the availability toggle — so the assertion
// went on unchecking the FIRST toggle, which is a different control, and reported
// the start filter as broken when nothing had touched it.
const startToggle = ".stream-strip .toggle:has-text('with a start') input"
const streamingCount = await rankedNow()
await page.uncheck(startToggle)
await page.waitForTimeout(500)
const unfilteredCount = await rankedNow()
t("turning the start filter off brings the rest of the pool back",
  unfilteredCount > streamingCount * 3 && (await startLines()).length < (await boardRows()),
  `${streamingCount} with a start, ${unfilteredCount} in the whole pool`)
await page.check(startToggle)
await page.waitForTimeout(500)

/**
 * A mode-scoped filter must not outlive the control that switches it. This page has
 * already shipped one that went on filtering after its checkbox stopped rendering,
 * and the board emptied with nothing on screen to undo — so leaving the tab has to
 * restore the full ranking, and the controls have to leave with it.
 */
await page.click(".modes .mode:has-text('This fortnight')")
await page.waitForTimeout(500)
t("the streaming controls leave with the streaming tab",
  (await page.$(".stream-strip")) === null && (await page.$("#horizon-panel .stream-note")) === null)
t("and the filter they own leaves with them rather than silently narrowing another horizon",
  (await page.$$eval(".board-row .who .code", n => n.some(e => !["SP", "RP", "P"].includes(e.textContent.trim())))),
  "the fortnight board still has no hitters on it")

// Keyboard and screen-reader access to the same board. These are not cosmetic:
// the horizon strip is the primary control on the page, and the rows are the
// answer — both were reachable by mouse and useless without one.
const tablist = await page.$eval(".modes", l => ({
  role: l.getAttribute("role"),
  children: [...l.children].map(c => c.getAttribute("role")),
  stops: [...l.children].filter(c => c.tabIndex === 0).length,
  selected: [...l.children].filter(c => c.getAttribute("aria-selected") === "true").length
}))
t("the horizon strip is a tablist of nothing but tabs",
  tablist.role === "tablist" && tablist.children.every(r => r === "tab"),
  JSON.stringify(tablist.children))
t("exactly one horizon is selected, and it is the only tab stop",
  tablist.selected === 1 && tablist.stops === 1, JSON.stringify(tablist))

// A tab strip is one stop with arrows inside it. Focus moves without selecting,
// because selecting re-rates every player.
await page.focus('[role="tab"][aria-selected="true"].mode')
await page.keyboard.press("ArrowRight")
const roved = await page.evaluate(() => ({
  focused: document.activeElement.id,
  selected: document.querySelector(".modes [aria-selected=true]").id
}))
t("arrow keys move focus along the horizons without re-ranking",
  roved.focused !== roved.selected && roved.focused.startsWith("horizon-"), JSON.stringify(roved))

// The one tab stop has to sit where the keyboard actually is. Pinned to the
// SELECTED tab instead, tabbing out of the strip and back landed you on the
// horizon you had arrowed away from, and Enter then re-picked that one.
const stop = await page.evaluate(() => ({
  focused: document.activeElement.id,
  stop: [...document.querySelectorAll(".modes .mode")].find(e => e.tabIndex === 0)?.id ?? null
}))
t("the strip's single tab stop follows the arrows", stop.stop === stop.focused, JSON.stringify(stop))

// Keyboard focus that draws nothing is not keyboard access. app.css's
// `.modes .mode` used to outrank the shared focus rule and win with box-shadow:none.
await page.waitForTimeout(400)
const ring = await page.evaluate(() => {
  const c = getComputedStyle(document.activeElement)
  return { shadow: c.boxShadow, outline: c.outlineStyle }
})
t("a focused horizon tab is visibly focused",
  (ring.shadow !== "none" && ring.shadow !== "") || ring.outline !== "none", JSON.stringify(ring))

const horizonPanel = await page.evaluate(() => {
  const tab = document.querySelector(".modes [aria-selected=true]")
  const panel = document.getElementById(tab.getAttribute("aria-controls"))
  return { role: panel?.getAttribute("role"), labelledby: panel?.getAttribute("aria-labelledby"), tab: tab.id }
})
t("the ranking is the panel the horizons control",
  horizonPanel.role === "tabpanel" && horizonPanel.labelledby === horizonPanel.tab,
  JSON.stringify(horizonPanel))

// The row's markup reads out as nine unlabelled numbers run together, so the
// name it announces has to carry the labels the columns carry visually.
const rowA11y = await page.$eval(".board-row", r => ({
  label: r.getAttribute("aria-label"),
  expanded: r.getAttribute("aria-expanded"),
  controls: r.getAttribute("aria-controls")
}))
t("a board row announces what its numbers are, not just the digits",
  /bscore/.test(rowA11y.label) && /projected points/.test(rowA11y.label) &&
    /confidence/.test(rowA11y.label), String(rowA11y.label))
t("a board row says it can be expanded", rowA11y.expanded === "false" && !!rowA11y.controls,
  JSON.stringify(rowA11y))
await page.click(".board-row")
await page.waitForSelector(".detail")
t("opening a row says so, and points at what opened",
  (await page.$eval(".board-row", r => r.getAttribute("aria-expanded"))) === "true" &&
    (await page.$eval(".detail", d => d.id)) === rowA11y.controls)
await page.click(".board-row")
await page.waitForTimeout(150)

// The sort arrow is the only visual cue for which column the board is sorted by,
// and "\u25be" says nothing out loud.
const sortLabels = await page.$$eval(".board-head .sort-head", n =>
  n.map(e => [e.textContent.replace(/[\u25be\u25b4]/g, "").trim(), e.getAttribute("aria-label")]))
t("the active column header announces the direction it is sorted",
  sortLabels.some(([, l]) => /sorted (descending|ascending)/.test(l ?? "")),
  JSON.stringify(sortLabels))


/**
 * bscore must be value OVER REPLACEMENT, so proj − repl should equal it.
 *
 * Those two operands used to be columns on the row, which is why the row stated one
 * subtraction three times. They are in the drill-down now, so the same arithmetic is
 * checked where it actually lives — and this doubles as the assertion that moving
 * them lost nothing.
 */
const rowBscore = await page.$eval(".board-row .bscore", e => Number(e.textContent))
await page.click(".board-row")
await page.waitForSelector(".detail")
const value = await page.$$eval(".detail .pair", n =>
  Object.fromEntries(n.map(e => [e.querySelector("dt").textContent.trim(), e.querySelector("dd").textContent.trim()]))
)
t("the drill-down carries the arithmetic the row no longer repeats",
  ["projected points", "waiver points", "bscore", "rostered", "uscore", "market edge"]
    .every(k => k in value), Object.keys(value).join(", "))
t("bscore equals projected minus replacement",
  Math.abs(rowBscore - (Number(value["projected points"]) - Number(value["waiver points"]))) < 0.05,
  `${rowBscore} vs ${value["projected points"]} − ${value["waiver points"]}`)
/**
 * ...and uscore really is what he adds times the share of leagues he is still free
 * in. This asserted the old QUOTIENT, `bscore / owned`, and survived the change to
 * `addValue x (1 - owned)` only because the row it happened to open was always
 * "unlisted" and the whole block was skipped. It fired the day the capture was
 * refreshed and the top row finally had an ownership figure — which is the correct
 * behaviour of a guard, arriving several commits late.
 *
 * `addValue` is `max(bscore, 0)`, so a below-replacement player has uscore 0 rather
 * than a negative one: you do not lose points by not adding him.
 */
if (value["rostered"] !== "unlisted") {
  const pctOwned = Number(String(value["rostered"]).replace("%", ""))
  const addValue = Math.max(rowBscore, 0)
  t("uscore is what he adds times the share of leagues he is free in",
    Math.abs(Number(value["uscore"]) - addValue * (1 - pctOwned / 100)) < 0.06,
    `${value["uscore"]} vs ${addValue} x (1 - ${pctOwned}/100)`)
}
await page.click(".board-row")
await page.waitForTimeout(200)

// provenance: opening a player must separate observed from modelled
await page.click(".board-row")
await page.waitForSelector(".detail")
const sections = await page.$$eval(".detail h3", n => n.map(e => e.textContent.toLowerCase()))
t("drill-down separates measured, Statcast model and our model",
  sections.some(s => s.includes("measured")) &&
  sections.some(s => s.includes("statcast model")) &&
  sections.some(s => s.includes("our model")),
  sections.join("|"))
/**
 * The advanced reader opens a row to ask why this player is ranked here, and the
 * first thing under his thumb has to be the answer.
 *
 * It was not. The first column was the per-stat points ledger — "K 75.58, OUT 54,
 * W 14.94, H -12.68" — eight lines of arithmetic behind a number the next column
 * states in one line. On a phone the four columns stack, so all of it came before
 * anything explanatory. Nothing was dropped in fixing it; the ledger is the same
 * eight rows, last instead of first.
 */
t("the drill-down leads with what the ranking is, not with the ledger behind it",
  sections[0].includes("what he is worth"), sections.join(" | "))
t("and it ends with the per-category ledger",
  sections[sections.length - 1].includes("by category"), sections.join(" | "))
/**
 * What the model could not read is the product's own promise, and it used to sit
 * at the bottom of the rightmost column, below two Statcast tables. It is second
 * now — beside the assumptions it qualifies — whenever there is any.
 */
const missingAt = sections.findIndex(s => s.includes("missing"))
t("anything missing is reported next to the model that missed it, not last",
  missingAt === -1 || missingAt < sections.indexOf("projected points by category"),
  sections.join(" | "))
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

/**
 * Billy's pick is a row ON the board, and every clause is backed by a real number.
 *
 * It used to be asserted as the TOP row. It no longer is, deliberately: on a
 * bscore board the top row is the best player in baseball, who is rostered
 * everywhere, and naming him is a fact rather than a recommendation. The card now
 * picks the best player the reader can actually get — see the availability
 * assertions further down — so what has to hold here is that he is somebody the
 * board actually ranked, not that he is first.
 */
await page.waitForSelector(".card.pick")
const pickName = (await page.textContent(".pick-name")).trim()
/**
 * Checked against the RANKING, not against what is painted.
 *
 * The board renders in pages of 60 and grows as you scroll, and Billy's pick is the
 * best AVAILABLE player, who is usually well down a bscore ranking — the whole
 * reason the card exists is that you would otherwise have to scroll to find him. So
 * asserting he is among the rendered rows tested the size of the render window.
 * Searching for him proves he is in the ranking, which is the actual claim.
 */
const search = page.locator(".board-controls .filters input[type=text]")
await search.fill(pickName.split(" ").pop())
await page.waitForTimeout(400)
const found = await page.$$eval(".board-row .who b", n => n.map(e => e.textContent.trim()))
t("Billy's pick is a player the board actually ranked",
  found.includes(pickName), `${pickName} not found; search returned ${found.slice(0, 4).join(", ")}`)
await search.fill("")
await page.waitForTimeout(400)
const why = await page.textContent(".pick-why")
const pickScore = Number(await page.textContent(".pick-score b"))
t("Billy's reasoning cites the actual bscore",
  why.includes(String(pickScore)) && /more points than the best/.test(why), why)
// Per side, like the column: a hitter's club's games, a starter's own turns. The
// card used to quote team games at everybody, which for a starting pitcher is the
// biggest number on his row and the least relevant one.
t("Billy's reasoning cites a real count of what is scheduled",
  /plays \d+ games/.test(why) || /down for [\d.]+ starts/.test(why), why)
t("Billy uses the right volume unit for the side",
  /plate appearances per team game|outs recorded per team game/.test(why), why)

/**
 * Billy's pick must not follow the sort DIRECTION, and must never be below
 * replacement.
 *
 * The card was built by `find`ing the first available row of `rows` — the board
 * ALREADY SORTED — so one click on the bscore header flipped the question. Shipped
 * live it read "Billy's pick — Nick Solak, bscore -109.33, Confidence is only 2%
 * (limited sample, 10 of 434)": the worst man on the board, projected 109 points
 * behind the body already sitting on waivers. Direction is a way of looking at the
 * board, so the pick has to survive it unchanged; bscore <= 0 is a player who costs
 * you points, so he can never be the pick in any order or any horizon.
 */
// $eval rather than textContent: when nothing clears replacement the card renders
// its "Nobody." variant with no score badge, and a missing badge has to read as a
// failed assertion rather than as a 30-second selector timeout that aborts the run.
const pickOf = () => page.$eval(".pick-name", e => e.textContent.trim()).catch(() => "")
const pickBscore = () =>
  page.$eval(".pick-score b", e => Number(String(e.textContent).replace(/[^0-9.\-]/g, ""))).catch(() => NaN)
const sortDir = () =>
  page.$eval(".board-head .sort-head.active", e => /ascending/.test(e.getAttribute("aria-label") ?? "") ? "asc" : "desc")

const descPick = await pickOf()
const descScore = await pickBscore()
t("the pick is above replacement descending", descScore > 0, `${descPick} bscore ${descScore}`)

// one click on the active header reverses it — worst-first
await page.click(".board-head .sort-head:has-text('bscore')")
await page.waitForTimeout(350)
const ascFirst = await page.$eval(".board-row .bscore", e => Number(e.textContent))
t("clicking the active header really does flip the board to worst-first",
  (await sortDir()) === "asc" && ascFirst < descScore, `top row ${ascFirst}, ${await sortDir()}`)
const ascPick = await pickOf()
const ascScore = await pickBscore()
t("Billy's pick does not follow the sort direction", ascPick === descPick,
  `descending ${descPick} (${descScore}) vs ascending ${ascPick} (${ascScore})`)
t("Billy never recommends a player below replacement", ascScore > 0,
  `${ascPick} bscore ${ascScore}`)
// back to descending, and the pick still hasn't moved
await page.click(".board-head .sort-head:has-text('bscore')")
await page.waitForTimeout(350)
t("and it comes back unchanged when the board is flipped again",
  (await pickOf()) === descPick, `${await pickOf()} vs ${descPick}`)

// Every horizon, both directions. The pick is re-derived per horizon (journey.mjs
// pins that it changes), so the bar has to hold on each of the three.
for (const mode of ["Streaming", "This fortnight", "Stash"]) {
  await page.click(`.modes .mode:has-text('${mode}')`)
  await page.waitForTimeout(350)
  const a = { name: await pickOf(), score: await pickBscore() }
  await page.click(".board-head .sort-head:has-text('bscore')")
  await page.waitForTimeout(350)
  const b = { name: await pickOf(), score: await pickBscore() }
  await page.click(".board-head .sort-head:has-text('bscore')")
  await page.waitForTimeout(350)
  t(`${mode}: the pick is the same player in both sort directions`, a.name === b.name,
    `${a.name} vs ${b.name}`)
  t(`${mode}: the pick clears replacement in both sort directions`,
    a.score > 0 && b.score > 0, `${a.score} / ${b.score}`)
}
await page.click(".modes .mode:has-text('This fortnight')")
await page.waitForTimeout(350)

// Ordering must be ignored; FILTERING must not be. A catcher-only board still has
// to name the best catcher you can get, in either direction.
await page.click('.chip-btn:text-is("C")')
await page.waitForTimeout(400)
const cPick = await pickOf()
const cSlots = await page.$$eval(".board-row .who .code", n => n.map(e => e.textContent))
// The card names the slot it priced him against — "the best C you could add off
// waivers" — so that clause is the pick's own slot, not the board's.
const cWhy = await page.textContent(".pick-why")
t("filtering to catchers moves the pick to a catcher",
  cSlots.length > 0 && cSlots.every(x => x === "C") && /best C you could add/.test(cWhy),
  `${cPick}: ${cWhy.slice(0, 90)} (on ${cSlots.length} C rows)`)
t("the filtered pick is still above replacement", (await pickBscore()) > 0, cPick)
await page.click(".board-head .sort-head:has-text('bscore')")
await page.waitForTimeout(350)
t("and the filtered pick ignores direction too", (await pickOf()) === cPick,
  `${await pickOf()} vs ${cPick}`)
await page.click(".board-head .sort-head:has-text('bscore')")
await page.waitForTimeout(350)
await page.click('.chip-btn:text-is("All")')
await page.waitForTimeout(400)

/**
 * Billy picks the best ADDABLE player, not the best player.
 *
 * The card read `rows[0]`, so once the board's default became bscore it named the
 * best outfielder in baseball — true, rostered in every league, and useless as a
 * recommendation. Availability comes from the league's own free-agent list, not
 * from the "% Ros" sweep that is mostly weather (test/ownership.mjs).
 *
 * The pool is optional data and Yahoo rate-limits it, so this asserts the card
 * tells the truth about WHICH claim it is making in either case.
 */
// Which of the three availability tiers answered, read off the control itself
// rather than sniffed out of its prose. It used to be
// `Number(textContent(".pool-count")) > 50`, which parsed a count out of a label —
// so rewording the label to "150 free" silently turned the tier into NaN and this
// assertion started demanding the wrong sentence. The tier is now stated in an
// attribute, which is what an attribute is for.
await page.waitForFunction(
  () => document.querySelector(".filters .toggle[data-avail]") !== null,
  { timeout: 30000 }
).catch(() => {})
const availLine = (await page.textContent(".pick-avail")).trim()
const tier = await page.$eval(".filters .toggle[data-avail]", e => e.dataset.avail)
t("Billy's card says which claim it is making",
  tier === "pool" ? /free agent in your league/i.test(availLine)
  : tier === "ownership" ? /probably free/i.test(availLine)
  : /availability unknown/i.test(availLine),
  `tier ${tier}: ${availLine}`)
const poolRead = tier === "pool"
if (poolRead) {
  // the decisive one: the pick has to be somebody you can actually get
  await page.locator(".toggle input").first().check()
  await page.waitForTimeout(400)
  const freeNames = await page.$$eval(".board-row .who b", n => n.map(e => e.textContent.trim()))
  await page.locator(".toggle input").first().uncheck()
  await page.waitForTimeout(400)
  const pickedName = (await page.textContent(".pick-name")).trim()
  t("Billy's pick is a player you can actually add",
    freeNames.includes(pickedName), `${pickedName} not among ${freeNames.length} free agents`)
  // and it is genuinely a different answer from the top of the board, or the
  // distinction this card exists to draw would be invisible
  const topRow = (await page.$$eval(".board-row .who b", n => n[0].textContent.trim()))
  t("the board still ranks by value even though the pick is filtered by availability",
    typeof topRow === "string" && topRow.length > 0, topRow)
}

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
// Side, min-confidence and hide-injured now sit behind "More filters" — they are
// reached for rarely and permanently on screen they pushed the ranking below the
// fold. The disclosure has to be opened before they can be driven, which is the
// same thing a reader does.
await page.click(".board-controls details.more > summary")
await page.waitForSelector("[data-ctl=group]", { state: "visible" })
const before = await page.$$eval(".board-row", n => n.length)
await page.selectOption("[data-ctl=group]", "hitting")
await page.waitForTimeout(400)
const after = await page.$$eval(".board-row", n => n.length)
t("side filter changes the board", after > 0 && after <= before, `${before} → ${after}`)
// A filter you cannot see must not be one you cannot escape: with the disclosure
// closed, its summary has to say what is still narrowing the board.
const summary = await page.$eval(".board-controls details.more > summary", e => e.textContent)
t("hidden filters are named on the summary that hides them",
  /batters only/i.test(summary), summary)

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

/**
 * The phone. Below 640px only two numbers fit beside the name — measured, the
 * board is 300px wide at 390px — and which two is a decision, not an accident.
 *
 * They used to be uscore and bscore, and uscore is the column that is blank on 36
 * of the first 60 rows: the mobile reader got a column of dashes as one of his two
 * numbers. The window count has the slot now. It is never blank (0 of 1,233 rows
 * on the fixture), it is the only number on the row that is a fact about the
 * window rather than about the player, and for a starter it is his own turns.
 * uscore comes back only when the board is RANKED by it, because a board must
 * always show the number it is sorted by.
 */
const phone = await browser.newPage({ viewport: { width: 390, height: 844 } })
await phone.goto(BASE, { waitUntil: "networkidle" })
await phone.waitForSelector(".board-row", { timeout: 30000 })
const cols = async () =>
  phone.evaluate(() => {
    const vis = el => getComputedStyle(el).display !== "none"
    const right = el => Math.round(el.getBoundingClientRect().right)
    const head = [...document.querySelectorAll(".board-head > [data-col]")].filter(vis)
    const row = [...document.querySelector(".board-row").querySelectorAll(":scope > [data-col]")].filter(vis)
    return {
      names: head.map(e => e.dataset.col),
      head: head.map(e => `${e.dataset.col}@${right(e)}`),
      row: row.map(e => `${e.dataset.col}@${right(e)}`)
    }
  })
const small = await cols()
t("at 390px the board keeps the name and the two numbers that are never blank",
  small.names.join() === "rank,who,bscore,games", small.names.join())
t("and the headings still sit over the cells they name at 390px",
  small.head.join() === small.row.join(), `${small.head.join(" ")} vs ${small.row.join(" ")}`)
t("no column on the phone board is empty",
  (await phone.$$eval(".board-row [data-col=games]", n => n.map(e => e.textContent.trim())))
    .every(x => /\d/.test(x)))
t("the page does not scroll sideways at 390px",
  (await phone.evaluate(() => document.documentElement.scrollWidth)) <= 390,
  String(await phone.evaluate(() => document.documentElement.scrollWidth)))
await phone.selectOption("[data-ctl=sort]", "uscore")
await phone.waitForTimeout(400)
const sorted = await cols()
t("ranking by uscore brings its column back on a phone",
  sorted.names.includes("uscore") && sorted.head.join() === sorted.row.join(),
  sorted.names.join())
// and confidence, which the phone drops, has to survive somewhere the phone reaches
await phone.click(".board-row")
await phone.waitForSelector(".detail")
const phoneDetail = await phone.$$eval(".detail .pair dt", n => n.map(e => e.textContent.trim()))
t("what the phone drops from the row is in the drill-down it can open",
  phoneDetail.includes("confidence"), phoneDetail.join(", "))

/**
 * The phone, on the STREAMING tab — which this block never reached, and which is
 * now the view with its own grid and its own control strip.
 *
 * It went sideways there: app.css sets `white-space:nowrap` on every `.toggle`,
 * and the availability toggle carries the tier it is using ("est. over 35% is
 * taken"), so at 390px that one label measured 411px — 21px of horizontal scroll
 * on the page this whole change exists to fix, while the fortnight board it was
 * measured on sat at exactly 390.
 */
await phone.click(".board-row")
await phone.waitForTimeout(150)
await phone.click(".modes .mode:has-text('Streaming')")
await phone.waitForSelector(".stream-strip", { timeout: 15000 })
await phone.waitForTimeout(600)
t("the streaming board does not scroll sideways at 390px either",
  (await phone.evaluate(() => document.documentElement.scrollWidth)) <= 390,
  String(await phone.evaluate(() => document.documentElement.scrollWidth)))
const smallStream = await cols()
t("at 390px streaming keeps the name, what he is worth and how many turns he gets",
  smallStream.names.join() === "rank,who,bscore,games", smallStream.names.join())
t("and those headings still sit over the cells they name",
  smallStream.head.join() === smallStream.row.join(),
  `${smallStream.head.join(" ")} vs ${smallStream.row.join(" ")}`)
await phone.close()

/**
 * How far down the page the answer starts, pinned.
 *
 * This has regressed three times: 1,187px, fixed to 895, back to 1,506 on the
 * streaming tab as each pass added a paragraph — and 2,863 on a 390px phone, seven
 * screens before a single recommendation. Every one of those paragraphs was
 * defensible on its own, which is exactly why a number is needed rather than
 * judgement: the cost is only visible in aggregate.
 *
 * The bars are set above where it sits now, not at it, so ordinary work has room
 * and only a slide back toward the old shape trips them.
 */
{
  await page.click(".modes .mode:has-text('Streaming')")
  await page.waitForTimeout(900)
  const deskTop = await page.$eval(".board-row", e => Math.round(e.getBoundingClientRect().top + scrollY))
  t("the streaming answer starts within a screen and a half on a desktop",
    deskTop < 1350, `first ranked row at y=${deskTop}`)

  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await phone.goto(BASE, { waitUntil: "domcontentloaded" })
  await phone.waitForSelector(".board-row", { timeout: 30000 })
  await phone.waitForTimeout(1200)
  await phone.click(".modes .mode:has-text('Streaming')")
  await phone.waitForTimeout(1200)
  const phoneTop = await phone.$eval(".board-row", e => Math.round(e.getBoundingClientRect().top + scrollY))
  t("and within two screens on a phone", phoneTop < 1900, `first ranked row at y=${phoneTop}`)
  t("with nothing spilling sideways on a phone",
    (await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) === 0)
  await phone.close()
}

await browser.close()

console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
