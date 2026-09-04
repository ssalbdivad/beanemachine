// Verifies the GitHub Pages build: no backend, leagues seeded from the committed
// asset into this browser's storage, editing and saving working exactly as they do
// with a server behind them, and — measured 2026-09-04 — a real ESPN league
// IMPORTING and its roster READING with no server at all, because ESPN sends CORS
// headers that let a page read it. Yahoo sends none, and that is the case this
// build exists to serve: the last two sections here are a Yahoo user's two routes
// to a ranked board — the preset, and a file dropped on the page — because before
// them the hosted site's only honest answers were a stranger's demo league or
// seventeen point values typed in by hand.
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
// now switch to the config editor for the remaining assertions
await p.click(".views button:nth-child(2)")
await p.waitForSelector(".grid section.card .rows", { timeout: 15000 })
t("static banner shown", await p.locator(".static-note").isVisible())
const note = await p.locator(".static-note").textContent()
// The claim, not the wording. A blanket "importing needs the local server" was the
// single sentence standing between a visitor and using this on their own league, and
// it was false for ESPN, which imports here with no backend at all. It is equally
// false the other way round: a banner that only says the server is needed leaves a
// Yahoo user — most of this app's users — with nothing to do. So the banner must
// name Yahoo whenever it raises the server, AND it must name a route that ends
// somewhere: the preset, or a file carried over from a local read.
t("the static banner says your leagues live in this browser", /browser/i.test(note), note)
t("and it does not claim the server is needed to import without naming Yahoo",
  !/server/i.test(note) || /yahoo/i.test(note), note)
/**
 * The route a Yahoo user can finish is asserted where importing is ATTEMPTED, not
 * in the masthead.
 *
 * It was six lines in the masthead, on every page view, and measured 134px of a
 * 1,506px climb to the first recommendation — while the same explanation already
 * appeared four times in this setup panel. The claim did not change: a build that
 * raises the server must name Yahoo and must name a route that ends somewhere. It
 * is checked against the page a person reads when they are actually stuck.
 */
const setupText = await p.$eval(".grid", e => e.innerText)
t("and a Yahoo user is given a route they can finish, where importing is attempted",
  /yahoo/i.test(setupText) && /(preset|drop|file)/i.test(setupText),
  setupText.slice(0, 200))
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
// machine that just cloned this repo. Now it names the file route and the command
// src/cli.ts actually prints for itself.
t("and it names the route that works for Yahoo: read it locally, carry the file back",
  /src\/cli\.ts/.test(yahooMsg) && /drop that file/i.test(yahooMsg) && !/\bnub\b/.test(yahooMsg),
  yahooMsg)

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
await p.waitForSelector(".board-row", { timeout: 25000 })
await p.click(".views button:nth-child(2)")
await p.waitForSelector("#tpl", { timeout: 15000 })
t("the picker offers no Sleeper league type on the hosted build either",
  !(await p.$$eval("#tpl option", n => n.map(e => `${e.value}${e.textContent}`).join(" "))).match(/sleeper/i),
  await p.$$eval("#tpl option", n => n.map(e => e.textContent).join(" | ")))
await p.click('.bar button:text-is("New")')
await p.waitForSelector(".board-row", { timeout: 25000 })
t("a Yahoo preset ranks a full board with no server and no import",
  (await p.$$eval(".board-row", n => n.length)) > 50,
  String(await p.$$eval(".board-row", n => n.length)))
const presetNote = await p.locator(".example-note").first().textContent()
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
await p.evaluate(() => localStorage.clear())
await p.reload({ waitUntil: "networkidle" })
await p.waitForSelector(".board-row", { timeout: 25000 })
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
t("which is the same leagues, back in this browser",
  await p.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("beanemachine:config")).leagues).length >= 2))

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
await p.waitForSelector(".board-row", { timeout: 25000 })
const streamHead = async (n = 6) => {
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
const listed = await p.$$eval(".board-row .who b", els => els.map(e => e.textContent.trim()))
const deep = listed.slice(14, 22)
t("the ranking runs deep enough to draw a pool from a part of it nobody would see",
  deep.length === 8 && !deep.some(n => estimated.includes(n)),
  `${listed.length} rows ranked; drew ${deep.join(", ")}`)
const READ_AT = new Date(Date.now() - 3 * 3_600_000).toISOString()
const withWire = JSON.parse(await p.evaluate(() => localStorage.getItem("beanemachine:config")))
withWire.pools = {
  "yahoo:228947": {
    at: READ_AT,
    leagueId: "228947",
    players: deep.map((name, i) => ({ yahooId: String(9000 + i), name, team: null, positions: ["SP"] })),
    positionsRead: ["SP"],
    note: "Top 25 free agents per position (SP)."
  }
}
await p.evaluate(() => localStorage.clear())
await p.reload({ waitUntil: "networkidle" })
await p.waitForSelector(".board-row", { timeout: 25000 })
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
await p.waitForSelector(".board-row", { timeout: 25000 })
withWire.pools["yahoo:228947"].at = new Date(Date.now() - 7 * 86_400_000).toISOString()
const staleDt = await p.evaluateHandle(text => {
  const d = new DataTransfer()
  d.items.add(new File([text], "scoring.json", { type: "application/json" }))
  return d
}, JSON.stringify(withWire))
await p.dispatchEvent("body", "drop", { dataTransfer: staleDt })
await p.waitForSelector(".toast", { timeout: 10000 })
await p.waitForTimeout(600)
const staleChip = await p.locator('[data-wire="carried"]')
t("a week-old free-agent list is shown as a week old, and flagged",
  /read 7d ago/.test((await staleChip.textContent()).replace(/\s+/g, " ")) &&
    (await staleChip.getAttribute("class")).includes("warn"),
  `${(await staleChip.textContent()).replace(/\s+/g, " ")} [${await staleChip.getAttribute("class")}]`)
t("and it is still USED, because a stale exact list beats an estimate that is not one",
  /8 free/.test((await p.$eval(".toggle", e => e.textContent)).replace(/\s+/g, " ")),
  (await p.$eval(".toggle", e => e.textContent)).replace(/\s+/g, " ").trim())

t("no page errors after all of that", errs.length===0, errs.join(" | "))
await b.close()
console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail?1:0)
