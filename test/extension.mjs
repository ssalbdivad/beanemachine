/**
 * THE BROWSER READER, END TO END, WITHOUT YAHOO.
 *
 * Everything else in this project can be tested against a committed capture. This cannot:
 * the whole feature is "a script inside a signed-in Yahoo tab hands pages to the app", and
 * there is no Yahoo tab here, no account, and nothing that would make scraping somebody
 * else's site to run a test acceptable.
 *
 * So Yahoo is served locally and the browser is told to believe it. `--host-resolver-rules`
 * maps `*.fantasysports.yahoo.com` at a local port, which means the pages really are
 * requested at `http://baseball.fantasysports.yahoo.com/b1/228947/8`, the extension's own
 * match patterns really do decide whether its content script runs, and the fetches the
 * sweep makes really are same-origin requests carrying whatever cookies that origin has.
 * Nothing about the extension is stubbed: the build in dist-ext/chrome is loaded unpacked,
 * exactly as a reader loads it.
 *
 * WHAT THIS PROVES: that the three scripts load, that the two content scripts find each
 * other through the background, that a page grabbed inside Yahoo arrives in the app, and
 * that what arrives parses into a league, a roster with seats and a pool of free agents
 * through the parsers the paste box already uses.
 *
 * WHAT IT CANNOT PROVE, and the commit message must say so: that Yahoo's real pages look
 * like these fixtures. The fixtures are built from the shapes this repository has already
 * measured — `test/ownership.mjs` for the player table, `test/settings.mjs` for the
 * settings page — and those were taken off real pages, but a redesign tomorrow is
 * invisible to this file. That is an argument for the app parsing rather than the
 * extension: a parser on this side ships in a minute, one inside an extension waits for a
 * store.
 */
import { chromium } from "playwright-core"
import { createServer } from "node:http"
import { readFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
/* The protocol's own pure parts, asserted directly rather than through a browser. They are
   the half of this feature that has no tab, no Yahoo and no timing in it, and a browser
   round-trip would only make their failures slower to read. */
import {
	PROTOCOL,
	protocolSkew,
	rowsOnly,
	teamIdFrom,
	pageKind,
	leagueIdFrom,
	sportFrom
} from "../src/data/extension.ts"
import { parsePage } from "../src/data/yahoo-pool.ts"

const cfg = JSON.parse(readFileSync("scoring.json", "utf8"))
const snap = JSON.parse(readFileSync("data/snapshot.json", "utf8"))
const real = cfg.leagues["yahoo:228947"]
const KEY = "yahoo:228947"
const LEAGUE_ID = "228947"

let pass = 0,
	fail = 0
const t = (n, ok, x = "") => {
	ok ? pass++ : fail++
	console.log(`${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : "  " + x}`)
}

/* ── the fixtures ────────────────────────────────────────────────────────────────────
   Two of these are lifted from suites that already assert against them, so the shapes
   under test here are the shapes this project has measured off the real site rather than
   shapes invented for this file. */

/** How Yahoo spells each code on the settings page — from test/settings.mjs. */
const LABEL = {
	R: "Runs", "1B": "Singles", "2B": "Doubles", "3B": "Triples", HR: "Home Runs",
	RBI: "Runs Batted In", SB: "Stolen Bases", BB: "Walks", HBP: "Hit By Pitch",
	W: "Wins", SV: "Saves", OUT: "Outs", H: "Hits Allowed", ER: "Earned Runs", K: "Strikeouts"
}

const settingsPage = league => {
	const rows = []
	rows.push("Yahoo Fantasy Baseball\tMy Team\tLeague\tPlayers")
	rows.push("Scoring & Settings")
	rows.push("Setting\tValue")
	for (const [k, v] of Object.entries(league.league_rules.raw_settings)) rows.push(`${k}\t${v}`)
	rows.push("Batters Stat Category\tValue")
	for (const [c, v] of Object.entries(league.scoring.batting)) rows.push(`${LABEL[c] ?? c} (${c})\t${v}`)
	rows.push("Pitchers Stat Category\tValue")
	rows.push("Innings Pitched (IP)\t0")
	for (const [c, v] of Object.entries(league.scoring.pitching)) rows.push(`${LABEL[c] ?? c} (${c})\t${v}`)
	rows.push("Terms\tPrivacy\tHelp\tFeedback")
	/* Served as a real page, because the extension reads it the way a browser renders it:
	   the tab-separated text above is what `innerText` gives back for a table. */
	return `<!doctype html><meta charset="utf-8"><title>Settings</title><body><pre>${rows
		.join("\n")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")}</pre></body>`
}

/** Nine men from the committed capture, seated — the team page as `innerText` gives it,
 *  which is what `rosterFromPaste` is written to be handed. */
const seated = (() => {
	const bats = snap.players
		.filter(p => p.group === "hitting" && (p.stats?.plateAppearances ?? 0) > 400)
		.slice(0, 6)
	const arms = snap.players
		.filter(p => p.group === "pitching" && (p.stats?.outs ?? 0) > 300)
		.slice(0, 3)
	const slots = ["C", "1B", "2B", "3B", "SS", "OF"]
	return [
		...bats.map((p, i) => ({ slot: slots[i], p })),
		...arms.map((p, i) => ({ slot: i < 2 ? "SP" : "RP", p }))
	]
})()

const teamPage = () =>
	`<!doctype html><meta charset="utf-8"><title>My Team</title><body><table>` +
	`<tr><th>Pos</th><th>Player</th></tr>` +
	seated
		.map(
			({ slot, p }) =>
				`<tr><td>${slot}</td><td>${p.name} ${p.team ?? "FA"} - ${p.position ?? "Util"}</td></tr>`
		)
		.join("") +
	`</table></body>`

/** The matchup page: both teams' men, the way the page prints them, with no label a
 *  name-matcher can see saying which half is whose. That is the point — the reader's own
 *  roster is what separates them. */
const rivals = snap.players
	.filter(p => p.group === "hitting" && (p.stats?.plateAppearances ?? 0) > 400)
	.filter(p => !seated.some(s => s.p.id === p.id))
	.slice(0, 7)

const matchupPage = () =>
	`<!doctype html><meta charset="utf-8"><title>Matchup</title><body><table>` +
	`<tr><td>Mrs. Met's Harem</td><td>Rival Nine</td></tr>` +
	seated
		.map(({ p }, i) => `<tr><td>${p.name}</td><td>${rivals[i]?.name ?? ""}</td></tr>`)
		.join("") +
	`</table></body>`

/** Yahoo serves 25 rows a page — measured on 2026-09-03 and recorded in
 *  src/data/yahoo-pool.ts. The union across nine positions is therefore 225 men, which is
 *  what "not one page nine times" means below. */
const PAGE_ROWS = 25

/** A player-table row in Yahoo's shape — from test/ownership.mjs, including the second
 *  id-bearing link with no title and the AccuWeather tooltip that once broke the parser. */
const row = (id, name, pct) =>
	`<tr><td><a href="/players/${id}" data-ys-playerid="${id}" class="name" title="${name}">${name}</a>` +
	`<span data-ys-playerid="${id}" class="note"></span>` +
	`<span class="Nowrap">MIL - SP,RP</span>${TOOLTIP}` +
	`<td class="Alt Ta-end"><div >984.40</div></td>` +
	`<td class="Ta-end Nowrap Bdrend"><div >${pct}%</div></td>` +
	`<td class="Alt Ta-end"><div >155.0</div></td></tr>`

/**
 * A PAGE OF FREE AGENTS, AT THE SIZE AND SHAPE THE REAL ONE WAS MEASURED TO BE.
 *
 * It used to be three rows and 700 copies of an HTML comment — about 10.5 KB, enough to
 * prove the union across positions and nothing else. It is bigger now because size is one of
 * the things under test, and a measurement taken against a fixture that is a twentieth of
 * the real page is a measurement of nothing.
 *
 * Two numbers here are measured off the real site and are cited rather than invented:
 *   · 25 rows a page — src/data/yahoo-pool.ts, measured disjoint on 2026-09-03 against
 *     league 228947 at pos=SP, which is also where `count=` was found to be an offset.
 *   · roughly 90 KB of page footer after the last row — the same file, recorded as the
 *     reason a single-regex row match could never reach the end of the page.
 * Everything else about the bytes is this file's invention and is labelled as such wherever
 * a number is reported.
 *
 * THE INLINE SCRIPT IN THE HEAD IS NOT DECORATION. Every real Yahoo page carries inline
 * script in its head, and that script mentions `login.yahoo.com`. The sweep's wall check
 * used to strip TAGS from the fetched page and read the first 600 characters — which left
 * the CONTENTS of that script in the text it read, so a perfectly good page of free agents
 * matched the sign-in wall and the reader was told to sign in to the site he was signed in
 * to. The assertion below reproduces both halves: that the old check would have called this
 * page a wall, and that the current one does not.
 */
const HEAD_SCRIPT =
	`<script>window.YAHOO=window.YAHOO||{};` +
	`YAHOO.i13n={login:"https://login.yahoo.com/config/login?.done=%2Fb1%2F228947"};` +
	`YAHOO.beacon="https://geo.yahoo.com/p?s=1197806657";</script>`

/** The forecast table Yahoo nests inside each outdoor game's tooltip — the thing that made
 *  a text-scan for "%" read the rain chance as the ownership percentage. Carried here so a
 *  row is the size a row really is, and so the cut being measured has something to cut. */
const TOOLTIP =
	`<div class="ys-tooltip"><table class="wthr"><tr><td>7:05 pm</td><td>76%</td>` +
	`<td>There is a 51% chance of precipitation</td></tr>` +
	`<tr><td>Wind</td><td>8 mph</td><td>Humidity 64%</td></tr></table></div>`

const FOOTER = `<!-- footer -->`.repeat(6000) // ~90 KB, per the measurement cited above

const playersPage = pos => {
	/* Keyed by the position's own index, not by its length: "SS", "OF", "SP", "RP", "1B",
	   "2B" and "3B" are all two characters, so a length-based id gave seven positions the
	   same three men and the union across the sweep came back as 9 rather than 27 — which
	   is exactly the bug this assertion exists to catch, arriving first in the fixture.
	   Spacing of 100 leaves room for the 25 rows a real page carries. */
	const base = 9000 + (["C", "1B", "2B", "3B", "SS", "OF", "Util", "SP", "RP"].indexOf(pos) + 1) * 100
	return (
		`<!doctype html><meta charset="utf-8"><title>Players</title>${HEAD_SCRIPT}<body><table>` +
		Array.from({ length: PAGE_ROWS }, (_, i) => row(base + i, `${pos} Free Agent ${i}`, 12 + i)).join("") +
		`</table>${FOOTER}</body>`
	)
}

/**
 * THE WALL YAHOO SERVES INSTEAD OF AN ERROR.
 *
 * 200, with a page, with the refusal in the words — which is why the extension reads the
 * words and why a throttle read as an empty league is the most expensive way this can fail.
 * Kept here so the served wall and the wall the reader's own tab is given (further down,
 * by overwriting a page's text) are the same sentence.
 */
const WALL = `<!doctype html><meta charset="utf-8"><body>Request denied. Too many requests from your network.</body>`

/**
 * HOW MANY PLAYERS PAGES THIS FIXTURE WILL SERVE BEFORE IT STARTS REFUSING.
 *
 * Yahoo throttles a sweep partway through — commit de44045 records 150 players, then 25,
 * then 0, then the literal string "Request denied" — and what the app does with the pages
 * it DID get is a question no amount of fixture that always answers can ask. Set to a
 * number for one block below and put back afterwards.
 */
let serveUntil = Infinity
let playersServed = 0

/** After this many players pages, answer with a STATUS rather than with a page. Yahoo
 *  refuses both ways — a wall served as 200 and a plain 429 — and the two take different
 *  branches through the sweep, only one of which was covered. */
let failFrom = Infinity

/* ── a Yahoo to point the browser at ─────────────────────────────────────────────── */
const asked = []
const server = createServer((req, res) => {
	asked.push(req.url)
	const url = new URL(req.url, "http://x")
	const send = html => {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
		res.end(html)
	}
	if (url.pathname.endsWith("/settings")) return send(settingsPage(real))
	if (url.pathname.endsWith("/matchup")) return send(matchupPage())
	if (url.pathname.endsWith("/players")) {
		playersServed++
		if (playersServed > failFrom) {
			res.writeHead(429, { "content-type": "text/html; charset=utf-8" })
			return res.end("<!doctype html><body>Too many requests</body>")
		}
		if (playersServed > serveUntil) return send(WALL)
		return send(playersPage(url.searchParams.get("pos") ?? "C"))
	}
	/* `f1` as well as `b1`: a reader with a football league open is a case this suite drives,
	   and the football pages are served by the same routes because Yahoo's fantasy URLs have
	   the same shape for every sport — the sport is in the HOST, which is what
	   `sportFrom` reads and what the router refuses on. */
	if (/\/[bf]1\/\d+\/\d+$/.test(url.pathname)) return send(teamPage())
	if (/\/[bf]1\/\d+$/.test(url.pathname)) return send(`<!doctype html><body>League home</body>`)
	send(`<!doctype html><body>Yahoo Fantasy</body>`)
})
await new Promise(r => server.listen(0, "127.0.0.1", r))
const port = server.address().port

const APP = process.env.BASE ?? "http://127.0.0.1:5299"
const EXT = new URL("../dist-ext/chrome", import.meta.url).pathname
const profile = mkdtempSync(join(tmpdir(), "bm-ext-"))

const context = await chromium.launchPersistentContext(profile, {
	/*
	   `channel: "chromium"` IS LOAD-BEARING, and it took a probe to find out.
	
	   Measured here: with plain `headless: true`, `context.serviceWorkers()` comes back
	   EMPTY — the extension is not loaded at all, and every assertion below fails with the
	   bridge never announcing itself. With `channel: "chromium"`, which is the new headless
	   shell, the background service worker starts and the same run passes. `headless: false`
	   also works and needs a display this machine may not have.
	*/
	channel: "chromium",
	headless: true,
	args: [
		"--no-sandbox",
		`--disable-extensions-except=${EXT}`,
		`--load-extension=${EXT}`,
		/* THE WHOLE TRICK. Yahoo's hostname resolves to the fixture server, so the pages
		   are fetched at their real URLs and every match pattern, origin check and
		   same-origin fetch in the extension is exercised for real. */
		`--host-resolver-rules=MAP *.fantasysports.yahoo.com 127.0.0.1:${port}`
	]
})

const yahoo = `http://baseball.fantasysports.yahoo.com/b1/${LEAGUE_ID}/8`

/* The reader's own Yahoo tab, open first — which is what the instructions tell him to do
   and what the extension requires: it never opens a tab by itself. */
const tab = await context.newPage()
await tab.goto(yahoo, { waitUntil: "domcontentloaded" })
t("the fixture Yahoo page is served at Yahoo's own hostname", /My Team|Pos/.test(await tab.content()))

const app = await context.newPage()
const errs = []
app.on("pageerror", e => errs.push(String(e)))
await app.addInitScript(c => localStorage.setItem("beanemachine:config", JSON.stringify(c)), {
	...cfg,
	active_league: KEY,
	leagues: { [KEY]: cfg.leagues[KEY] }
})
await app.goto(APP, { waitUntil: "domcontentloaded" })
await app.waitForSelector("nav button", { timeout: 30000 })
await app.waitForTimeout(1500)

t("the page knows the reader is there", await app.evaluate(() => !!document.documentElement.getAttribute("data-beanemachine-extension")), await app.evaluate(() => document.documentElement.outerHTML.slice(0, 200)))

/* ── the handshake, from the page's own side ─────────────────────────────────────── */
const hello = await app.evaluate(
	() =>
		new Promise(resolve => {
			const on = e => {
				if (e.source === window && e.data?.from === "beanemachine-extension" && e.data.kind === "hello") {
					window.removeEventListener("message", on)
					resolve(e.data)
				}
			}
			window.addEventListener("message", on)
			/* Asked more than once on purpose. `hello` is unsolicited news from the bridge and
			   the bridge sends it at `document_start`, focus and visibility — all of which can
			   have happened before this listener existed. A page that missed it has to be able
			   to ask, and the ask is what the app's own hook does on mount. */
			const beat = setInterval(
				() => window.postMessage({ from: "beanemachine-page", id: "hello", ask: "hello" }, location.origin),
				400
			)
			setTimeout(() => {
				clearInterval(beat)
				resolve(null)
			}, 8000)
		})
)
t("it says hello, with a version and whether Yahoo is open", !!hello && !!hello.version, JSON.stringify(hello))
t("and it can see the Yahoo tab", !!hello && hello.yahooOpen === true, JSON.stringify(hello))

/** Asks the extension the way the app asks it, and waits for the one answer with this id. */
const askFor = (ask, opts = {}) =>
	app.evaluate(
		([ask, opts]) =>
			new Promise(resolve => {
				const id = `t-${Math.random()}`
				const on = e => {
					if (e.source !== window || e.data?.from !== "beanemachine-extension") return
					if (e.data.id !== id || e.data.kind === "progress") return
					window.removeEventListener("message", on)
					resolve(e.data)
				}
				window.addEventListener("message", on)
				window.postMessage({ from: "beanemachine-page", id, ask, ...opts }, location.origin)
				setTimeout(() => resolve({ kind: "timeout" }), 60000)
			}),
		[ask, opts]
	)

/**
 * THE SAME ASK, KEEPING THE PROGRESS LINES.
 *
 * A sweep is nine sequential requests with a quarter-second between them, which is long
 * enough that a reader with no words in front of him assumes it has hung. The lines take a
 * different route from the answer — the content script cannot use its reply channel twice,
 * so they go out through the router to every app tab — and that route is the one that
 * breaks silently: nothing throws, the answer still arrives, and all he loses is any reason
 * to believe the thing is working. So it is asserted rather than assumed.
 */
const askWithProgress = (ask, opts = {}) =>
	app.evaluate(
		([ask, opts]) =>
			new Promise(resolve => {
				const id = `t-${Math.random()}`
				const said = []
				const on = e => {
					if (e.source !== window || e.data?.from !== "beanemachine-extension") return
					if (e.data.id !== id) return
					if (e.data.kind === "progress") {
						said.push(e.data)
						return
					}
					window.removeEventListener("message", on)
					resolve({ answer: e.data, said })
				}
				window.addEventListener("message", on)
				window.postMessage({ from: "beanemachine-page", id, ask, ...opts }, location.origin)
				setTimeout(() => resolve({ answer: { kind: "timeout" }, said }), 60000)
			}),
		[ask, opts]
	)

/* ── one press: the team page and the settings page ──────────────────────────────── */
const league = await askFor("league")
t("one press brings back the three pages a league is made of",
	league.kind === "grabs" && league.grabs.length === 3 &&
		league.grabs.map(g => g.kind).join(",") === "team,settings,matchup",
	(league.grabs ?? []).map(g => g.kind).join(",") || JSON.stringify(league).slice(0, 200))
t("the team page comes back as text, not as 400 KB of markup",
	league.grabs?.[0]?.kind === "team" && league.grabs[0].text.length > 40 && !league.grabs[0].html,
	JSON.stringify(league.grabs?.[0] ?? null).slice(0, 200))
t("and the settings page is fetched alongside it",
	league.grabs?.[1]?.kind === "settings" && /Stat Category/.test(league.grabs[1].text),
	(league.grabs?.[1]?.text ?? "").slice(0, 120))

/* What the app makes of them, through the parsers the paste box uses. */
const read = await app.evaluate(async grabs => {
	const { readGrabs } = await import("/src/data/yahoo-read.ts")
	const snap = await (await fetch("/snapshot.json")).json()
	const out = readGrabs(grabs, snap)
	return {
		leagueKey: out.leagueKey,
		batting: out.league ? Object.keys(out.league.scoring.batting).length : 0,
		pitching: out.league ? Object.keys(out.league.scoring.pitching).length : 0,
		teams: out.league?.meta.max_teams ?? null,
		players: out.roster?.players.length ?? 0,
		spots: out.roster?.spots.length ?? 0,
		opponent: out.opponent?.length ?? 0,
		mineOnBoth: (out.opponent ?? []).filter(k => (out.roster?.keys ?? []).includes(k)).length,
		notes: out.notes
	}
}, league.grabs)

t("it lands on the league the reader is already in", read.leagueKey === KEY, read.leagueKey)
t("with the league's own scoring, both sides of the ball",
	read.batting === Object.keys(real.scoring.batting).length &&
		read.pitching === Object.keys(real.scoring.pitching).length,
	JSON.stringify(read))
t("and the team count that moves every ranking", read.teams === real.meta.max_teams, String(read.teams))
t("and the team, with the seat each man is in",
	read.players === seated.length && read.spots === seated.length,
	JSON.stringify({ players: read.players, spots: read.spots, want: seated.length }))

/* WHO HE IS PLAYING, off the same press. The recap card has been asking him to paste his
   opponent's roster; the page his league already shows him carries both teams, and his own
   roster is the only thing that tells them apart — so a man on his own team must never come
   back as his opponent's. */
t("and the other side of the matchup, told apart from his own team",
	read.opponent === rivals.length, JSON.stringify({ got: read.opponent, want: rivals.length }))
t("with none of his own men on the other side of it", read.mineOnBoth === 0, String(read.mineOnBoth))

/* ── the sweep ───────────────────────────────────────────────────────────────────── */
const before = asked.length
const pool = await askFor("pool", { leagueId: LEAGUE_ID, sport: "baseball" })
t("the sweep comes back with a page per position", pool.kind === "grabs" && pool.grabs.length === 9, String(pool.grabs?.length))
t("and it asked Yahoo nine times, not ninety", asked.length - before === 9, String(asked.length - before))
t("one position at a time, in order",
	asked.slice(before).every(u => /\/players\?/.test(u)) &&
		new Set(asked.slice(before).map(u => new URL(u, "http://x").searchParams.get("pos"))).size === 9,
	asked.slice(before).join(" "))
/* count= is an OFFSET, and every page of the sweep must ask for 0 — the bug that hid the
   top 25 free agents at every position for a season. */
t("and asked for the top of each list, not the second page",
	asked.slice(before).every(u => new URL(u, "http://x").searchParams.get("count") === "0"),
	asked.slice(before).join(" "))

const poolRead = await app.evaluate(async grabs => {
	const { readGrabs } = await import("/src/data/yahoo-read.ts")
	const snap = await (await fetch("/snapshot.json")).json()
	const out = readGrabs(grabs, snap)
	return {
		players: out.pool?.players.length ?? 0,
		read: out.pool?.positionsRead ?? [],
		requested: out.pool?.positionsRequested ?? []
	}
}, pool.grabs)
/* 225 rather than 27: the fixture now serves the 25 rows a real page serves, which was
   measured off league 228947 and written down in src/data/yahoo-pool.ts. The claim under
   test has not changed — nine positions of distinct men, not one page counted nine times —
   only the size of the page it is tested against, which had to grow before any statement
   about bytes could mean anything. */
t("the free agents are the union across positions, not one page nine times",
	poolRead.players === 9 * PAGE_ROWS, String(poolRead.players))
t("and the sweep says which positions it actually got",
	poolRead.read.length === 9 && poolRead.requested.length === 9,
	JSON.stringify(poolRead.read))

/* ── the wall ────────────────────────────────────────────────────────────────────── */
/* Yahoo throttles by serving a 200 with a wall of words rather than an error status, so
   the only signal is the words — and a throttle read as an empty league is the single
   most expensive way this can fail. */
const walled = await context.newPage()
await walled.goto(`http://baseball.fantasysports.yahoo.com/b1/${LEAGUE_ID}/8`, { waitUntil: "domcontentloaded" })
await walled.evaluate(() => {
	document.body.textContent = "Request denied. Too many requests from your network."
})
const refused = await askFor("page")
t("a throttle is reported as a throttle, not as an empty league",
	refused.kind === "failed" && /refusing to answer/i.test(refused.failure.what),
	JSON.stringify(refused).slice(0, 200))
await walled.close()

/* ── WHAT A READ ACTUALLY COSTS, IN BYTES ────────────────────────────────────────────
   Nine pages of markup cross `postMessage` in one message, and until now nobody had
   counted them. The numbers printed here are measured on THIS fixture and are only as
   honest as it is: 25 rows a page and ~90 KB of footer are the two figures taken off the
   real site (src/data/yahoo-pool.ts, 2026-09-03, league 228947); the rest of the bytes —
   the head, the row markup, the forecast tooltip — are this file's invention and are the
   reason the absolute totals below are an ESTIMATE of a real read rather than a
   measurement of one. What is exactly measured is the RATIO the cut achieves on a page of
   this shape, because that is a property of the cut and not of the fixture's size. */
{
	const bytes = v => Buffer.byteLength(typeof v === "string" ? v : JSON.stringify(v), "utf8")
	const servedPage = playersPage("SP")
	const arrived = pool.grabs.map(g => bytes(g.html ?? ""))
	const sweepTotal = arrived.reduce((a, b) => a + b, 0)
	const wholePages = bytes(servedPage) * 9
	const press = league.grabs.map(g => ({ kind: g.kind, bytes: bytes(g) }))

	/* Printed, not just asserted. A number in a report has to be reproducible by running
	   the thing that produced it, and this is that line. */
	console.log(
		`\n  bytes — one press (${press.map(p => `${p.kind} ${p.bytes}`).join(", ")}) ` +
			`= ${press.reduce((a, p) => a + p.bytes, 0)} total`
	)
	console.log(
		`  bytes — sweep of 9 positions: ${sweepTotal} arrived, ` +
			`${wholePages} if whole pages had been sent (${(100 - (sweepTotal / wholePages) * 100).toFixed(1)}% cut)\n`
	)

	/* The cut has to be worth doing at all. On a page of this shape — 25 rows and a footer
	   the size the real one was measured at — it removes the overwhelming majority of the
	   bytes, because what it keeps is bounded by the rows and what it drops is the page. */
	t("the players pages arrive cut down to their rows, not whole",
		sweepTotal < wholePages / 4,
		`${sweepTotal} vs ${wholePages}`)

	/* THE ONLY THING THAT MAKES THE CUT ACCEPTABLE. It is a size cut on the app's own row
	   boundary, so what arrives must parse to the identical rows — not nearly, identically,
	   field for field. If this ever fails the cut must go, whatever it saves. */
	const full = parsePage(servedPage)
	const cut = parsePage(rowsOnly(servedPage))
	t("and they parse to exactly the same players, field for field",
		full.length === PAGE_ROWS && JSON.stringify(full) === JSON.stringify(cut),
		`${full.length} vs ${cut.length}`)

	/* FAIL-SAFE. A page whose markers Yahoo has moved yields nothing, and the caller sends
	   the whole page rather than a cut one — a redesign costs bandwidth and never a row. */
	t("a page it cannot recognise is refused whole rather than cut to nothing",
		rowsOnly("<html><body>Yahoo has redesigned this page</body></html>") === null,
		String(rowsOnly("<html><body>Yahoo has redesigned this page</body></html>")))

	/* THE SIGN-IN WALL THAT WAS NOT THERE.
	   The sweep's wall check used to strip tags and read the first 600 characters of a
	   fetched page, which left the contents of the head's inline script in what it read —
	   and that script names `login.yahoo.com` on every Yahoo page there is. The left half of
	   this assertion reproduces the old check on the fixture page and shows it firing; the
	   right half is the whole sweep above having returned nine pages of free agents off the
	   same fixture, with the script in place. */
	const OLD_CHECK = /login\.yahoo\.com|\/account\/challenge|guce\.yahoo\.com|please sign in/i
	t("a page whose head script names the login host is not a sign-in wall",
		OLD_CHECK.test(servedPage.replace(/<[^>]+>/g, " ").slice(0, 600)) && pool.grabs.length === 9,
		`old check fired: ${OLD_CHECK.test(servedPage.replace(/<[^>]+>/g, " ").slice(0, 600))}`)
}

/* ── VERSION SKEW ────────────────────────────────────────────────────────────────────
   The page redeploys in a minute; the half in the browser waits on a store review. They
   are ALWAYS allowed to disagree, and the only question is whether the disagreement is a
   sentence or a silence. */
{
	t("a browser half that speaks an older protocol is named, not guessed at",
		!!protocolSkew(PROTOCOL - 1) && /older than this page/.test(protocolSkew(PROTOCOL - 1).what),
		JSON.stringify(protocolSkew(PROTOCOL - 1)))
	/* The first shipped build had no protocol field at all, so a missing number is that
	   build rather than a fault — read as 1, which is what it was. */
	t("and so is one so old it had no number to send", !!protocolSkew(undefined), "")
	t("the same protocol is not a complaint", protocolSkew(PROTOCOL) === null, "")
	/* A NEWER half is expected to keep answering an older page — that is what a protocol
	   number is for — so the page says nothing. If that ever stops being true it shows up
	   as a specific ask being refused, which has its own sentence. */
	t("and a newer one is not a complaint either", protocolSkew(PROTOCOL + 5) === null, "")
	t("the hello carries the protocol, not only the version it prints",
		hello?.protocol === PROTOCOL, JSON.stringify({ got: hello?.protocol, want: PROTOCOL }))

	/* AN ASK FROM A PAGE NEWER THAN THE BUILD IN THE BROWSER. This used to fall out of the
	   listener with no reply at all: Chrome closed the channel, and the page told the reader
	   the connection was lost and to reload — advice that cannot work, because the page is
	   already the newest thing he has. */
	const unknown = await askFor("draftresults")
	t("an ask this build has never heard of is refused by name, not by going quiet",
		unknown.kind === "failed" && /older than this page/.test(unknown.failure?.what ?? ""),
		JSON.stringify(unknown).slice(0, 200))
}

/* ── TWO LEAGUES OPEN AT ONCE ────────────────────────────────────────────────────────
   A manager in September has his baseball league and his football league open, and often
   two baseball leagues. Which tab gets read was previously "the last one the router heard
   from", which was not even that: `Map.set` on an existing key leaves it where it was, so a
   tab that re-announced kept its original place in the order. */
{
	const OTHER = "339588"
	const second = await context.newPage()
	await second.goto(`http://baseball.fantasysports.yahoo.com/b1/${OTHER}/4`, {
		waitUntil: "domcontentloaded"
	})
	await second.waitForTimeout(500)

	const onSecond = await askFor("league")
	t("with two leagues open, the one he is looking at is the one read",
		leagueIdFrom(onSecond.grabs?.[0]?.url ?? "") === OTHER,
		onSecond.grabs?.[0]?.url ?? JSON.stringify(onSecond).slice(0, 160))

	/* Back to the first tab. The content script announces again on focus and on becoming
	   visible, which is what makes "most recently looked at" true rather than merely
	   written — one announcement per page load would have left this reading the second
	   league forever. */
	await tab.bringToFront()
	await tab.waitForTimeout(600)
	const onFirst = await askFor("league")
	t("and switching back to the other tab switches which league is read",
		leagueIdFrom(onFirst.grabs?.[0]?.url ?? "") === LEAGUE_ID,
		onFirst.grabs?.[0]?.url ?? JSON.stringify(onFirst).slice(0, 160))

	/*
	   A SWEEP FOR A LEAGUE THAT IS NOT OPEN IS REFUSED, NOT GUESSED AT.

	   This is the one case worth a refusal rather than a best guess, and the reason is that
	   it SUCCEEDS if you let it. Every page the sweep fetches goes through the chosen tab and
	   is same-origin whatever league that tab is on, so asking a tab on league B for league
	   A's players returns league A's free agents perfectly well — while the team page in the
	   same answer is league B's roster, written under league A's key. A read that fails
	   leaves nothing behind. That one leaves something wrong behind.
	*/
	const wrongLeague = await askFor("pool", { leagueId: "999999", sport: "baseball" })
	t("a read for a league he does not have open is refused rather than taken off another",
		wrongLeague.kind === "failed" && /different league/.test(wrongLeague.failure?.what ?? ""),
		JSON.stringify(wrongLeague).slice(0, 200))

	await second.close()
}

/* ── A FOOTBALL LEAGUE IS NOT A SMALL BASEBALL LEAGUE ─────────────────────────────────
   The same half of the browser sees every fantasy sport Yahoo runs. A football roster read
   as baseball is a team of nobody, reported as a team. */
{
	const football = await context.newPage()
	await football.goto("http://football.fantasysports.yahoo.com/f1/112233/5", {
		waitUntil: "domcontentloaded"
	})
	await football.waitForTimeout(500)

	/* The football tab is the most recent, and it still must not win: baseball is not a
	   preference here, it is the only thing that can be read at all. */
	const still = await askFor("league")
	t("a football tab open in front does not become the league that is read",
		sportFrom(still.grabs?.[0]?.url ?? "") === "baseball",
		still.grabs?.[0]?.url ?? JSON.stringify(still).slice(0, 160))

	/* Now the football tab is the ONLY one. "Nothing is open" would be a sentence he can
	   see is false, with Yahoo on his screen. */
	await tab.close()
	await football.bringToFront()
	await football.waitForTimeout(500)
	const onlyFootball = await askFor("league")
	t("and with only football open, it says which sport is open rather than that none is",
		onlyFootball.kind === "failed" && /football/.test(onlyFootball.failure?.what ?? ""),
		JSON.stringify(onlyFootball).slice(0, 200))

	await football.close()
	/* A baseball tab again, for everything below — including the reader's own path through
	   the screens, which needs something to read. */
	const back = await context.newPage()
	await back.goto(yahoo, { waitUntil: "domcontentloaded" })
	await back.waitForTimeout(400)
}

/* ── A PAGE THAT IS NOT WHAT IT SAYS ─────────────────────────────────────────────────
   The reader presses the button from wherever he happens to be standing. */
{
	/* THE URL IS THE ONLY THING THAT TELLS TWO TEAM PAGES APART, and these are the shapes
	   it comes in. A settings page matched as a team is a roster of nobody; a draft page is
	   not a team at all. */
	t("a team page is told from every other page by its URL alone",
		teamIdFrom(`https://baseball.fantasysports.yahoo.com/b1/${LEAGUE_ID}/8`) === "8" &&
			teamIdFrom(`https://baseball.fantasysports.yahoo.com/b1/${LEAGUE_ID}/settings`) === null &&
			teamIdFrom(`https://baseball.fantasysports.yahoo.com/b1/${LEAGUE_ID}`) === null &&
			pageKind(`https://baseball.fantasysports.yahoo.com/b1/${LEAGUE_ID}/draftresults`) === "league" &&
			pageKind(`https://baseball.fantasysports.yahoo.com/b1/${LEAGUE_ID}/settings`) === "settings",
		"")

	const home = await context.newPage()
	await home.goto(`http://baseball.fantasysports.yahoo.com/b1/${LEAGUE_ID}`, {
		waitUntil: "domcontentloaded"
	})
	await home.waitForTimeout(400)
	const fromHome = await askFor("league")
	const saidHome = await app.evaluate(async grabs => {
		const { readGrabs } = await import("/src/data/yahoo-read.ts")
		const snap = await (await fetch("/snapshot.json")).json()
		const out = readGrabs(grabs, snap)
		return { players: out.roster?.players.length ?? 0, notes: out.notes, scoring: !!out.league }
	}, fromHome.grabs)
	/* The league home carries the scoring and the matchup perfectly well — it is only the
	   team that is missing, and the absence used to be silent: the screen reported what it
	   DID get and said nothing about the roster, which reads as a team that was read and had
	   nobody in it. */
	t("pressed from the league home, it says no team was read rather than saying nothing",
		saidHome.players === 0 && saidHome.notes.some(n => /not your team/.test(n)),
		JSON.stringify(saidHome).slice(0, 200))
	await home.close()

	/* SOMEBODY ELSE'S TEAM. A rival's roster page is the same page with different men on
	   it, and the name-matcher cannot tell. Pressed from there, the app used to replace his
	   own team with his opponent's: nine men, no error, nothing said. */
	const rival = await context.newPage()
	await rival.goto(`http://baseball.fantasysports.yahoo.com/b1/${LEAGUE_ID}/3`, {
		waitUntil: "domcontentloaded"
	})
	await rival.waitForTimeout(400)
	const fromRival = await askFor("league")
	const saidRival = await app.evaluate(async grabs => {
		const { readGrabs } = await import("/src/data/yahoo-read.ts")
		const snap = await (await fetch("/snapshot.json")).json()
		/* The fourth argument is what the app knows already: this reader's team is 8. */
		const guarded = readGrabs(grabs, snap, undefined, { teamId: "8" })
		const blind = readGrabs(grabs, snap)
		return {
			teamId: guarded.teamId,
			guardedPlayers: guarded.roster?.players.length ?? 0,
			blindPlayers: blind.roster?.players.length ?? 0,
			notes: guarded.notes
		}
	}, fromRival.grabs)
	t("a rival's team page is read as a rival's, from the id in the URL",
		saidRival.teamId === "3", String(saidRival.teamId))
	t("and told which team is his, it refuses to replace his own with it",
		saidRival.guardedPlayers === 0 && saidRival.notes.some(n => /somebody else/.test(n)),
		JSON.stringify(saidRival).slice(0, 200))
	/* The unguarded call is the app as it ships today — nothing passes the team id yet, so
	   this reads the rival's nine men and would store them. Asserted so the hole is a
	   measured fact in this suite rather than a claim in a report. */
	t("and without being told, it still reads them — which is the hole that remains",
		saidRival.blindPlayers > 0, String(saidRival.blindPlayers))
	await rival.close()

	/* A LEAGUE THAT IS NOT THE ONE ON SCREEN, refused before anything is parsed. The router
	   covers this for a sweep, which names its league; a league press names none. */
	const elsewhere = await app.evaluate(async grabs => {
		const { readGrabs } = await import("/src/data/yahoo-read.ts")
		const snap = await (await fetch("/snapshot.json")).json()
		const out = readGrabs(grabs, snap, undefined, { leagueKey: "yahoo:111111" })
		return { players: out.roster?.players.length ?? 0, league: !!out.league, notes: out.notes }
	}, league.grabs)
	t("pages from another league are refused before a single one is parsed",
		elsewhere.players === 0 && !elsewhere.league && elsewhere.notes.some(n => /different league/.test(n)),
		JSON.stringify(elsewhere).slice(0, 200))
}

/* ── A SWEEP THAT IS THROTTLED HALFWAY ───────────────────────────────────────────────
   Already recorded against the real site: commit de44045 has a sweep returning 150
   players, then 25, then 0, then the literal string "Request denied". Four positions of
   real list beat none, so what it got must reach the pool — and must reach it MARKED, so
   nothing downstream can mistake four positions for the whole wire. */
{
	serveUntil = playersServed + 4
	const partial = await askFor("pool", { leagueId: LEAGUE_ID, sport: "baseball" })
	serveUntil = Infinity

	t("a sweep walled at the fifth position comes back with the four it got",
		partial.kind === "grabs" && partial.grabs?.length === 4,
		`${partial.kind} ${partial.grabs?.length}`)
	t("and carries the reason it stopped alongside them, rather than instead of them",
		/refusing to answer/i.test(partial.failure?.what ?? ""),
		JSON.stringify(partial.failure ?? null))

	const readPartial = await app.evaluate(async grabs => {
		const { readGrabs } = await import("/src/data/yahoo-read.ts")
		const { poolIsPartial } = await import("/src/client/api.ts")
		const snap = await (await fetch("/snapshot.json")).json()
		const out = readGrabs(grabs, snap)
		return {
			players: out.pool?.players.length ?? 0,
			read: out.pool?.positionsRead.length ?? 0,
			requested: out.pool?.positionsRequested.length ?? 0,
			partial: out.pool ? poolIsPartial(out.pool) : null
		}
	}, partial.grabs)
	t("the four positions it did get reach the pool rather than the floor",
		readPartial.players === 4 * PAGE_ROWS && readPartial.read === 4,
		JSON.stringify(readPartial))
	t("and the pool is refused as partial on the same rule a carried file is",
		readPartial.partial === true, JSON.stringify(readPartial))
}

/* ── ONE POSITION IS NOT A WIRE ──────────────────────────────────────────────────────
   `poolIsPartial` calls a pool partial when fewer than two thirds of the positions it
   ASKED for came back. One of one is not partial — so a reader standing on the shortstop
   list who presses "read my league" would have had a page of shortstops promoted to "the
   exact list of everyone free in your league", and the board would tell him there is nobody
   available anywhere else. Nothing calls that path today; this is the gun being unloaded. */
{
	const list = await context.newPage()
	await list.goto(
		`http://baseball.fantasysports.yahoo.com/b1/${LEAGUE_ID}/players?status=A&pos=SS&sort=AR&sdir=1&count=0`,
		{ waitUntil: "domcontentloaded" }
	)
	await list.waitForTimeout(400)
	const one = await askFor("page")
	const readOne = await app.evaluate(async grabs => {
		const { readGrabs } = await import("/src/data/yahoo-read.ts")
		const snap = await (await fetch("/snapshot.json")).json()
		const out = readGrabs(grabs, snap)
		return { pool: out.pool, notes: out.notes }
	}, one.grabs)
	t("a single players page the reader was standing on does not become his league's wire",
		readOne.pool === null && readOne.notes.some(n => /one position/.test(n)),
		JSON.stringify(readOne).slice(0, 200))
	await list.close()
}

/* ── YAHOO REFUSING WITH A STATUS RATHER THAN WITH A PAGE ────────────────────────────
   The wall served as a 200 has its own test above. A plain 429 takes the other branch, and
   it is the branch that used to say `Yahoo answered 429 for SS` — a number aimed at a
   program and a position code aimed at nobody. */
{
	failFrom = playersServed + 6
	const stopped = await askFor("pool", { leagueId: LEAGUE_ID, sport: "baseball" })
	failFrom = Infinity
	t("a sweep refused with a status keeps the six positions it already had",
		stopped.kind === "grabs" && stopped.grabs?.length === 6,
		`${stopped.kind} ${stopped.grabs?.length}`)
	t("and says which men it could not read about, in words rather than in a status code",
		/would not answer for the/.test(stopped.failure?.what ?? "") &&
			!/\b429\b/.test(stopped.failure?.what ?? ""),
		JSON.stringify(stopped.failure ?? null))
}

/* ── THE WORDS WHILE IT WORKS ────────────────────────────────────────────────────────
   Nine sequential requests is long enough to look hung. The lines take a different route
   from the answer, and that route breaks silently. */
{
	const { answer, said } = await askWithProgress("pool", { leagueId: LEAGUE_ID, sport: "baseball" })
	t("the sweep says what it is doing, all the way through",
		answer.kind === "grabs" && said.length >= 9,
		`${answer.kind}, ${said.length} lines`)
	t("and says it in the reader's words, never in a count of requests or a URL",
		said.every(s => /^reading |^done$/.test(s.say)) && said.some(s => /shortstops/.test(s.say)),
		said.map(s => s.say).join(" | "))
}

/* ── TWO PRESSES AT ONCE ─────────────────────────────────────────────────────────────
   The app disables its own button while a read runs, which covers one screen and nothing
   at all for two: the board and the setup sheet are separate tabs with separate ideas of
   busy, both routing to the one Yahoo tab. Interleaved, that is eighteen requests in the
   budget for nine, against a site that walls nine often enough to have its own commit. */
{
	const at = playersServed
	const [first, second] = await Promise.all([
		askFor("pool", { leagueId: LEAGUE_ID, sport: "baseball" }),
		/* A beat behind, so the first has certainly started. Without it the two race and
		   which one is refused is a coin toss — the assertion is that ONE of them is. */
		new Promise(r => setTimeout(r, 300)).then(() =>
			askFor("pool", { leagueId: LEAGUE_ID, sport: "baseball" })
		)
	])
	const done = [first, second].filter(a => a.kind === "grabs")
	const turned = [first, second].filter(a => a.kind === "failed")
	t("a second press while a sweep is running is refused, not run alongside it",
		done.length === 1 && turned.length === 1 && /being read right now/.test(turned[0]?.failure?.what ?? ""),
		JSON.stringify([first.kind, second.kind, turned[0]?.failure?.what]))
	t("and Yahoo was asked nine times for it, not eighteen",
		playersServed - at === 9, String(playersServed - at))
}

/* ── HE CLICKS A LINK ON YAHOO WHILE IT IS READING ───────────────────────────────────
   The sweep lives in the Yahoo tab, so navigating that tab destroys it mid-flight. Nothing
   in the app knows: the press was made on another tab, the answer simply never comes, and
   the reader waits out the full ninety seconds of patience for a read that stopped existing
   two seconds in. The browser does tell the router — the message channel closes — and the
   router's answer to that is a sentence he can act on. */
{
	const started = Date.now()
	const inFlight = askFor("pool", { leagueId: LEAGUE_ID, sport: "baseball" })
	await new Promise(r => setTimeout(r, 700))
	const open = context.pages().find(p => /fantasysports\.yahoo\.com/.test(p.url()))
	await open.goto(`http://baseball.fantasysports.yahoo.com/b1/${LEAGUE_ID}`, {
		waitUntil: "domcontentloaded"
	})
	const lost = await inFlight
	const took = Date.now() - started
	t("navigating away mid-sweep is answered at once, not after ninety seconds of patience",
		lost.kind === "failed" && took < 30_000,
		`${lost.kind} after ${took} ms`)
	t("and it says the tab could not be read, which is the thing he can do something about",
		/could not be read/.test(lost.failure?.what ?? ""),
		JSON.stringify(lost).slice(0, 200))
	/* Back on his own team, for everything below. */
	await open.goto(yahoo, { waitUntil: "domcontentloaded" })
	await open.waitForTimeout(400)
}

/* ── THE SIGN-IN WALL ────────────────────────────────────────────────────────────────
   Yahoo's answer to a session that has expired is a page, not a status — the same shape as
   the throttle, with different words. A reader whose session died mid-afternoon must be
   told to sign in rather than told his league is empty. */
{
	const out = context.pages().find(p => /fantasysports\.yahoo\.com/.test(p.url()))
	await out.evaluate(() => {
		document.body.textContent = "Please sign in to continue to Yahoo Fantasy."
	})
	const asked = await askFor("page")
	t("an expired session is reported as an expired session, not as a team of nobody",
		asked.kind === "failed" && /sign in/i.test(asked.failure?.what ?? ""),
		JSON.stringify(asked).slice(0, 200))
	await out.goto(yahoo, { waitUntil: "domcontentloaded" })
	await out.waitForTimeout(400)
}

/* ── THE READER'S OWN PATH, through the screens he actually touches ──────────────────
   Everything above proves the wire. This drives the UI: open the setup sheet, take the
   offer, press the button, and check that what lands in this browser is a league, a team
   with seats and a list of free agents — through the same stores every other route writes
   to, because the reader is a way of getting the pages and not a second way of having a
   league. */
{
	const ui = await context.newPage()
	const uiErrs = []
	ui.on("pageerror", e => uiErrs.push(String(e)))
	await ui.addInitScript(c => {
		localStorage.clear()
		localStorage.setItem("beanemachine:config", JSON.stringify(c))
	}, { ...cfg, active_league: KEY, leagues: { [KEY]: cfg.leagues[KEY] } })
	await ui.goto(`${APP}#my-league`, { waitUntil: "domcontentloaded" })
	await ui.waitForSelector("nav button", { timeout: 30000 })
	await ui.waitForTimeout(2500)

	const setup = await ui.$('button:text-is("Set up a league")')
	if (setup) await setup.click()
	await ui.waitForSelector(".onboard", { timeout: 20000 })
	/* THE SHEET OPENS ON THE BUTTON, not on the box, and this assertion changed to say so.
	   It used to require the offer LINE above the team box and then click it. That was the
	   right screen for a reader who has to be told the reader exists; it is the wrong one for
	   a reader whose browser can already do it and who has no team stored yet, and this test
	   is that reader — the extension is loaded in this browser. Both paths are still covered:
	   the offer line is asserted by the walkthrough screenshot path, and the way BACK to the
	   box is asserted below. */
	await ui.waitForSelector(".connect", { timeout: 10000 })
	t("a reader who already has it lands on the button, not on the box",
		!(await ui.$(".onboard-offer button")) && !!(await ui.$(".connect")),
		await ui.$eval(".onboard", e => e.innerText.slice(0, 120)))
	t("and the way back to typing a team in is on the same screen",
		!!(await ui.$(".connect-back button")),
		await ui.$eval(".connect", e => e.innerText.slice(-80)))

	/* The extension is installed in this browser, so the walkthrough must NOT be what he
	   sees: a screen that keeps telling a reader how to install the thing he has installed
	   is a screen that has not noticed him. */
	t("and once it is there, the steps are gone and the button is the button",
		(await ui.$$(".step")).length === 0 && !!(await ui.$(".connect.connected")),
		await ui.$eval(".connect", e => e.innerText.slice(0, 160)))

	await ui.click(".connect .primary")
	/* The sweep is nine sequential requests with a quarter-second between them, so this
	   waits on the STORE rather than on a spinner. */
	await ui.waitForFunction(
		() => {
			try {
				return Object.keys(JSON.parse(localStorage.getItem("beanemachine:pool") ?? "{}")).length > 0
			} catch {
				return false
			}
		},
		{ timeout: 60000 }
	)
	const got = await ui.evaluate(k => {
		const read = n => JSON.parse(localStorage.getItem(`beanemachine:${n}`) ?? "null")
		const pool = read("pool")?.[k]
		return {
			roster: read("roster")?.[k]?.length ?? 0,
			spots: read("lineup")?.[k]?.spots?.length ?? 0,
			pool: pool?.players?.length ?? 0,
			asked: pool?.positionsRequested?.length ?? 0,
			note: pool?.note ?? "",
			stamped: !!pool?.at
		}
	}, KEY)
	t("one press puts his team in this browser, with the seat each man is in",
		got.roster === seated.length && got.spots === seated.length, JSON.stringify(got))
	t("and his league's free agents, stamped with when they were read",
		got.pool === 9 * PAGE_ROWS && got.stamped, JSON.stringify(got))
	t("and says where they came from, because a carried file and a read age differently",
		/read off your league in this browser/.test(got.note), got.note)
	t("and records which positions it asked for, so a throttled sweep is refused as partial",
		got.asked === 9, String(got.asked))
	t("with nothing thrown on the way", uiErrs.length === 0, uiErrs.join(" | "))
	await ui.close()
}

/* ── WHAT EACH STORE WILL ACCEPT ─────────────────────────────────────────────────────
   The Chromium run above proves one of the two builds. Firefox cannot be driven with an
   unpacked extension from here, so what is asserted instead is the thing that actually
   goes wrong when one source has to make two builds — and it goes wrong SILENTLY.

   Firefox does not support `background.service_worker` at all (bug 1573659) and runs an
   event page from `background.scripts`. Ship Chrome's key to Firefox and the add-on
   installs, shows up in the list, and never runs a line of background code: no router, no
   answer to any question the page asks, and nothing on screen saying why. That is the
   failure this block exists to make loud. */
{
	const manifest = b => JSON.parse(readFileSync(new URL(`../dist-ext/${b}/manifest.json`, import.meta.url), "utf8"))
	const chrome = manifest("chrome")
	const firefox = manifest("firefox")
	t("Chrome gets a service worker", chrome.background?.service_worker === "background.js" && !chrome.background.scripts,
		JSON.stringify(chrome.background))
	t("and Firefox gets an event page, never a service worker",
		firefox.background?.scripts?.[0] === "background.js" && !firefox.background.service_worker,
		JSON.stringify(firefox.background))
	t("Firefox gets an id it can recognise across updates",
		/@/.test(firefox.browser_specific_settings?.gecko?.id ?? ""),
		JSON.stringify(firefox.browser_specific_settings))
	/* 128 rather than 109. MV3 has been available since 109, but host permissions are only
	   GRANTED at install from 127 — before that they sit ungranted with nothing telling the
	   reader why nothing works. 128 is the ESR, which is what a cautious install runs. */
	t("and a floor where host permissions are actually granted at install",
		Number.parseInt(firefox.browser_specific_settings?.gecko?.strict_min_version ?? "0", 10) >= 127,
		firefox.browser_specific_settings?.gecko?.strict_min_version)
	for (const [name, m] of [["chrome", chrome], ["firefox", firefox]]) {
		t(`${name} asks for the Yahoo host and nothing wider`,
			JSON.stringify(m.host_permissions) === JSON.stringify(["*://*.fantasysports.yahoo.com/*"]),
			JSON.stringify(m.host_permissions))
		/* A permission nobody uses is a permission somebody has to justify — to a store
		   reviewer and to a reader reading the install prompt. Nothing is stored, so
		   `storage` is not asked for. */
		t(`${name} asks for no storage, because it keeps nothing`,
			!(m.permissions ?? []).includes("storage"), JSON.stringify(m.permissions))
		t(`${name} reads the app's own origin, so the two halves can talk`,
			m.content_scripts?.some(c => c.matches.includes("https://beanemachine.com/*")),
			JSON.stringify(m.content_scripts?.map(c => c.matches)))
	}
}

/* ── WHEN IT GOES AWAY UNDER AN OPEN PAGE ────────────────────────────────────────────
   LAST, BECAUSE IT DESTROYS THE THING UNDER TEST. `chrome.runtime.reload()` is what the
   browser does to an extension when the store updates it, and it is the closest this suite
   can get to a reader switching it off or uninstalling it: the new instance starts, and
   every content script already injected into an open tab is orphaned — still running, still
   listening, with a handle that throws `Extension context invalidated` on every call.

   What that used to do, walked through the code and then confirmed by the timing assertion
   below: the throw happened inside the bridge's own listener, invisibly to the page; no
   answer was ever posted; and the page sat on its ninety-second patience before telling the
   reader "the read did not come back. Check your Yahoo tab is still open" — which is false,
   and which he waits a minute and a half to hear. The mark on the document stayed put, too,
   so every screen went on offering a read that could not happen. */
{
	const worker = context.serviceWorkers()[0]
	if (!worker) t("the background worker can be reached, to reload the extension", false, "no service worker")
	else {
		/*
		   FIRST, WITH A READ ALREADY IN THE AIR.

		   This is the shape a reader actually meets it in: the store updates the thing while
		   his sweep is running. The press was made two seconds ago, the answer is never
		   coming, and the only question is whether he finds out now or in a minute and a
		   half. Here the channel dies between the send and the answer, which is the
		   `lastError` branch rather than the throw.
		*/
		const flying = askFor("pool", { leagueId: LEAGUE_ID, sport: "baseball" })
		const flyingFrom = Date.now()
		await app.waitForTimeout(600)
		/* The evaluate never returns — the worker it is running in is torn down by the call
		   it is making — so the rejection IS the success signal, and either way the reload
		   has happened by the time it settles. */
		await worker.evaluate(() => chrome.runtime.reload()).catch(() => {})
		const interrupted = await flying
		const flyingTook = Date.now() - flyingFrom
		t("a read already in the air when it is updated comes back, rather than being waited out",
			interrupted.kind === "failed" && flyingTook < 30_000,
			`${interrupted.kind} after ${flyingTook} ms`)
		t("and that answer says it was switched off or updated, not that his Yahoo tab is gone",
			/switched off or updated/.test(interrupted.failure?.what ?? ""),
			JSON.stringify(interrupted).slice(0, 200))

		await app.waitForTimeout(1000)

		const started = Date.now()
		const dead = await askFor("page")
		const took = Date.now() - started
		console.log(`\n  a read after the extension went away came back in ${took} ms\n`)
		t("a read started after it went away comes back at once, not after ninety seconds",
			dead.kind === "failed" && took < 10_000,
			`${dead.kind} after ${took} ms`)
		t("and says what actually happened, rather than blaming his Yahoo tab",
			/switched off or updated/.test(dead.failure?.what ?? ""),
			JSON.stringify(dead).slice(0, 200))
		/* The mark is what `extensionHere()` reads during a first render to decide whether to
		   offer a read at all. Left on a dead page it makes every screen offer something that
		   cannot happen; taken off, the app recovers on its own without knowing any of this
		   went on. */
		t("and the page stops believing there is anything here to ask",
			!(await app.evaluate(() => document.documentElement.hasAttribute("data-beanemachine-extension"))),
			await app.evaluate(() => document.documentElement.getAttribute("data-beanemachine-extension")))

		/*
		   A PAGE LOADED AFTERWARDS DOES NOT CLAIM IT CAN READ EITHER.

		   The mark is written by a content script at `document_start`, so a page loaded while
		   there is nothing to inject it never gets one — which is the same state as a reader
		   who never installed anything, and is what every screen in the app is already
		   written for. Asserted because it is the difference between "the app recovers" and
		   "the app recovers until he opens a second tab".

		   WHAT THIS SUITE CANNOT SHOW, and the report must say so: that the read works again
		   once a NEW version is running. Measured here rather than assumed — after
		   `chrome.runtime.reload()`, this browser, launched with `--load-extension`, comes
		   back with zero service workers and injects nothing into any page loaded afterwards.
		   The extension does not return, so the second half of a store update cannot be
		   staged in this harness at all. What is covered is everything up to the reader
		   pressing reload; what happens after his browser has installed the new version is
		   covered by the ordinary path, which is every other assertion in this file.
		*/
		const fresh = await context.newPage()
		await fresh.goto(APP, { waitUntil: "domcontentloaded" })
		await fresh.waitForSelector("nav button", { timeout: 30000 })
		await fresh.waitForTimeout(1000)
		t("and a page opened after it went away does not claim it can read either",
			(await fresh.evaluate(() => document.documentElement.getAttribute("data-beanemachine-extension"))) === null,
			String(await fresh.evaluate(() => document.documentElement.getAttribute("data-beanemachine-extension"))))
		await fresh.close()
	}
}

t("and the app logged no errors through any of it", errs.length === 0, errs.join(" | "))

await context.close()
server.close()
console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
