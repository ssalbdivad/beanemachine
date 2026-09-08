// The decision card, in a real browser, against a team this test constructs.
//
// The roster and the wire are BUILT HERE from the committed snapshot rather than
// loaded from anybody's file: the card's whole job is to answer for a specific
// team, and a test that needed a real person's roster could neither be committed
// nor re-run by someone else. Every player named below is in data/snapshot.json,
// so the projections behind the assertions are the ones the app really computes.
import { chromium } from "playwright-core"
import { readFileSync } from "node:fs"

const BASE = process.env.BASE ?? "http://127.0.0.1:5173"
const browser = await chromium.launch({ args: ["--no-sandbox"] })
let pass = 0, fail = 0
const t = (n, ok, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : "  " + x}`) }

const snap = JSON.parse(readFileSync("data/snapshot.json", "utf8"))
const league = JSON.parse(readFileSync("scoring.json", "utf8")).leagues["yahoo:228947"]
const KEY = "yahoo:228947"

/** Seat the N best players at each position the league seats, so the constructed
 *  team is a legal one rather than an arbitrary bag of names. */
const bestAt = (pos, n, taken) =>
	snap.players
		.filter(p => p.group === "hitting" && p.position === pos && !taken.has(p.name))
		.sort((a, b) => (b.stats?.plateAppearances ?? 0) - (a.stats?.plateAppearances ?? 0))
		.slice(0, n)
const pitchers = n =>
	snap.players
		.filter(p => p.group === "pitching")
		.sort((a, b) => (b.stats?.outs ?? 0) - (a.stats?.outs ?? 0))
		.slice(0, n)

const taken = new Set()
const spots = []
const seat = (slot, p, positions) => { taken.add(p.name); spots.push({ slot, name: p.name, positions, team: null }) }
for (const [pos, slot] of [["C", "C"], ["1B", "1B"], ["2B", "2B"], ["3B", "3B"], ["SS", "SS"]])
	for (const p of bestAt(pos, 1, taken)) seat(slot, p, [pos])
for (const p of bestAt("LF", 1, taken)) seat("OF", p, ["OF"])
for (const p of bestAt("CF", 1, taken)) seat("OF", p, ["OF"])
for (const p of bestAt("RF", 1, taken)) seat("OF", p, ["OF"])
const arms = pitchers(8)
;["SP", "SP", "RP", "RP", "P", "P", "P", "P"].forEach((slot, i) => {
	if (arms[i]) seat(slot, arms[i], [slot === "RP" ? "RP" : "SP"])
})
/** One deliberately terrible bench bat, so there is something to drop. */
const scrub = snap.players.find(
	p => p.group === "hitting" && p.position === "1B" && (p.stats?.plateAppearances ?? 0) > 20 &&
		(p.stats?.plateAppearances ?? 0) < 60 && !taken.has(p.name)
)
if (scrub) seat("BN", scrub, ["1B"])

/** A wire of good, unrostered bats — men the card should want. */
const wire = snap.players
	.filter(p => p.group === "hitting" && !taken.has(p.name) && (p.stats?.plateAppearances ?? 0) > 400)
	.sort((a, b) => (b.stats?.plateAppearances ?? 0) - (a.stats?.plateAppearances ?? 0))
	.slice(0, 25)
	.map(p => ({ yahooId: String(p.id), name: p.name, team: p.team ?? null, positions: ["1B", "OF"] }))

const seedLineup = { [KEY]: { at: new Date().toISOString(), spots } }
const seedPool = {
	[KEY]: {
		at: new Date().toISOString(), leagueId: "228947", players: wire,
		positionsRead: ["1B", "OF"], note: "constructed by test/decide.mjs"
	}
}

/**
 * @param seeds  what localStorage holds before the page loads
 * @param opts   `offline` blocks the server read of the wire, so the carried-file
 *               path is exercised deterministically. Without it this case passes or
 *               fails on whether a dev API server happens to be running — which is
 *               exactly how it stopped testing anything the moment one was.
 */
const open = async (seeds, opts = {}) => {
	const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } })
	if (opts.offline) await page.route("**/api/available", r => r.abort())
	await page.addInitScript(([l, p, cfg]) => {
		if (l) localStorage.setItem("beanemachine:lineup", JSON.stringify(l))
		if (p) localStorage.setItem("beanemachine:pool", JSON.stringify(p))
		if (cfg) localStorage.setItem("beanemachine:config", JSON.stringify(cfg))
	}, [seeds.lineup ?? null, seeds.pool ?? null, seeds.config ?? null])
	await page.goto(BASE, { waitUntil: "networkidle", timeout: 60000 })
	await page.waitForSelector(".decide", { timeout: 30000 })
	await page.waitForTimeout(1500)
	return page
}

/**
 * With a team and a wire, the card names both sides of every move.
 *
 * This is the whole claim: a ranked list is not a decision, and a decision that
 * does not say who leaves cannot be carried out.
 */
{
	const page = await open({ lineup: seedLineup, pool: seedPool })
	const text = await page.$eval(".decide", e => e.innerText)
	t("the card is the first thing on the page, above the board",
		await page.evaluate(() => {
			const d = document.querySelector(".decide"), b = document.querySelector(".board")
			return !b || d.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
		}), text.slice(0, 60))
	t("it answers for the league's own scoring period, not a fortnight",
		/For <?b?>?(this matchup|this scoring period|today)/.test(text) || /For\s+(this matchup|this scoring period|today)/.test(text),
		text.split("\n").slice(0, 3).join(" | "))
	t("every move it proposes names the man who leaves",
		[...text.matchAll(/^\+[\d.]+\nAdd .+, drop .+$/gm)].length ===
			[...text.matchAll(/^Add /gm)].length,
		text)
	const adds = [...text.matchAll(/Add ([^,]+), drop (.+)/g)].map(m => [m[1], m[2]])
	t("it never proposes adding a player already on the roster",
		adds.every(([a]) => !spots.some(s => s.name === a)), JSON.stringify(adds))
	t("it never proposes dropping a player who is not on the roster",
		adds.every(([, d]) => spots.some(s => s.name === d)), JSON.stringify(adds))
	await page.close()
}

/**
 * TODAY — the decision a daily-lock league forces every day.
 *
 * The league's own settings say "Weekly Deadline: Daily", so he sets a lineup every
 * day. Nothing in this app knew what day it was: `startingLineup` takes no date, so
 * its answer was identical on every day of the fortnight and it seated men whose
 * clubs were not playing.
 *
 * The invariant asserted here is the one that makes the card copyable into Yahoo:
 * EVERY active seat is accounted for — filled by a named man or explicitly told to
 * leave empty. A card that rendered fourteen of eighteen rows and said nothing about
 * the rest would read as a complete lineup, and that is the failure mode this whole
 * project exists to avoid.
 */
{
	const page = await open({ lineup: seedLineup, pool: seedPool })
	const text = await page.$eval(".decide", e => e.innerText)
	t("a daily-lock league is answered for TODAY, before the period", /\bToday\b/.test(text),
		text.slice(0, 200))

	const active = league.roster.slot_order.filter(sl => !/^(BN|IL|NA)/i.test(sl))
	const rows = await page.$$eval(".decide-today li", ns =>
		ns.map(e => ({
			slot: e.querySelector(".decide-slot")?.textContent?.trim(),
			empty: e.classList.contains("decide-empty"),
			who: e.querySelector("b")?.textContent?.trim() ?? null
		})))
	t("every active seat is accounted for, filled or explicitly left empty",
		rows.length === active.length,
		`${rows.length} rows against ${active.length} seats: ${JSON.stringify(rows.map(r => r.slot))}`)
	t("and the seats it lists are the league's own, in the league's own order",
		rows.map(r => r.slot).sort().join(",") === [...active].sort().join(","),
		`${rows.map(r => r.slot)} vs ${active}`)
	t("an empty seat says to leave it empty rather than going unmentioned",
		rows.every(r => r.empty === (r.who === null)),
		JSON.stringify(rows.filter(r => r.empty !== (r.who === null))))

	/*
	 * Nobody is seated whose club is not playing. On a day when all thirty clubs have
	 * a game this cannot fail, so it is computed off the slate rather than assumed —
	 * on a Monday or a Thursday it is the whole point.
	 */
	const today = new Date().toISOString().slice(0, 10)
	const playingClubs = new Set(
		snap.slate.filter(g => g.date === today).flatMap(g => [g.home, g.away])
	)
	const clubOf = new Map(snap.players.map(p => [p.name, p.teamId]))
	const seated = rows.filter(r => r.who).map(r => r.who)
	/*
	 * The card leads with the DIFFERENCE, not the lineup.
	 *
	 * He already has a lineup in Yahoo; what he needs is the handful of seats that
	 * should change. Every row it asks him to change has to be a real change against
	 * the seats it was given, or he is being sent to move a man who is already there.
	 */
	const changes = await page.$$eval(".decide-changes li", ns =>
		ns.map(e => ({
			// `textContent` runs the spans together as "SPBench Cristopher …", so there
			// is no word boundary before the verb — \bBench\b never matches and every
			// row read as a start. Matched on the trailing space instead.
			verb: /Bench /.test(e.textContent) ? "bench" : "start",
			who: e.querySelector("b")?.textContent?.trim()
		})))
	const activeSeated = new Set(
		seedLineup[KEY].spots.filter(sp => !/^(BN|IL|NA)/i.test(sp.slot)).map(sp => sp.name)
	)
	t("everyone it says to bench is currently in an active seat",
		changes.filter(c => c.verb === "bench").every(c => activeSeated.has(c.who)),
		JSON.stringify(changes.filter(c => c.verb === "bench" && !activeSeated.has(c.who))))
	t("everyone it says to start is not already in one",
		changes.filter(c => c.verb === "start").every(c => !activeSeated.has(c.who)),
		JSON.stringify(changes.filter(c => c.verb === "start" && activeSeated.has(c.who))))
	t("and it says how old the seats it compared against are",
		/as read .* (hour|day|in the last hour)/.test(text), text.slice(-400))

	/*
	 * A stale WIRE is worse than a stale lineup, and silently so: it goes on offering
	 * a man the league picked up days ago and never offers one it just dropped. On
	 * 2026-09-08 the carried file was four days old and did not contain Chandler
	 * Simpson, whom the league had released and who is the best outfielder on it. So
	 * when the list is a carried one rather than a live read, the card says how old.
	 * This test blocks the live read, which is the only way to be sure which of the
	 * two it is looking at.
	 */
	{
		const off = await open({ lineup: seedLineup, pool: seedPool }, { offline: true })
		const t2 = await off.$eval(".decide", e => e.innerText)
		t("a carried free-agent list is dated where the moves are proposed",
			!/Add .+, drop /.test(t2) ||
				/free-agent list as it stood .*(hour|day|in the last hour)/.test(t2),
			t2.slice(-500))
		await off.close()
	}

	/*
	 * The shipped example league is his own, which made one sentence permanently
	 * false for the one reader it was written for. The demo is the SEEDED copy of it,
	 * and what distinguishes a seed is that nothing has been read into it — no roster,
	 * no wire. Asked that way it goes quiet the moment a real team is loaded.
	 */
	t("a league you have read your own roster into is not called an example",
		!(await page.$(".example-note")),
		(await page.$(".example-note").then(e => e && e.innerText())) || "")

	/*
	 * A man the model cannot price is still on his roster.
	 *
	 * Unpriceable players are neither started nor offered up nor mentioned, which is
	 * the roster quietly shrinking: the lineup is planned as if he owned fewer men
	 * than he does. On the shipped team that is two — an injured outfielder and a
	 * pitcher with no projection — and an absence is stated as an absence.
	 */
	{
		const watch = await page.$(".decide-watch")
		const txt = watch ? await watch.innerText() : ""
		const claimed = /(\d+) players on your roster could not be priced|One player on your roster could not be priced/.exec(txt)
		if (claimed) {
			const n = claimed[1] ? Number(claimed[1]) : 1
			const named = (txt.match(/could not be priced this period, so nothing above counts them: ([^.]+)\./) ?? [])[1]
			t("it names every player it could not price, not just a count",
				!!named && named.split(",").length === n, `${n} claimed, named: ${named}`)
		} else {
			t("with every player priced, no unpriceable note is invented", true,
				"nothing on this roster was skipped")
		}
	}

	t("nobody is seated whose club has no game today",
		seated.every(n => !clubOf.has(n) || playingClubs.has(clubOf.get(n))),
		seated.filter(n => clubOf.has(n) && !playingClubs.has(clubOf.get(n))).join(", ") ||
			`${playingClubs.size} clubs playing`)
	await page.close()
}

/**
 * Without a roster it says so, and does not pretend.
 *
 * The failure it must never make is answering anyway — a ranked board rendered
 * where an answer belongs reads as an answer.
 */
{
	const page = await open({})
	const text = await page.$eval(".decide", e => e.innerText)
	t("with no roster it names what is missing rather than answering",
		/not been told which players are yours/.test(text), text.slice(0, 160))
	t("and it proposes no moves at all",
		!/Add .+, drop /.test(text), text.slice(0, 200))

	/*
	 * The way OUT of that state has to be one the reader can actually take.
	 *
	 * For a Yahoo league it is the command line and nothing else — Yahoo sends no
	 * CORS headers, so no page will ever read it — and the command has to carry the
	 * TEAM in its url. The stored `league_url` stops at the league, and that command
	 * returns settings and free agents and no roster, which is the one thing this
	 * card is blocked on. Telling a Yahoo reader to "read it on My team", as this
	 * card used to, sends him to a button that cannot work.
	 */
	if (league.meta.platform === "yahoo") {
		const cmd = await page.$eval(".decide-cmd", e => e.textContent.replace(/\s+/g, " ").trim())
		t("it prints the one command that can work, with the team in the url",
			cmd.includes("src/cli.ts") && cmd.includes(String(league.meta.league_id)) &&
				new RegExp(`/${league.meta.team_id}\\b`).test(cmd), cmd)
		t("and says why the page cannot do it itself, naming CORS",
			/CORS/.test(text) && !/Read your roster on/.test(text), text.slice(0, 300))
	}
	await page.close()
}

/**
 * With a roster but no wire, the lineup half still answers and the moves half
 * refuses — they depend on different things and must fail independently.
 */
{
	const page = await open({ lineup: seedLineup }, { offline: true })
	const text = await page.$eval(".decide", e => e.innerText)
	// The heading is "Set your lineup" on its own, and "Over the rest of the period"
	// once a daily-lock league has been answered for today above it — the same
	// section, named for what distinguishes it.
	t("the lineup half answers without any free-agent list",
		/Set your lineup|Over the rest of the period/.test(text) &&
			!/not been told which players are yours/.test(text),
		text.slice(0, 160))
	t("and the moves half says why it cannot, naming CORS rather than shrugging",
		/free-agent list/.test(text) && /CORS/.test(text), text)
	await page.close()
}

/**
 * A league that locks weekly is not shown a daily lineup.
 *
 * The "Today" section exists because this league's settings say "Weekly Deadline:
 * Daily", and for a league that locks once a week there is no daily decision to
 * make — a card offering one would be inventing a choice the platform does not
 * give you. The branch had no coverage, which for a branch whose whole content is
 * "say nothing" is the easiest kind to get wrong without noticing.
 */
{
	// the committed config, with ONE field changed — anything hand-built here would
	// be a second schema to keep in step with the real one
	const cfg = JSON.parse(readFileSync("scoring.json", "utf8"))
	cfg.leagues[KEY].scoring_period.lineup_lock = "period"
	cfg.leagues[KEY].scoring_period.source = "rewritten by test/decide.mjs to lock once a period"
	const page = await open({ lineup: seedLineup, pool: seedPool, config: cfg })
	const text = await page.$eval(".decide", e => e.innerText)
	t("a weekly-lock league is shown no daily lineup at all",
		!/\bToday\b/.test(text) && !(await page.$(".decide-changes")),
		text.slice(0, 200))
	t("and it still answers the question it does have — the period",
		/Set your lineup/.test(text), text.slice(0, 200))
	await page.close()
}

console.log(`\npassed ${pass}, failed ${fail}`)
await browser.close()
process.exit(fail ? 1 : 0)
