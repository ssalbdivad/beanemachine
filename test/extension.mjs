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
 * Nothing about the extension is stubbed: the suite builds it and loads the result
 * unpacked, exactly as a reader loads it.
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
import { existsSync, readFileSync, mkdtempSync } from "node:fs"
import { inflateRawSync, inflateSync } from "node:zlib"
import { spawn } from "node:child_process"
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

/**
 * THE POSITION-ELIGIBILITY PAGE, BUILT FROM THE VALUES THE REAL ONE GAVE.
 *
 * Not invented: `scoring.json`'s own league carries `eligibility` read off
 * `/positioneligibility` for league 228947 by the Node importer — 5 games started or 10
 * played, 3 starts for SP, 5 relief appearances for RP, and ten tracked positions ending
 * in P. This page is written back out of those numbers and the parse is asserted against
 * them, so the fixture and the assertion cannot agree on anything the real page did not
 * say. The ORDER — the legend, then the tracked positions, then "Player" — is what the
 * importer's own header expression implies about the page it was measured on.
 *
 * Until now no press asked for this page at all, so every league read in a browser carried
 * `eligibility: null` while the editor for it sat on My league with nothing in it.
 */
const eligibilityPage = e => {
	const rows = [
		"Yahoo Fantasy Baseball\tMy Team\tLeague\tPlayers",
		"Position Eligibility",
		`Batters need either ${e.batters.games_started_at_position} Games Started or ${e.batters.games_played_at_position} Games Played at a position to gain eligibility.`,
		`Pitchers need ${e.pitchers.SP.starts} Starts to gain SP eligibility, ${e.pitchers.RP.relief_appearances} Relief Appearances to gain RP eligibility.`,
		"E Currently Eligible",
		"P Games to Play Until Eligible",
		"S Games to Start Until Eligible",
		"- No Appearances Yet",
		e.tracked_positions.join("\t"),
		"Player\tTeam",
		"Terms\tPrivacy\tHelp\tFeedback"
	]
	return `<!doctype html><meta charset="utf-8"><title>Position Eligibility</title><body><pre>${rows
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

/*
   THE ROW IS THE WIDTH A REAL ONE IS, and two of its cells are new.

   It used to be `<td>slot</td><td>name TEAM - POS</td>` and nothing else, which is a
   shape no Yahoo team page has: consecutive names sat under 24 characters apart, so
   `statusBetween` correctly found nothing and a suite over it would have passed over a
   dead function. The trailing cells are this file's reconstruction of the columns a real
   row carries and are labelled as such.

   Two cells are INFERRED rather than measured, and the inference is named so a green
   suite is not read as a capture:
     · the status badge, whose class pair comes from src/auto/roster.ts's selector;
     · the eligibility line with TWO positions — Yahoo prints the live multi-position
       line here and the capture in data/snapshot.json holds one primary position per
       man, so a fixture printing `p.position` alone can never exercise the widening.
   docs/EXTENSION.md records both gaps.
*/
const FLAG_AT = 0
const WIDE_AT = 1

/**
 * EVERY TEAM IN THE LEAGUE HAS ITS OWN MEN, which this fixture used not to model.
 *
 * One page was served for every `/b1/<league>/<digits>`, so nine rival rosters came back
 * identical — which is what the union's duplicate rule is written to REFUSE, and which
 * would have made a suite over it either green on a bug or red on the fixture. Each team
 * id now gets a disjoint slice of the capture: team 8 is the reader's own (the seats every
 * other assertion in this file is written against, unchanged), and every other id deals
 * from a pool of men nobody else has.
 */
const rivalsFor = (() => {
	const mine = new Set(seated.map(s => s.p.id))
	const spare = snap.players
		.filter(p => !mine.has(p.id))
		.filter(p => (p.stats?.plateAppearances ?? 0) > 200 || (p.stats?.outs ?? 0) > 200)
	const SIZE = 9
	return teamId => {
		const n = Number(teamId)
		if (!Number.isInteger(n) || n < 1) return []
		const from = (n - 1) * SIZE
		return spare
			.slice(from, from + SIZE)
			.map((p, i) => ({ slot: ["C", "1B", "2B", "3B", "SS", "OF", "SP", "RP", "BN"][i], p }))
	}
})()

const teamPage = (teamId = "8") =>
	`<!doctype html><meta charset="utf-8"><title>My Team</title><body><table>` +
	`<tr><th>Pos</th><th>Player</th></tr>` +
	(teamId === "8" ? seated : rivalsFor(teamId))
		.map(({ slot, p }, i) => {
			const elig =
				i === WIDE_AT ? `${p.position ?? "Util"},1B` : (p.position ?? "Util")
			return (
				`<tr><td>${slot}</td><td>${p.name} ${p.team ?? "FA"} - ${elig}</td>` +
				/* Its own CELL, not a bare inline span inside the name cell: `innerText`
				   renders `C<span>Q</span>` as "CQ" with no separator, and the parser reads
				   space-delimited tokens. A cell is the conservative reconstruction — if the
				   real page turns out to run the badge together with the eligibility line, the
				   flag is absent and the seat is stored without one, which is where this was
				   yesterday. */
				(i === FLAG_AT ? `<td><span class="F-injury">Q</span></td>` : `<td></td>`) +
				`<td>Wed 7:05 pm @ BAL</td><td>Preview</td>` +
				`<td>0.0</td><td>0.0</td><td>0.0</td><td>Add Drop</td></tr>`
			)
		})
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
/*
   `pos` IS NOT DECORATION EITHER. Every row used to read "MIL - SP,RP" whatever page it was
   on, which is a shape no real players page has: Yahoo's `pos=C` page lists catchers, and the
   eligibility in the row says so. The reader now checks exactly that — a page whose rows are
   mostly not of the position that was asked for was not filtered — so a fixture that always
   says SP,RP is a fixture that asserts the opposite of the page it stands in for. Every
   caller passes the position the page was served for; the one row built by hand further down
   keeps its own, and says why there.
*/
/* `status` is INFERRED, not measured: the class pair `F-injury, ysf-player-status` is what
   src/auto/roster.ts reads off the TEAM page, and whether Yahoo prints the same badge in the
   players table has never been captured. Every third row carries one so the parser is
   exercised on both shapes — a green suite here means the parser handles the badge, not that
   the badge is on the page. docs/EXTENSION.md records that gap. */
const row = (id, name, pct, pos = "SP,RP", status = id % 3 === 0 ? "DTD" : null) =>
	`<tr><td><a href="/players/${id}" data-ys-playerid="${id}" class="name" title="${name}">${name}</a>` +
	(status ? `<span class="F-injury">${status}</span>` : "") +
	`<span data-ys-playerid="${id}" class="note"></span>` +
	`<span class="Nowrap">MIL - ${pos}</span>${TOOLTIP}` +
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
		Array.from({ length: PAGE_ROWS }, (_, i) => row(base + i, `${pos} Free Agent ${i}`, 12 + i, pos)).join("") +
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
 * THE SAME WALL, BEHIND A HEADER.
 *
 * Yahoo's real pages open with a nav, a league name and a row of tabs before anything that
 * is about the request at all, and how much of that comes first is a layout nobody here
 * controls. The wall check used to read the first 600 characters, so a refusal that sat
 * behind a fuller header than the fixture's was invisible — and a throttle that is not seen
 * is a throttle parsed as a league and written into his stores as an empty team.
 *
 * 900 characters of nav is not a measurement of Yahoo's header; no real page has been read
 * by this project. It is a page built to sit between the old window and the new one, which
 * is what makes the assertion about the two windows mean something.
 */
const NAV = "Fantasy Baseball My Team League Players Scoreboard Standings Transactions Draft Research ".repeat(10)
const WALLED_BEHIND_NAV = `<!doctype html><meta charset="utf-8"><body>${NAV}Request denied. Too many requests from your network.</body>`

/**
 * HOW MANY PLAYERS PAGES THIS FIXTURE WILL SERVE BEFORE IT STARTS REFUSING.
 *
 * Yahoo throttles a sweep partway through — commit de44045 records 150 players, then 25,
 * then 0, then the literal string "Request denied" — and what the app does with the pages
 * it DID get is a question no amount of fixture that always answers can ask. Set to a
 * number for one block below and put back afterwards.
 */
let serveUntil = Infinity
/** Rival roster pages served this run, and the page after which the fixture walls —
 *  `Infinity` for the ordinary case. Drives the partial-union assertion. */
let teamsServed = 0
let teamsUntil = Infinity
let playersServed = 0

/** After this many players pages, answer with a STATUS rather than with a page. Yahoo
 *  refuses both ways — a wall served as 200 and a plain 429 — and the two take different
 *  branches through the sweep, only one of which was covered. */
let failFrom = Infinity

/** Which of the two wall pages to serve once the sweep is being refused — bare, or behind
 *  the header a real page would have. */
let wallShape = "bare"

/** After this many players pages, redirect to the login host the way an expired Yahoo
 *  session does. */
let redirectFrom = Infinity

/** After this many players pages, ACCEPT the request and never answer it — a wifi drop
 *  mid-sweep, a laptop waking from sleep, or Yahoo hanging. The socket is held open and the
 *  handle kept so the block that uses it can let go afterwards. */
let stallFrom = Infinity
const stalled = []

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
	if (url.pathname.endsWith("/positioneligibility")) return send(eligibilityPage(real.eligibility))
	if (url.pathname.endsWith("/matchup")) return send(matchupPage())
	if (url.pathname.endsWith("/players")) {
		playersServed++
		/* AN EXPIRED SESSION, THE WAY YAHOO ACTUALLY ENDS ONE: a redirect to the login host,
		   which is a different origin from the tab the sweep is running in. The request
		   therefore stops being same-origin at the redirect and the fetch rejects outright
		   rather than returning a page — a branch nothing else in this suite reaches. */
		if (playersServed > stallFrom) {
			/* No writeHead, no end: the connection is accepted and nothing is ever sent. */
			stalled.push(res)
			return
		}
		if (playersServed > redirectFrom) {
			res.writeHead(302, { location: "https://login.yahoo.com/config/login" })
			return res.end()
		}
		if (playersServed > failFrom) {
			res.writeHead(429, { "content-type": "text/html; charset=utf-8" })
			return res.end("<!doctype html><body>Too many requests</body>")
		}
		if (playersServed > serveUntil) return send(wallShape === "behind-nav" ? WALLED_BEHIND_NAV : WALL)
		return send(playersPage(url.searchParams.get("pos") ?? "C"))
	}
	/* `f1` as well as `b1`: a reader with a football league open is a case this suite drives,
	   and the football pages are served by the same routes because Yahoo's fantasy URLs have
	   the same shape for every sport — the sport is in the HOST, which is what
	   `sportFrom` reads and what the router refuses on. */
	if (/\/[bf]1\/\d+\/\d+$/.test(url.pathname)) {
		/* The team id off the URL, so nine rival rosters are nine different rosters — see
		   `rivalsFor`. `teamsServed` counts them so a walled read can be driven. */
		teamsServed++
		if (teamsServed > teamsUntil) return send(WALL)
		return send(teamPage(url.pathname.split("/").pop()))
	}
	if (/\/[bf]1\/\d+$/.test(url.pathname)) return send(`<!doctype html><body>League home</body>`)
	send(`<!doctype html><body>Yahoo Fantasy</body>`)
})
await new Promise(r => server.listen(0, "127.0.0.1", r))
const port = server.address().port

const APP = process.env.BASE ?? "http://127.0.0.1:5299"

/**
 * THE SUITE BUILDS WHAT IT TESTS, BOTH WAYS, RATHER THAN TRUSTING WHATEVER WAS LAST BUILT.
 *
 * It used to load `dist-ext/chrome` and take it on faith. That is a green suite over a
 * stale bundle whenever anybody edits extension/src and forgets the build step, which
 * happened during the work that added these assertions — the source was right, the bundle
 * was yesterday's, and the run said everything was fine.
 *
 * TWO BUILDS, and the difference between them is the point. The default is what goes to a
 * store: the bridge reaches beanemachine.com and nothing else. The suite serves the app at
 * 127.0.0.1, which the store build deliberately cannot see — a match pattern cannot name a
 * port, so shipping `http://localhost/*` would let any page served from the reader's own
 * machine ask for his Yahoo league. So the browser is given the dev build, and the store
 * build is still made, in dist-ext, because the assertions about what each store will accept
 * read that one.
 */
const buildExt = async (dir, dev) =>
	new Promise((ok, no) => {
		const child = spawn(process.execPath, ["extension/build.mjs"], {
			cwd: new URL("..", import.meta.url).pathname,
			env: { ...process.env, BM_EXT_OUT: dir, BM_EXT_DEV: dev ? "1" : "" },
			stdio: ["ignore", "pipe", "pipe"]
		})
		let said = ""
		child.stdout.on("data", d => (said += d))
		child.stderr.on("data", d => (said += d))
		child.on("close", code => (code === 0 ? ok(said.trim()) : no(new Error(said))))
	})

/* Store build first, because building it empties its own output directory and the dev build
   lives inside it — inside, rather than beside, because `.gitignore` covers `dist-ext` and a
   sibling directory would be a pile of untracked build output in every `git status` from
   here on. */
await buildExt("dist-ext", false)
await buildExt("dist-ext/dev", true)

const EXT = new URL("../dist-ext/dev/chrome", import.meta.url).pathname
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

/** Asks for a hello and waits for it — the same ask the app's own hook makes on mount, and
 *  the only way to read "is there a Yahoo tab open right now" as the app reads it. */
const helloNow = () =>
	app.evaluate(
		() =>
			new Promise(resolve => {
				const on = e => {
					if (e.source !== window || e.data?.from !== "beanemachine-extension") return
					if (e.data.kind !== "hello") return
					window.removeEventListener("message", on)
					resolve(e.data)
				}
				window.addEventListener("message", on)
				window.postMessage({ from: "beanemachine-page", id: "hello", ask: "hello" }, location.origin)
				setTimeout(() => resolve(null), 10000)
			})
	)

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

/* ── one press: the pages a league is made of ─────────────────────────────────────── */
const league = await askFor("league")
/* WAS THREE — team, settings, matchup. The fourth is `/positioneligibility`, which carries
   the thresholds and is the only page that does: every league read in a browser carried
   `eligibility: null` because no press had ever asked for it, while the Node importer had
   been reading it off that URL since before the extension existed. */
t("one press brings back the four pages a league is made of",
	league.kind === "grabs" && league.grabs.length === 4 &&
		league.grabs.map(g => g.kind).join(",") === "team,settings,eligibility,matchup",
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
		eligibility: out.eligibility,
		onLeague: out.league?.eligibility ?? null,
		notes: out.notes
	}
}, league.grabs)

/* THE THRESHOLDS, WHICH THE APP HAS AN EDITOR FOR AND HAD NOTHING TO PUT IN IT. Compared
   against the committed league, which got these numbers off the real page. */
t("and the league's own eligibility thresholds, off the page that states them",
	read.eligibility?.batters?.games_started_at_position ===
		real.eligibility.batters.games_started_at_position &&
		read.eligibility?.batters?.games_played_at_position ===
			real.eligibility.batters.games_played_at_position &&
		read.eligibility?.pitchers?.SP?.starts === real.eligibility.pitchers.SP.starts &&
		read.eligibility?.pitchers?.RP?.relief_appearances ===
			real.eligibility.pitchers.RP.relief_appearances,
	JSON.stringify(read.eligibility))
t("with the positions his league tracks, in order",
	(read.eligibility?.tracked_positions ?? []).join(",") === real.eligibility.tracked_positions.join(","),
	JSON.stringify(read.eligibility?.tracked_positions))
/* On the league as well as beside it, so a screen that adopts what came back adopts these
   without knowing they arrived on a page of their own. */
t("and they are on the league the press produced, not only beside it",
	read.onLeague?.source?.endsWith("/positioneligibility") === true, JSON.stringify(read.onLeague?.source))

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

	/*
	   THE BOUNDARY THE WHOLE ARGUMENT RESTS ON.

	   `parsePage` reads at most 9000 characters after each row marker and the cut keeps
	   exactly that span, which is why the two agree BY CONSTRUCTION rather than by luck. The
	   claim is only worth anything at the boundary, so here is a page whose rows run well
	   past it: if the cut ever kept less than the parser reads, the men on this page would
	   come back with their team and their ownership missing, and no test that used ordinary
	   rows would notice.
	*/
	const fat = `<!doctype html><body><table>` +
		[0, 1, 2]
			.map(i =>
				`<tr><td><a data-ys-playerid="${7700 + i}" title="Fat Row ${i}">Fat Row ${i}</a>` +
					`<span class="pad">${"x".repeat(9500)}</span>` +
					`<span class="Nowrap">MIL - SP,RP</span>` +
					`<td class="Ta-end"><div >${20 + i}%</div></td></tr>`
			)
			.join("") +
		`</table>${FOOTER}</body>`
	t("a row longer than the parser's own reach is cut to exactly that reach, not less",
		JSON.stringify(parsePage(fat)) === JSON.stringify(parsePage(rowsOnly(fat))) &&
			parsePage(fat).length === 3,
		JSON.stringify(parsePage(rowsOnly(fat)).map(p => p.rosteredPct)))

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
			teamIdFrom(`https://baseball.fantasysports.yahoo.com/b1/${LEAGUE_ID}/draftresults`) === null &&
			teamIdFrom(`https://baseball.fantasysports.yahoo.com/b1/${LEAGUE_ID}`) === null &&
			/* Off the same derivation `leagueIdFrom` uses, so the two cannot disagree about
			   where in the path the league sits. */
			teamIdFrom(`https://baseball.fantasysports.yahoo.com/2024/b1/${LEAGUE_ID}/8`) === "8" &&
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
	t("pressed from the league home by a browser that knows no team, it says no team was read",
		saidHome.players === 0 && saidHome.notes.some(n => /not your team/.test(n)),
		JSON.stringify(saidHome).slice(0, 200))

	/*
	   ONE PRESS BRINGS BACK HIS TEAM FROM A PAGE WHOSE URL DOES NOT NAME ONE.

	   This is the whole of the fix and it is measured here rather than argued: the same tab,
	   the same button, the only difference being that the app says which team is his. Before,
	   `onePress` could not ask for a roster from any URL shape but the roster's own — so a
	   reader pressing from the league home or the players page, which is where a manager
	   spends his week, got his scoring and his matchup and a board priced against seats
	   nothing had ever read.
	*/
	const knowing = await askFor("league", { teamId: "8" })
	const saidKnowing = await app.evaluate(async grabs => {
		const { readGrabs } = await import("/src/data/yahoo-read.ts")
		const snap = await (await fetch("/snapshot.json")).json()
		const out = readGrabs(grabs, snap, undefined, { teamId: "8" })
		return { players: out.roster?.players.length ?? 0, spots: out.roster?.spots.length ?? 0, teamId: out.teamId }
	}, knowing.grabs)
	t("and told which team is his, the same press from the league home brings his roster back",
		saidKnowing.players === seated.length && saidKnowing.spots === seated.length && saidKnowing.teamId === "8",
		JSON.stringify(saidKnowing))
	/* Five pages, four of them fetched: the one he is standing on costs nobody a request,
	   and the other four are his own league's, from his own signed-in tab. */
	t("…in five pages and no more",
		knowing.grabs?.length === 5 &&
			knowing.grabs.map(g => g.kind).join(",") === "league,team,settings,eligibility,matchup",
		(knowing.grabs ?? []).map(g => g.kind).join(","))
	await home.close()

	/*
	   THE PLAYERS PAGE, WHICH IS WHERE A MANAGER ACTUALLY STANDS.

	   The page he is on while he decides who to add, and the one a press used to be worth
	   least from: no roster, because its URL names no team. One press from here has to bring
	   his team back AND still refuse to call one position of the player list a wire — the two
	   pull in opposite directions, so they are asserted together.
	*/
	const onPlayers = await context.newPage()
	await onPlayers.goto(
		`http://baseball.fantasysports.yahoo.com/b1/${LEAGUE_ID}/players?status=A&pos=C&count=0`,
		{ waitUntil: "domcontentloaded" }
	)
	await onPlayers.waitForTimeout(400)
	const fromPlayers = await askFor("league", { teamId: "8" })
	const saidPlayers = await app.evaluate(async grabs => {
		const { readGrabs } = await import("/src/data/yahoo-read.ts")
		const snap = await (await fetch("/snapshot.json")).json()
		const out = readGrabs(grabs, snap, undefined, { teamId: "8" })
		return {
			kinds: grabs.map(g => g.kind).join(","),
			players: out.roster?.players.length ?? 0,
			scoring: out.league ? Object.keys(out.league.scoring.batting).length : 0,
			thresholds: out.eligibility?.batters?.games_played_at_position ?? null,
			pool: out.pool?.players.length ?? 0,
			notes: out.notes
		}
	}, fromPlayers.grabs)
	t("pressed from the players page, one press brings back his team, his scoring and his thresholds",
		saidPlayers.players === seated.length &&
			saidPlayers.scoring === Object.keys(real.scoring.batting).length &&
			saidPlayers.thresholds === real.eligibility.batters.games_played_at_position,
		JSON.stringify(saidPlayers).slice(0, 300))
	/* And the page he is standing on is still one position of a list, not the wire. Promoting
	   it would tell him nobody is free at the other eight positions. */
	t("…and the one position he is looking at is not promoted to his whole wire",
		saidPlayers.pool === 0 && saidPlayers.notes.some(n => /one position/.test(n)),
		JSON.stringify(saidPlayers.notes))
	await onPlayers.close()

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
	/* The unguarded call is a browser that has never read his team page: there is nothing to
	   check the rival's id against, so his nine men are read and would be stored. That is
	   still the honest fallback — refusing every first read would refuse the feature — and it
	   is asserted so the remaining hole is a measured fact rather than a claim in a report.
	   `readLeagueHere` passes the id as soon as this browser has one. */
	t("and without being told, it still reads them — which is the hole that remains",
		saidRival.blindPlayers > 0, String(saidRival.blindPlayers))

	/*
	   TOLD WHICH TEAM IS HIS, THE PRESS GOES AND GETS IT.

	   The refusal above is the right answer to "this page is not yours" and it used to be the
	   only answer: the reader who opened a rival's roster to see what he was up against, then
	   pressed the button, was told no and had to go back to his own team page and press again.
	   One press now returns both — the rival page he is standing on, which is refused, and his
	   own, which is read — so the sentence and the roster arrive together.
	*/
	const knowingRival = await askFor("league", { teamId: "8" })
	const saidKnowingRival = await app.evaluate(async grabs => {
		const { readGrabs } = await import("/src/data/yahoo-read.ts")
		const snap = await (await fetch("/snapshot.json")).json()
		const out = readGrabs(grabs, snap, undefined, { teamId: "8" })
		return {
			kinds: grabs.map(g => g.kind).join(","),
			teamId: out.teamId,
			players: out.roster?.players.length ?? 0,
			notes: out.notes
		}
	}, knowingRival.grabs)
	t("standing on a rival's roster, one press still brings back his own",
		saidKnowingRival.teamId === "8" && saidKnowingRival.players === seated.length,
		JSON.stringify(saidKnowingRival).slice(0, 240))
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

/* ── HIS SESSION EXPIRES HALFWAY THROUGH ─────────────────────────────────────────────
   Yahoo does not answer a signed-out request with a page; it redirects to the login host,
   which is a different origin from the tab the sweep is running in. The request stops being
   same-origin at that redirect, so the fetch does not return a wall to read — it rejects,
   which is a different branch from every other refusal in this file, and the branch a
   reader whose session times out mid-afternoon actually takes. */
{
	redirectFrom = playersServed + 2
	const expired = await askFor("pool", { leagueId: LEAGUE_ID, sport: "baseball" })
	redirectFrom = Infinity
	t("a session that expires mid-sweep keeps the positions already read",
		expired.kind === "grabs" && expired.grabs?.length === 2,
		`${expired.kind} ${expired.grabs?.length}`)
	t("and tells him to check he is still signed in, rather than reporting an empty league",
		/signed in/i.test(expired.failure?.fix ?? ""),
		JSON.stringify(expired.failure ?? null))
}

/* ── A WALL BEHIND A HEADER ──────────────────────────────────────────────────────────
   The refusal does not have to be the first thing on the page, and where it sits depends on
   a layout nobody here controls. The check used to read 600 characters; this page puts the
   wall past that and inside 2000, which is the window now. Both halves are asserted: that
   the old window would have walked straight past it, and that the sweep stops on it. */
{
	t("the wall this serves really is out of the old six-hundred-character window",
		!/request denied/i.test(WALLED_BEHIND_NAV.slice(0, 600)) &&
			/request denied/i.test(WALLED_BEHIND_NAV.slice(0, 2000)),
		String(WALLED_BEHIND_NAV.indexOf("Request denied")))

	wallShape = "behind-nav"
	serveUntil = playersServed + 3
	const late = await askFor("pool", { leagueId: LEAGUE_ID, sport: "baseball" })
	serveUntil = Infinity
	wallShape = "bare"
	t("a refusal that is not the first thing on the page is still seen as a refusal",
		late.kind === "grabs" &&
			late.grabs?.length === 3 &&
			/refusing to answer/i.test(late.failure?.what ?? ""),
		`${late.grabs?.length} grabs, ${JSON.stringify(late.failure ?? null)}`)
	/* The expensive failure this prevents: unseen, the walled page parses to no rows, the
	   sweep carries on, and what reaches the pool is four positions of real men and five
	   positions of nothing — reported as the league's whole wire. */
	t("and the sweep stops there rather than carrying on collecting empty pages",
		late.grabs?.every(g => !!g.html) === true,
		JSON.stringify(late.grabs?.map(g => (g.html ?? "").length)))
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
	/* And it does not cross the wire whole, either. This is the one grab that is a page of
	   markup rather than a page of text, and it is taken from a press nobody meant as a
	   sweep — so it gets the same cut, on the same fail-safe terms. */
	const looseBytes = Buffer.byteLength(one.grabs?.[0]?.html ?? "", "utf8")
	const wholeBytes = Buffer.byteLength(playersPage("SS"), "utf8")
	console.log(`\n  bytes — the players page he was standing on: ${looseBytes} arrived, ${wholeBytes} whole\n`)
	t("and it is cut to its rows on the way out, like a swept one",
		looseBytes > 0 && looseBytes < wholeBytes / 4,
		`${looseBytes} vs ${wholeBytes}`)
	await list.close()
}

/* ── WHAT THE PAGE IS ALLOWED TO PUT IN A URL ────────────────────────────────────────
   The league and the sport come from the app and end up interpolated into a path that is
   fetched with the reader's own cookies. Same-origin bounds the damage — nothing can be
   sent to another site — but a league id carrying a path is still a request for a different
   page of Yahoo, answered as him and handed back to whatever asked. The app is a static
   site with no server, so the realistic way this is ever abused is a script injected into a
   page of it, which is exactly the case where the request must not be made. */
{
	const crooked = await askFor("pool", { leagueId: "228947/../../mail", sport: "baseball" })
	t("a league id carrying a path is refused rather than fetched",
		crooked.kind === "failed", JSON.stringify(crooked).slice(0, 200))

	/* And a sweep costs at most nine requests however it is asked for. `positions` becomes
	   one request each against somebody else's site, made by the READER's account, so the
	   list is narrowed to the nine slots that exist and deduplicated before anything is
	   fetched. */
	const at = playersServed
	const narrowed = await askFor("pool", {
		leagueId: LEAGUE_ID,
		sport: "baseball",
		positions: ["SS", "SS", "SS", "not-a-position"]
	})
	t("a sweep asked for one slot three times and one that does not exist asks Yahoo once",
		narrowed.kind === "grabs" && narrowed.grabs?.length === 1 && playersServed - at === 1,
		`${narrowed.grabs?.length} grabs, ${playersServed - at} requests`)
}

/* ── HE CLICKS SOMETHING ELSE ON YAHOO ───────────────────────────────────────────────
   A tab that announced itself and then went somewhere else is the commonest stale fact
   there is: nothing announces a departure. The router used to keep what it had been told
   until the tab closed, which meant the app went on being offered a read off a tab that is
   now Yahoo's fantasy front page — and the read would have succeeded, handing back the front
   page as though it were his league: the entry stayed because nothing announces a departure,
   and the content script is alive on the front page too, so the ask would have been answered
   with it. That last part is read off the router that was there rather than staged; this
   suite cannot run the old one and the new one in the same browser.

   The fix is that the router asks the browser which tabs are Yahoo instead of remembering,
   and reads what each one IS out of its own URL. The same change is what survives the
   service worker being stopped, which Chrome does after about thirty seconds idle and which
   this harness cannot stage — Playwright attaches a debugger to the worker and that keeps it
   alive; measured here, still one worker and the tab still found after seventy seconds. That
   half is argued rather than proven, and the report says so. */
{
	for (const p of context.pages()) if (/fantasysports\.yahoo\.com/.test(p.url())) await p.close()
	const only = await context.newPage()
	await only.goto(yahoo, { waitUntil: "domcontentloaded" })
	await only.waitForTimeout(500)
	const before = await helloNow()
	t("with one league tab open, the app is told there is something to read",
		before?.yahooOpen === true, JSON.stringify(before))

	/* Yahoo's own fantasy front page: same host, so it is still a Yahoo tab as far as any
	   match pattern is concerned, and no league in its path at all. */
	await only.goto("http://baseball.fantasysports.yahoo.com/", { waitUntil: "domcontentloaded" })
	await only.waitForTimeout(600)
	const gone = await askFor("page")
	t("a tab that has wandered off his league is not read as though it were still on it",
		gone.kind === "failed" && /no Yahoo fantasy page is open/.test(gone.failure?.what ?? ""),
		JSON.stringify(gone).slice(0, 200))
	const after = await helloNow()
	t("and the app is told there is nothing to read, rather than offered a read that cannot work",
		after?.yahooOpen === false, JSON.stringify(after))

	await only.close()
	const back = await context.newPage()
	await back.goto(yahoo, { waitUntil: "domcontentloaded" })
	await back.waitForTimeout(400)
}

/* ── THE LEAGUE ID OUT OF A URL ──────────────────────────────────────────────────────
   The key every store in this app writes under. Getting it wrong does not fail, it writes
   a league under a name that will never match anything again. */
{
	t("the league is the number after the game, not the first number in the path",
		leagueIdFrom("https://baseball.fantasysports.yahoo.com/b1/228947/8") === "228947" &&
			leagueIdFrom("https://baseball.fantasysports.yahoo.com/b1/228947/settings") === "228947" &&
			/* A shape this project has never seen served, narrowed against anyway because the
			   cost is one condition and the failure is a season id stored as a league. */
			leagueIdFrom("https://baseball.fantasysports.yahoo.com/2024/b1/228947/8") === "228947" &&
			leagueIdFrom("https://baseball.fantasysports.yahoo.com/") === null,
		String(leagueIdFrom("https://baseball.fantasysports.yahoo.com/2024/b1/228947/8")))
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
		const spots = read("lineup")?.[k]?.spots ?? []
		return {
			roster: read("roster")?.[k]?.length ?? 0,
			spots: spots.length,
			/* The two things the TEAM page prints that the browser route used to lose
			   between the text and the store: the flag beside a hurt man, and the live
			   multi-position eligibility line. Read back out of the store rather than off
			   the parser, because the four narrowing points between them are where it died. */
			seatFlags: spots.filter(x => x.status).map(x => x.status),
			widened: spots.filter(x => x.positions.length > 1).length,
			pool: pool?.players?.length ?? 0,
			asked: pool?.positionsRequested?.length ?? 0,
			note: pool?.note ?? "",
			stamped: !!pool?.at,
			/* The two columns the sweep already fetched and used to throw away at the store —
			   Yahoo's own roster share and its own status badge. Both are what the board now
			   prices and marks a row from, so the round trip is what is asserted, not the
			   parser, which test/ownership.mjs pins on its own. */
			priced: pool?.players?.filter(p => typeof p.rosteredPct === "number").length ?? 0,
			flagged: pool?.players?.filter(p => p.status).length ?? 0
		}
	}, KEY)
	t("one press puts his team in this browser, with the seat each man is in",
		got.roster === seated.length && got.spots === seated.length, JSON.stringify(got))
	t("the flag his own team page printed beside a man reaches the seats it stores",
		got.seatFlags.length === 1 && got.seatFlags[0] === "Q", JSON.stringify(got.seatFlags))
	t("…and it is not smeared onto the man below him",
		got.seatFlags.length === 1, JSON.stringify(got.seatFlags))
	/* The capture holds one primary position per man, so before this the only widening
	   available came from `snapshot.eligibility` — 328 of 1,446 players. The page's own
	   line is what widens the rest, and this is the seat coming back wider than the
	   capture could have made it. */
	t("…and the league's own eligibility line widens the seat the capture could not",
		got.widened >= 1, String(got.widened))
	t("and his league's free agents, stamped with when they were read",
		got.pool === 9 * PAGE_ROWS && got.stamped, JSON.stringify(got))
	t("and says where they came from, because a carried file and a read age differently",
		/read off your league in this browser/.test(got.note), got.note)
	t("and records which positions it asked for, so a throttled sweep is refused as partial",
		got.asked === 9, String(got.asked))
	t("and every man carries the rostered share his own league page printed for him",
		got.priced === got.pool && got.pool > 0, JSON.stringify(got))
	t("and the status badge on the rows that had one, and nothing on the rows that did not",
		got.flagged > 0 && got.flagged < got.pool, JSON.stringify(got))
	t("with nothing thrown on the way", uiErrs.length === 0, uiErrs.join(" | "))

	/*
	   ── AND THEN THE ONE THAT STOPS THE APP ESTIMATING ──────────────────────────────
	
	   Every other answer this app has to "can I add him" approximates this one. The sweep
	   above is Yahoo's top twenty-five a position, so the addable universe it produces is
	   ~225 men chosen by Yahoo's own rank; without it the board falls back to a capture's
	   rostered-share column, which calls 1,010 of 1,248 rateable men gettable where the
	   derived wire calls 540. The union of the league's own rosters is the set.
	*/
	/* Out of the setup sheet and onto My league, which is where a press that costs one
	   request per rival team lives — beside the league read rather than inside it. */
	await ui.click(".connect-back button").catch(() => {})
	await ui.waitForTimeout(500)
	const dock = await ui.$('.dock-bar button[aria-expanded="true"], .dock-sheet button[aria-expanded="true"]')
	if (dock) await dock.click()
	await ui.waitForSelector("button.read-rosters", { timeout: 20000 })
	await ui.click("button.read-rosters")
	await ui.waitForFunction(
		() => {
			try {
				return Object.keys(JSON.parse(localStorage.getItem("beanemachine:taken") ?? "{}")).length > 0
			} catch {
				return false
			}
		},
		undefined,
		{ timeout: 90000 }
	)
	const union = await ui.evaluate(k => {
		const held = JSON.parse(localStorage.getItem("beanemachine:taken") ?? "null")?.[k]
		const teams = Object.keys(held?.byTeam ?? {})
		const all = Object.values(held?.byTeam ?? {}).flat()
		return {
			teams: teams.length,
			read: held?.teamsRead?.length ?? 0,
			asked: held?.teamsAsked?.length ?? 0,
			men: all.length,
			distinct: new Set(all).size,
			mine: teams.includes("8"),
			stamped: !!held?.at,
			note: held?.note ?? "",
			first: all[0] ?? ""
		}
	}, KEY)
	/* Nine rivals in a ten-team league, and his own team is not one of them: he is not a
	   counterparty and his own men are already in the roster store. */
	t("one press reads every OTHER team in his league",
		union.teams === 9 && union.asked === 9 && union.read === 9 && !union.mine,
		JSON.stringify(union))
	/* The fixture deals each team a disjoint slice of the capture, so a union that
	   deduplicated to fewer men than it holds would mean two teams came back as one page —
	   which is the redirect the duplicate rule exists to catch. */
	t("…and the nine rosters are nine different rosters, not one page served nine times",
		union.men > 0 && union.distinct === union.men, JSON.stringify(union))
	t("…kept per team, so the app can name who owns a man rather than only that somebody does",
		union.teams === 9 && union.men >= 9 * 5, JSON.stringify(union))
	t("…and stamped and sourced, because a taken list is as perishable as a wire",
		union.stamped && /read off your league.s own rosters/.test(union.note),
		JSON.stringify(union))
	/* AND THE PAYOFF FOR KEEPING IT PER TEAM. This screen has always been a calculator
	   for a deal somebody else proposed: it prices both sides and could not say who would
	   have to agree to it. The search on the receiving side now names the holder. */
	/* A man the FIXTURE put on team 1, so the search below is asking about a real holder
	   rather than hoping one turns up. */
	const held1 = rivalsFor("1")[0]?.p?.name ?? ""
	/* The deal builder is a disclosure — a reader opens it when he has a deal to price —
	   so it is opened here rather than assumed. */
	/* Either wording: this league's trade deadline has passed on the committed config, so
	   the press reads "Price one anyway" rather than "Price a trade". */
	await ui.click('.trade-deal .chip-btn').catch(() => {})
	await ui.waitForSelector('[data-ctl="get-search"]', { timeout: 20000 })
	await ui.fill('[data-ctl="get-search"]', held1.split(" ").slice(-1)[0] || "zzz")
	await ui.waitForTimeout(600)
	const named = await ui
		.$$eval(".trade-result .owner", n => n.map(e => e.textContent.trim()))
		.catch(() => [])
	t("and the man he would be receiving is labelled with the team that holds him",
		named.some(x => /^team \d+$/.test(x)), JSON.stringify(named.slice(0, 5)))
	t("with nothing thrown on the way either", uiErrs.length === 0, uiErrs.join(" | "))
	await ui.close()
}

/* ── A UNION MISSING ONE ROSTER IS NOT A SMALLER ANSWER ──────────────────────────────
   It is that team's twenty-seven men reported as FREE, and rostered men rank at the top,
   so they would head the board — the failure `likelyAvailable` records on Blake Snell.
   So the taken store is all-or-nothing, and this drives the partial: the fixture walls
   after the fifth roster, and what must be in the browser afterwards is NOTHING. */
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
	await ui.waitForSelector("button.read-rosters", { timeout: 30000 })
	teamsServed = 0
	teamsUntil = 5
	await ui.click("button.read-rosters")
	await ui.waitForFunction(
		() => /rosters came back|could not be read/.test(document.querySelector(".read-yahoo")?.innerText ?? ""),
		undefined,
		{ timeout: 90000 }
	)
	teamsUntil = Infinity
	const said = await ui.$eval(".read-yahoo", e => e.innerText.replace(/\s+/g, " "))
	const after = await ui.evaluate(
		k => JSON.parse(localStorage.getItem("beanemachine:taken") ?? "null")?.[k] ?? null,
		KEY
	)
	t("a walled roster read stores nothing at all, rather than a union that is short",
		after === null, JSON.stringify(after))
	t("…and says how many came back, so it reads as a failure and not as a small league",
		/\b\d+ of \d+ rosters came back\b/.test(said), said.slice(0, 400))
	t("nothing thrown while being refused", uiErrs.length === 0, uiErrs.join(" | "))
	await ui.close()
}

/* ── THE SAME PATH, THROTTLED HALFWAY ────────────────────────────────────────────────
   The wire-level assertions above prove the partial answer travels. This one proves what
   the reader is left holding: four positions of real free agents IN HIS BROWSER, written to
   the same store a complete sweep writes to, and marked as having asked for nine — which is
   the mark, and the only mark, that makes the board refuse to call it the exact list. Four
   positions of real list beat none; four positions PRESENTED as the whole league is the
   failure this is written against, and it is silent when it happens. */
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
	await ui.waitForSelector(".connect", { timeout: 20000 })

	/* Set just before the press: the counter does not move until the sweep starts, so this
	   walls Yahoo at the fifth position of the sweep his press is about to begin. */
	serveUntil = playersServed + 4
	await ui.click(".connect .primary")
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
	serveUntil = Infinity

	const held = await ui.evaluate(async k => {
		const { poolIsPartial } = await import("/src/client/api.ts")
		const pool = JSON.parse(localStorage.getItem("beanemachine:pool") ?? "null")?.[k]
		return {
			players: pool?.players?.length ?? 0,
			read: pool?.positionsRead?.length ?? 0,
			asked: pool?.positionsRequested?.length ?? 0,
			partial: pool ? poolIsPartial(pool) : null,
			roster: JSON.parse(localStorage.getItem("beanemachine:roster") ?? "null")?.[k]?.length ?? 0
		}
	}, KEY)

	t("a throttled sweep still puts what it read into his browser",
		held.players === 4 * PAGE_ROWS && held.read === 4, JSON.stringify(held))
	t("and it is stored as having asked for all nine, which is what makes it partial",
		held.asked === 9 && held.partial === true, JSON.stringify(held))
	/* The team was read before the sweep began, and a sweep that stopped must not cost him
	   the half of the press that succeeded. */
	t("and the team the same press read is not lost with it",
		held.roster === seated.length, JSON.stringify(held))
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
	/*
	   AND MOZILLA WILL NOT TAKE A NEW ADD-ON WITHOUT THIS SINCE 3 NOVEMBER 2025.
	
	   A new submission that does not declare what it collects is refused at signing. `none` is
	   the honest declaration and the one PRIVACY.md already makes — nothing here leaves the
	   local browser — and it may only ever appear alone. Asserted rather than trusted because
	   its absence is not visible in anything the add-on DOES; it shows up once, at the upload.
	*/
	t("Firefox is told what the add-on collects, which it now refuses a submission without",
		JSON.stringify(firefox.browser_specific_settings?.gecko?.data_collection_permissions) ===
			JSON.stringify({ required: ["none"] }),
		JSON.stringify(firefox.browser_specific_settings?.gecko?.data_collection_permissions))
	t("…and Chrome is not sent a key that means nothing to it",
		chrome.browser_specific_settings === undefined,
		JSON.stringify(chrome.browser_specific_settings))
	t("and a floor where host permissions are actually granted at install",
		Number.parseInt(firefox.browser_specific_settings?.gecko?.strict_min_version ?? "0", 10) >= 127,
		firefox.browser_specific_settings?.gecko?.strict_min_version)
	for (const [name, m] of [["chrome", chrome], ["firefox", firefox]]) {
		/* THIS USED TO REQUIRE `*://`, WHICH INCLUDES PLAINTEXT http.
		
		   Yahoo answers over http with a 200 rather than a redirect, so that was not a
		   formality: it let the reader be injected into a page a network could have written,
		   on the host whose cookies the same script then sends with every fetch it makes. The
		   shipped build is https only; the plaintext form is added by the dev build alone,
		   which is what serves this suite's fake Yahoo on 127.0.0.1 — see `readerMatches(dev)`
		   in src/data/platforms.ts. Both builds are asserted, below and here, so the narrowing
		   cannot be undone by a build flag. */
		t(`${name} asks for the Yahoo host over https and nothing wider`,
			JSON.stringify(m.host_permissions) === JSON.stringify(["https://*.fantasysports.yahoo.com/*"]),
			JSON.stringify(m.host_permissions))
		t(`${name} does not ask for plaintext Yahoo`,
			!(m.host_permissions ?? []).some(h => h.startsWith("http://")) &&
				!(m.content_scripts ?? []).some(c => c.matches.some(x => x.startsWith("http://"))),
			JSON.stringify(m.host_permissions) + " " + JSON.stringify(m.content_scripts?.map(c => c.matches)))
		/* A permission nobody uses is a permission somebody has to justify — to a store
		   reviewer and to a reader reading the install prompt. Nothing is stored, so
		   `storage` is not asked for. */
		/*
	   THE STORE'S OWN LIMITS, checked here because the alternative is finding out at submission.
	
	   Chrome's `description` has a hard 132-character limit and rejects a longer one rather
	   than truncating it; this manifest carried 178 for as long as it has existed, and nobody
	   would have known until the first upload. One description serves both browsers, so the
	   limit is asserted on both.
	*/
	t(`${name} has a description the Chrome Web Store will accept`,
		typeof m.description === "string" && m.description.length > 0 && m.description.length <= 132,
		`${m.description?.length} chars`)
	t(`${name} asks for no storage, because it keeps nothing`,
			!(m.permissions ?? []).includes("storage"), JSON.stringify(m.permissions))
		t(`${name} reads the app's own origin, so the two halves can talk`,
			m.content_scripts?.some(c => c.matches.includes("https://beanemachine.com/*")),
			JSON.stringify(m.content_scripts?.map(c => c.matches)))
		/*
		   AND NOTHING SERVED OFF THE READER'S OWN MACHINE.

		   A match pattern cannot name a port — both browsers match on host alone — so
		   `http://localhost/*` in a shipped manifest is not "my dev server", it is every
		   page served from this machine on every port, each of which could post a message
		   and be answered with his team, his league's settings and whatever else his
		   signed-in Yahoo session can reach. The capability is still buildable and the
		   browser in this suite is running a build that has it; what is asserted here is
		   that the build which goes to a store does not.
		*/
		t(`${name} does not hand the reader's league to anything on his own machine`,
			!(m.content_scripts ?? []).some(c => c.matches.some(p => /localhost|127\.0\.0\.1/.test(p))),
			JSON.stringify(m.content_scripts?.map(c => c.matches)))
	}

	/*
	   THE BUILD THIS SUITE DRIVES IS NOT THE BUILD THAT SHIPS, and that is a hole unless the
	   difference between them is nailed down. Everything above this block reads the store
	   build's manifest; everything in the browser ran the dev build. So: the two differ in
	   the bridge's match list and in NOTHING else, and the three bundles are byte for byte
	   the same file. A dev build that had drifted anywhere else would take the whole suite
	   green with it while proving nothing about what a reader installs.
	*/
	const dev = JSON.parse(readFileSync(new URL("../dist-ext/dev/chrome/manifest.json", import.meta.url), "utf8"))
	t("the build this suite drives is the one with the local addresses, and the one that ships is not",
		dev.content_scripts.some(c => c.matches.includes("http://127.0.0.1/*")) &&
			dev.content_scripts.some(c => c.matches.includes("https://beanemachine.com/*")),
		JSON.stringify(dev.content_scripts.map(c => c.matches)))

	/* `host_permissions` is blanked alongside the content-script matches, and it did not used
	   to be, because the two builds used to ask for the same Yahoo hosts. They no longer do:
	   the dev build adds the plaintext form so this suite's fake Yahoo on 127.0.0.1 can be
	   read, and the shipped build is https only. Blanking both is what keeps this assertion
	   saying what it has always meant — the two builds differ in WHERE they run and in nothing
	   else — and the lists themselves are asserted above, for both builds, rather than left to
	   this comparison. */
	const withoutHosts = m => ({
		...m,
		host_permissions: null,
		content_scripts: (m.content_scripts ?? []).map(c => ({ ...c, matches: null }))
	})
	t("and they are otherwise the same manifest, down to the permissions",
		JSON.stringify(withoutHosts(dev)) === JSON.stringify(withoutHosts(chrome)),
		JSON.stringify(withoutHosts(dev)) === JSON.stringify(withoutHosts(chrome)) ? "" : "manifests differ beyond the matches")
	t("and the dev build is the ONLY one that reads plaintext Yahoo",
		dev.host_permissions.includes("http://*.fantasysports.yahoo.com/*") &&
			!chrome.host_permissions.includes("http://*.fantasysports.yahoo.com/*"),
		JSON.stringify(dev.host_permissions))

	/* The scripts themselves carry no build flag at all — the router reads its match list
	   back out of the manifest at runtime rather than being compiled with one — so these
	   three files must be identical, and if they ever stop being, the browser in this suite
	   is running code no reader will ever have. */
	const same = ["background.js", "yahoo.js", "bridge.js"].filter(f =>
		readFileSync(new URL(`../dist-ext/chrome/${f}`, import.meta.url)).equals(
			readFileSync(new URL(`../dist-ext/dev/chrome/${f}`, import.meta.url))
		)
	)
	t("and the code the browser ran here is byte for byte the code that ships",
		same.length === 3, same.join(", "))
}

/* ── WHAT THE STORES ACTUALLY RECEIVE ────────────────────────────────────────────────
   Everything above this reads the built FOLDERS. Nobody uploads a folder. What goes to a
   store is a zip and a handful of images, and until this block existed not one byte of any
   of them was checked by anything: the zip writer is hand-rolled in extension/build.mjs,
   the icons are drawn pixel by pixel in the same file, and the first reader of either was
   going to be a reviewer.

   Three of the four defects this block now catches were live on 2026-09-19 and all three
   were invisible from the folder:

   - the 128 px store icon carried 112x112 of artwork where Chrome's page asks for 96x96,
     because `inset` is per side and 96/128 was written as 1/16 instead of 1/8;
   - every entry in every zip was STORED — 64,973 bytes for a file the site hands to every
     reader, against 8,846 deflated and minified;
   - the package a store would have received carried a README.txt whose first instruction
     was "turn on Developer mode, press Load unpacked", which is the sentence a Chrome Web
     Store listing may not contain about itself.

   A zip is parsed here rather than shelled out to `unzip`, for the reason build.mjs writes
   one rather than shelling out to `zip`: the binary is not on this machine. The central
   directory is the only part that has to be read, and reading it is also the assertion —
   a zip whose central directory does not parse is a zip no store can open. */
{
	const zipPath = name => new URL(`../dist-ext/${name}`, import.meta.url)
	/** Entries from the CENTRAL DIRECTORY, which is the index every unzipper actually reads. */
	const entriesOf = file => {
		const b = readFileSync(file)
		/* The end-of-central-directory record, found from the back: it is the last 22 bytes
		   when there is no archive comment, and these are written without one. */
		let end = b.length - 22
		while (end >= 0 && b.readUInt32LE(end) !== 0x06054b50) end--
		if (end < 0) return null
		const count = b.readUInt16LE(end + 10)
		let at = b.readUInt32LE(end + 16)
		const out = []
		for (let i = 0; i < count; i++) {
			if (b.readUInt32LE(at) !== 0x02014b50) return null
			const method = b.readUInt16LE(at + 10)
			const crc = b.readUInt32LE(at + 16)
			const packed = b.readUInt32LE(at + 20)
			const raw = b.readUInt32LE(at + 24)
			const nameLen = b.readUInt16LE(at + 28)
			const extraLen = b.readUInt16LE(at + 30)
			const commentLen = b.readUInt16LE(at + 32)
			const offset = b.readUInt32LE(at + 42)
			const name = b.toString("utf8", at + 46, at + 46 + nameLen)
			/* The local header at `offset`, so the bytes are read the way an unzipper reads
			   them rather than from the index that describes them. */
			const localNameLen = b.readUInt16LE(offset + 26)
			const localExtraLen = b.readUInt16LE(offset + 28)
			const from = offset + 30 + localNameLen + localExtraLen
			const body = b.subarray(from, from + packed)
			out.push({ name, method, packed, raw, crc, body })
			at += 46 + nameLen + extraLen + commentLen
		}
		return { size: b.length, entries: out }
	}

	/** Inflate if it says it is deflated. The CRC is compared BETWEEN the two packages
	    below rather than recomputed here; nothing in this block verifies it against the bytes. */
	const contentOf = e => (e.method === 8 ? inflateRawSync(e.body) : e.body)

	const PACKAGE = ["manifest.json", "background.js", "yahoo.js", "bridge.js",
		"icon-16.png", "icon-48.png", "icon-128.png"]

	for (const browser of ["chrome", "firefox"]) {
		const download = entriesOf(zipPath(`beanemachine-${browser}.zip`))
		const upload = entriesOf(zipPath(`beanemachine-${browser}-store.zip`))
		t(`${browser}: both zips exist and their central directories parse`,
			!!download && !!upload, `${!!download} ${!!upload}`)
		if (!download || !upload) continue

		/* NAMED, IN ORDER, AND NOTHING ELSE. The list is written out here rather than derived
		   from build.mjs, because a test that imports the list it is checking asserts only
		   that the build is self-consistent. A file that arrives in the package by having
		   been left in the folder — a .map, a stray screenshot, a .DS_Store — is exactly what
		   this is for. */
		t(`${browser}: the store package is the seven files a browser needs and nothing else`,
			JSON.stringify(upload.entries.map(e => e.name)) === JSON.stringify(PACKAGE),
			JSON.stringify(upload.entries.map(e => e.name)))
		t(`${browser}: the download is those seven plus the README that tells a reader to load it`,
			JSON.stringify(download.entries.map(e => e.name)) ===
				JSON.stringify([...PACKAGE, "README.txt"]),
			JSON.stringify(download.entries.map(e => e.name)))

		/*
		   AND THIS IS THE ONE THAT BLOCKS A CHROME REVIEW.

		   A Chrome Web Store listing may not tell a reader to install from outside the Web
		   Store, and the package is part of what a reviewer reads. The download zip carries
		   those instructions because for its reader they are the only ones that work; the
		   upload zip must not carry them anywhere, in any file, so every entry is searched
		   rather than just the one that used to hold them.
		*/
		const sideloadWords = /developer mode|load unpacked|load temporary add-on|about:debugging/i
		const offenders = upload.entries
			.filter(e => !e.name.endsWith(".png"))
			.filter(e => sideloadWords.test(contentOf(e).toString("utf8")))
			.map(e => e.name)
		t(`${browser}: nothing in the store package tells a reader to sideload it`,
			offenders.length === 0, offenders.join(", "))
		t(`${browser}: and the download says how to load it, because that reader has no store`,
			sideloadWords.test(
				contentOf(download.entries.find(e => e.name === "README.txt")).toString("utf8")
			))

		/* THE TWO PACKAGES ARE ONE PACKAGE. If they ever stop being, two different add-ons
		   are in circulation under one name and the one nobody tests is the one readers have. */
		const byName = z => Object.fromEntries(z.entries.map(e => [e.name, e.crc]))
		t(`${browser}: the two packages hold the same seven files, byte for byte`,
			PACKAGE.every(n => byName(download)[n] === byName(upload)[n]),
			PACKAGE.filter(n => byName(download)[n] !== byName(upload)[n]).join(", "))

		/*
		   DEFLATED, AND THE ARITHMETIC IS CHECKED RATHER THAN THE FLAG.

		   Every entry was stored until 2026-09-19 and the comment beside the writer argued
		   that DEFLATE "would save a few kilobytes". Measured on the Chrome package it saved
		   56,127 of 64,973 bytes. What is asserted is not "method 8" — a PNG is already
		   deflated and re-compressing icon-16 made it three bytes BIGGER, so the writer picks
		   per entry — but the property that made the change worth making: no entry is larger
		   than the file it came from, and the archive as a whole is far smaller than the sum
		   of its contents.
		*/
		const grew = download.entries.filter(e => e.packed > e.raw).map(e => e.name)
		t(`${browser}: no entry is packed larger than the file it came from`, grew.length === 0,
			grew.join(", "))
		const contents = download.entries.reduce((n, e) => n + e.raw, 0)
		t(`${browser}: the zip is well under the bytes it contains, so it is really compressed`,
			download.size < contents * 0.6, `${download.size} bytes holding ${contents}`)
		/* A store's upload limit is far above this; the number is asserted so that a bundle
		   that suddenly triples — a dependency pulled in, minification switched off — is
		   caught here rather than by somebody noticing the download got slow. */
		t(`${browser}: and the whole add-on is still one small file`, download.size < 20_000,
			`${download.size} bytes`)

		/* The zipped manifest is the manifest. A build that zips a stale folder ships a
		   manifest nobody reviewed, and every assertion above this block reads the folder. */
		const zipped = contentOf(upload.entries.find(e => e.name === "manifest.json")).toString("utf8")
		t(`${browser}: the manifest inside the zip is the one this suite has been reading`,
			zipped === readFileSync(new URL(`../dist-ext/${browser}/manifest.json`, import.meta.url), "utf8"))
	}

	/*
	   THE ICONS, MEASURED AS A REVIEWER SEES THEM: a bounding box of what is not transparent.

	   Chrome's Supplying Images page asks for 96x96 of artwork centred in a 128x128 canvas,
	   which is 16 transparent pixels a side. The build drew 112x112 at (8, 8) for as long as
	   the padding had existed, because the inset is a fraction PER SIDE and 96 inside 128 is
	   1/8, not 1/16 — an error that looks right in a thumbnail and is wrong on the store
	   page, where Chrome's own frame is drawn against the artwork's edge.

	   The 16 and the 48 go in a toolbar and an extensions list, where padding makes a small
	   icon smaller, so those are asserted full bleed — the opposite property, asserted
	   explicitly, because "pad the icon" applied to all three is the obvious wrong fix.
	*/
	const decodePng = file => {
		const b = readFileSync(file)
		if (!b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
			return null
		let at = 8, w = 0, h = 0, depth = 0, colour = 0
		const idat = []
		while (at + 8 <= b.length) {
			const len = b.readUInt32BE(at)
			const type = b.toString("ascii", at + 4, at + 8)
			const data = b.subarray(at + 8, at + 8 + len)
			if (type === "IHDR") {
				w = data.readUInt32BE(0)
				h = data.readUInt32BE(4)
				depth = data[8]
				colour = data[9]
			}
			if (type === "IDAT") idat.push(data)
			at += 12 + len
		}
		if (colour !== 6 || depth !== 8) return { w, h, depth, colour }
		const raw = inflateSync(Buffer.concat(idat))
		const stride = w * 4 + 1
		let minX = w, maxX = -1, minY = h, maxY = -1
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++)
				if (raw[y * stride + 1 + x * 4 + 3] !== 0) {
					if (x < minX) minX = x
					if (x > maxX) maxX = x
					if (y < minY) minY = y
					if (y > maxY) maxY = y
				}
		return { w, h, depth, colour, ink: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } }
	}

	const icon = s => decodePng(new URL(`../dist-ext/chrome/icon-${s}.png`, import.meta.url))
	for (const size of [16, 48, 128]) {
		const png = icon(size)
		t(`the ${size} px icon is a ${size}x${size} PNG`,
			png?.w === size && png?.h === size, JSON.stringify(png && { w: png.w, h: png.h }))
	}
	for (const size of [16, 48]) {
		const { ink } = icon(size)
		t(`the ${size} px icon is full bleed, because padding a toolbar icon just shrinks it`,
			ink.x === 0 && ink.y === 0 && ink.w === size && ink.h === size, JSON.stringify(ink))
	}
	const big = icon(128).ink
	t("the 128 px icon is 96x96 of artwork inside 16 px of transparency, which is what Chrome asks for",
		big.w === 96 && big.h === 96 && big.x === 16 && big.y === 16, JSON.stringify(big))

	/* Chrome's small promotional tile is 440x280 and must be FULL BLEED — its own page says
	   so in the same breath it asks for padding on the icon, which is why both are asserted
	   here and in opposite directions. */
	const promo = decodePng(new URL("../dist-ext/promo-440x280.png", import.meta.url))
	t("the promotional tile is 440x280", promo?.w === 440 && promo?.h === 280,
		JSON.stringify(promo && { w: promo.w, h: promo.h }))
	t("and it is full bleed, with no transparent border for the store to frame",
		promo.ink.x === 0 && promo.ink.y === 0 && promo.ink.w === 440 && promo.ink.h === 280,
		JSON.stringify(promo.ink))

	/*
	   THE VERSION, AND WHAT IT IS ALLOWED TO BE.

	   `VERSION` in extension/build.mjs is bumped by hand and deliberately does NOT track
	   package.json: the app's version and the add-on's are two things readers see in two
	   places, and tying them would make every site deploy a store submission. What has to
	   hold is that the two browsers ship the SAME version — one source, two manifests, and a
	   build that let them drift would put two different add-ons in circulation under one
	   number — and that the string is one Chrome will take at all.

	   CHROME'S RULE, AND THE CLAUSE THIS ASSERTION GOT WRONG FIRST: one to four dot-separated
	   integers, each 0..65535, and no integer written with a leading zero (`032` is invalid,
	   `0` is not). The first version of this line also demanded the leading integer be
	   non-zero, which failed on `0.2.0` — the version this add-on actually ships. That rule
	   does not exist; what does is the leading-zero rule inside each integer, which is the
	   one a hand-bumped `VERSION` can plausibly break by writing `0.02`.
	*/
	const chromeM = JSON.parse(readFileSync(new URL("../dist-ext/chrome/manifest.json", import.meta.url), "utf8"))
	const firefoxM = JSON.parse(readFileSync(new URL("../dist-ext/firefox/manifest.json", import.meta.url), "utf8"))
	t("both browsers ship the same version", chromeM.version === firefoxM.version,
		`${chromeM.version} vs ${firefoxM.version}`)
	/* Both listings show this as the developer's website and both reviewers follow it. An
	   add-on that reads a signed-in site and hands the pages to beanemachine.com invites the
	   question of whether the add-on and the site are the same people, and this is the only
	   answer either store's furniture has room for. https, because a store listing linking
	   out over plaintext is a finding of its own. */
	t("both manifests point a reviewer at the site the add-on hands pages to",
		chromeM.homepage_url === "https://beanemachine.com" &&
			firefoxM.homepage_url === chromeM.homepage_url,
		`${chromeM.homepage_url} / ${firefoxM.homepage_url}`)
	const parts = String(chromeM.version).split(".")
	t("and it is a version Chrome will accept: up to four integers under 65536, none zero-padded",
		parts.length >= 1 && parts.length <= 4 &&
			parts.every(p => /^(0|[1-9]\d*)$/.test(p) && Number(p) <= 65535) &&
			parts.some(p => Number(p) > 0),
		chromeM.version)

	/*
	   AND THE DOCUMENT SOMEBODY PASTES FROM.

	   extension/SUBMITTING.md holds the exact text to paste into each store's form and names
	   the exact files to upload. Both are copies of things the build produces, so both can go
	   stale silently — and the failure lands at a submission, where the cost of finding out is
	   an afternoon and a review queue. The description is quoted there as a blockquote; the
	   files are named in a table. Asserted against the manifest and against the filesystem
	   rather than against a second copy of the answer.
	*/
	const submitting = readFileSync(new URL("../extension/SUBMITTING.md", import.meta.url), "utf8")
	t("SUBMITTING.md quotes the description the manifest actually carries",
		submitting.includes(`> ${chromeM.description}`),
		`manifest: ${chromeM.description}`)
	const named = [...submitting.matchAll(/`dist-ext\/([A-Za-z0-9._-]+\.(?:zip|png))`/g)].map(m => m[1])
	const missing = [...new Set(named)].filter(
		n => !existsSync(new URL(`../dist-ext/${n}`, import.meta.url))
	)
	t("and every file it tells you to upload is a file the build wrote",
		named.length >= 3 && missing.length === 0,
		missing.length ? `missing: ${missing.join(", ")}` : `${named.length} named`)

	/* THE ONLY THING A REVIEWER CAN READ IN A MINIFIED BUNDLE. The shipped scripts are
	   minified — 61,833 bytes of source to 16,011, measured 2026-09-19 — so the four lines
	   naming the repository, the build command and the privacy policy are the whole of what
	   the file says about itself. A minifier that swallows them (the first two attempts here
	   both did: `output.banner` was dropped as a plain comment and again as a `/*!` legal
	   comment) leaves a store a package with no provenance in it at all. */
	for (const f of ["yahoo.js", "background.js", "bridge.js"]) {
		const js = readFileSync(new URL(`../dist-ext/chrome/${f}`, import.meta.url), "utf8")
		t(`${f} names where it came from, which is all a reviewer can read in a minified file`,
			js.startsWith("/*! beanemachine reader ") &&
				js.includes("github.com/ssalbdivad/beanemachine") &&
				js.includes(chromeM.version),
			js.slice(0, 60))
		t(`${f} is minified, not shipped as commented source`,
			js.length < 12_000 && !js.includes("\n *"), `${js.length} bytes`)
	}
}

/* THIS RUNS BEFORE THE ORPHAN BLOCK BELOW, and the order is load-bearing: that block calls
   `chrome.runtime.reload()`, and under `--load-extension` the extension does not come back —
   measured, 0 service workers afterwards. Anything that needs a working reader has to be
   above it. Placed below it, this block saw the install walkthrough instead of the button and
   timed out waiting for a press that was never going to be offered. */
/* ── A STRANGER, ON THE PUBLISHED BUILD, WITH NOTHING IN HIS BROWSER ─────────────────
   The acceptance test for the whole feature, and the only one that starts where a real
   reader starts: the built site (which strips the shipped league, so a first visit really
   has nothing), an empty profile, and the reader added. One press has to produce a league
   with HIS scoring in it, his team in the seats it is in, his free agents, and a board that
   actually ranks.

   It runs against the preview on :4173 when one is up and says so and skips when it is not,
   rather than failing on somebody else's missing server — the same rule test/static.mjs
   follows. */
{
	const STATIC = process.env.STATIC_BASE ?? "http://127.0.0.1:4173/"
	const up = await fetch(STATIC)
		.then(r => r.ok)
		.catch(() => false)
	if (!up) {
		console.log(`SKIP  the published build is not being served at ${STATIC}`)
	} else {
		const first = await context.newPage()
		const firstErrs = []
		first.on("pageerror", e => firstErrs.push(String(e)))
		await first.goto(STATIC, { waitUntil: "domcontentloaded" })
		await first.evaluate(() => localStorage.clear())
		await first.reload({ waitUntil: "domcontentloaded" })
		await first.waitForSelector("nav button", { timeout: 30000 })
		await first.waitForTimeout(2000)

		t("a first visit to the built site holds no league at all",
			await first.evaluate(() => {
				const c = JSON.parse(localStorage.getItem("beanemachine:config") ?? "null")
				return !c || !Object.keys(c.leagues ?? {}).length
			}),
			await first.evaluate(() => localStorage.getItem("beanemachine:config")?.slice(0, 120) ?? "(nothing)"))

		/* The way in a stranger is actually offered: the bar at the foot of the screen. */
		await first.waitForSelector(".dock-bar button", { timeout: 20000 })
		await first.click(".dock-bar button")
		await first.waitForSelector(".onboard", { timeout: 20000 })
		/* The sheet opens on the button for a reader who has the browser reader and no team
		   yet — and on the box for everybody else, which is what the offer line is for. Either
		   is a pass here: what this block is about is what ONE PRESS produces, not which of
		   the two screens he pressed it from. */
		const offerLine = await first.$(".onboard-offer button")
		if (offerLine) await offerLine.click()
		await first.waitForSelector(".connect", { timeout: 20000 })
		await first.click(".connect .primary")
		/* A PRESS THAT NEVER LANDS IS A FAILED ASSERTION, NOT A DEAD SUITE.
		
		   This was a bare `waitForFunction`, so a press that produced nothing threw out of the
		   file and took every assertion below it with it — about two hundred of them, including
		   every one about the store packages. The whole block is about what ONE PRESS produces,
		   so the timeout is exactly the thing worth reporting: it is reported, with whatever the
		   page threw, and the rest of the run still happens. */
		const pressLanded = await first
			.waitForFunction(
				() => {
					try {
						return Object.keys(JSON.parse(localStorage.getItem("beanemachine:pool") ?? "{}")).length > 0
					} catch {
						return false
					}
				},
				{ timeout: 90000 }
			)
			.then(() => true)
			.catch(() => false)
		t("one press on a first visit fills the free agents", pressLanded,
			pressLanded ? "" : (
				`${(await first.evaluate(() => document.querySelector(".connect")?.innerText ?? "")).replace(/\s+/g, " ").slice(0, 300)} :: ${firstErrs.slice(0, 2).join(" | ")}`
			))
		const made = await first.evaluate(() => {
			const read = n => JSON.parse(localStorage.getItem(`beanemachine:${n}`) ?? "null")
			const c = read("config")
			const key = c?.active_league
			const l = key ? c.leagues?.[key] : null
			return {
				key,
				batting: l ? Object.keys(l.scoring?.batting ?? {}).length : 0,
				pitching: l ? Object.keys(l.scoring?.pitching ?? {}).length : 0,
				teams: l?.meta?.max_teams ?? null,
				roster: key ? (read("roster")?.[key]?.length ?? 0) : 0,
				spots: key ? (read("lineup")?.[key]?.spots?.length ?? 0) : 0,
				pool: key ? (read("pool")?.[key]?.players?.length ?? 0) : 0,
				verified: l?.provenance?.verified ?? null,
				sources: l?.provenance?.sources ?? [],
				method: l?.provenance?.method ?? "",
				saysUnfetched: (l?.needs_review ?? []).some(r => /Nothing fetched/.test(r))
			}
		})
		t("one press on a first visit makes the league his own, under his league's own key",
			made.key === KEY, JSON.stringify({ ...made, sources: made.sources.length }))
		/*
		   AND THE BOARD STOPS CALLING IT HEARSAY.
		
		   The settings page is parsed by the same function the paste box uses, which stamps
		   `verified: false` and a review line reading "Nothing fetched that page" — so the
		   masthead's own trust chip said "not from your league" about a league this browser had
		   just fetched, with the URL in hand. The reader did the hard thing and the board told
		   him it did not count.
		*/
		t("and the league it read is vouched for, because this browser fetched the page",
			made.verified === true, JSON.stringify({ verified: made.verified, method: made.method }))
		t("…naming the settings page it read, which is what makes that checkable",
			made.sources.some(u => /\/settings/.test(u)), JSON.stringify(made.sources))
		t("…and nothing anywhere tells him nothing fetched it",
			made.saysUnfetched === false, JSON.stringify(made.method))
		t("with his league's scoring rather than a borrowed table",
			made.batting === Object.keys(real.scoring.batting).length &&
				made.pitching === Object.keys(real.scoring.pitching).length &&
				made.teams === real.meta.max_teams,
			JSON.stringify(made))
		/* Nine positions of `PAGE_ROWS`, which is what Yahoo serves a page. The fixture was
		   three a page when this block was written and is a full page now, so it is asserted
		   as the product rather than as the literal 225 — the two drifted apart once. */
		t("his team, in the seats it is in, and his free agents",
			made.roster === seated.length && made.spots === seated.length &&
				made.pool === 9 * PAGE_ROWS,
			JSON.stringify({ ...made, want: 9 * PAGE_ROWS }))

		/* And the thing all of that is for. A league read perfectly into a browser that then
		   shows nothing is a failed read.

		   The card asserted on is TONIGHT rather than the ranked board, and that is a property
		   of the FIXTURE rather than a retreat: this suite's free agents are invented names —
		   "C Free Agent 0" — which match nobody in the committed capture, so the board
		   correctly ranks none of them and an empty board there is the app being right. His own
		   team is real men out of the capture, so the lineup card is where a real answer can be
		   asserted end to end. Measured when this was pointed at the board instead: 225 free
		   agents in the store, 0 rows, and the app entirely correct about it. */
		await first.goto(`${STATIC}#tonight`, { waitUntil: "domcontentloaded" })
		await first.waitForSelector("nav button", { timeout: 30000 })
		await first.waitForSelector(".decide", { timeout: 40000 })
		await first.waitForTimeout(2500)
		const card = await first.$eval(".decide", e => e.innerText)
		t("and the card answers with his own men, out of the league it just read",
			seated.some(({ p }) => card.includes(p.name)),
			card.replace(/\n+/g, " | ").slice(0, 220))
		t("and it is not the blocked card that asks him to go and set a league up",
			(await first.$$(".decide.decide-blocked")).length === 0,
			card.replace(/\n+/g, " | ").slice(0, 200))
		t("with nothing thrown from the first press to the first ranked row",
			firstErrs.length === 0, firstErrs.join(" | "))
		await first.close()
	}
}




/* ── HOW HARD A PAGE CAN DRIVE THE READER'S OWN YAHOO SESSION ───────────────────────
   
   SECOND-TO-LAST, because it deliberately spends this tab's whole per-minute allowance and
   the only clean way to give it back is to reload the page — which is what this block does
   when it is finished, and which is also the honest statement of how the ceiling works: it
   is per tab and per page load, held in the content script and in nothing else.
   
   The hole this closes was measured against the real unpacked extension before it existed:
   twenty `{ask:"league"}` posts from a page script produced forty fetches of the reader's
   signed-in Yahoo inside 68 milliseconds. Nothing the app does looks like that. But the app
   is a static site whose entire threat model is a script injected into a page of it, and the
   damage lands on the reader rather than on this project — it is HIS account that gets
   throttled, and uninstalling afterwards does not un-throttle it.
   
   What is asserted is the property, not the mechanism: a burst cannot turn into requests,
   and what comes back instead is a sentence with a number of seconds in it. */
{
	/* A tab of its own, opened last so the router routes to it — the same pattern every other
	   block here uses, and the reason it matters is that the ceiling is per tab. */
	const gate = await context.newPage()
	await gate.goto(yahoo, { waitUntil: "domcontentloaded" })
	await app.waitForTimeout(400)
	const before = asked.length

	/* Twenty at once, from the page, exactly as a loop in injected script would. */
	const burst = await app.evaluate(
		n =>
			Promise.all(
				Array.from({ length: n }, (_, i) => {
					const id = `burst-${i}`
					return new Promise(resolve => {
						const on = e => {
							if (e.source !== window || e.data?.from !== "beanemachine-extension") return
							if (e.data.id !== id || e.data.kind === "progress") return
							window.removeEventListener("message", on)
							resolve(e.data)
						}
						window.addEventListener("message", on)
						window.postMessage({ from: "beanemachine-page", id, ask: "league" }, location.origin)
						setTimeout(() => resolve({ kind: "timeout" }), 30000)
					})
				})
			),
		20
	)
	await app.waitForTimeout(1200)
	const made = asked.length - before

	/* One press off a team page is three pages — the settings, the eligibility grid and the
	   matchup — so twenty presses unguarded would be sixty. WAS `<= 6` when a press was two
	   pages; the bound is generous on purpose, because it is not trying to pin what a single
	   press costs (the descriptor decides that) but to say that a burst never becomes a burst
	   of requests. Measured at 6 from twenty presses. */
	t("twenty presses at once do not become twenty presses' worth of requests",
		made <= 8, `${made} requests to Yahoo from 20 simultaneous presses`)
	t("and every press that was refused came back with a sentence rather than a silence",
		burst.every(b => (b.kind === "grabs" && (b.grabs?.length ?? 0) > 0) || (b.kind === "failed" && b.failure?.what)),
		JSON.stringify(burst.map(b => b.kind)))
	/*
	   A REFUSAL IS NOT AN EMPTY ANSWER, and it used to be one.
	
	   The page the reader is standing on was read from the DOM and cost nobody a request, so a
	   press whose EXTRA fetching is refused still has his team page in hand. Replying
	   `kind: "failed"` threw it away — and the app's caller treats that as "nothing came back",
	   so a reader pressing twice got less than a reader pressing once. What is refused is the
	   fetching; the answer still carries the page and the sentence together.
	*/
	const refused = burst.map(b => b.failure).filter(Boolean)
	/* WAS "nineteen of the twenty", and the number was never the property. The gate is
	   one-at-a-time, so how many get through depends on how long one press takes to release
	   it: a press is three fetches now rather than two, and the first can finish before the
	   twentieth message is dispatched, which measured as two through and eighteen refused.
	   What is protected is that all but a couple are refused and that the requests never
	   arrive — the bound above is the half of it that counts. */
	t("all but at most two of the twenty are refused",
		refused.length >= 18, `${refused.length} refused of 20`)
	t("…and every one of them still hands back the page he is standing on",
		burst.filter(b => b.failure).every(b => (b.grabs?.length ?? 0) > 0),
		JSON.stringify(burst.filter(b => b.failure).map(b => b.grabs?.length)))
	t("…and the refusal says what to do about it, in seconds, with no word about this app",
		refused.every(f => /wait|try again/i.test(`${f.what} ${f.fix}`)) &&
			refused.every(f => !/mutex|allowance|ceiling|protocol/i.test(`${f.what} ${f.fix}`)),
		JSON.stringify(refused[0]))

	/*
	   A REFUSAL COSTS NOTHING, which is what makes the ceiling usable at all.
	
	   The first version of this block assumed the burst above would exhaust the allowance and
	   that the next honest press would be refused. It is not, and that is the correct
	   behaviour rather than a weaker one: what is spent is REQUESTS, and nineteen presses that
	   never reached Yahoo never spent anything. A reader whose page is being driven by a loop
	   is not thereby locked out of his own board.
	*/
	const afterBurst = asked.length
	const honest = await askFor("pool", { leagueId: LEAGUE_ID, sport: "baseball" })
	t("an honest sweep straight after a refused burst still runs, because a refusal costs nothing",
		honest.kind === "grabs" && asked.length - afterBurst === 9,
		`${asked.length - afterBurst} requests, kind ${honest.kind}`)

	/*
	   AND THE SUSTAINED BOUND, which is the other half of the finding: the old flag stopped
	   sweeps OVERLAPPING and nothing stopped them running back to back for ever — measured at
	   27 requests in 6.9 seconds, refused by nothing. It is asked for all nine up front,
	   because a sweep that stops at position four is the partial list `poolIsPartial` exists
	   to refuse, and refusing before it starts costs a sentence instead of a wrong wire.

	   WAS "the sixth", when the minute's allowance was 45 and a sweep of nine went into it
	   five times. The allowance is 60 — raised because one press became eleven requests and
	   then thirteen, and a reader pressing three times in a minute was being told to wait; see
	   `ALLOWANCE` in extension/src/yahoo.ts. Six sweeps of nine plus the burst above is the
	   whole of it, so the seventh is the one that must be told to wait.
	*/
	for (let i = 0; i < 5; i++) await askFor("pool", { leagueId: LEAGUE_ID, sport: "baseball" })
	const spentAll = asked.length
	const denied = await askFor("pool", { leagueId: LEAGUE_ID, sport: "baseball" })
	t("the seventh sweep inside a minute makes no requests at all",
		asked.length === spentAll, `${asked.length - spentAll} requests`)
	t("and says the list is not coming yet rather than coming back empty",
		denied.kind === "failed" && /rest|wait|again/i.test(`${denied.failure?.what} ${denied.failure?.fix}`),
		JSON.stringify(denied).slice(0, 200))

	/* Given back by a page load, which is the whole lifetime of the thing that holds it. */
	await gate.reload({ waitUntil: "domcontentloaded" })
	await app.waitForTimeout(400)
	const fresh = await askFor("league")
	t("a reloaded tab is a fresh allowance, because that is all the tab remembers",
		fresh.kind === "grabs" && fresh.grabs?.length > 0,
		JSON.stringify({ kind: fresh.kind, grabs: fresh.grabs?.length }))
	await gate.close()
}

/* ── A PAGE THAT NEVER ANSWERS ───────────────────────────────────────────────────────
   
   `fetch` has no timeout, so a server that accepts a connection and then sends nothing leaves
   the promise pending until the operating system gives up — minutes, sometimes hours. The
   one-at-a-time gate is released in a `finally`, and a `finally` under a promise that never
   settles never runs: measured against this fixture before `getPage` existed, the gate stayed
   claimed and every later press of EITHER button was refused with "your free agents are being
   read right now — it takes a few seconds", for the life of the tab. False in both halves, and
   the file's own note beside the gate calls this failure worse than the burst it was added to
   stop.
   
   Twenty seconds a page now bounds it. This block asserts the two things that follow: the
   stalled read ENDS, and the tab is usable afterwards. */
{
	const hung = await context.newPage()
	await hung.goto(yahoo, { waitUntil: "domcontentloaded" })
	await app.waitForTimeout(400)
	const before = Date.now()
	stallFrom = 0
	const answer = await askFor("pool", { leagueId: LEAGUE_ID, sport: "baseball" })
	const took = Date.now() - before
	stallFrom = Infinity
	/* Let the held sockets go, so the fixture's server can close at the end of the run. */
	for (const res of stalled.splice(0)) {
		try {
			res.destroy()
		} catch {
			/* already gone */
		}
	}
	t("a page that never answers ends the read rather than hanging on it",
		answer.kind === "failed" || answer.kind === "grabs", JSON.stringify(answer).slice(0, 160))
	t("…inside the app's own patience, not the operating system's",
		took < 60_000, `${Math.round(took / 1000)}s`)
	t("…and says so in a sentence rather than going quiet",
		answer.kind !== "failed" || !!answer.failure?.what, JSON.stringify(answer).slice(0, 200))

	/* THE POINT OF THE WHOLE BLOCK: the tab still works. */
	const after = await askFor("league")
	t("and the next press works, because the gate was given back",
		after.kind === "grabs" && after.grabs?.length > 0,
		JSON.stringify({ kind: after.kind, grabs: after.grabs?.length, failure: after.failure?.what }))
	await hung.close()
}

/* ── WHAT A SIGNED-IN PAGE'S OWN SCRIPTS NEVER GET TO DO ─────────────────────────────
   
   The markup path has a deliberate fail-safe: when `rowsOnly` finds no row marker it sends
   the whole page, so that a Yahoo redesign costs bandwidth and never costs a row. The day
   that fires is the day the entire players page crosses `postMessage` to the app origin —
   and a signed-in Yahoo fantasy page's inline script is not neutral. This fixture's head
   script carries `login.yahoo.com` and a beacon id, which is exactly the shape of the thing
   nobody wants handed over: session-scoped values in a page that parses fine without them.
   
   `parsePage` reads `data-ys-playerid` and `title=` off anchors and has never read a script,
   so stripping them costs nothing and is asserted on BOTH paths — the swept page and the
   page the reader is standing on. */
{
	const listed = await context.newPage()
	await listed.goto(
		`http://baseball.fantasysports.yahoo.com/b1/${LEAGUE_ID}/players?status=A&pos=SP&count=0`,
		{ waitUntil: "domcontentloaded" }
	)
	await app.waitForTimeout(400)
	const here = await askFor("page")
	const html = here.grabs?.[0]?.html ?? ""
	t("the page in hand comes across with its rows",
		/data-ys-playerid="\d+"/.test(html), html.slice(0, 120))
	t("and with no script of Yahoo's in it",
		!/<script/i.test(html) && !html.includes("geo.yahoo.com") && !html.includes("login.yahoo.com"),
		html.slice(0, 200))

	const swept = await askFor("pool", { leagueId: LEAGUE_ID, sport: "baseball" })
	const pages = (swept.grabs ?? []).filter(g => g.html)
	t("nine swept pages, and not one of them carries a script either",
		pages.length === 9 && pages.every(g => !/<script/i.test(g.html) && !g.html.includes("geo.yahoo.com")),
		`${pages.length} pages, ${pages.filter(g => /<script/i.test(g.html)).length} with script`)
	/* `parsePage`'s own marker is the id followed by a `title=` — the fixture's rows carry the
	   id twice, on the anchor and on a note span, and only the anchor is a row. Counting the
	   marker rather than the attribute is what makes this a statement about ROWS. */
	const ROWS = /data-ys-playerid="\d+"[^>]*title="/g
	t("…and every one of them still parses to the rows it was fetched for",
		pages.every(g => (g.html.match(ROWS) ?? []).length === PAGE_ROWS),
		JSON.stringify(pages.map(g => (g.html.match(ROWS) ?? []).length)))
	await listed.close()
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
