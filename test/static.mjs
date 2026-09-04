// Verifies the GitHub Pages build: no backend, leagues seeded from the committed
// asset into this browser's storage, editing and saving working exactly as they do
// with a server behind them, and — measured 2026-09-04 — a real ESPN and a real
// Sleeper league IMPORTING and their rosters READING with no server at all, because
// both send CORS headers that let a page read them. Yahoo sends none, so Yahoo is
// the one thing left that says it needs the server, and it has to say it is Yahoo.
import { chromium } from "playwright-core"
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
// The board is the default view and must render with NO server. A synchronous
// throw in the static-mode guard once killed the whole render here.
await p.waitForSelector(".board-row", { timeout: 25000 })
let pass=0, fail=0
const t=(n,ok,x="")=>{ok?pass++:fail++; console.log(`${ok?"PASS":"FAIL"}  ${n}${ok?"":"  "+x}`)}
t("no page errors", errs.length===0, errs.join(" | "))
t("the board renders with no server", (await p.$$eval(".board-row", n=>n.length)) > 50)
t("free-agents toggle is disabled rather than failing",
  await p.$eval(".toggle input", e => e.disabled))
t("Billy's pick renders", await p.locator(".card.pick").isVisible())
// now switch to the config editor for the remaining assertions
await p.click(".views button:nth-child(2)")
await p.waitForSelector(".grid section.card .rows", { timeout: 15000 })
t("static banner shown", await p.locator(".static-note").isVisible())
const note = await p.locator(".static-note").textContent()
// The claim, not the wording. This used to assert that the banner named IMPORTING as
// the thing the server is for, and that is no longer true: measured 2026-09-04, ESPN
// reflects the requesting origin and Sleeper answers `*`, so both import on this build
// with no backend at all (see readableInBrowser in src/import.ts). Yahoo sends no
// access-control headers and is the only platform left that needs a server. So the
// banner may still say your leagues live in this browser, and it may still mention the
// server — but it may not mention the server without naming Yahoo, because a blanket
// "importing needs the local server" is now false for two platforms out of three and
// is the single sentence standing between a visitor and using this on their own league.
t("the static banner says your leagues live in this browser", /browser/i.test(note), note)
t("and it does not claim the server is needed to import without naming Yahoo",
  !/server/i.test(note) || /yahoo/i.test(note), note)
const codes = await p.$$eval(".grid section:nth-of-type(1) .code", n=>n.map(e=>e.textContent))
const vals = await p.$$eval(".grid section:nth-of-type(1) input.val", n=>n.map(e=>e.value))
t("scoring seeded from the committed asset", vals[codes.indexOf("HR")]==="10.4", vals.join(","))
t("the seed was stored, not just rendered",
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
t("the save landed in browser storage", await p.evaluate(() =>
  JSON.parse(localStorage.getItem("beanemachine:config")).leagues["yahoo:228947"].scoring.batting.HR === 9.9))
await p.reload({ waitUntil:"networkidle" })
await p.click(".views button:nth-child(2)")
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
 *   Sleeper  api.sleeper.app                access-control-allow-origin: *
 *   Yahoo    baseball.fantasysports.yahoo.com   no access-control headers at all
 *
 * The same reads from `http://127.0.0.1:4173` — this preview's own origin — were
 * checked too, because ESPN reflects whatever origin asks and a wildcard is not
 * what it sends: it answered `access-control-allow-origin: http://127.0.0.1:4173`.
 *
 * Politeness: two requests to ESPN and two to Sleeper per run, both to leagues those
 * projects publish as their own integration-test fixtures — ESPN 81134470/2021 is
 * the id the `espn-api` wrapper uses and the one data/rosters.ts was verified
 * against; Sleeper 289646328504385536 is the league Sleeper's own docs example.
 * No ids are enumerated and no stranger's league is touched.
 */

/** Toasts dismiss themselves (2.6s for a success, 6.5s for a failure), so the
 *  previous one is waited out rather than read again as if it answered this
 *  import. A toast that never matches is returned anyway, so the assertion below
 *  reports what actually appeared instead of dying on a timeout. */
const importUrl = async (url, expect) => {
  await p.waitForSelector(".toast", { state:"detached", timeout: 12000 }).catch(() => {})
  await p.fill('input[type=text]', url)
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
// The scoring table is ESPN's numeric stat ids, kept raw under scoring.unmapped
// exactly as importEspn says it does — 14 items and 12 seat types on this league
// when measured. Asserted as "present and named", not as an exact count, because
// this reads a live API and a changed count is ESPN's news, not a broken import.
t("with ESPN's own scoring items and lineup slots read off its API, and kept raw",
  (espn?.scoring.unmapped?.length ?? 0) > 0 && Object.keys(espn?.roster.slots ?? {}).length > 0 &&
    espn.scoring.unmapped.every(i => typeof i.espn_stat_id === "number"),
  `${espn?.scoring.unmapped?.length} scoring items (14 when measured), ` +
    `${Object.keys(espn?.roster.slots ?? {}).length} slot types (12 when measured)`)
t("and the source it cites is ESPN's endpoint, so the provenance is not this origin",
  espn?.provenance.sources.every(u => u.startsWith("https://lm-api-reads.fantasy.espn.com/")),
  JSON.stringify(espn?.provenance.sources))

// Sleeper. It answers `*`, so the page reads it too — and what it hands back is an
// NFL league, which the importer says outright rather than pretending is baseball.
const sleeperMsg = await importUrl("https://sleeper.com/leagues/289646328504385536", /imported/i)
t("a Sleeper league imports on the static build too", /^Imported /.test(sleeperMsg.trim()), sleeperMsg)
t("and that read went straight to Sleeper as well",
  requested.some(u => u.startsWith("https://api.sleeper.app/")))
const sleeper = await stored("sleeper:289646328504385536")
t("and the imported Sleeper league still refuses to pass NFL off as baseball",
  sleeper !== null && sleeper.meta.league_name === "Sleeper Friends League" &&
    String(sleeper.meta.season) === "2018" &&
    sleeper.needs_review.some(n => /NFL league/.test(n)),
  JSON.stringify(sleeper?.needs_review?.[0] ?? sleeper?.meta))

// Yahoo, the one platform that genuinely cannot be read here. The old sentence —
// "Importing a league needs the local server" — was true only about this case and
// was shown to everybody, which is what made the hosted build a demo of one
// stranger's team. It has to keep being said, and it has to say WHICH platform.
const yahooMsg = await importUrl(
  "https://baseball.fantasysports.yahoo.com/b1/228947/8", /server/i)
t("a Yahoo import still says it needs the local server", /local server/i.test(yahooMsg), yahooMsg)
t("and it names Yahoo, and the CORS headers Yahoo doesn't send, as the reason",
  /yahoo/i.test(yahooMsg) && /cors/i.test(yahooMsg), yahooMsg)
t("and it says ESPN and Sleeper import here, so it can't be read as a blanket refusal",
  /espn/i.test(yahooMsg) && /sleeper/i.test(yahooMsg), yahooMsg)

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
await p.evaluate(() => {
  const c = JSON.parse(localStorage.getItem("beanemachine:config"))
  const seeded = c.leagues["yahoo:228947"], espn = c.leagues["espn:81134470"]
  espn.scoring = JSON.parse(JSON.stringify(seeded.scoring))
  espn.roster = JSON.parse(JSON.stringify(seeded.roster))
  c.active_league = "espn:81134470"
  localStorage.setItem("beanemachine:config", JSON.stringify(c))
})
await p.reload({ waitUntil:"networkidle" })
await p.waitForSelector(".board-row", { timeout: 25000 })
const tabs = await p.$$eval(".views button", n => n.map(e => e.textContent))
await p.click(`.views button:nth-child(${tabs.findIndex(x => /my team/i.test(x)) + 1})`)
await p.waitForSelector(".pull-roster", { timeout: 15000 })
t("the roster card offers to read from ESPN, naming the platform the league is on",
  /Read my roster from ESPN/.test(await p.locator(".pull-roster button.primary").textContent()))
await p.click(".pull-roster button.primary")
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

t("no page errors after all of that", errs.length===0, errs.join(" | "))
await b.close()
console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail?1:0)
