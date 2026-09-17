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

/** A player-table row in Yahoo's shape — from test/ownership.mjs, including the second
 *  id-bearing link with no title and the AccuWeather tooltip that once broke the parser. */
const row = (id, name, pct) =>
	`<tr><td><a href="/players/${id}" data-ys-playerid="${id}" class="name" title="${name}">${name}</a>` +
	`<span data-ys-playerid="${id}" class="note"></span>` +
	`<span class="Nowrap">MIL - SP,RP</span>` +
	`<td class="Alt Ta-end"><div >984.40</div></td>` +
	`<td class="Ta-end Nowrap Bdrend"><div >${pct}%</div></td>` +
	`<td class="Alt Ta-end"><div >155.0</div></td></tr>`

/** Three free agents per position, ids kept distinct per position so the union across a
 *  nine-position sweep is 27 men rather than 3 seen nine times. */
const playersPage = pos => {
	/* Keyed by the position's own index, not by its length: "SS", "OF", "SP", "RP", "1B",
	   "2B" and "3B" are all two characters, so a length-based id gave seven positions the
	   same three men and the union across the sweep came back as 9 rather than 27 — which
	   is exactly the bug this assertion exists to catch, arriving first in the fixture. */
	const base = 9000 + (["C", "1B", "2B", "3B", "SS", "OF", "Util", "SP", "RP"].indexOf(pos) + 1) * 100
	return (
		`<!doctype html><meta charset="utf-8"><title>Players</title><body><table>` +
		[0, 1, 2].map(i => row(base + i, `${pos} Free Agent ${i}`, 12 + i)).join("") +
		`</table>${"<!-- footer -->".repeat(700)}</body>`
	)
}

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
	if (url.pathname.endsWith("/players")) return send(playersPage(url.searchParams.get("pos") ?? "C"))
	if (/\/b1\/\d+\/\d+$/.test(url.pathname)) return send(teamPage())
	if (/\/b1\/\d+$/.test(url.pathname)) return send(`<!doctype html><body>League home</body>`)
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

/* ── one press: the team page and the settings page ──────────────────────────────── */
const league = await askFor("league")
t("one press brings back two pages", league.kind === "grabs" && league.grabs.length === 2, JSON.stringify(league).slice(0, 300))
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
t("the free agents are the union across positions, not one page nine times",
	poolRead.players === 27, String(poolRead.players))
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

t("and the app logged no errors through any of it", errs.length === 0, errs.join(" | "))

await context.close()
server.close()
console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
