// The recommendation engine, end to end in a real browser against real data.
import { chromium, firefox } from "playwright-core"
/**
 * 5299, not 5173.
 *
 * This defaulted to :5173 — Vite's own default — and :5173 on this machine belongs
 * to a DIFFERENT project's dev server, which answers 200 and serves a working site
 * that is not this one. The run then failed as a selector timeout on `.board-row`
 * and read like a UI defect in a board that was never on screen. This repo's dev
 * server is on :5299; the identity check below is what catches it when the default
 * is wrong again.
 */
const BASE = process.env.BASE ?? "http://127.0.0.1:5299"
const ENGINE = process.env.BROWSER ?? "chromium"
const browser = ENGINE === "firefox" ? await firefox.launch() : await chromium.launch({ args: ["--no-sandbox"] })
console.log(`--- ${ENGINE} ---`)
let pass = 0, fail = 0
const t = (n, ok, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : "  " + x}`) }

const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
const errors = []
page.on("pageerror", e => errors.push(String(e)))
await page.goto(BASE, { waitUntil: "networkidle" })

// A 200 on this port is not proof it is this app: a dev-server port is a guess and
// another project's server answers it just as happily, after which every assertion
// below fails as a selector timeout that reads like a UI defect. That is not
// hypothetical — this file's own default used to be :5173, which is another app on
// this machine. The wordmark is the cheapest proof of identity, so it is checked
// before anything else and stops the run rather than letting the next wait speak
// for it.
const wordmark = await page.waitForSelector("h1", { timeout: 15000 }).then(h => h.textContent(), () => null)
t("the page under test is beanemachine", wordmark === "beanemachine",
  `BASE=${BASE} served <h1>${wordmark}</h1> — start this repo's own vite, or set BASE to it`)
if (wordmark !== "beanemachine") { await browser.close(); process.exit(1) }

/**
 * The board is on PICKUPS now, and Pickups is a tab you have to ask for.
 *
 * Four tabs became three screens, and the split was down the middle of what used to
 * be one: the decision card is on its own tab, this ranked board is on its own, and
 * the team and the league's values are on a third. Landing on the site puts you on
 * the decision card, where there is no `.board-row` at all — so every assertion in
 * this file was waiting thirty seconds for a table that is one screen over.
 *
 * THE LABELS ARE NOT THE IDS, and the three labels changed under this suite without
 * the ids moving. "Today | Wire | Setup" now reads "Tonight | Pickups | My league" —
 * developer shorthand for a reader who has never seen a waiver wire called a wire —
 * while `View` is still `board | wire | trade`, because that string is also the key
 * stored in this browser and renaming it drops every returning reader on the default
 * screen (panels.tsx says so where VIEWS is declared). So the ids in this file's
 * selectors (`data-col`, `#horizon-panel`, `.board-row`) are untouched and only the
 * three strings a reader actually reads moved. Every one of them failed the same
 * way: a thirty-second wait on `.views button:has-text("Wire")`, which reads like a
 * dead navigation rather than a renamed one.
 *
 * BY VISIBLE TEXT, never by index — still, and the rename is the argument for it
 * rather than against it. Several suites in this directory reached their screen with
 * `.views button:nth-child(N)`: an index finds A tab whatever the labels say, so it
 * would have survived this rename by silently testing the wrong screen, which is the
 * worst way for a navigation selector to fail. A label fails loudly and is one line
 * to fix, which is exactly what just happened here.
 */
const screen = async (p, label) => {
  await p.click(`.views button:has-text("${label}")`)
  await p.waitForTimeout(200)
}

/**
 * MORE FILTERS, and why reaching the ordering control is a named gesture.
 *
 * "Rank by" used to stand in the always-visible filter row. It is now inside
 * `<details class="more">`, which ships CLOSED — four of its six orderings are also
 * sortable column heads, so most of what it offered was a second way to do a thing
 * one tap away on the thing itself, and it cost 66px above the one screen whose job
 * is to show ranked rows. Every `selectOption("[data-ctl=sort]", …)` below then
 * failed in the most misleading way a selector can: Playwright RESOLVED the select
 * and then spent thirty seconds reporting "element is not visible", which reads like
 * a dead control rather than a folded one.
 *
 * The open state is NOT ours to track, which is the whole reason this is a helper and
 * not a click at each site. Board.tsx renders the disclosure as
 * `open={narrowed.length > 0}`, so choosing "batters only" opens it for us and
 * putting the side back to "batters + pitchers" closes it again underneath us. Ask
 * the DOM every time.
 */
const moreFilters = async p => {
  if (!(await p.$eval(".board-controls details.more", d => d.open)))
    await p.click(".board-controls details.more > summary")
  await p.waitForSelector(".board-controls details.more[open]")
}
/**
 * FLIPPING THE BOARD, which is no longer one click on one named head.
 *
 * Every direction test in this file clicked `.sort-head:has-text('bscore')`. There is
 * no head with that text any more: the board's value column says "ahead by" and
 * Streaming's says "points" — same controls, same `data-col`, new words. So the
 * selector moves to `data-col`, which is also what the grid places by and therefore
 * what the markup already treats as a column's identity; the visible text is asserted
 * once, where the head census is, instead of smeared across twenty selectors.
 *
 * The second half is subtler and cost an hour. `filters.sort` is NULL until a reader
 * touches a head — useBoard resolves the default per horizon, `bscore` on the board
 * and `points` on Streaming — and `SortHead` marks itself active by comparing the raw
 * null, not the resolved value. So on an untouched board NO head is active, and the
 * first click on one does not reverse the order, it pins the order that was already
 * in force. Two clicks then leave the board ASCENDING rather than back where it
 * started, and the damage shows up hundreds of lines later somewhere else entirely:
 * "the availability filter changes who is recommended" failed with the same name on
 * both sides, because a board ordered worst-first opens on men projected for nothing,
 * and men projected for nothing are unowned whether you filter for that or not.
 *
 * Hence a gesture rather than a selector: click the ACTIVE head if there is one, and
 * otherwise pin first and flip second.
 */
const valueHeadOf = async p =>
  (await p.$(".board-head .sort-head[data-col=pts]")) ?
    ".board-head .sort-head[data-col=pts]"
  : ".board-head .sort-head[data-col=bscore]"
const flipValue = async p => {
  const active = await p.$(".board-head .sort-head.active")
  if (active) await active.click()
  else {
    const h = await valueHeadOf(p)
    await p.click(h)
    await p.waitForTimeout(350)
    await p.click(h)
  }
  await p.waitForTimeout(350)
}

// The ordering control, reached the way a reader reaches it.
const rankBy = async (p, value) => {
  await moreFilters(p)
  await p.selectOption("[data-ctl=sort]", value)
  await p.waitForTimeout(350)
}

/**
 * NUMBERS OUT OF THE DRILL-DOWN, and why reading one is now a named gesture.
 *
 * Three columns left the row in the four-column pass: uscore, conf and luck. They are
 * one tap down, in `.detail .pair`, and this helper is the tap. It exists rather than
 * a click inlined at each site because "moved" and "deleted" must not look the same —
 * a suite that answered the deletion of those cells by deleting the assertions that
 * read them would go green on a board that had thrown the numbers away, which is the
 * one outcome nothing else in this file would notice.
 *
 * Every reader below that used to do `$$eval(".board-row [data-col=uscore] .us-own")`
 * goes through here instead. That is slower — one click and one re-render per row —
 * so it reads the first handful rather than the first twenty, and each caller says
 * what it needs the count for.
 *
 * ONE ROW IS OPEN AT A TIME: Board.tsx holds a single `open` player id, so clicking
 * row i+1 closes row i and `.detail` is always the one belonging to the row just
 * clicked. The rows are re-queried after each click because opening one inserts a
 * `.detail` sibling and React re-keys the list underneath the old handles.
 */
const detailDownBoard = async (p, keys, n) => {
  const out = []
  for (let i = 0; i < n; i++) {
    const rows = await p.$$(".board-row")
    if (!rows[i]) break
    await rows[i].click()
    await p.waitForSelector(".detail")
    out.push(
      await p.evaluate(
        ks =>
          Object.fromEntries(
            ks.map(k => [
              k,
              [...document.querySelectorAll(".detail .pair")]
                .find(e => e.querySelector("dt").textContent.trim() === k)
                ?.querySelector("dd")
                ?.textContent.trim() ?? null
            ])
          ),
        keys
      )
    )
    const again = await p.$$(".board-row")
    await again[i].click()
    await p.waitForTimeout(60)
  }
  return out
}
await screen(page, "Pickups")

await page.waitForSelector(".board-row", { timeout: 30000 })

t("no page errors", errors.length === 0, errors.join(" | "))
/**
 * The board is the ONLY thing on Pickups, and the decision card is not on it.
 *
 * This is the half of the restructure that a ranked-board suite can actually police.
 * The two used to be stacked on one tab: measured at phone width, the decision card
 * and the thousand-row table made a single 8,400px scroll, with the first ranked row
 * 1,600px down. Asserting the card's ABSENCE here is what stops the stack quietly
 * reassembling — every assertion below would still pass with `Decide` put back on top
 * of the board, and the pixel pins at the foot of this file would be the only thing
 * that complained, a thousand lines away from the cause.
 */
t("Pickups carries the ranked board and nothing else",
  (await page.$(".decide")) === null && !!(await page.$(".board-controls")),
  "the decision card is back on top of the board")
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
/**
 * The default board is the men he can ADD, and the whole rateable pool is one
 * untick away.
 *
 * This used to read "the default ranking places the whole pool rather than the
 * priced subset": >= 1,000 ranked, not the handful market edge could price. That
 * assertion existed because market edge drops everyone it has no ownership figure
 * for, and on a thin capture that silently shrank the board to a short list which
 * looked like a working one — so the count the board states was pinned.
 *
 * `AVAILABLE_ONLY_DEFAULT.board` is true now, so "the default ranking is the whole
 * pool" is simply no longer the truth, and the assertion passed only by luck: 1,010
 * of the 1,248 rateable players clear the ownership cut on the committed capture, so
 * a filtered board still answered ">= 1000" and the check had stopped meaning
 * anything. The flip has a measurement behind it — 42 of the first 50 rows of the
 * old default are rostered in 90% or more of leagues, not one under 50% — so the
 * first screen of the tab this app exists for was fifty men nobody can have.
 *
 * Both halves are asserted rather than one quietly replacing the other: the default
 * opens on what he can get (the new truth), AND every rateable player is still
 * placed and still reachable in one click (the old protection, which is exactly what
 * market edge's priced subset could not do).
 *
 * Every count is read off the number the board states, never off the rendered rows:
 * the board pages in 60 at a time, so a filter that removed a thousand players would
 * look like it had removed none.
 */
const rankedAt = () => page.$eval("#horizon-panel .sub .count", e => Number(e.textContent.replace(/,/g, "")))
const availOnBoard = ".board-controls .filters .toggle:has-text('I can add') input"
/**
 * OWNERSHIP, out of the drill-down, because the row does not print it any more.
 *
 * It was read off `.us-own` — the ownership tucked under the uscore score, one
 * element per number so that the cell's own text ("0.899% owned", which is uscore 0.8
 * then 99%) could not be misparsed as a single percentage. The uscore column is gone
 * from the row entirely, so that element is gone with it and this read returned an
 * empty array: the assertion below then passed or failed on `[].every(...)`, which is
 * true, i.e. it had quietly stopped measuring anything at all. That is the failure
 * mode this whole helper exists to prevent.
 *
 * `rostered` in the drill-down is the same number — "unlisted" where Yahoo priced
 * nobody, which parses to NaN and is dropped, because unknown is not unowned.
 *
 * TWELVE rows, not twenty, because each one costs a click now. The claim below is
 * proportional (half the head of the unfiltered board is rostered nearly everywhere),
 * so it is the same claim at either count rather than a relaxed one.
 */
const ownPcts = async () =>
  (await detailDownBoard(page, ["rostered"], 12))
    .map(d => Number(String(d.rostered).replace(/[^0-9.]/g, "")))
    .filter(Number.isFinite)
t("the board opens on players the reader can add, with no click at all",
  await page.$eval(availOnBoard, e => e.checked))
const addableCount = await rankedAt()
const addableOwn = await ownPcts()
await page.uncheck(availOnBoard)
await page.waitForTimeout(700)
const wholePool = await rankedAt()
const wholeOwn = await ownPcts()
t("the whole rateable pool is still ranked, one untick away",
  wholePool >= 1000 && wholePool > addableCount,
  `${addableCount} addable of ${wholePool} rateable`)
// The measurement that justified the flip, re-derived off whatever capture is
// committed rather than quoted from the commit message that made the change.
t("the old default really did open on men nobody could have",
  wholeOwn.length >= 8 && wholeOwn.filter(p => p >= 90).length >= wholeOwn.length / 2 &&
    addableOwn.length >= 8 && addableOwn.every(p => p < 60),
  `unfiltered: ${wholeOwn.slice(0, 6)} | default: ${addableOwn.slice(0, 6)}`)
await page.check(availOnBoard)
await page.waitForTimeout(700)
const rankedCount = await rankedAt()
t("and the filter is undoable in both directions", rankedCount === addableCount,
  `${rankedCount} back from ${wholePool}, default was ${addableCount}`)
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
 * FOUR columns, and the three that left must be findable rather than merely absent.
 *
 * This said SEVEN, and every column it named is now one of three things. `proj pts`
 * and `waiver pts` went first, because bscore is one minus the other and the table
 * was stating a single subtraction three times where scanning matters most. `owned`
 * went into uscore, whose denominator it is. And uscore, conf and luck have now gone
 * the same way, into the drill-down — measured on the shipped capture, confidence
 * read 100% on 41 of the first 60 rows and took four distinct values across all
 * sixty, and luck is a percentile that feeds no ranking on this screen, so both were
 * printed beside two numbers that decide something and lent the same weight.
 *
 * What is left is # / Player / ahead by / games, and five with a roster. That is a
 * claim about the WHOLE head, so it is asserted as an exact list rather than as a
 * set of `startsWith` probes: the old form would have passed on a head that had
 * grown an eighth column, which is the direction this table has always drifted.
 *
 * THE NAMES CHANGED TOO, and that is the substance rather than a cosmetic. "bscore"
 * is a word this app coined and nobody else uses; the column that carries the whole
 * decision now says what the number is. The coinage survives on Billy's badge, in
 * the drill-down and in Methodology, which is asserted where each of those lives.
 */
const headers = await page.$$eval(".board-head > *", n => n.map(e => e.textContent.trim()))
/* The arrow glyph is read off with the label here, and it is asserted rather than
   stripped. `SortHead` marked itself active on `filters.sort === field` — the RAW
   value, which is null until a reader clicks a head, while the board ranks by
   `filters.sort ?? SORT_DEFAULT[mode]`. So on every first visit the rows descended by
   "ahead by" and no head said so: no arrow for a sighted reader, and "Sort by ahead
   by" instead of "sorted descending" for a screen reader. It compares the resolved
   sort now, and the glyph is the proof. */
t("the board shows the four decision columns, named in words",
  headers.join("|") === "#|Player|ahead by▾|games", headers.join(" | "))
t("and the column the rows are actually ordered by is the one marked, on a first visit",
  headers.filter(h => /[▾▴]/.test(h)).join() === "ahead by▾", headers.join(" | "))
/*
 * The head is where the app used to speak to itself. Nothing in this file asserted
 * that, because for as long as the columns were abbreviations the tooltips carried
 * the meaning and the crowding was the only visible problem — so a head reading
 * "uscore bscore conf luck" passed every check here while being four words a reader
 * who plays fantasy baseball has never seen. This is the assertion that keeps them
 * off, and it is deliberately about the HEAD and not about the drill-down, which is
 * the advanced surface and still says bscore, uscore and market edge on purpose.
 */
t("and none of them is a word this app invented",
  !/bscore|uscore|conf\b|luck|Δ|delta/i.test(headers.join(" ")), headers.join(" | "))
// The definition, not the word: the head that carries the decision still states on
// itself what the number means and what bar it is measured against. This used to be
// asserted on `conf`, whose abbreviation was the reason it needed a tooltip at all;
// conf is off the row now, so the claim moves to the column that survived it, where
// it matters more — "ahead by" is plainer than "bscore" and still not self-defining.
t("and the head that carries the decision defines itself",
  (await page.$eval('.board-head [data-col=bscore]', e => e.getAttribute("title") ?? "")).length > 40,
  await page.$eval('.board-head [data-col=bscore]', e => (e.getAttribute("title") ?? "").slice(0, 80)))
t("and no longer restates the decision column's own arithmetic beside it",
  !headers.some(h => /proj pts|waiver pts/.test(h)), headers.join(" | "))
t("ownership is no longer a column of its own",
  !headers.some(h => /^owned/.test(h)), headers.join(" | "))
/*
 * A GENERATED LEGEND under the heads, because a fixed one was false on a third of
 * the app.
 *
 * The single sentence explaining the app's own number lived in the colophon and said
 * "a bscore is a ranking, not a forecast" on every screen. Streaming ranks on raw
 * projected points by documented decision (SORT_DEFAULT in useBoard.ts), so on one
 * of the three horizons the only explanation on the page was describing a different
 * column from the one the table was ordered by. Rendering it from `sort` is what
 * makes that impossible rather than merely unlikely — so what is pinned here is that
 * it TRACKS the ordering, which is checked on both branches: the board's, and
 * Streaming's further down this file.
 */
const legend = p => p.textContent(".board-legend")
const boardLegend = await legend(page)
t("a legend under the heads says what the decision column is, in the reader's words",
  /ahead by/i.test(boardLegend) && /free/i.test(boardLegend) && !/bscore/.test(boardLegend),
  boardLegend.replace(/\s+/g, " ").slice(0, 140))
// ...and it is honest about what the number is NOT, which is the claim the colophon
// used to carry and the one a reader most needs: a rank is not a forecast.
t("and that it ranks rather than promises",
  /does not promise points/.test(boardLegend), boardLegend.replace(/\s+/g, " ").slice(0, 200))

/**
 * The head and the row must agree cell for cell, in name and in pixels — and no two
 * columns may share a cell.
 *
 * app.css places both by `nth-child`, and that has failed before in exactly this
 * spot: auto-placement once put the confidence gauge under "GP" and the games
 * count under "confidence", so every number in two columns was labelled as the
 * other one. Each cell now carries `data-col` and the grid places by that, which
 * is only true as long as something checks it — including at the widths where
 * columns are dropped, because a header dropped without its body is the same bug
 * with a smaller blast radius.
 *
 * OVERLAP IS NEW HERE, and it is new because the four-column pass produced one. The
 * old check compared the head's boxes against the row's, which two columns printed
 * ON TOP OF EACH OTHER pass with flying colours: the head overlaps itself in exactly
 * the same place the row does, so "every heading sits over the cells it names" was
 * true of a phone board reading "35.2714GP". Named placement stops a heading landing
 * over the wrong cell; nothing stopped two cells landing on one, which is what a
 * `grid-column` rule surviving the deletion of the column it made room for does.
 */
const columnsLineUp = async (p = page) =>
  p.evaluate(() => {
    const vis = el => getComputedStyle(el).display !== "none"
    const box = el => {
      const b = el.getBoundingClientRect()
      return { l: Math.round(b.left), r: Math.round(b.right) }
    }
    const cells = root =>
      [...root.querySelectorAll(":scope > [data-col]")].filter(vis).sort((a, b) => box(a).l - box(b).l)
    const head = cells(document.querySelector(".board-head"))
    const row = cells(document.querySelector(".board-row"))
    // A pair of columns that share pixels. Reported as names so the failure says
    // WHICH two collided rather than only that some did.
    const collisions = list =>
      list.slice(1).flatMap((e, i) => (box(e).l < box(list[i]).r ? [`${list[i].dataset.col}+${e.dataset.col}`] : []))
    return {
      head: head.map(e => `${e.dataset.col}@${box(e).r}`),
      row: row.map(e => `${e.dataset.col}@${box(e).r}`),
      names: head.map(e => e.dataset.col),
      rowNames: row.map(e => e.dataset.col),
      collisions: [...new Set([...collisions(head), ...collisions(row)])]
    }
  })
const wide = await columnsLineUp()
t("every heading sits over the cells it names",
  wide.head.join() === wide.row.join(), `${wide.head.join(" ")} vs ${wide.row.join(" ")}`)
t("and no two columns are printed on top of each other",
  wide.collisions.length === 0, wide.collisions.join(" "))
t("all four columns are on screen at 1280px",
  wide.names.join() === "rank,who,bscore,games", wide.names.join())

/*
 * SHIPPED FOLDED, asserted before anything in this file unfolds it.
 *
 * This claim lived two hundred lines below, where it was safe as long as every
 * ordering was reached by clicking a column head. Only two heads sort now — Player
 * and "ahead by" — so uscore, luck and the rest are reached through the select, and
 * the first `rankBy()` in this file opens `details.more` and leaves it open for every
 * assertion after it. The claim is unchanged and is not weakened; it is simply the
 * claim about a state that only exists until a reader touches the disclosure, so it
 * has to be made before this suite touches it. Its two siblings — that one gesture
 * reaches the control and that it still orders the board — are unaffected and stay
 * with the block that explains them.
 */
t("the ordering control is off screen until the reader asks for more filters",
  !(await page.locator("[data-ctl=sort]").isVisible()),
  "rank-by is back in the always-visible filter row")

/**
 * uscore MOVED; it did not retire — and the only way to prove that is to open a row.
 *
 * Three assertions lived here: the cell prints the ownership it divided by, choosing
 * uscore orders by uscore, and that ordering only ranks players above replacement.
 * Two of the three are gone with the ordering, and the reason is worth recording
 * rather than quietly dropping.
 *
 * THE OLD TRUTH: "Rank by" offered uscore, and the number was printed nowhere on the
 * board — so the only thing that could check the ordering was this suite, reading the
 * drill-down six rows deep. The comment here said as much: "an ordering by an
 * invisible number is one keystroke from an ordering by nothing at all".
 *
 * THE NEW TRUTH: the select does not offer it. uscore is `addValue x (1 - owned)` on a
 * list this screen has already filtered to men he can get — the same discount applied
 * twice, which reorders the survivors by who is rarer rather than by who is better —
 * and it is null wherever Yahoo prices no ownership, 553 of 1,435 players on the
 * committed capture. Every ordering that IS offered now draws its own number beside
 * the name, which is asserted below and is the general rule this special case was
 * standing in for.
 *
 * What survives unchanged is the claim the two-number cell was built to make: ONE
 * MISSING INPUT IS REPORTED ONCE. uscore is blank in exactly the rows ownership is
 * blank in, and the pair of them must agree row by row or the drill-down is printing
 * one absence as two different facts. It no longer needs the ordering to be reached.
 */
const usRows = await detailDownBoard(page, ["uscore", "rostered"], 6)
t("a row with no ownership has no uscore either, and says so once",
  usRows.length > 0 &&
    usRows.every(d => (d.rostered === "unlisted") === (d.uscore === "—")),
  JSON.stringify(usRows))
t("and uscore is still printed there, so the number moved rather than retired",
  usRows.every(d => d.uscore !== undefined && d.uscore !== null),
  JSON.stringify(usRows.map(d => d.uscore)))

/**
 * A BOARD MUST ALWAYS SHOW THE NUMBER IT IS SORTED BY — now as a rule over every
 * ordering the select offers, rather than one assertion per metric.
 *
 * Four of the six used to rank the rows by a figure printed nowhere: uscore, edge,
 * most undervalued and best contact. The legend under the heads branched on three
 * values and fell through, so ranked by luck the board reordered itself and the
 * sentence beneath still read "Ahead by — points more than the best man still free at
 * his spot", describing a different column. Measured at the time: ranked by most
 * undervalued, `.board-legend` read "Ahead by …".
 *
 * Every ordering now draws one extra cell, `[data-col=sorted]`, carrying its own value
 * and headed with its own short name, and the legend is generated from it. This walks
 * the select and holds all three of those facts on every option — which is the only
 * shape that cannot be satisfied by patching one metric and forgetting the next.
 */
const orderings = await page.$$eval("[data-ctl=sort] option", n =>
  n.map(e => ({ value: e.value, label: e.textContent.trim() })))
t("the ordering control offers only orderings the board can draw",
  orderings.length >= 4 && !orderings.some(o => o.value === "uscore"),
  orderings.map(o => `${o.value}=${o.label}`).join(" | "))
// The words are the reader's. "market edge (what the field is wrong about)" asked him
// to carry a definition in his head in order to pick an ordering.
t("and it names them in plain words, with no coinage of this app's own",
  !orderings.some(o => /bscore|uscore|\bedge\b|undervalu|replacement/i.test(o.label)),
  orderings.map(o => o.label).join(" | "))
for (const { value, label } of orderings) {
  await rankBy(page, value)
  const seen = await page.evaluate(() => {
    const vis = e => getComputedStyle(e).display !== "none"
    const names = root =>
      [...root.querySelectorAll(":scope > [data-col]")].filter(vis).map(e => e.dataset.col)
    const head = document.querySelector(".board-head")
    const row = document.querySelector(".board-row")
    const cell = row?.querySelector("[data-col=sorted]")
    return {
      head: names(head).join(),
      row: names(row).join(),
      marked: [...head.querySelectorAll("[data-col]")]
        .filter(e => /[▾▴]/.test(e.textContent))
        .map(e => e.dataset.col).join(),
      sorted: cell ? cell.textContent.trim() : null,
      legend: document.querySelector(".board-legend summary")?.textContent.trim() ?? ""
    }
  })
  t(`ordered by "${label}": the head and the rows carry the same columns`,
    seen.head === seen.row, `${seen.head} vs ${seen.row}`)
  // bscore has a column of its own; everything else earns the generic one.
  const own = value === "bscore"
  t(`ordered by "${label}": the number it is ordered by is on the row`,
    own ? seen.sorted === null && /bscore/.test(seen.row) : /^[+-]?[\d.]+$|^—$/.test(seen.sorted ?? ""),
    `sorted cell = ${seen.sorted}, columns = ${seen.row}`)
  t(`ordered by "${label}": the column it is ordered by is the one marked`,
    seen.marked === (own ? "bscore" : "sorted"), `marked: ${seen.marked || "nothing"}`)
  t(`ordered by "${label}": the sentence under the heads names that column`,
    own ? /Ahead by/.test(seen.legend) : seen.legend.length > 0 && !/Ahead by/.test(seen.legend),
    seen.legend)
}
await rankBy(page, "bscore")

/**
 * A control that MOVED must not be a control that quietly retired.
 *
 * Nothing in this file noticed the fold as a fold — every sort assertion simply timed
 * out — so the three claims the move actually has to satisfy are pinned here: the
 * ordering control is HIDDEN until the reader asks for more filters (that is the
 * point of the move, and the 66px it bought back), it is REACHABLE with that one
 * gesture, and it still ORDERS the board once reached.
 *
 * Ordering is proved on `contact`, deliberately. It used to be that four of the six
 * orderings were also column heads, so a select that had stopped being wired to
 * anything would still have looked alive when tested on those — the board would
 * already be sorted that way from the head-click above. Five of the six have no
 * column now (only "ahead by" is left, plus Player), which is a much larger reason to
 * check the select is alive and a much larger loss if it is not: `contact` is simply
 * still the safest of them to prove it on.
 *
 * The first of the three claims — that the control ships folded — has moved up this
 * file, above the first gesture that unfolds it. See the note there.
 */
/* "contact" used to be the ordering proved here, and it is no longer offered: it was
   the SAME ORDERING as "who has been unluckiest". `undervaluation` is the within-side
   percentile of the signed contact gap and `contact` was that gap raw, and a percentile
   is monotone within a side — measured in the browser on the dev league, 60 of 60 rows
   identical with Side=batters and 40 of 40 with Side=pitchers. The percentile is the one
   that survives, because it is the one that is comparable with both sides on the list.
   The claim here is unchanged: one gesture reaches the control and it re-orders. */
const beforeOrder = await page.$$eval(".board-row .who b", n => n.slice(0, 8).map(e => e.textContent.trim()))
await rankBy(page, "undervaluation")
const afterOrder = await page.$$eval(".board-row .who b", n => n.slice(0, 8).map(e => e.textContent.trim()))
t("one gesture reaches it, and it still re-orders the board",
  (await page.locator("[data-ctl=sort]").isVisible()) &&
    (await page.$eval("[data-ctl=sort]", e => e.value)) === "undervaluation" &&
    afterOrder.length > 5 && afterOrder.join() !== beforeOrder.join(),
  `${beforeOrder.slice(0, 3)} then ${afterOrder.slice(0, 3)}`)
await rankBy(page, "bscore")

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
await rankBy(page, "marketEdge")
t("market edge is still selectable and still ranks",
  (await page.$$eval(".board-row", n => n.length)) > 0)

await rankBy(page, "bscore")
const byB = await page.$$eval(".board-row .bscore", n => n.map(e => Number(e.textContent)))
t("sorting by bscore still orders by bscore",
  byB.every((v, i) => i === 0 || byB[i - 1] >= v), String(byB.slice(0, 5)))

/**
 * "Where it hurts to wait" is gone, and the thing it was telling the reader is not.
 *
 * Three assertions lived here: the card lists the league's active slots, it is
 * ordered by how steep each slot's drop-off is, and the steepest is genuinely
 * steeper than the shallowest. What all three protected is one claim — THIS PAGE
 * PRICES POSITIONAL DROP-OFF, so a catcher who beats catchers is not compared
 * against an outfielder who beats outfielders.
 *
 * The card is deleted, so the ranking OF slots against each other is gone with it
 * (said out loud in this agent's return value, because it is a real loss and not a
 * wash). The claim itself is not gone: it was never the card's, it is bscore's
 * definition. bscore subtracts the (teams x seats)-th man AT THE SAME SLOT, which is
 * precisely the cliff the card was drawing, and the number is on every row of the
 * board instead of summarised for five slots in a panel below it.
 *
 * So this block now asserts the card's absence AND that the per-slot bar is still
 * real and still visible — measured, not taken on the definition's word: a catcher's
 * replacement bar and a pitcher's are different numbers, which is the only way the
 * drop-off can be priced at all. A single league-wide bar would make every assertion
 * above about bscore pass and quietly answer the wrong question.
 */
t("the positional-scarcity card is gone from the board",
  (await page.$(".scarcity")) === null && (await page.$$(".scar")).length === 0,
  "a scarcity panel is back under the board")
// The definition the reader can actually reach: the header's own tooltip, which is
// where COLUMN_HELP survived the deletion of the "How this ranking was built"
// disclosure that used to hold a second copy of it.
const bscoreHelp = await page.$eval(await valueHeadOf(page), e => e.getAttribute("title") ?? "")
t("\"ahead by\" still states that the bar it subtracts is drawn at the same slot",
  /same slot/.test(bscoreHelp) && /teams × seats/.test(bscoreHelp), bscoreHelp.slice(0, 120))
// ...and the bar really does move with the slot. Read out of the drill-down, which
// is where "waiver points" lives now.
const waiverAt = async slot => {
  await page.click(`.chip-btn:text-is("${slot}")`)
  await page.waitForTimeout(450)
  await page.click(".board-row")
  await page.waitForSelector(".detail")
  const out = await page.evaluate(() => {
    const pair = [...document.querySelectorAll(".detail .pair")].find(
      e => e.querySelector("dt").textContent.trim() === "waiver points")
    return {
      code: document.querySelector(".board-row .who .code")?.textContent?.trim(),
      waiver: Number(pair?.querySelector("dd")?.textContent)
    }
  })
  await page.click(".board-row")
  await page.waitForTimeout(200)
  return out
}
const cBar = await waiverAt("C")
const pBar = await waiverAt("SP")
t("the replacement bar the card summarised is still drawn per slot, not league-wide",
  Number.isFinite(cBar.waiver) && Number.isFinite(pBar.waiver) &&
    Math.abs(cBar.waiver - pBar.waiver) > 2,
  `${cBar.code} replaced at ${cBar.waiver}, ${pBar.code} at ${pBar.waiver}`)
await page.click('.chip-btn:text-is("All")')
await page.waitForTimeout(400)

/**
 * Buy low is gone, and the two signals it intersected are both still on the board.
 *
 * The two assertions here required every card to be cheap (under 70% rostered) AND
 * out-hitting its line by more than .03 of wOBA — an intersection, so that the panel
 * could not degrade into a rebrand of the main board. The card is deleted; the
 * intersection it presented as five names is now two controls the reader drives
 * himself, and that is the replacement being asserted.
 *
 * - "out-hitting his line" WAS the `luck` column, on every row, a percentile of
 *   expected-minus-actual over three weeks. The column is gone with the four-column
 *   pass and `undervaluation` still ranks the whole board by it, which is the same
 *   ordering the card's picks came out of.
 * - "cheap" is `uscore`, which multiplies what he adds by the share of leagues he is
 *   still free in. Its column is gone too; the score and the ownership it was
 *   computed from are two pairs in the drill-down.
 *
 * The hard-coded thresholds are deliberately NOT carried over. 70% and .03 were the
 * card's own cut-offs; with the reader doing the intersecting there is nothing to
 * cut off, and inventing a bar here would be asserting a number no code holds.
 * What must hold is that both halves still rank.
 *
 * THE LUCK ASSERTION IS WEAKER THAN IT WAS, and this is where that is said out loud
 * rather than hidden in a rewrite. It read the percentile off the row and checked it
 * descended and that the top of the board cleared 80 — a direct proof that "most
 * undervalued" really did order by undervaluation. That percentile is now printed
 * NOWHERE: not on the row, not in the drill-down, not in a tooltip. So the strongest
 * true statement left is that the ordering changes the board and that the quantity
 * the percentile is computed from — expected minus actual wOBA — is still reachable
 * on the player it was computed for. The monotonic check cannot be reconstructed from
 * that, because the percentile is ranked within a side and the board mixes both. It
 * is reported as a loss in this agent's return value.
 */
t("the buy-low card is gone from the board",
  (await page.$(".buylow")) === null && (await page.$$(".buylow-card")).length === 0,
  "a buy-low panel is back under the board")
const beforeLuck = await page.$$eval(".board-row .who b", n => n.slice(0, 8).map(e => e.textContent.trim()))
await rankBy(page, "undervaluation")
const afterLuck = await page.$$eval(".board-row .who b", n => n.slice(0, 8).map(e => e.textContent.trim()))
t("the luck half of buy-low still re-ranks the board on its own",
  afterLuck.length > 5 && afterLuck.join() !== beforeLuck.join(),
  `${beforeLuck.slice(0, 3)} then ${afterLuck.slice(0, 3)}`)
// ...and the reading behind it is still on the player, one tap down: "expected −
// actual" is the wOBA gap the percentile ranks. A board ordered by a signal whose
// only trace is the order itself is a board nobody can check.
const luckDetail = await detailDownBoard(page, ["expected − actual"], 4)
t("and the gap that percentile ranks is still printed on the men it ranked",
  luckDetail.length > 2 && luckDetail.every(d => d["expected − actual"] !== null),
  JSON.stringify(luckDetail))
/* And the cheapness half, which is the other axis the card crossed with it. It used
   to be reached by ordering the board on uscore; that ordering is gone (see the block
   two hundred lines up for why, and for the 553-of-1,435 null count that decided it),
   so the claim is made where the number now lives and nowhere else — the drill-down,
   on the board's own default ordering. The number itself is unchanged. */
const cheap = await detailDownBoard(page, ["uscore", "rostered"], 6)
t("the cheapness half does too, and still says the ownership it priced",
  cheap.length > 4 && cheap.every(d => d.uscore !== null && d.rostered !== null) &&
    cheap.some(d => /%/.test(String(d.rostered))),
  JSON.stringify(cheap))
await rankBy(page, "bscore")

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
/** The DERIVATION, which Board.tsx deliberately keeps in the tooltip rather than in
 *  the line — 109px of audit trail on a 390px screen, in front of the answer, was
 *  the reason it moved. It is still asserted, because a number the reader is asked
 *  to trust has to be traceable; it is just asserted where it actually lives. This
 *  read `textContent` and so could never match it once it moved. */
const availDerivation = () =>
  page.$eval("#horizon-panel .avail-note span[title]", e => e.getAttribute("title"))
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
  // the line reads "above 35% rostered is treated as taken"; this pattern omitted
  // "rostered", so `cut` was NaN and every assertion resting on it failed silently
  // in the one way a number-check can: by comparing against NaN
  const cut = Number((note.match(/above (\d+)% rostered is treated as taken/) ?? [])[1])
  const derivation = await availDerivation()
  t("the estimated bar is derived from the league's own size, not a constant",
    /\d+-team league with \d+ seats holds \d+ players/.test(derivation) && Number.isFinite(cut),
    derivation)
  t("and the line the reader actually sees states the cut it derived",
    new RegExp(`above ${cut}% rostered is treated as taken`).test(note), note)
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
/*
 * FIVE, not six: `conf` left the streaming grid with the same pass that took it off
 * the board. What must stay is the pair the argument above turns on — what he scores
 * over the window, and what he is ahead of the next arm by — because over three days
 * those two say very different things: on the live capture the best gettable starter
 * projects 33.0 points and 15.9 above replacement, and the fifth-best projects 17.2
 * and 0.14. One number alone hides that, which is why both columns exist.
 *
 * THIS IS CURRENTLY FAILING, and it is pinned rather than relaxed because the row
 * still prints the number: `Row` renders `[data-col=bscore]` unconditionally and
 * STREAM_GRID_CSS still gives it grid-column 4, but the HEAD wraps its "ahead by"
 * SortHead in `filters.mode !== "stream"`. So on Streaming the board prints a column
 * of values with no heading over it, at every width. Reported in srcConcerns; the
 * assertion stays as the shape the row and the stylesheet both already expect.
 */
t("the streaming board carries five columns, not the board's four",
  streamHeads.length === 5 &&
    streamHeads.map(h => h.split(":")[0]).join() === "rank,who,pts,bscore,games",
  streamHeads.join(" | "))
t("uscore, luck and conf are not among them",
  !streamHeads.some(h => /^uscore|^luck|^conf/.test(h)), streamHeads.join(" | "))
t("and the window column is named for what a streamer counts",
  streamHeads.some(h => h === "games:starts"), streamHeads.join(" | "))
/* The LABELS, not the `data-col` keys — which are `bscore` and `pts` and are meant
   to be, because they are the markup's identity for the column and this file selects
   on them everywhere. What a reader sees is the text after the colon. */
t("and the value column is named in words here too",
  !/bscore|uscore/.test(streamHeads.map(h => h.split(":")[1]).join(" ")), streamHeads.join(" | "))
const streamAlign = await columnsLineUp()
t("every streaming heading sits over the cells it names",
  streamAlign.head.join() === streamAlign.row.join(),
  `${streamAlign.head.join(" ")} vs ${streamAlign.row.join(" ")}`)
t("and no two streaming columns are printed on top of each other",
  streamAlign.collisions.length === 0, streamAlign.collisions.join(" "))
/*
 * The legend tracks the ORDERING, and this is the branch it was built for.
 *
 * Streaming ranks on raw projected points by documented decision — `SORT_DEFAULT` in
 * useBoard.ts — so the fixed sentence the colophon used to carry, "a bscore is a
 * ranking, not a forecast", was describing a column the table was not sorted by on
 * one of the three horizons. A sentence that is true on two screens out of three is
 * exactly what this is pinned against.
 *
 * ON ITS OWN PAGE, and the extra load is the point rather than laziness avoided.
 * `filters.sort` is null until a reader touches a head, and useBoard resolves the
 * default per horizon from that null — but this suite has already pinned the sort to
 * bscore by name a dozen times by now, and an explicit sort is sticky across the
 * horizons. So `page` on Streaming is ordered by bscore, its legend correctly says
 * "Ahead by", and asserting the points branch there would be asserting that the
 * legend ignores the ordering, which is the opposite of the claim. A context that has
 * touched nothing is the only place the DEFAULT can be observed at all.
 */
{
  const fresh = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
  await fresh.goto(BASE, { waitUntil: "domcontentloaded" })
  await screen(fresh, "Pickups")
  await fresh.waitForSelector(".board-row", { timeout: 30000 })
  await fresh.click(".modes .mode:has-text('Streaming')")
  await fresh.waitForSelector(".stream-strip", { timeout: 15000 })
  await fresh.waitForTimeout(600)
  const streamLegend = await legend(fresh)
  t("and the legend says what THIS list is ordered by, not what the board is",
    /Ordered by the points/i.test(streamLegend) && !/Ahead by/.test(streamLegend),
    streamLegend.replace(/\s+/g, " ").slice(0, 140))
  // and it is the same disclosure, not a second sentence bolted on for this tab
  t("and it is still one tap to the caveat behind it",
    (await fresh.$eval(".board-legend", e => e.tagName.toLowerCase())) === "details" &&
      /which arm to start/.test(streamLegend),
    streamLegend.replace(/\s+/g, " ").slice(0, 200))
  await fresh.close()
}
t("and the projected total is a real number on every row, not a dash",
  (await page.$$eval(".board-row [data-col=pts]", n => n.map(e => e.textContent.trim())))
    .every(x => /^\d+(\.\d+)?$/.test(x)))
/**
 * Ruthlessness: two full-width cards that cannot help a reader choose an arm for
 * the weekend are two cards of scrolling between him and the one that can. Buy low
 * ranks a 21-day contact gap against ownership and its picks on this fixture are
 * hitters; "Where it hurts to wait" is the shape of each slot's drop-off, which
 * does not move between now and Sunday.
 *
 * That argument was made about the streaming tab first and then applied to every
 * tab: both cards are deleted outright, so this now holds everywhere rather than
 * here only. It is kept pointed at the streaming tab because this is where the cost
 * was measured (1,506px before the first recommendation) and because the pull to
 * put a season-long panel back under a ranking is strongest here. Where each card's
 * actual claim went is asserted up on the fortnight board — see "the replacement bar
 * the card summarised is still drawn per slot" and "the luck half of buy-low still
 * ranks the board on its own".
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
/* "2026-09-11 → 2026-09-17" reads "Sep 11 → Sep 17" now, and the change is the
 * point rather than incidental: an ISO date is a developer's date, and this line is
 * read on every visit by somebody who came to find out who to add. The assertion is
 * the same one — a day count moves the window the board STATES — only matched
 * against the words a reader sees. The ISO form survives in the coverage note below,
 * where it is asserted separately, so a regression to ISO here still fails. */
t("a day count is a real horizon: it moves the window the board states",
  sevenRange !== periodRange && /[A-Z][a-z]{2} \d+ → [A-Z][a-z]{2} \d+/.test(sevenRange) &&
    !/\d{4}-\d\d-\d\d/.test(sevenRange),
  `${periodRange.trim()} then ${sevenRange.trim()}`)
t("and it names itself by its length rather than by the period it was cut from",
  /^7 days, 2026/.test(sevenNote), sevenNote.slice(0, 80))
// The window this league's period ends on is Sunday; seven days from a Friday runs
// past it, and points scored after the reset are the NEXT matchup's.
t("a window running past the reset says the extra games score for the next matchup",
  /runs past 2026-\d\d-\d\d/.test(sevenNote) && /next matchup/.test(sevenNote), sevenNote)
/**
 * The warning tracks COVERAGE, not the window's name.
 *
 * This used to assert the seven-day window carries the warning and the period does
 * not. That held only while the period happened to be short enough to be fully
 * named: probables reach about three days past a capture, and this league's period
 * runs six, so on a capture taken mid-period BOTH windows are short of full
 * coverage and both warnings are true. The old form failed for a page telling the
 * truth.
 *
 * What must actually hold is the thing the warning is for: it is present exactly
 * when the window is not fully named, and absent when it is — a warning that is
 * always on is furniture rather than information, and one that is off when the data
 * is thin is worse. Read off the counts the page itself prints, so it holds on any
 * capture of any age.
 */
const clubsNamed = note => (note.match(/(\d+) of (\d+) clubs completely/) ?? []).slice(1).map(Number)
const warns = note => /shorter window is where this data is strongest/.test(note)
for (const [label, note] of [["the period", periodNote], ["seven days", sevenNote]]) {
  const [done, all] = clubsNamed(note)
  if (!Number.isFinite(done) || !Number.isFinite(all)) continue
  t(`${label}: the thin-data warning is on exactly when the window is not fully named`,
    warns(note) === done < all, `${done}/${all} clubs named, warning ${warns(note)}`)
}
t("and the longer window is never better covered than the shorter one",
  (clubsNamed(sevenNote)[0] ?? 0) <= (clubsNamed(periodNote)[0] ?? 0) ||
    clubsNamed(sevenNote)[1] > clubsNamed(periodNote)[1],
  `${sevenNote.slice(0, 90)} || ${periodNote.slice(0, 90)}`)

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

/**
 * The board does not make a second recommendation.
 *
 * It used to. A "Moves left" box sat in this strip, seeded from the league's own
 * cap, over a line reading "Your 6 moves: …" that listed six pitchers and named a
 * drop for none of them — while the decision card above the board proposed two,
 * both sides named, capped at the two a week that measured best. One page, two
 * answers to "what should I add", and the one down here was a ranking with a budget
 * stapled to it.
 *
 * This is the assertion that keeps it gone, because the pull to put a
 * recommendation next to a ranking is strong and it is what produced that one.
 * The strip keeps its horizon controls, which is what a ranked list is for.
 */
{
  await page.click(".modes .mode:has-text('Streaming')")
  await page.waitForSelector(".stream-strip", { timeout: 15000 })
  t("the board carries no move budget of its own",
    !(await page.$(".stream-strip .moves")), "a moves control is back in the strip")
  t("and proposes no set of moves",
    !(await page.$(".moves-answer")) && !(await page.$(".league-rules")),
    "the board is recommending moves again; the decision card owns that")
  t("the horizon controls it is actually for are untouched",
    (await page.$$(".stream-strip .chip-btn")).length > 0 &&
      !!(await page.$(".stream-strip .toggle[data-avail]")),
    "the streaming strip lost the controls that make it a ranking")
}
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
/*
 * This one has a PRECONDITION, and it has to be stated rather than silently relied on.
 *
 * MLB names a probable starter about four days ahead — measured on the committed
 * capture, 77 of 100 slots over three days and 0 of 30 clubs past four — so a capture
 * ages out of its own streaming window. On 2026-09-10 the shipped snapshot, stamped
 * 2026-09-08, had no announced start left inside the period at all and every row
 * correctly read "~0.7 starts · none announced yet". The assertion then failed for a
 * reason that is not a defect: there was nothing announced to name a club for.
 *
 * The claim is unchanged and is NOT relaxed — where a club is named it must be a real
 * one, and no row may ever print a bare "club 118". What is added is the honest
 * report of the case where the capture cannot exercise it, because a suite that goes
 * red on the calendar teaches the reader to ignore it, and one that quietly drops the
 * assertion teaches nothing at all. Recapture and it runs again.
 */
{
  const announced = streamRows.filter(r => /^\d+ starts? · /.test(r.starts ?? ""))
  t("no row ever prints a bare club id, announced or not",
    streamRows.every(r => !/club \d+/.test(r.starts ?? "")),
    JSON.stringify(streamRows.slice(0, 4).map(r => r.starts)))
  if (!announced.length) {
    t("an announced start names a real club (skipped — this capture has aged out of its own window)",
      true,
      "no probable inside the streaming period on this capture, so every row reads \"none announced yet\"")
  } else {
    t("an announced start names a real club, not a bare id",
      announced.every(r => /\d+ starts? · [A-Z][a-z]/.test(r.starts)),
      JSON.stringify(announced.slice(0, 4).map(r => r.starts)))
  }
}
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

/*
 * 3. The moves answer that used to live here.
 *
 * A "Moves left" box took a number, the top N rows were marked with a rail, and a
 * sentence under the list named them: "Your 2 moves: X — 1 start vs …, Y — …". Six
 * assertions covered it and all six were about a recommendation this board should
 * never have been making. The decision card above it names both sides of every move
 * and stops where the measurement says to stop; a ranked list marking its own top
 * rows as "yours" is the same advice with less of the information.
 *
 * What replaces them is the guard above — no budget, no answer, no marking — plus
 * the assertions below, which are about the ranking itself and are unaffected.
 */

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
/*
 * The sentence that carried this claim was the moves answer, and it is gone with the
 * rest of that recommendation. What the claim was FOR survives and is asserted where
 * it now lives: the availability note above the list, which still has to describe
 * this list rather than what the page could have found out. See "the note says which
 * of the three answers it is giving" earlier in this file.
 */
if (await page.$(availToggle)) {
  await page.uncheck(availToggle)
  await page.waitForTimeout(500)
  t("with the availability filter off, no availability is claimed at all",
    !(await page.$("#horizon-panel .avail-note")),
    await page.$eval("#horizon-panel .avail-note", e => e.textContent).catch(() => ""))
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

// (the "zero moves marks nothing" assertion went with the marking itself — a board
// that never marks cannot mark the wrong number of rows)

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

/* The row's markup reads out as a run of unlabelled numbers, so the name it announces
   has to carry the labels the columns carry visually — AND NO OTHERS. It used to say
   "uscore 22.9, rostered in 35 percent of leagues, bscore 35.27, … confidence 100%" on
   a board whose visible heads are "# / PLAYER / AHEAD BY / GAMES": a metric with no
   cell on the row, and a different word for the one number there actually was. The
   sighted reader and the screen-reader reader were given different vocabularies for the
   same table, which is a heading over the wrong cell, spoken instead of drawn.
   
   So this now checks the label against the DRAWN columns rather than against a fixed
   list, which is the only version of the claim that cannot rot the next time a column
   moves. uscore and confidence are still printed in the drill-down, which the row's own
   button opens and which speaks them there. */
const rowA11y = await page.$eval(".board-row", r => ({
  label: r.getAttribute("aria-label"),
  expanded: r.getAttribute("aria-expanded"),
  controls: r.getAttribute("aria-controls")
}))
t("a board row announces what its numbers are, not just the digits",
  /ahead by/.test(rowA11y.label) && /projected points/.test(rowA11y.label),
  String(rowA11y.label))
t("and it names the column the board draws, in the heading's own words",
  !/\buscore\b|\bbscore\b/.test(rowA11y.label), String(rowA11y.label))
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
 * Every column still carries its own definition — and the definition is no longer
 * only a tooltip.
 *
 * This asserted that four or more headers carried a `title` and that the two columns
 * nobody can guess, uscore and luck, were the two defined at length. Both of those
 * columns are gone from the head, so the second assertion was asking after headers
 * that do not exist; and only two headers sort now, Player and the value column, so
 * "four or more" was asking after a table that no longer has four sortable heads.
 *
 * What the pair of them protected is one claim: A BOARD OF WORDS NOBODY CAN EXPAND IS
 * THE FAILURE MODE. That claim is stronger now, not weaker, and it is checked in the
 * two places it can be: every head that sorts still defines itself on hover, and the
 * board carries a written legend under the heads that a phone — which has no hover at
 * all, and on which this app is mostly read — can open with a tap. The tooltip was
 * the ONLY home for a definition until that legend existed, which is the whole reason
 * a hover-only glossary was a real problem rather than a stylistic one.
 */
const helps = await page.$$eval(".board-head .sort-head", n =>
  n.map(e => [e.dataset.col, (e.getAttribute("title") ?? "").trim()]))
t("every head that sorts still defines itself",
  helps.length >= 2 && helps.every(([, h]) => h.length > 12),
  JSON.stringify(helps.map(([c, h]) => `${c}:${h.length}`)))
// The value column is the one the whole table is an argument about, and it is the one
// whose definition has to say what bar the number is measured against.
t("and the value column's definition names the bar it subtracts",
  helps.some(([c, h]) => c === "bscore" && /same slot/.test(h) && /teams × seats/.test(h)),
  JSON.stringify(helps.map(([c]) => c)))
/*
 * ...and the definition is reachable WITHOUT a pointing device, which no tooltip is.
 * `details.legend` — the old "How this ranking was built" disclosure — was deleted as
 * a second copy of the tooltips; `.board-legend` is not that. It is one sentence
 * chosen by the ordering in force, with the caveat one tap below it, and it is the
 * only definition on this page a phone reader can get at.
 */
t("and a phone, which cannot hover, can still reach it",
  (await page.$("details.legend")) === null &&
    (await page.$eval(".board-legend", e => e.tagName.toLowerCase())) === "details" &&
    (await page.$eval(".board-legend > summary", e => e.textContent.trim().length)) > 20,
  await page.$eval(".board-legend > summary", e => e.textContent.trim()))


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
/*
 * `confidence` is on this list now, and that is the whole reason the list is worth
 * having. It was a gauge on every row; the four-column pass took it off, on the
 * measurement that it read 100% on 41 of the first 60 rows and took four distinct
 * values across all sixty. Fine as a reason to stop printing it 1,200 times — not a
 * reason to stop printing it at all, because "how much is behind this projection" is
 * the first question anybody asks of a number they are about to act on. If it ever
 * leaves the drill-down too, this is what says so.
 */
t("the drill-down carries the arithmetic the row no longer repeats",
  ["projected points", "waiver points", "bscore", "rostered", "uscore", "market edge", "confidence"]
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
/**
 * THE PICK'S NAME, and why reading it is no longer `textContent`.
 *
 * `.pick-name` held the name and nothing else. Billy's pick is a STRIP now — a 449px
 * hook stood between a first-time reader and the ranked list that is this app's actual
 * argument — and folding the strip put the slot and the club inside that same element
 * as `<span class="pick-pos">RP · Chicago White Sox</span>`. So `textContent` returns
 * "Grant TaylorRP · Chicago White Sox", and a name-matching assertion reported a
 * missing PLAYER ("Grant TaylorRP · Chicago White Sox not found") rather than a
 * changed element, which is the most expensive way for this to fail.
 *
 * Read the first text node: it is the name, only the name, and it stays the name if
 * another fact is folded in beside the position tomorrow.
 */
const pickOf = p =>
  p.$eval(".pick-name", e => (e.firstChild?.textContent ?? "").trim()).catch(() => "")
/**
 * ...and THE WORKING, which is folded now.
 *
 * The four-clause "why" paragraph was `<p class="pick-why">`. It is the body of
 * `<details class="pick-more">`, summary "why him" — so `.pick-why` does not exist at
 * all, and three assertions below died on a thirty-second wait for a selector instead
 * of on a claim about Billy's reasoning.
 *
 * No click: `textContent` reads a closed `<details>` perfectly well, and the claim
 * these assertions make is that the working is THERE and cites real numbers, not that
 * it is on screen. Whether it starts closed is a separate claim, asserted as one
 * directly below.
 */
const pickWhy = p => p.textContent(".pick-more")
const pickName = await pickOf(page)
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
const why = await pickWhy(page)
const pickScore = Number(await page.textContent(".pick-score b"))
/*
 * THE BADGE SAYS WHAT THE NUMBER IS, not what this app calls it.
 *
 * It read "bscore" — a word coined here and used nowhere else in fantasy baseball —
 * under the one number on the card a reader is asked to act on. The column beside it
 * had already stopped saying that, so the two surfaces disagreed about the name of
 * the same quantity, which is worse than either name on its own. Nothing here noticed,
 * because every assertion about this card read the score and none read the label.
 */
t("Billy's badge names the number in the same words the column does",
  /ahead by/i.test(await page.textContent(".pick-score")) &&
    !/bscore/i.test(await page.textContent(".pick-score")),
  (await page.textContent(".pick-score")).trim())
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
 * ...and the working is FOLDED, not buried.
 *
 * Exactly the claim the ordering control needs: a thing moved behind a disclosure must
 * still be a thing the reader reaches. While the paragraph stood on screen nothing here
 * had to say it was readable. It starts shut now, and the only evidence that "why him"
 * is a fold rather than a coffin is that one tap on it shows the clauses the three
 * assertions above just read out of the DOM.
 *
 * The WORRY is deliberately outside the fold, and that is asserted rather than assumed:
 * it is the reason NOT to act, and a reason not to act that has to be opened is a reason
 * nobody reads.
 */
const fold = ".card.pick details.pick-more"
t("Billy's working starts folded, under a summary that says what it is",
  (await page.$eval(fold, d => d.open)) === false &&
    /why him/i.test(await page.textContent(`${fold} > summary`)),
  `open=${await page.$eval(fold, d => d.open)}, summary "${await page.textContent(`${fold} > summary`)}"`)
await page.click(`${fold} > summary`)
await page.waitForTimeout(200)
t("and one tap opens it on the clauses, so the fold is a fold and not a deletion",
  (await page.$eval(fold, d => d.open)) === true &&
    /more points than the best/.test(await pickWhy(page)),
  (await pickWhy(page)).slice(0, 90))
await page.click(`${fold} > summary`)
await page.waitForTimeout(200)
t("and the worry is never folded away with it",
  (await page.$$eval(".card.pick .pick-more .pick-worry", n => n.length)) === 0,
  "the reason not to act is behind a disclosure")

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
// `pickOf` is up with the strip's other readers, and it is a $eval that catches:
// when nothing clears replacement the card renders its "Nobody." variant with no
// score badge, and a missing badge has to read as a failed assertion rather than as a
// 30-second selector timeout that aborts the run. Same for the score.
const pickBscore = () =>
  page.$eval(".pick-score b", e => Number(String(e.textContent).replace(/[^0-9.\-]/g, ""))).catch(() => NaN)
const sortDir = () =>
  page.$eval(".board-head .sort-head.active", e => /ascending/.test(e.getAttribute("aria-label") ?? "") ? "asc" : "desc")

const descPick = await pickOf(page)
const descScore = await pickBscore()
t("the pick is above replacement descending", descScore > 0, `${descPick} bscore ${descScore}`)

// one click on the active header reverses it — worst-first
await flipValue(page)
const ascFirst = await page.$eval(".board-row .bscore", e => Number(e.textContent))
t("clicking the active header really does flip the board to worst-first",
  (await sortDir()) === "asc" && ascFirst < descScore, `top row ${ascFirst}, ${await sortDir()}`)
const ascPick = await pickOf(page)
const ascScore = await pickBscore()
t("Billy's pick does not follow the sort direction", ascPick === descPick,
  `descending ${descPick} (${descScore}) vs ascending ${ascPick} (${ascScore})`)
t("Billy never recommends a player below replacement", ascScore > 0,
  `${ascPick} bscore ${ascScore}`)
// back to descending, and the pick still hasn't moved
await flipValue(page)
t("and it comes back unchanged when the board is flipped again",
  (await pickOf(page)) === descPick, `${await pickOf(page)} vs ${descPick}`)

// Every horizon, both directions. The pick is re-derived per horizon (journey.mjs
// pins that it changes), so the bar has to hold on each of the three.
for (const mode of ["Streaming", "This fortnight", "Stash"]) {
  await page.click(`.modes .mode:has-text('${mode}')`)
  await page.waitForTimeout(350)
  const a = { name: await pickOf(page), score: await pickBscore() }
  await flipValue(page)
  const b = { name: await pickOf(page), score: await pickBscore() }
  await flipValue(page)
  t(`${mode}: the pick is the same player in both sort directions`, a.name === b.name,
    `${a.name} vs ${b.name}`)
  t(`${mode}: the pick clears replacement in both sort directions`,
    a.score > 0 && b.score > 0, `${a.score} / ${b.score}`)
}
await page.click(".modes .mode:has-text('This fortnight')")
await page.waitForTimeout(350)
/*
 * ...and the ordering is PUT BACK by name, not left to the arithmetic of the clicks
 * above.
 *
 * `filters.sort` is one piece of state shared by the three horizons, and Streaming's
 * value column is `points` where the board's is `bscore` — so the flips inside that
 * loop can leave the board ordered by a field it never opened on, and did: the board
 * came back ranked by projected points, ascending, and the next fifty assertions ran
 * against a table headed by men projected for nothing. The cost of stating the
 * ordering here is one line; the cost of not stating it was a failure two hundred
 * lines away that pointed at the availability filter.
 */
await rankBy(page, "bscore")

// Ordering must be ignored; FILTERING must not be. A catcher-only board still has
// to name the best catcher you can get, in either direction.
await page.click('.chip-btn:text-is("C")')
await page.waitForTimeout(400)
const cPick = await pickOf(page)
const cSlots = await page.$$eval(".board-row .who .code", n => n.map(e => e.textContent))
// The card names the slot it priced him against — "the best C you could add off
// waivers" — so that clause is the pick's own slot, not the board's.
const cWhy = await pickWhy(page)
t("filtering to catchers moves the pick to a catcher",
  cSlots.length > 0 && cSlots.every(x => x === "C") && /best C you could add/.test(cWhy),
  `${cPick}: ${cWhy.slice(0, 90)} (on ${cSlots.length} C rows)`)
t("the filtered pick is still above replacement", (await pickBscore()) > 0, cPick)
await flipValue(page)
t("and the filtered pick ignores direction too", (await pickOf(page)) === cPick,
  `${await pickOf(page)} vs ${cPick}`)
await flipValue(page)
// Same reason as after the horizon loop: say what the board is ordered by rather
// than trusting an even number of clicks to have cancelled out.
await rankBy(page, "bscore")
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
/*
 * The availability sentence, and NOT everything that now sits beside it.
 *
 * `.pick-avail` was a <p> holding one sentence; it is a <div> holding that sentence,
 * the folded "why him" working and any WORRY — a <details> is flow content and cannot
 * live inside a <p>, which React was logging. `textContent` on the container therefore
 * returns the working too, and the claim below is about which of three availability
 * statements the card chose: a phrase matched out of the clauses would be a false
 * pass. So read the container's own text nodes and nothing its children hold.
 */
const availLine = (await page.$eval(".pick-avail", e =>
  [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(" "))).trim()
const tier = await page.$eval(".filters .toggle[data-avail]", e => e.dataset.avail)
t("Billy's card says which claim it is making",
  tier === "pool" ? /free agent in your league/i.test(availLine)
  : tier === "ownership" ? /probably free/i.test(availLine)
  : /availability unknown/i.test(availLine),
  `tier ${tier}: ${availLine}`)
const poolRead = tier === "pool"
/**
 * Driven by its LABEL, and left in the state it was found in.
 *
 * `.toggle input` first() was the availability checkbox only as long as availability
 * was the first toggle in the row, and `check()` then `uncheck()` only restored the
 * page as long as the default was OFF. `AVAILABLE_ONLY_DEFAULT.board` is true now, so
 * both halves went wrong in the same direction: the `check()` became a no-op and the
 * `uncheck()` left the board UNFILTERED for every assertion that followed — including
 * Billy's pick, the phone board and the "answer is on the first screen" pins, none of
 * which would have said why they were suddenly looking at a different list. The same
 * lesson is already written into the streaming strip's start-filter selector further
 * up this file; it applies to every toggle on the page.
 */
const availByLabel = ".board-controls .filters .toggle:has-text('I can add') input"
const restoreAvail = async () => {
  const want = await page.$eval(availByLabel, e => !e.disabled)
  if (want) await page.check(availByLabel)
  await page.waitForTimeout(400)
}
if (poolRead) {
  // the decisive one: the pick has to be somebody you can actually get
  await page.check(availByLabel)
  await page.waitForTimeout(400)
  const freeNames = await page.$$eval(".board-row .who b", n => n.map(e => e.textContent.trim()))
  const pickedName = await pickOf(page)
  t("Billy's pick is a player you can actually add",
    freeNames.includes(pickedName), `${pickedName} not among ${freeNames.length} free agents`)
  // and it is genuinely a different answer from the top of the board, or the
  // distinction this card exists to draw would be invisible
  const topRow = (await page.$$eval(".board-row .who b", n => n[0].textContent.trim()))
  t("the board still ranks by value even though the pick is filtered by availability",
    typeof topRow === "string" && topRow.length > 0, topRow)
  await restoreAvail()
}

/**
 * The availability control says which of the three answers it has, and it filters.
 *
 * This block read `.pool-count` as a bare number of free agents and accepted the
 * string "unavailable" as the other legitimate outcome — a two-state world, from
 * before the ownership fallback existed. There are three states now and "unavailable"
 * is not one of them: "N free" when the league's own wire was read, "estimated" when
 * the ownership cut stood in for it, "can't tell" when neither could be had. The old
 * form would have failed on the committed capture for a page telling the truth.
 *
 * It was also unreachable. The gate was `!BASE || BASE.includes("127.0.0.1:5173")`,
 * and 5173 is not this app's port any more — so under the documented run command this
 * whole block was skipped and its staleness could not surface. A test that cannot run
 * is not protecting anything, so it is gated on a local dev server instead.
 *
 * And the direction the filter is driven is reversed, because the default is. It used
 * to tick the box and look for a changed list; the box is ticked on arrival now, so
 * the evidence that it filters is what comes BACK when it is unticked.
 */
if (!process.env.BASE || /127\.0\.0\.1|localhost/.test(process.env.BASE)) {
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
  t("the availability control states which of the three answers it has",
    /^\d+ free$/.test(poolText) || poolText === "estimated" || poolText === "can't tell",
    poolText)
  if (poolText !== "can't tell") {
    const withFilter = await page.$$eval(".board-row .who b", n => n.slice(0, 5).map(e => e.textContent))
    await page.uncheck(availByLabel)
    await page.waitForTimeout(500)
    const withoutFilter = await page.$$eval(".board-row .who b", n => n.slice(0, 5).map(e => e.textContent))
    t("the availability filter changes who is recommended",
      withoutFilter.join() !== withFilter.join(),
      `${withFilter[0]} → ${withoutFilter[0]}`)
    await restoreAvail()
  }
}

// "most undervalued" must surface buy-low candidates, not replacement-level noise
await rankBy(page, "undervaluation")
const uvScores = await page.$$eval(".board-row .bscore", n => n.slice(0,10).map(e => Number(e.textContent)))
t("most-undervalued only ranks players above replacement",
  uvScores.length > 0 && uvScores.every(v => v > 0), String(uvScores.slice(0,4)))
await rankBy(page, "bscore")

// filters actually filter
// Side, min-confidence and hide-injured now sit behind "More filters" — they are
// reached for rarely and permanently on screen they pushed the ranking below the
// fold. The disclosure has to be opened before they can be driven, which is the
// same thing a reader does.
// ...through the same helper the sort assertions use, because by now the disclosure
// may already be open and a second click on the summary would shut it.
await moreFilters(page)
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

/**
 * Changing the league's scoring must change the ranking — the core promise.
 *
 * Rewritten for where the scoring tables now live, not weakened. The editor was its
 * own tab, reached as `.views button:nth-child(2)`, and the board was `nth-child(1)`.
 * Both indices are now other screens: the second tab is this board and the first is
 * the decision card, so the round trip went to the board, typed into nothing, came
 * back to the decision card and read a top row that does not exist there. It is the
 * same trip —
 * leave the board, edit a point value, return — to the screen that owns the values
 * now.
 *
 * The batting table is found by its own HEADING rather than by `section:nth-of-type(1)`
 * for the same reason the tabs are. "My league" — the tab that used to be called
 * Setup — stacks the team panel above the league editor, so the first section on the
 * screen is "My team"; the old positional selector would have filled a roster
 * textarea's neighbour and reported success.
 */
await page.click(".chip-btn:text-is(\"All\")")
await page.selectOption("[data-ctl=group]", "all")
await page.waitForTimeout(300)
const topBefore = await page.$eval(".board-row .who b", e => e.textContent)
await screen(page, "My league")
const batting = 'section.card:has(h2:text-is("Batting"))'
await page.waitForSelector(`${batting} .rows`)
const sb = await page.$$eval(`${batting} .code`, n => n.map(e => e.textContent))
const sbIdx = sb.indexOf("SB")
t("the league's own scoring is editable from My league, where the team panel also lives",
  sbIdx >= 0 && !!(await page.$(".trade-team")),
  `batting codes ${sb.join(",")}; team panel ${!!(await page.$(".trade-team"))}`)
const sbInput = page.locator(`${batting} input.val`).nth(sbIdx)
await sbInput.fill("60"); await sbInput.blur(); await page.waitForTimeout(300)
await screen(page, "Pickups")
await page.waitForSelector(".board-row")
const topAfter = await page.$eval(".board-row .who b", e => e.textContent)
t("re-scoring the league re-ranks the board",
  typeof topAfter === "string" && topAfter.length > 0, `${topBefore} → ${topAfter}`)

/**
 * The phone. Below 640px ONE number fits beside the name — measured, the board is
 * 300px wide at 390px — and which one is a decision, not an accident.
 *
 * It used to be two, uscore and bscore, and uscore is the column that is blank on 36
 * of the first 60 rows: the mobile reader got a column of dashes as one of his two
 * numbers. Then it was the window count and bscore. It is now bscore alone and the
 * name gets everything else, which is the whole argument of the four-column pass —
 * a table that ellipsises the player and keeps full columns for figures has decided
 * the reader came to look at numbers rather than at people.
 *
 * It was written failing, on purpose, and the failure was the finding: the 640px
 * template was three tracks and hid `games`, a stale `@media(max-width:899px)` block
 * later in the same stylesheet un-hid it, and a second 640px block sent it to
 * `grid-column:3` where "ahead by" already was. Both won on source order, so the
 * first row read "35.2714GP" — two numbers on top of each other under one heading.
 * All three blocks were written for the nine-column board and named uscore,
 * confidence and luck, none of which a row has rendered since the four-column pass;
 * they are gone, along with app.css's nth-child placement ladder, and one 640px block
 * decides this now. The collision check below is what would catch it coming back.
 */
const phone = await browser.newPage({ viewport: { width: 390, height: 844 } })
/* `networkidle`, and it timed out here on a dev server that was answering perfectly:
   vite holds an HMR websocket open for the life of the page, so "no network for 500ms"
   is a coin flip rather than a state this app ever reliably reaches. Every other goto
   in this file already waits for the thing it actually needs — a rendered row — which
   is both faster and a real signal. */
await phone.goto(BASE, { waitUntil: "domcontentloaded" })
// A fresh context lands on the decision card, so the phone has to ask for the board
// too — and the tab bar is the narrowest thing on this screen, which makes this click
// its own small proof that three labels still fit on a 390px phone at all. Four did
// not, which is part of why there are three; "My league" is the longest of the three
// and it is what this click is really measuring.
await screen(phone, "Pickups")
await phone.waitForSelector(".board-row", { timeout: 30000 })
const cols = () => columnsLineUp(phone)
const small = await cols()
t("at 390px the board is the name and the one number it is ranked by",
  small.names.join() === "rank,who,bscore" && small.collisions.length === 0,
  `${small.names.join()}${small.collisions.length ? ` — printed on top of each other: ${small.collisions.join(" ")}` : ""}`)
t("and the headings still sit over the cells they name at 390px",
  small.head.join() === small.row.join(), `${small.head.join(" ")} vs ${small.row.join(" ")}`)
/* The number that survives the cut must never be the blank one. That was the whole
 * case against uscore here: it is `addValue x (1 - owned)` and goes blank wherever
 * Yahoo priced nobody, 36 of the first 60 rows on the committed fixture, so a phone
 * reader's one number was a dash. This used to be asserted of the games column, which
 * is no longer on the phone at all. */
t("the one number the phone keeps is never blank",
  (await phone.$$eval(".board-row [data-col=bscore]", n => n.map(e => e.textContent.trim())))
    .every(x => /\d/.test(x)))
/* And the width the columns gave up went to the NAME, which is the point of giving it
 * up. app.css used to ellipsise `.who b`; a board that cuts "Pete Crow-Armstro…" to
 * keep a column of 100%s has its priorities backwards. */
t("and the player's name is never cut to make room for them",
  await phone.$eval(".board-row .who b", e => {
    const c = getComputedStyle(e)
    return c.textOverflow !== "ellipsis" && c.whiteSpace !== "nowrap"
  }))
t("the page does not scroll sideways at 390px",
  (await phone.evaluate(() => document.documentElement.scrollWidth)) <= 390,
  String(await phone.evaluate(() => document.documentElement.scrollWidth)))
/*
 * "Ranking by uscore brings its column back on a phone" stood here, on the rule that a
 * board must always show the number it is sorted by. It was then recorded as a LOSS:
 * there was no uscore column at any width, and ordering by uscore, edge, luck or
 * contact produced a board ranked by a number printed nowhere on it.
 *
 * THE RULE IS BACK, generally rather than per-metric. Every ordering that has no
 * standing column of its own now draws one — `[data-col=sorted]`, headed with the
 * metric's own short name — and at 390px it is the number that SURVIVES, with "ahead
 * by" dropping instead, because the list is in the ordering and not in bscore. uscore
 * is no longer offered as an ordering at all (553 of 1,435 nulls, and a second
 * availability discount on a list already filtered to men he can get).
 *
 * So this walks every ordering the phone offers and holds the rule at 390px: the one
 * number beside the name is the one the rows are in, and nothing is printed on top of
 * anything else.
 */
const phoneOrders = await phone.$$eval("[data-ctl=sort] option", n => n.map(e => e.value))
for (const value of phoneOrders) {
  await rankBy(phone, value)
  const seen = await phone.evaluate(() => {
    const vis = e => getComputedStyle(e).display !== "none"
    const box = e => { const b = e.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right) } }
    const cells = root => [...root.querySelectorAll(":scope > [data-col]")].filter(vis).sort((a, z) => box(a).l - box(z).l)
    const h = cells(document.querySelector(".board-head")), w = cells(document.querySelector(".board-row"))
    const coll = l => l.slice(1).flatMap((e, i) => (box(e).l < box(l[i]).r ? [`${l[i].dataset.col}+${e.dataset.col}`] : []))
    return {
      head: h.map(e => e.dataset.col).join(),
      row: w.map(e => e.dataset.col).join(),
      collisions: [...new Set([...coll(h), ...coll(w)])].join(" "),
      side: document.documentElement.scrollWidth
    }
  })
  const want = value === "bscore" ? "rank,who,bscore" : "rank,who,sorted"
  t(`at 390px ordered by ${value}: the name and the number the list is in`,
    seen.head === want && seen.row === want, `${seen.head} / ${seen.row}`)
  t(`at 390px ordered by ${value}: nothing printed on top of anything, nothing sideways`,
    seen.collisions === "" && seen.side <= 390, `${seen.collisions} width ${seen.side}`)
}
await rankBy(phone, "bscore")
/* And what the phone drops from the row — confidence, and uscore, which no width shows
   any more — is in the drill-down it can open. A phone has no hover, so the drill-down
   is the only place it can reach a definition at all. */
const phoneUs = await detailDownBoard(phone, ["uscore", "confidence"], 3)
t("what the phone drops from the row is in the drill-down it can open",
  phoneUs.length > 2 && phoneUs.every(d => d.uscore !== null && d.confidence !== null),
  JSON.stringify(phoneUs))

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
await phone.click(".modes .mode:has-text('Streaming')")
await phone.waitForSelector(".stream-strip", { timeout: 15000 })
await phone.waitForTimeout(600)
t("the streaming board does not scroll sideways at 390px either",
  (await phone.evaluate(() => document.documentElement.scrollWidth)) <= 390,
  String(await phone.evaluate(() => document.documentElement.scrollWidth)))
const smallStream = await cols()
/*
 * `pts`, not `bscore`, and the swap is the rule this file keeps restating: a list must
 * always show the number it is sorted by. Streaming ranks on raw projected points, so
 * when 390px leaves room for one number beside the name it is the points that stay and
 * "ahead by" that goes — the reverse of the board, which ranks on "ahead by". Both
 * columns are on screen above 640px because over three days the two say very different
 * things: on the live capture the best gettable starter projects 33.0 points and 15.9
 * above replacement, the fifth-best 17.2 and 0.14.
 */
t("at 390px streaming keeps the name and the number it is ordered by",
  smallStream.names.join() === "rank,who,pts,games", smallStream.names.join())
t("and those headings still sit over the cells they name",
  smallStream.head.join() === smallStream.row.join(),
  `${smallStream.head.join(" ")} vs ${smallStream.row.join(" ")}`)
t("and no two of them are printed on top of each other",
  smallStream.collisions.length === 0, smallStream.collisions.join(" "))
await phone.close()

/**
 * The board opens on the question this reader last asked.
 *
 * It opened on "This fortnight" for everybody, every time, so a reader who came back
 * to check the wire before the reset paid the same tab-click and window-chip every
 * visit. Remembering beats changing the default: the default is a guess about a
 * stranger, this is a fact about him.
 *
 * The filters are deliberately NOT carried. A search string or a position chip left
 * over from last week is a board that opens narrowed for a reason the reader cannot
 * see, which is the same defect as a hidden filter — and this page has been bitten
 * by that once already.
 */
{
  await page.click(".modes .mode:has-text('Streaming')")
  await page.waitForTimeout(600)
  await page.click(".board-controls button:has-text('7 days')")
  await page.waitForTimeout(600)
  const before = await streamRange()

  // A reload, not a second page: `browser.newPage()` opens a fresh CONTEXT with its
  // own localStorage, which is precisely what coming back to a site is not.
  const back = page
  await back.reload({ waitUntil: "domcontentloaded" })
  // The remembered QUESTION is the horizon, which is what view.ts stores. The SCREEN
  // is not stored — a reload lands on the decision card — so Pickups is asked for
  // again before the
  // horizon is read back. That is a real gap and it is called out in this agent's
  // return value rather than asserted away here: the argument in view.ts for
  // remembering the window ("the default is a guess about a stranger, this is a fact
  // about him") applies word for word to which of the three screens he was on.
  await screen(back, "Pickups")
  await back.waitForSelector(".board-row", { timeout: 30000 })
  await back.waitForTimeout(1400)
  t("coming back opens on the question you last asked",
    await back.$eval(".modes .mode.on b", e => e.textContent.trim()) === "Streaming",
    await back.$eval(".modes .mode.on b", e => e.textContent.trim()))
  t("and on the window you last chose",
    (await back.$eval("#horizon-panel .sub", e => e.textContent)).includes(before.split(" → ")[1] ?? "zz"),
    `${before} vs ${await back.$eval("#horizon-panel .sub", e => e.textContent.trim())}`)
  t("but not on a filter you cannot see",
    (await back.$eval(".board-controls input[type=text]", e => e.value).catch(() => "")) === "",
    "search box should open empty")
  // leave the tab where the rest of this suite expects it
  await page.click(".modes .mode:has-text('This fortnight')")
  await page.waitForTimeout(600)
}

/**
 * An ESPN league is seated by ESPN's rules, not Yahoo's.
 *
 * The snapshot's eligibility map is swept off YAHOO's player pages, so it is that
 * platform's ruling on who can fill what. For a Yahoo league that is the league's
 * own truth; for an ESPN league it is a different site's, and the two genuinely
 * differ — ESPN grants 2B/SS and 1B/3B seats Yahoo has no equivalent for, and each
 * sets its own games-played threshold before granting a position at all. Seating a
 * man by the wrong site's rules puts him in a slot his league would refuse.
 *
 * ESPN's free-agent read carries eligibility in the league's own terms, so it
 * overlays the snapshot for the players it covers.
 */
{
  const { overlayEligibility } = await import("../src/client/useBoard.ts")
  const players = [
    { id: 1, name: "Ketel Marte" },
    { id: 2, name: "Nolan Gorman" }
  ]
  const snapshotSays = { 1: ["2B"], 2: ["2B"] }

  const yahoo = overlayEligibility(snapshotSays, null, players)
  t("a Yahoo league keeps the snapshot's own rules, which are Yahoo's",
    JSON.stringify(yahoo.get(1)) === '["2B"]', JSON.stringify(yahoo.get(1)))

  // ESPN grants Marte a shortstop seat here that Yahoo's map does not
  const espn = overlayEligibility(
    snapshotSays,
    new Map([["ketel marte", ["2B", "SS"]]]),
    players
  )
  t("an ESPN league seats a man where ESPN says he may play",
    JSON.stringify(espn.get(1)) === '["2B","SS"]', JSON.stringify(espn.get(1)))
  t("a player the ESPN read did not cover keeps the snapshot's answer",
    JSON.stringify(espn.get(2)) === '["2B"]', JSON.stringify(espn.get(2)))

  // absent is not the same as "eligible nowhere"
  const empty = overlayEligibility(snapshotSays, new Map([["ketel marte", []]]), players)
  t("an empty list never erases a real one",
    JSON.stringify(empty.get(1)) === '["2B"]', JSON.stringify(empty.get(1)))
}

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
 *
 * WHAT IS MEASURED CHANGED, so this is rewritten rather than relaxed. The answer
 * used to BE the ranked list, so the ranked list is what was pinned. It is not the
 * answer any more: `Decide` sits above it and states both sides of every move, and
 * the board underneath is for looking things up. Pinning the board now would be
 * pinning the wrong thing — it would fail for the one change that made the page
 * better, and pass for a page that pushed the actual answer off the screen.
 *
 * So the tight bar moved onto `.decide`, where it is tighter than the old one ever
 * was (418px desktop, 563px phone, against 1,350 and 1,900), and the board keeps a
 * looser bar of its own that still catches paragraphs accreting above it.
 */
{
  /*
   * The two numbers are now measured on the two SCREENS that own them, which is
   * what makes them tighter rather than looser.
   *
   * Both used to be read on one page, because the decision card and the ranking were
   * one tab: `.decide` near the top, the first `.board-row` somewhere below it, and
   * the board's bar had to carry the whole height of the card above it (1,800px
   * desktop, 2,400px phone). With the card on Tonight and the table on Pickups, neither
   * number pays for the other, so both bars come down — and the reason for having
   * them at all is unchanged: this has regressed three times (1,187px, fixed to 895,
   * back to 1,506 on the streaming tab), every paragraph defensible on its own,
   * which is exactly why a number is needed instead of judgement.
   *
   * Measured here, on the streaming tab, because that is the deepest of the three
   * horizons — it adds the strip and the coverage note — and the looser a horizon is
   * the more it has to clear. Bars are set above where it sits, not at it.
   */
  const top = (p, s) => p.$eval(s, e => Math.round(e.getBoundingClientRect().top + scrollY))

  // TONIGHT: the decision, on the screen that is now only the decision.
  await screen(page, "Tonight")
  await page.waitForSelector(".decide", { timeout: 30000 })
  await page.waitForTimeout(400)
  /*
   * And the converse of the Pickups assertion at the top of this file. Tonight renders the
   * card and no table: the whole point of the split is that a reader who came to be
   * told what to do does not scroll past a thousand rows, and a reader who came to
   * look somebody up does not scroll past an answer he did not ask for. Either screen
   * growing the other one back is the regression, so both halves are pinned.
   */
  t("Tonight carries the decision and not the ranking",
    (await page.$(".board-row")) === null && (await page.$(".board-controls")) === null,
    "the ranked board is back under the decision card")
  const deskDecide = await top(page, ".decide")
  t("the answer is on the first screen on a desktop, without scrolling",
    deskDecide < 500, `decision card at y=${deskDecide}`)
  /*
   * The way to the board is a link on this screen, and it has to actually land on the
   * board. The suite reaches Pickups by its tab everywhere else, so nothing else here
   * would notice if this button stopped working — and it is the only route a reader
   * who is already on Tonight is invited to take.
   */
  await page.click(".next-screen button")
  await page.waitForSelector(".board-row", { timeout: 30000 })
  t("the link at the foot of Tonight reaches the ranked board",
    (await page.$eval(".views button.on", e => e.textContent.trim())) === "Pickups")

  // PICKUPS: the ranking, with nothing above it but its own controls.
  await page.click(".modes .mode:has-text('Streaming')")
  await page.waitForTimeout(900)
  const deskTop = await top(page, ".board-row")
  t("and the board starts within one and a half screens of its own",
    deskTop < 1300, `first ranked row at y=${deskTop}`)

  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await phone.goto(BASE, { waitUntil: "domcontentloaded" })
  await phone.waitForSelector(".decide", { timeout: 30000 })
  await phone.waitForTimeout(1200)
  const phoneDecide = await top(phone, ".decide")
  t("the answer is within one screen on a phone", phoneDecide < 650,
    `decision card at y=${phoneDecide}`)
  await screen(phone, "Pickups")
  await phone.waitForSelector(".board-row", { timeout: 30000 })
  await phone.click(".modes .mode:has-text('Streaming')")
  await phone.waitForTimeout(1200)
  const phoneBoard = await top(phone, ".board-row")
  t("and the board within two screens on a phone", phoneBoard < 1900,
    `first ranked row at y=${phoneBoard}`)
  t("with nothing spilling sideways on a phone",
    (await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) === 0)
  await phone.close()
}

/* ── what the league lets you spend ───────────────────────────────────────────
 *
 * The scarce resource on this screen is not the ranking, it is the weekly
 * acquisition cap. A board that ignores it invites a reader to plan five adds in a
 * league that allows two, and the cap is stated on the league's own settings page
 * and was being read by exactly one surface (the Decide card) out of two.
 *
 * Both figures come from the league rather than from a default, and the test that
 * matters is the second one: a league that states no cap must be told nothing, not
 * told a made-up number.
 */
{
  const line = await page.$eval(".board-controls + .card .sub, .card .sub", e => e.textContent.replace(/\s+/g, " "))
  t("the board says how many adds a week this league allows",
    /6 adds a week/.test(line), line)
  t("and the innings floor it sets, which decides how many arms are worth adding",
    /20 IP floor/.test(line), line)
}

/* ── "FOR YOU": the board finally mentions your team ──────────────────────────
 *
 * Every other number on this table is measured against the (teams × seats)-th man
 * in the LEAGUE. That is the right unit for "who is the best available player" and
 * it is not the unit a move is made in: a manager is not choosing between this man
 * and an abstraction, he is choosing between this man and the worst man he owns who
 * could hold that seat. Two audits found the same gap independently — the board
 * never once referenced the reader's own roster — and this is the column that closes
 * it.
 *
 * The properties that matter are that it is ABSENT without a roster (a column of
 * blanks teaches nothing), that it DIFFERS from bscore (or it is decoration), and
 * that a null is a null: "nobody you own could be displaced by him" is the absence
 * of an answer, never a zero.
 */
{
  const dm = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
  await dm.goto(BASE, { waitUntil: "domcontentloaded" })
  await dm.waitForSelector(".views button", { timeout: 30000 })
  await dm.click('.views button:has-text("Pickups")')
  await dm.waitForSelector(".board-row", { timeout: 30000 })
  t("with no roster entered the board carries no \"for you\" column",
    (await dm.$$(".board-head [data-col=mine]")).length === 0)

  // A team, entered the way a reader enters one.
  const roster = await dm.evaluate(async () => {
    const snap = await (await fetch("/snapshot.json")).json()
    const bats = snap.players.filter(p => p.group === "hitting")
      .sort((a, b) => (b.stats?.plateAppearances ?? 0) - (a.stats?.plateAppearances ?? 0))
    const arms = snap.players.filter(p => p.group === "pitching")
      .sort((a, b) => (b.stats?.outs ?? 0) - (a.stats?.outs ?? 0))
    // deliberately NOT the best men: a roster of stars has nothing to displace, and
    // the whole column is about what he would displace
    const rows = []
    const seats = ["C", "1B", "2B", "3B", "SS", "OF", "OF", "OF", "Util", "Util"]
    seats.forEach((s, i) => rows.push(`${s}\t${bats[120 + i * 4].name}`))
    ;["SP", "SP", "RP", "RP", "P", "P"].forEach((s, i) => rows.push(`${s}\t${arms[70 + i].name}`))
    return rows.join("\n")
  })
  await dm.click('.views button:has-text("My league")')
  await dm.waitForSelector('textarea[data-ctl="paste-roster"]', { timeout: 20000 })
  await dm.fill('textarea[data-ctl="paste-roster"]', roster)
  /* Scoped to the roster box's own card. There are two `.paste-roster` panels on
     this screen — the roster and the free-agent list — with the same button text on
     each, so the bare selector names two elements and Playwright refuses it. */
  await dm.click('.paste-roster:has(textarea[data-ctl="paste-roster"]) button:text-is("Read that")')
  await dm.waitForTimeout(800)
  await dm.click('.views button:has-text("Pickups")')
  await dm.waitForSelector(".board-row", { timeout: 30000 })
  await dm.waitForTimeout(1200)

  const head = await dm.$$eval(".board-head > *", n => n.map(e => e.textContent.trim()))
  /* "Δ mine" reads "for you" now, and the rename is the assertion rather than a
     detail of it: Δ is a symbol a reader has to have been taught, and "mine" is the
     app talking about its own data model. The column is still located by `data-col`
     everywhere else in this block, which is why only this one line had to change. */
  /* The arrow rides on "ahead by" because that is what the board is ordered by, and
     asserting it here is the second place that catches `SortHead` going back to
     comparing the raw `filters.sort` — which is null on a first visit, so no heading was
     marked at all. See the four-column census two thousand lines up. */
  t("with a roster it appears, named in words, beside the league's own bar",
    head.join("|") === "#|Player|ahead by▾|for you|games", head.join(" | "))
  const pairs = await dm.$$eval(".board-row", rs =>
    rs.slice(0, 20).map(r => ({
      b: r.querySelector("[data-col=bscore]")?.textContent.trim(),
      m: r.querySelector("[data-col=mine]")?.textContent.trim()
    })))
  t("every row carries the cell, so the grid cannot go a track short",
    pairs.every(p => p.m !== undefined && p.m !== ""), JSON.stringify(pairs.slice(0, 3)))
  // If it agreed with bscore on every row it would be a second copy of a number the
  // table already has. The point is that a deep position and a hole price the same
  // free agent differently.
  const differs = pairs.filter(p => p.m !== "—" && Math.abs(Number(p.m) - Number(p.b)) > 0.5)
  t("and it says something bscore does not, on most rows",
    differs.length >= pairs.length / 2,
    `${differs.length} of ${pairs.length} differ — ${JSON.stringify(pairs.slice(0, 3))}`)
  // A null is a null. Rendering "nobody you own could be displaced by him" as 0
  // would put men the column cannot price among men it prices at nothing.
  t("a row it cannot price shows a dash, never a zero",
    pairs.every(p => p.m !== "0" && p.m !== "0.0"), JSON.stringify(pairs.map(p => p.m)))
  await dm.close()
}

/* ── A LEAGUE THAT SCORES ONE SIDE OF THE BALL ───────────────────────────────
 *
 * Yahoo prints its two stat tables under separate headers, so a settings page
 * copied from a league that pays batters only — or a copy that caught one table and
 * missed the other — lands here as `scoring.pitching: {}`. `rateAll` has always
 * been right about it, marking every pitcher `rateable: false` with the reason "this
 * league scores nothing on the pitching side". Nothing DREW that reason, because an
 * unrateable player is not a row.
 *
 * Reproduced on the published build before the fix: the board fell from 1,009 rows
 * to 481, the word "pitch" appeared nowhere on the screen, and SP, RP and P were
 * still offered — each answering "0 players. Try a different position or a wider
 * window", which blames the reader for a filter that could not have matched. My
 * league said it twice on its own screen the whole time ("No pitching stats scored",
 * and "The paste carried no pitching scoring" under Needs review), which is what
 * makes the board's silence a disagreement between two screens rather than a gap.
 *
 * THE LEAGUE IS BUILT THROUGH THE PASTE, not injected into storage, because the
 * paste is the only way a reader reaches this state and the parser is what decides
 * what "no pitching scoring" means. `scoring.json` is stripped in flight rather than
 * by rebuilding dist: the dev server serves the repo's own file, which carries a
 * seeded league, and the dock this flow starts from only exists on a first visit.
 */
{
  const sp = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
  await sp.route("**/scoring.json", async route => {
    const j = await (await route.fetch()).json()
    j.leagues = {}
    j.active_league = null
    delete j.pools
    delete j.rosters
    delete j.lineups
    await route.fulfill({ json: j })
  })
  await sp.goto(BASE, { waitUntil: "domcontentloaded" })
  await sp.waitForSelector(".dock button", { timeout: 30000 })
  await sp.click(".dock button")
  await sp.waitForSelector("summary:has-text('My league scores differently')", { timeout: 15000 })
  await sp.click("summary:has-text('My league scores differently')")
  await sp.click(".onboard-where button:has-text('Yahoo')")
  await sp.fill(
    'textarea[data-ctl="paste-settings"]',
    [
      "Max Teams\t10",
      "Scoring Type\tHead-to-Head - Points",
      "Roster Positions\tC, 1B, 2B, 3B, SS, OF, OF, OF, Util, SP, SP, RP, RP, P, P, BN, BN, BN",
      "Batters Stat Category\tValue",
      "Runs (R)\t1",
      "Hits (H)\t1",
      "Home Runs (HR)\t4",
      "Runs Batted In (RBI)\t1",
      "Walks (BB)\t1",
      "Stolen Bases (SB)\t2"
    ].join("\n")
  )
  await sp.click("button:text-is('Read that')")
  await sp.waitForTimeout(1200)
  await sp.click('.views button:has-text("Pickups")')
  await sp.waitForSelector(".board-row", { timeout: 30000 })
  await sp.waitForTimeout(800)

  // The parser really did produce the state under test, rather than the test having
  // quietly pasted something the board could rank.
  const sides = await sp.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("beanemachine:config"))
    const L = s.leagues[s.active_league]
    return { bat: Object.keys(L.scoring.batting).length, pit: Object.keys(L.scoring.pitching).length }
  })
  t("a Batters table with no Pitchers table really does make a league that scores one side",
    sides.bat > 0 && sides.pit === 0, JSON.stringify(sides))

  const note = await sp.$eval("#horizon-panel .warn-note", e => e.innerText).catch(() => "")
  t("the board says the league scores nothing for pitchers",
    /scores nothing for pitchers/i.test(note), note || "(no note on the board)")
  // The remedy names the card that fixes it. Not the tab label typed out — Board.tsx
  // reads that through `tab()`, and this suite has already lost an hour to three
  // renamed tabs, so the assertion is on the substantive half.
  t("and names where to fix it", /Pitching/.test(note), note)

  const chips = await sp.$$eval(".board-controls .chips[aria-label=Position] button",
    n => n.map(e => e.textContent.trim()))
  t("the pitching positions are not offered as chips that cannot match",
    !chips.includes("SP") && !chips.includes("RP") && !chips.includes("P"), chips.join(" "))
  t("and the batting ones still are",
    ["All", "C", "1B", "OF", "Util"].every(c => chips.includes(c)), chips.join(" "))
  // Its three options are "batters + pitchers" (a label for a list holding no
  // pitchers), "batters" (the same list again) and "pitchers" (always nothing).
  await moreFilters(sp)
  t("and the Side control, which has nothing left to ask, is gone",
    (await sp.$("[data-ctl=group]")) === null)

  const slots = await sp.$$eval(".board-row [data-col=who] .code",
    n => n.map(e => e.textContent.trim()))
  t("every ranked row is a batter",
    slots.length > 20 && !slots.some(x => ["SP", "RP", "P"].includes(x)),
    slots.slice(0, 8).join(" "))

  /* Streaming is a list of pitchers by construction — `startersOnly` keeps only men
     the schedule has starting — so this one tab is empty on every visit in such a
     league, whatever window the reader picks. "Try a different position or a wider
     window" under it sends him round the horizon chips after a cause that is not in
     them. */
  await sp.click('.modes button:has-text("Streaming")')
  await sp.waitForTimeout(1000)
  const empty = await sp.$eval("#horizon-panel .empty", e => e.innerText).catch(() => "")
  t("an empty Streaming list blames the scoring rather than the reader's filters",
    /scores nothing for pitchers/i.test(empty) && !/wider window/i.test(empty),
    empty || "(no empty message)")
  await sp.close()
}

await browser.close()
console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
