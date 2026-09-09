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
			// three verbs now: Bench, Move (a seat change for a man who stays in), Start
			verb:
				/Bench /.test(e.textContent) ? "bench"
				: /Move /.test(e.textContent) ? "move"
				: "start",
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
	// a man asked to change seat must be one who is already in the lineup — the row
	// exists to free a seat for somebody else, and moving a man who is not there
	// would be an instruction that cannot be followed
	t("everyone it says to move seats is already in the lineup",
		changes.filter(c => c.verb === "move").every(c => activeSeated.has(c.who)),
		JSON.stringify(changes.filter(c => c.verb === "move" && !activeSeated.has(c.who))))
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
 * With no team, the card asks for one — it does not send the reader to a terminal.
 *
 * This is the difference between a website and a developer tool, and for a long
 * time beanemachine.com was on the wrong side of it: a stranger was shown somebody
 * else's league and told to run `node --experimental-strip-types src/cli.ts` from a
 * checkout he did not have, against a league id that was not his.
 *
 * Every platform can be entered by hand here, in the browser, and the
 * recommendations that follow are real. So that is what it offers, with a control
 * that actually goes there — a card that says "add your players" and does not take
 * you to them has told you to go and find something.
 */
{
	const page = await open({})
	const text = await page.$eval(".decide", e => e.innerText)
	t("with no team it asks for one rather than answering",
		/Tell me who is on your team/.test(text), text.slice(0, 200))
	t("and it proposes no moves at all",
		!/Add .+, drop /.test(text), text.slice(0, 200))
	t("the way out is a control on the page, not an instruction to go elsewhere",
		!!(await page.$(".decide-cta")), text.slice(0, 200))
	t("and it says up front that availability will be an estimate",
		/estimated|estimate/i.test(text), text.slice(0, 400))

	/*
	 * The command line survives as a footnote for the exact list, and only for a
	 * platform a browser cannot read. Two things must hold: it is FOLDED, so it is
	 * not what a visitor meets first, and it names a command that exists. It used to
	 * print `node --experimental-strip-types src/cli.ts` — a flag node has not needed
	 * since 22.18, and a path that only exists inside a clone.
	 */
	if (league.meta.platform === "yahoo") {
		t("the exact-list route is folded away, not the headline",
			!!(await page.$(".decide-blocked details")), "the command is not behind a fold")
		const cmd = await page.$eval(".decide-cmd", e => e.textContent.replace(/\s+/g, " ").trim())
		t("and it is a command a visitor could actually run",
			/^npx /.test(cmd) && !/experimental-strip-types/.test(cmd), cmd)
		t("with his own league in it, and the team, which is what carries the roster",
			cmd.includes(String(league.meta.league_id)) &&
				new RegExp(`/${league.meta.team_id}\\b`).test(cmd), cmd)
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
	// A daily-lock league is answered under "Today" and shown no period lineup at
	// all — the two contradicted each other over the same seats. Either heading is a
	// lineup answer; what matters here is that one of them arrived without a wire.
	t("the lineup half answers without any free-agent list",
		/Set your lineup|\bToday\b/.test(text) &&
			!/not been told which players are yours/.test(text),
		text.slice(0, 160))
	/*
	 * The moves half no longer refuses here, and that is the point of the change.
	 *
	 * It used to say "no add can be judged" and send the reader to a command line
	 * whenever nothing had read his league's wire — which, for every Yahoo user on a
	 * static host, is always. The board's own availability ladder has a rung for
	 * exactly this: rank by how widely a man is rostered, cut at `teams x seats`,
	 * call the men below it probably free. It is an estimate, it is calibrated to
	 * this league, and it is what the board has been filtering on all along.
	 *
	 * So the assertion is the one that matters: an answer, and the estimate declared.
	 */
	t("the moves half answers from the ownership estimate rather than refusing",
		/Add .+, drop /.test(text) || /none clear the bar/.test(text), text.slice(-600))
	t("and it says plainly that who is available is an estimate",
		!/Add .+, drop /.test(text) || /is an estimate/.test(text), text.slice(-600))
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

/**
 * A league that scores nothing gets a refusal, not a plan.
 *
 * The roster templates ship a shape without a scoring table, so until one is entered
 * every projection is exactly zero. `rateAll` already refuses to rank that — everyone
 * comes back unrateable — and an unrateable roster reaches the diff as a lineup
 * nobody is in, which renders as "bench all eighteen of your starters". The surface
 * that gives instructions is the last one that should skip a refusal the board and
 * the trade page both make.
 */
{
	const cfg = JSON.parse(readFileSync("scoring.json", "utf8"))
	for (const k of Object.keys(cfg.leagues[KEY].scoring.batting))
		cfg.leagues[KEY].scoring.batting[k] = 0
	for (const k of Object.keys(cfg.leagues[KEY].scoring.pitching))
		cfg.leagues[KEY].scoring.pitching[k] = 0
	const page = await open({ lineup: seedLineup, pool: seedPool, config: cfg })
	const text = await page.$eval(".decide", e => e.innerText)
	t("a league with no scoring is told what is missing rather than given a plan",
		/not what each stat is worth|every projection here would be exactly zero/.test(text),
		text.slice(0, 220))
	t("and it proposes nothing at all — no benchings, no moves",
		!(await page.$(".decide-changes")) && !/Add .+, drop /.test(text), text.slice(0, 300))
	await page.close()
}

/**
 * Nor does a league that does not say how many teams are in it.
 *
 * Replacement level is the (teams x seats)-th man deep, so without a team count
 * there is no honest bar. The card would have fallen through to "no projection could
 * be made for this period" — the symptom, not the missing input, and no way to act
 * on it.
 */
{
	const cfg = JSON.parse(readFileSync("scoring.json", "utf8"))
	cfg.leagues[KEY].meta.max_teams = null
	const page = await open({ lineup: seedLineup, pool: seedPool, config: cfg })
	const text = await page.$eval(".decide", e => e.innerText)
	t("a league with no team count is told that, and where to set it",
		/how many teams are in it/.test(text) && /League setup/.test(text), text.slice(0, 240))
	await page.close()
}

/**
 * Waiting for the data and failing to get it are different states.
 *
 * Both used to reach "no projection could be made for this period" — a sentence
 * about the answer, where the reader needs one about the app. Blocking the snapshot
 * outright is the only way to see the failure branch, since it is otherwise served
 * from the same origin as the page.
 */
{
	const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
	await page.route("**/snapshot.json", r => r.abort())
	await page.addInitScript(l => localStorage.setItem("beanemachine:lineup", JSON.stringify(l)), seedLineup)
	await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 })
	await page.waitForSelector(".decide", { timeout: 30000 })
	await page.waitForTimeout(2500)
	const text = await page.$eval(".decide", e => e.innerText)
	t("a snapshot that will not load is reported as that, not as a missing projection",
		/load the player data|Loading player data/.test(text) &&
			!/No projection could be made for this period/.test(text),
		text.slice(0, 220))
	await page.close()
}

/**
 * Everyone unpriceable is not "bench everyone".
 *
 * A roster whose names the board does not recognise — a capture that predates a
 * call-up, a read that caught a different league — produces a lineup nobody is in,
 * and the diff renders that as eighteen rows saying Bench. There is no lineup to
 * compare against, so there is no diff.
 */
{
	const nobody = {
		[KEY]: {
			at: new Date().toISOString(),
			spots: ["C", "1B", "2B", "OF", "SP"].map((slot, i) => ({
				slot,
				name: `Nonexistent Player ${i}`,
				positions: [slot === "SP" ? "SP" : slot],
				team: null
			}))
		}
	}
	const page = await open({ lineup: nobody, pool: seedPool })
	const text = await page.$eval(".decide", e => e.innerText)
	t("a roster the board cannot price is not told to bench itself",
		!/Bench /.test(text), text.slice(0, 300))
	t("and it is told why there is nothing to compare against",
		/could be priced|could not be priced/.test(text), text.slice(0, 300))
	// the fold is collapsed, so innerText misses it — and it carried the same bug,
	// advising that all eighteen seats be left empty
	const fold = await page.$$eval(".decide-today li", ns => ns.map(e => e.textContent))
	t("nor does the fold beneath it advise emptying every seat",
		!fold.some(x => /leave empty/.test(x)), JSON.stringify(fold.slice(0, 3)))
	await page.close()
}

/**
 * One lineup answer per card.
 *
 * A daily-lock league does not set a lineup for the week, it sets one every day, so
 * a second list rearranging the same seats over six days is not a plan it can carry
 * out — and it disagreed with the one it can. Today said bench Nolan McLean; the
 * period list said move him from SP to P. Two answers to "who starts", on one card,
 * for one team.
 */
{
	const page = await open({ lineup: seedLineup, pool: seedPool })
	const text = await page.$eval(".decide", e => e.innerText)
	t("a daily-lock league is given exactly one lineup answer",
		/\bToday\b/.test(text) && !/Over the rest of the period/.test(text),
		text.slice(0, 300))
	t("and the moves are still priced over the period, which is what an add accrues over",
		/Make these moves/.test(text), text.slice(0, 300))
	await page.close()
}

/**
 * An ESPN league is given the instruction that can work for IT.
 *
 * ESPN answers a browser directly, so "read your roster on My team" is a real
 * route there and the command line is not the only one. Yahoo sends no CORS
 * headers and the command is the only route. The card used to give every reader
 * the ESPN sentence; this asserts it now gives each the right one, which is a
 * branch nothing else covers.
 */
{
	const cfg = JSON.parse(readFileSync("scoring.json", "utf8"))
	cfg.leagues[KEY].meta.platform = "espn"
	const page = await open({ config: cfg }, { offline: true })
	const text = await page.$eval(".decide", e => e.innerText)
	t("an ESPN league is told its platform can read the roster for it",
		/answers a browser directly/.test(text) && !/CORS/.test(text), text.slice(0, 400))
	t("and is not handed a command line it does not need",
		!(await page.$(".decide-cmd")), text.slice(0, 260))
	await page.close()
}

/**
 * A team entered BY HAND gets a real answer — no file, no server, no terminal.
 *
 * This is the path every visitor to beanemachine.com actually has. `lineupStore`
 * holds seats and is written by exactly two things: a scoring.json carried in from
 * the command line, and a roster read off the platform. Neither is available to
 * somebody who opened the site and typed his players into My team, and the card
 * told him "this page has not been told which players are yours" about a team he
 * had just entered.
 *
 * `roster.ts` has him — ids, per league, everything but the seats. The seats stay
 * genuinely unknown, so there is no diff and the card says so; everything else
 * works, including the adds, off the ownership estimate.
 */
{
	const hand = {}
	// the same shape roster.ts stores: "<mlbamId>:<side>", nothing else
	hand[KEY] = [
		...snap.players
			.filter(p => p.group === "hitting")
			.sort((a, b) => (b.stats?.plateAppearances ?? 0) - (a.stats?.plateAppearances ?? 0))
			.slice(0, 12)
			.map(p => `${p.id}:hitting`),
		...snap.players
			.filter(p => p.group === "pitching")
			.sort((a, b) => (b.stats?.outs ?? 0) - (a.stats?.outs ?? 0))
			.slice(0, 9)
			.map(p => `${p.id}:pitching`)
	]
	const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } })
	await page.addInitScript(r => localStorage.setItem("beanemachine:roster", JSON.stringify(r)), hand)
	await page.goto(BASE, { waitUntil: "networkidle", timeout: 60000 })
	await page.waitForSelector(".decide", { timeout: 30000 })
	await page.waitForTimeout(2500)
	const text = await page.$eval(".decide", e => e.innerText)

	t("a hand-entered team is not told the page has not been told about it",
		!/has not been told which players are yours|Tell me who is on your team/.test(text),
		text.slice(0, 240))
	t("it produces a lineup for that team",
		(await page.$$(".decide-changes li")).length > 0, text.slice(0, 400))
	t("and it says the seats are unknown rather than inventing a comparison",
		/lineup to set, not the changes to make/.test(text), text.slice(0, 900))
	t("the adds are answered too, from the estimate",
		/Add .+, drop |none clear the bar/.test(text), text.slice(-700))
	t("and nothing on it claims a free-agent list was read",
		!/read off your league|as it stood/.test(text), text.slice(-700))
	await page.close()
}

/**
 * A store too broken to read must not take the page down.
 *
 * `roster.of` throws on a store it cannot parse, deliberately: repairing one means
 * guessing which ids were meant, and a roster guessed wrong prices every
 * recommendation. **My team** owns that conversation and offers the control that
 * clears it. This card is not that screen, and calling it unguarded during render
 * turned a corrupt localStorage key into a blank page.
 */
{
	const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
	const crashes = []
	page.on("pageerror", e => crashes.push(e.message.slice(0, 120)))
	await page.addInitScript(() =>
		localStorage.setItem("beanemachine:roster", '{"any:league":["nope"]}')
	)
	await page.goto(BASE, { waitUntil: "networkidle", timeout: 60000 })
	const rendered = await page
		.waitForSelector(".decide", { timeout: 30000 })
		.then(() => true, () => false)
	t("a roster store that cannot be parsed still renders the card",
		rendered, crashes.join(" | ") || "the card never appeared")
	t("and throws nothing at the page while doing it",
		crashes.length === 0, crashes.join(" | "))
	await page.close()
}

console.log(`\npassed ${pass}, failed ${fail}`)
await browser.close()
process.exit(fail ? 1 : 0)
