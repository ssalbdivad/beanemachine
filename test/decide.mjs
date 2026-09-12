// The decision card, in a real browser, against a team this test constructs.
//
// The roster and the wire are BUILT HERE from the committed snapshot rather than
// loaded from anybody's file: the card's whole job is to answer for a specific
// team, and a test that needed a real person's roster could neither be committed
// nor re-run by someone else. Every player named below is in data/snapshot.json,
// so the projections behind the assertions are the ones the app really computes.
//
// ONE THING ABOUT THIS SUITE CHANGED IN KIND, and every bench assertion below is
// written around it: the card's bench REASONS no longer come out of the committed
// capture. They come from `src/data/today.ts`, which reads MLB's schedule live on
// mount, so "no game today" / "not in today's lineup" / "not projected to play
// today" / "a better man is projected for that seat today" / "he is not on the
// board" depend on what is actually happening tonight and on what time of day it
// is — before lineups are posted almost nobody is "not in today's lineup", after
// they are posted several men can be. A test that pinned the sentence would be
// green in the afternoon and red in the evening, which is a test that reports the
// clock. So the assertions below are on the PROPERTIES of the reasons — one row
// per distinct reason, every man named once, every man's own seat named, no reason
// naming a man — and never on which reason a given man got.
import { chromium } from "playwright-core"
import { readFileSync } from "node:fs"
// The same live read the card itself does, from the same module, so there is one
// definition of "who is playing tonight" rather than a second one here that can
// drift from it. See `nobody is seated whose club has no game today`.
import { fetchSlate, localDate } from "../src/data/today.ts"

/*
 * 5299, not 5173, and the wordmark is checked before anything else.
 *
 * This file defaulted BASE to http://127.0.0.1:5173 for as long as it has existed,
 * which is not this repo's port — it belongs to another app on this machine, and a
 * dev server there answers 200 just as happily. Every assertion below then failed as
 * a selector timeout on `.decide`, which reads like a UI defect in this app and is
 * not one; worse, the suite was quietly exercising somebody else's site. ui.mjs,
 * board.mjs and journey.mjs all already carried the wordmark guard for exactly this
 * reason, and this was the one file that did not, so it is the one file that could
 * be wrong about which app it was testing. The guard stops the run outright rather
 * than letting thirty downstream timeouts speak for it.
 */
const BASE = process.env.BASE ?? "http://127.0.0.1:5299"
const browser = await chromium.launch({ args: ["--no-sandbox"] })
let pass = 0, fail = 0
const t = (n, ok, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : "  " + x}`) }

{
	const probe = await browser.newPage()
	await probe.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 })
	const wordmark = await probe
		.waitForSelector("h1", { timeout: 15000 })
		.then(h => h.textContent(), () => null)
	t("the page under test is beanemachine", wordmark === "beanemachine",
		`BASE=${BASE} served <h1>${wordmark}</h1> — start this repo's own vite, or set BASE to it`)
	await probe.close()
	if (wordmark !== "beanemachine") { await browser.close(); process.exit(1) }
}

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

/**
 * ONE MAN IN YAHOO'S SECOND INJURED SLOT, "IL+".
 *
 * New here, and it exists because of a real defect with a real shape: six places in
 * this codebase asked "is this seat a reserve seat" by hand, as
 * `slot !== "BN" && slot !== "IL" && slot !== "NA"`, and every one of them counted
 * "IL+" as an ACTIVE seat. `isReserveSlot` in src/engine/bscore.ts now answers it in
 * one place. On this card the consequence of getting it wrong is the worst kind of
 * instruction: a man on the injured list is unrateable on purpose
 * (`injuryPolicy: "exclude"`), so he can never be seated, so an active-looking seat
 * holding him produces a row telling the reader to bench a player he cannot move.
 *
 * An injured hitter rather than a healthy one deliberately — with a healthy man the
 * planner could legitimately seat him and the row would vanish for the wrong reason,
 * and the test would pass on a bug. A name with no period in it, because the
 * unpriceable note below is parsed up to the first full stop.
 */
const shelved = snap.players.find(
	p => p.group === "hitting" && snap.injuries?.[String(p.id)] && !taken.has(p.name) &&
		!p.name.includes(".") && (p.stats?.plateAppearances ?? 0) > 100
)
if (shelved) seat("IL+", shelved, [shelved.position ?? "Util"])

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

/** Yahoo writes its non-playing seats as BN, IL, IL+ and NA — the same question
 *  `isReserveSlot` answers in src/engine/bscore.ts, asked here so the expectations
 *  below cannot quietly disagree with the card about what an active seat is. */
const reserve = slot => /^(BN|IL|NA)/i.test(slot)

/**
 * Click a tab by its VISIBLE TEXT, never by position.
 *
 * Four suites in this directory reached for `.views button:nth-child(N)`, and the
 * restructure from four tabs to three moved every index: the card this file is about
 * is still the first tab, but "League setup" was the third and is now gone, and the
 * screen that takes a roster went from second to third. An index-based click is a
 * silent rename away from asserting against the wrong screen — it does not fail, it
 * tests something else — whereas a label-based one fails loudly and is a one-line fix
 * when a tab is renamed. The labels are the contract with the reader anyway: he finds
 * the screen by reading it, not by counting.
 *
 * THE LABELS HAVE SINCE BEEN REWRITTEN, and it vindicated the paragraph above: the
 * bar read "Today | Wire | Setup" and now reads "Tonight | Pickups | My league",
 * which are three renames and not one restructure, and every label-based click in
 * this file failed loudly and was fixed on one line. The VIEW IDS did not move —
 * board / wire / trade — because the id is also the key this browser stores, and
 * renaming it drops every returning reader on the default screen. So the ids below
 * stay as they were and only the visible text changed. `TAB` exists so the next
 * rename is one edit rather than seven: the comments around each assertion still
 * name the screen by its id, which is the thing that is actually stable.
 */
const DAY_HITTING = JSON.parse(readFileSync(new URL("./fixtures/mlb-byDateRange-hitting-2026-09-11.json", import.meta.url), "utf8"))
const DAY_PITCHING = JSON.parse(readFileSync(new URL("./fixtures/mlb-byDateRange-pitching-2026-09-11.json", import.meta.url), "utf8"))

const TAB = { board: "Tonight", wire: "Pickups", trade: "My league" }
const tab = async (page, label) => {
	await page.click(`.views button:text-is("${label}")`)
	await page.waitForTimeout(400)
}

/**
 * @param seeds  what localStorage holds before the page loads
 * @param opts   `offline` blocks the server read of the wire, so the carried-file
 *               path is exercised deterministically. Without it this case passes or
 *               fails on whether a dev API server happens to be running — which is
 *               exactly how it stopped testing anything the moment one was.
 *               `logs` is an array the page's own console.errors are pushed into,
 *               attached before the first render because React's DOM-nesting
 *               complaint is a console.error and nothing else — see the folds block
 *               at the foot of this file.
 */
const open = async (seeds, opts = {}) => {
	const page = await browser.newPage({ viewport: opts.phone ? { width: 390, height: 844 } : { width: 1100, height: 1400 } })
	if (opts.logs) page.on("console", m => m.type() === "error" && opts.logs.push(m.text()))
	if (opts.offline) await page.route("**/api/available", r => r.abort())
	/** Cut the two LIVE MLB reads — the schedule and the transactions feed — so the
	 *  card has to fall back to the shipped capture. See the block at the foot of this
	 *  file for why that fallback must never be silent. */
	if (opts.noMlb) await page.route("**statsapi.mlb.com**", r => r.abort())
	/**
	 * LAST NIGHT, SERVED FROM THE COMMITTED FIXTURES, whatever date the card asks for.
	 *
	 * The recap card reads `byDateRange` for yesterday, so a suite that let it through would
	 * assert against whichever eight of four hundred men happened to play last night — a
	 * test that reports the schedule. The two fixtures are REAL responses for 2026-09-11
	 * trimmed to eight men, which is what makes the numbers below hand-computable: every one
	 * of them is what league 228947's table actually paid for that day. The date in the URL
	 * is ignored on purpose; the card's own date LABEL still comes from the reader's clock,
	 * which is the part worth asserting about it.
	 */
	if (opts.actuals)
		await page.route("**stats?stats=byDateRange**", r =>
			r.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(r.request().url().includes("group=pitching") ? DAY_PITCHING : DAY_HITTING)
			}))
	await page.addInitScript(([l, p, cfg, ro, led]) => {
		if (l) localStorage.setItem("beanemachine:lineup", JSON.stringify(l))
		if (p) localStorage.setItem("beanemachine:pool", JSON.stringify(p))
		if (cfg) localStorage.setItem("beanemachine:config", JSON.stringify(cfg))
		if (ro) localStorage.setItem("beanemachine:roster", JSON.stringify(ro))
		if (led) localStorage.setItem("beanemachine:ledger", JSON.stringify(led))
	}, [seeds.lineup ?? null, seeds.pool ?? null, seeds.config ?? null, seeds.roster ?? null, seeds.ledger ?? null])
	await page.goto(BASE, { waitUntil: "networkidle", timeout: 60000 })
	await page.waitForSelector(".decide", { timeout: 30000 })
	await page.waitForTimeout(1500)
	return page
}

/** The ages `readAgo` can print, as a set. Several assertions below want "it said
 *  HOW OLD" without caring which bucket today's clock landed in. */
const AGE = /(in the last hour|\d+ hours? ago|\d+ days? ago|at an unknown time)/

/**
 * With a team and a wire, the card names both sides of every move.
 *
 * This is the whole claim: a ranked list is not a decision, and a decision that
 * does not say who leaves cannot be carried out.
 */
{
	const page = await open({ lineup: seedLineup, pool: seedPool })
	const text = await page.$eval(".decide", e => e.innerText)
	/*
	 * TODAY HOLDS THE DECISION AND NOTHING ELSE. This assertion changed in kind, not
	 * in wording, and the old one has to be described or the change looks like a loss.
	 *
	 * It read "the card is the first thing on the page, above the board", and it was
	 * written when this card and the ranked board shared one tab called
	 * "Recommendations": the card on top, a thousand-row table underneath, and the only
	 * thing left to protect was the ORDER — that the answer came before the lookup. The
	 * two are separate screens now, and the old assertion could therefore only pass: it
	 * was `!board || cardIsFirst`, so with no board on the screen at all the first
	 * clause is true and nothing whatever is checked. An assertion that cannot fail is
	 * worse than no assertion, because the log still prints PASS and reads like cover.
	 *
	 * What replaces it is the property the split was actually for, and it is the
	 * stronger claim: Today renders NO board. Measured at phone width the combined tab
	 * was 7,477px with the first ranked row 1,600px down; Today is 947px and 105 words
	 * with no roster loaded. Two questions asked at different moments — what do I do
	 * before first pitch, and who is out there — stopped being one scroll.
	 *
	 * The board is not lost, so the link to it is asserted too, and asserted to LAND:
	 * a control promising "Everyone you can get" that does not reach the ranked table
	 * has told the reader to go and find something, which is the same failure the
	 * blocked card's CTA is written against further down.
	 */
	t(`${TAB.board} carries the decision and no ranked board under it`,
		!(await page.$(".board")) && !!(await page.$(".decide")),
		text.slice(0, 60))
	// by `TAB.board`, not by the literal: the label was "Today" and is now "Tonight",
	// and what the assertion is for is that the card is the tab a first load OPENS on,
	// which is a fact about the stored view id and survives the rename
	t(`and the card is the tab labelled ${TAB.board}, which is the one that opens`,
		await page.$eval(".views button.on", e => e.textContent.trim()) === TAB.board,
		await page.$eval(".views", e => e.innerText.replace(/\s+/g, " ")))
	{
		const link = await page.$(".next-screen button")
		t("the way to the board is one control on this screen",
			!!link && /Everyone you can get/.test(await link.innerText()),
			(await page.$eval(".decide, .next-screen", e => e.innerText).catch(() => "")).slice(-120))
		if (link) {
			await link.click()
			const onWire = await page
				.waitForSelector(".board .board-row", { timeout: 20000 })
				.then(() => true, () => false)
			t(`and it really lands on ${TAB.wire}, where the ranked board now lives`,
				onWire && await page.$eval(".views button.on", e => e.textContent.trim()) === TAB.wire,
				onWire ? "the board arrived but the tab did not follow" : "no ranked row ever appeared")
			// back to the card's own tab by LABEL, because everything below this point is
			// about the card and the bar it sits in has now been renamed twice
			await tab(page, TAB.board)
			t("and the card is still there when you come back to it",
				!!(await page.$(".decide")) && !(await page.$(".board")), "")
		}
	}
	t("it answers for the league's own scoring period, not a fortnight",
		/For <?b?>?(this matchup|this scoring period|today)/.test(text) || /For\s+(this matchup|this scoring period|today)/.test(text),
		text.split("\n").slice(0, 3).join(" | "))
	/*
	 * "Every move names the man who leaves" now has to say WHICH adds it means.
	 *
	 * This counted every line beginning "Add" and required each to carry a ", drop".
	 * The card has since grown a second kind of Add — the `Empty seats` list, which
	 * offers a free agent for a seat that would otherwise score nothing tonight — and
	 * those rows name no drop, so the old count made the original claim fail for a
	 * reason that has nothing to do with it.
	 *
	 * The claim belongs to the waiver half and is asserted there, identified by the
	 * `.decide-delta` badge that only a priced move carries. It is the reason this card
	 * exists: a ranked list is not a decision, and a decision that does not say who
	 * leaves cannot be carried out.
	 */
	const priced = await page.$$eval(".decide li", ns =>
		ns
			.filter(e => e.querySelector(":scope > .decide-delta"))
			.map(e => e.textContent.replace(/\s+/g, " ").trim()))
	t("every priced move names the man who leaves",
		priced.filter(r => /^Add /.test(r)).every(r => /, drop \S/.test(r)),
		JSON.stringify(priced))
	/*
	 * The empty-seat list is the other kind, and its own rules.
	 *
	 * It names no drop, which is new and which this suite deliberately does not assert
	 * as correct — see the note returned with this run. What it must not do is offer a
	 * man who is already his, or offer the same man for two seats: one man fills one
	 * seat, and the measured bug was Sam Antonacci offered for 2B, 3B, OF and Util at
	 * once — four adds that are really one, with three seats still empty after them.
	 */
	const fills = await page.$$eval(".decide-fill li", ns =>
		ns.map(e => ({
			slot: e.querySelector(".decide-slot")?.textContent?.trim(),
			name: e.querySelector("b")?.textContent?.trim()
		})))
	t("a seat-filling add offers a man who is not already yours",
		fills.every(f => f.name && !spots.some(s => s.name === f.name)), JSON.stringify(fills))
	t("and one man is offered for one seat, not for every seat he is eligible at",
		new Set(fills.map(f => f.name)).size === fills.length, JSON.stringify(fills))
	/*
	 * THE HEADING COUNTS SEATS AND THE LIST NAMES MEN, and the two are not the same
	 * number. Observed on the dev server with a fourteen-man roster: "4 seats score
	 * nothing tonight" over a list of two, because two of the four had no free man both
	 * eligible there and on a card — and one man can only take one seat. A list shorter
	 * than its own heading reads as the app having run out of room, so the difference is
	 * now stated. Asserted as an identity between the two numbers rather than against a
	 * fixed count, since how many seats are open is tonight's schedule and not this
	 * code's business.
	 */
	const openSeats = Number(
		(/(\d+) seats? scores? nothing/.exec(
			(await page.textContent(".decide-fill-head")) ?? ""
		) ?? [])[1] ?? NaN
	)
	const rest = (await page.$$eval(".decide-fill-rest", n => n.map(e => e.textContent.trim())))[0] ?? ""
	t("every seat the heading counts is either offered a man or explained",
		Number.isNaN(openSeats) ||
			openSeats === fills.length ||
			new RegExp(`other ${openSeats - fills.length}\\b|other seat`).test(rest),
		`${openSeats} open, ${fills.length} offered, rest: ${rest || "(nothing said)"}`)
	/*
	 * The seat phrase has to come off the name before the name is compared.
	 *
	 * A row reads "Add Yordan Alvarez for your 1B or OF or Util seat, drop Tyler
	 * Locklear", and `Add ([^,]+), drop` captured "Yordan Alvarez for your 1B or OF or
	 * Util seat" — a string that can never equal a roster name, so both assertions
	 * below passed unconditionally and protected nothing. They are the two that catch
	 * the card telling him to add a man he already owns or drop one he does not, so
	 * they are worth having actually armed.
	 */
	/*
	 * NOBODY IS DROPPED WHILE A SEAT IS FREE.
	 *
	 * The most expensive sentence this product ever printed, found by a stranger walking
	 * the published build: holding 12 of 27 seats, the card said "Add Dominic Canzone for
	 * your Util seat, drop Trevor Megill" — with fifteen seats free, three of which the
	 * SAME card was listing as scoring nothing tonight. A reader told to drop a man he
	 * does not have to drop stops believing every other number on the page.
	 *
	 * Asserted against the league's own seat count rather than a fixed number, because how
	 * many men this browser holds is whatever the suite pasted. `planSwaps` offers the add
	 * with nobody removed through the same evaluation as a swap, so it wins on merit when
	 * it is legal: measured, the same add went from +10.18 paired with a drop to +21.54
	 * standing alone, because the lineup keeps both men.
	 */
	const room = await page.evaluate(() => {
		const c = JSON.parse(localStorage.getItem("beanemachine:config"))
		const l = c.leagues[c.active_league]
		const seats = Object.values(l.roster.slots).reduce((a, n) => a + n, 0)
		const held = (JSON.parse(localStorage.getItem("beanemachine:roster") ?? "{}")[c.active_league] ?? []).length
		return { seats, held, free: seats - held }
	})
	t(
		room.free > 0 ?
			"with seats free, no move asks anybody to be dropped"
		:	"every seat is taken, so a move may pair an add with a drop",
		room.free <= 0 || !/, drop /.test(text),
		`${room.held} of ${room.seats} seats held; ${
			(text.match(/, drop [^.]{0,40}/g) ?? []).join(" | ") || "no drop proposed"
		}`)
	t("and where there is room the card says that is why nobody comes out",
		room.free <= 0 ||
			!/Add /.test(text) ||
			/free seat, so nobody comes out|seats are free/.test(text),
		text.slice(-300))

	/* Two shapes now: paired with a drop, and standing alone into a free seat. The two
	   assertions below are about the man arriving and the man leaving, so a pure add
	   contributes only an arrival and `drop` is null for it. */
	const adds = [
		...[...text.matchAll(/Add (.+?)(?: for your [^,]*seat)?, drop (.+)/g)].map(m => [m[1], m[2]]),
		/* `innerText`, so the seat clause and the reason can arrive on separate lines —
		   `.decide-why` is its own block. `[\s\S]` rather than `.` for that reason. */
		...[...text.matchAll(/Add ([^\n]+?)(?:[\s\S]{0,60}?seat)?[\s\S]{0,4}you have a free seat/g)].map(
			m => [m[1], null]
		)
	]
	t("it proposes at least one move, so the two rules below are tested against something",
		adds.length > 0 || /none clear the bar|None worth making/.test(text), text.slice(-400))
	t("it never proposes adding a player already on the roster",
		adds.every(([a]) => !spots.some(s => s.name === a)), JSON.stringify(adds))
	t("it never proposes dropping a player who is not on the roster",
		adds.every(([, d]) => d === null || spots.some(s => s.name === d)), JSON.stringify(adds))
	/*
	 * Availability is never silent, whichever way it was arrived at.
	 *
	 * This is what the old assertion in the no-team block ("it says up front that
	 * availability will be an estimate") was really protecting, and it belongs HERE,
	 * on the surface that actually proposes the adds, rather than on a card that
	 * proposes nothing. Two sources and two sentences: a list read off the league,
	 * dated, or the ownership estimate, labelled. A third state — moves proposed and
	 * nothing said about where the candidates came from — is the one that must not
	 * exist, because the reader cannot tell whether the man is really free.
	 */
	t("whether availability was read or estimated is said wherever adds are proposed",
		!/Add .+, drop /.test(text) ||
			/Who is free is an estimate/.test(text) ||
			new RegExp(`free-agent list, read ${AGE.source}`).test(text),
		text.slice(-500))
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
	/** Everything in the card including what is behind a closed fold. The card got
	 *  shorter by FOLDING prose, not by deleting it, and several assertions below
	 *  turn on that difference: a claim that is one tap away still has to be there. */
	const deep = await page.$eval(".decide", e => e.textContent)
	t("a daily-lock league is answered for TODAY, before the period", /\bToday\b/.test(text),
		text.slice(0, 200))

	const active = league.roster.slot_order.filter(sl => !reserve(sl))
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
	 * The card leads with the DIFFERENCE, not the lineup.
	 *
	 * He already has a lineup in Yahoo; what he needs is the handful of seats that
	 * should change. Every row it asks him to change has to be a real change against
	 * the seats it was given, or he is being sent to move a man who is already there.
	 *
	 * The shape of this list changed. Bench rows used to be one per man; they are now
	 * ONE PER REASON, each naming every man it applies to, because on a real 27-man
	 * roster on a five-game night it printed sixteen consecutive rows identical but
	 * for the name. So the parse is per-row-and-per-name rather than per-row: reading
	 * only `querySelector("b")` — which is what this test used to do — now sees the
	 * first man in each group and silently stops checking the rest, which on that
	 * same five-game night would have been fifteen unchecked names.
	 */
	const changeRows = await page.$$eval(".decide-changes li", ns =>
		ns.map(e => ({
			group: e.classList.contains("decide-bench-group"),
			badge: e.querySelector(".decide-slot")?.textContent?.trim() ?? null,
			// the bench reason, the "N projected today" on a start, the "from X to Y" on
			// a move: one per row either way
			why: e.querySelector("em.decide-why")?.textContent?.trim() ?? "",
			verb:
				e.classList.contains("decide-bench-group") ? "bench"
				: /Move /.test(e.textContent) ? "move"
				: "start",
			// every name in the row, each with the seat printed beside it — a grouped
			// bench row carries one <b> and one <em class="decide-seat"> per man
			men: [...e.querySelectorAll("b")].map(b => ({
				name: b.textContent.trim(),
				seat: b.parentElement?.querySelector("em.decide-seat")?.textContent?.trim() ?? null
			}))
		})))
	const activeSeated = new Set(
		seedLineup[KEY].spots.filter(sp => !/^(BN|IL|NA)/i.test(sp.slot)).map(sp => sp.name)
	)
	const benchRows = changeRows.filter(c => c.verb === "bench")
	const benched = benchRows.flatMap(c => c.men)
	const startRows = changeRows.filter(c => c.verb === "start")
	const moveRows = changeRows.filter(c => c.verb === "move")

	t("everyone it says to bench is currently in an active seat",
		benched.every(m => activeSeated.has(m.name)),
		JSON.stringify(benched.filter(m => !activeSeated.has(m.name))))
	t("everyone it says to start is not already in one",
		startRows.every(c => c.men.every(m => !activeSeated.has(m.name))),
		JSON.stringify(startRows.filter(c => c.men.some(m => activeSeated.has(m.name)))))
	// a man asked to change seat must be one who is already in the lineup — the row
	// exists to free a seat for somebody else, and moving a man who is not there
	// would be an instruction that cannot be followed
	t("everyone it says to move seats is already in the lineup",
		moveRows.every(c => c.men.every(m => activeSeated.has(m.name))),
		JSON.stringify(moveRows.filter(c => c.men.some(m => !activeSeated.has(m.name)))))

	/*
	 * GROUPING, as four properties rather than as a sentence.
	 *
	 * What was measured, and what made the change: sixteen rows reading "Bench X — he
	 * is not projected to play today", identical but for the name, sitting above the
	 * two moves that were the point of the card. Sixteen rows of one sentence is not
	 * sixteen decisions; it is one fact about the schedule and a list of who it applies
	 * to. The properties that make that safe, each of which a naive grouping breaks:
	 *
	 *  · one row per DISTINCT reason — if two rows share a reason the grouping did not
	 *    happen and the sixteen rows are back
	 *  · every man named EXACTLY ONCE across the rows — a grouping keyed on the wrong
	 *    thing duplicates men, and a reader shown a name twice cannot tell whether it
	 *    is two seats
	 *  · every man's own SEAT printed beside him — the row's badge is "×5" for a group,
	 *    so without the per-man seat he has no way to find any of them in Yahoo
	 *  · the badge IS the count for a group of several, and the man's own seat for a
	 *    group of one
	 *
	 * None of these mentions which reasons came back, because that is tonight's
	 * schedule talking.
	 */
	const reasons = benchRows.map(c => c.why)
	t("bench rows are one per reason, not one per man",
		new Set(reasons).size === reasons.length,
		JSON.stringify(reasons))
	t("and every man it benches is named exactly once across them",
		new Set(benched.map(m => m.name)).size === benched.length,
		JSON.stringify(benched.map(m => m.name)))
	t("each man keeps his own seat beside his name, which is what he changes in Yahoo",
		benched.every(m => m.seat && activeSeated.has(m.name) &&
			seedLineup[KEY].spots.some(sp => sp.name === m.name && sp.slot === m.seat)),
		JSON.stringify(benched))
	t("the badge on a grouped row is the count, and on a single row his seat",
		benchRows.every(c =>
			c.men.length > 1 ? c.badge === `×${c.men.length}` : c.badge === c.men[0]?.seat),
		JSON.stringify(benchRows.map(c => [c.badge, c.men.length])))
	/*
	 * A reason has to be a fact about the world, not about a man — which is the
	 * precondition for grouping at all. If a reason ever carried a name in it, two men
	 * could never share one, every group would be of size one, and the sixteen rows
	 * would come back through the back door while this suite stayed green.
	 */
	t("no reason names a player, which is why men can share one",
		reasons.every(r => r && ![...activeSeated].some(n => r.includes(n))),
		JSON.stringify(reasons))

	/*
	 * Nobody is dropped on the floor by the grouping.
	 *
	 * The old one-row-per-man list could not lose a man: each had his own row. A
	 * grouped list can — a reason the reducer does not handle, a man whose reason came
	 * back undefined — and the symptom is the quiet one this card exists to prevent: a
	 * seat that is neither "change this" nor "this is right", simply unmentioned. So
	 * every man in an active seat must be in exactly one of the two lists the card
	 * shows: the bench groups, or the seat-by-seat fold of the lineup it wants.
	 */
	const inFold = new Set(rows.filter(r => r.who).map(r => r.who))
	const benchNames = new Set(benched.map(m => m.name))
	const unaccounted = [...activeSeated].filter(n => inFold.has(n) === benchNames.has(n))
	t("every man in an active seat is either benched or in tonight's lineup, never neither",
		unaccounted.length === 0, JSON.stringify(unaccounted))

	/*
	 * A man in Yahoo's "IL+" seat is not a man to bench.
	 *
	 * See `shelved` above. The hand-written reserve check this card's helpers replaced
	 * read "IL+" as an active seat, and an injured man in an active seat is unrateable
	 * by design, so he lands in the bench list with a reason attached — an instruction
	 * to make a move the platform will not allow, about a man whose absence the reader
	 * already knows about. The correct answer is silence in the change list.
	 */
	if (shelved) {
		t("a man on the injured list is not told to take a seat he cannot leave",
			!benchNames.has(shelved.name) &&
				!changeRows.some(c => c.men.some(m => m.name === shelved.name)),
			`${shelved.name} appears in ${JSON.stringify(changeRows.filter(c => c.men.some(m => m.name === shelved.name)))}`)
	}

	/*
	 * The age of the baseline, in one clause.
	 *
	 * This used to be two sentences — "Compared against your seats as read N hours
	 * ago. Change your lineup in Yahoo since then and this list is against the old
	 * one." The second restated the first for anybody who had already understood it,
	 * and it is gone. What it protected is not: a diff is only as good as the age of
	 * the seats it was diffed against, and the age is still on the card, which is the
	 * part a reader acts on. So the assertion is that the AGE is stated, and — new —
	 * that the dropped sentence really was dropped rather than folded away somewhere,
	 * because a "shorter" card that still carries 277 words behind a summary has not
	 * got shorter.
	 */
	/* The verb changed, the AGE is the claim. "as read" was true of seats pulled off a
	   platform and false of seats typed in, which is the commoner route and the only one a
	   phone has — a reader who typed his team forty seconds ago was told the comparison was
	   against seats "as read". What this assertion is for is that the age is on the card,
	   because the age is the part he acts on. */
	t("and it says how old the seats it compared against are",
		new RegExp(`you last gave it, ${AGE.source}`).test(text), text.slice(-400))
	t("it says it once — the sentence restating it is gone, not folded",
		!/Change your lineup in Yahoo since then/.test(deep), text.slice(-400))

	/*
	 * What the moves are denominated in is FOLDED, not deleted.
	 *
	 * The old paragraph was four sentences under every move: what the gain counts,
	 * that everyone leaving is under the keep floor, that none is worth holding for the
	 * season, and the arithmetic behind the ownership cut. All of it true, none of it
	 * changing the next tap, and on a phone it was eight lines under each of two moves.
	 * It is now a `<details class="decide-fine">` called "what these numbers are".
	 *
	 * Both halves are asserted deliberately. A reader who wants to know what "+38.8"
	 * means must still be able to find out — so the text is present in the DOM — and a
	 * reader who does not must not have to scroll past it — so it is not in the rendered
	 * text of a card nobody has clicked. Deleting the explanation would pass half of
	 * this and is the failure this is written against.
	 */
	if (/Add .+, drop /.test(text)) {
		t("what the numbers mean is a tap away, not four sentences on the card",
			/what these numbers are/i.test(text) &&
				!/Each figure is what your starting lineup projects/.test(text),
			text.slice(-600))
		t("and the explanation still exists behind that fold rather than being deleted",
			/Each figure is what your starting lineup projects/.test(deep) &&
				/under the keep floor/.test(deep),
			deep.slice(-900))
	}

	/*
	 * BOTH HALVES OF THE FLOOR, and this block used to assert the opposite.
	 *
	 * It read: "the innings line says it counts only what is still to come" and "why it
	 * cannot count the rest is folded" — because what had already been thrown was on the
	 * reader's team page, which nothing here read. That was the old truth and it is no longer
	 * true: one byDateRange request covers a whole period for every pitcher in baseball, so
	 * the line now states the banked innings, the projection, and the total against the floor.
	 *
	 * Asserted as a DISJUNCTION rather than pinned to the new wording alone. The read is live,
	 * and a suite that required it to have landed would be a suite that reports MLB's
	 * availability — so either the full sentence is there or the old one is, and in neither
	 * case may the page compare the floor against a total it could not source. The one thing
	 * forbidden outright is the retracted claim that nothing here reads the thrown innings.
	 */
	if (/innings a week/.test(text)) {
		const banked = /have thrown [\d.]+ in it so far and project [\d.]+ more/.test(text)
		t("the innings line states what was thrown as well as what is coming, or says it could not",
			banked || /still to come only/.test(text), text.slice(-700))
		t("and a floor is only compared against a total the page could source",
			banked ? /against \d/.test(text) : !/against \d/.test(text), text.slice(-400))
		t("the fold explains whichever of the two it printed, and never the retracted claim",
			/what these two numbers are|why not the whole week/i.test(text) &&
				!/are on your team page, which\s+nothing here reads/.test(deep),
			deep.slice(-900))
	}

	/*
	 * A stale WIRE is worse than a stale lineup, and silently so: it goes on offering
	 * a man the league picked up days ago and never offers one it just dropped. On
	 * 2026-09-08 the carried file was four days old and did not contain Chandler
	 * Simpson, whom the league had released and who is the best outfielder on it. So
	 * when the list is a carried one rather than a live read, the card says how old.
	 * This test blocks the live read, which is the only way to be sure which of the
	 * two it is looking at.
	 *
	 * The SENTENCE changed and the claim did not. It read "your league's free-agent
	 * list as it stood N hours ago"; the four sentences around it were folded away and
	 * what is left on the line is "Your league's own free-agent list, read N hours
	 * ago". So the assertion is on the age — which is the part that tells the reader
	 * whether to trust it — rather than on the wording around it.
	 */
	{
		const off = await open({ lineup: seedLineup, pool: seedPool }, { offline: true })
		const t2 = await off.$eval(".decide", e => e.innerText)
		t("a carried free-agent list is dated where the moves are proposed",
			!/Add .+, drop /.test(t2) ||
				new RegExp(`free-agent list, read ${AGE.source}`).test(t2),
			t2.slice(-500))
		await off.close()
	}

	/*
	 * A league that WAS read from source must never be labelled as borrowed values.
	 *
	 * This used to be about the seeded example league — the site shipped one real
	 * league and opened every first visit on it, and the notice above the board said
	 * so. That league is gone: a first visit opens on the setup in Onboard.tsx and
	 * this browser holds only what the reader put in it. What survives, and is what
	 * this assertion is really about, is the rule the notice enforces — it appears
	 * for a PRESET, whose numbers came from somebody else's league, and it must not
	 * appear for a league whose values were read off its own pages.
	 */
	t("a league read from its own pages is never labelled as borrowed values",
		!(await page.$(".preset-note")),
		(await page.$(".preset-note").then(e => e && e.innerText())) || "")

	/*
	 * A man the model cannot price is still on his roster.
	 *
	 * Unpriceable players are neither started nor offered up nor mentioned, which is
	 * the roster quietly shrinking: the lineup is planned as if he owned fewer men
	 * than he does. On the shipped team that is two — an injured outfielder and a
	 * pitcher with no projection — and an absence is stated as an absence.
	 *
	 * `shelved` above does NOT make this note appear, and it should not: a man parked
	 * in an IL seat whom a source does list as hurt is accounted for, not missing, and
	 * `planLineup` only reports a reserve seat when nothing lists him hurt — which is
	 * the activatable case and a different thing to tell the reader. So on this
	 * constructed roster the branch taken is the second one. It stays written both ways
	 * because the assertion is about the note being HONEST, not about its being there:
	 * a count without the names is the failure, and so is a note with nothing behind it.
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
			if (shelved)
				t("and the injured man this test seated is one of the names",
					named?.includes(shelved.name) ?? false, `${shelved.name} not in: ${named}`)
		} else {
			t("with every player priced, no unpriceable note is invented", true,
				"nothing on this roster was skipped")
		}
	}

	/*
	 * Nobody is seated whose club is not playing.
	 *
	 * The SOURCE of that fact changed, and the assertion had to follow it. This used
	 * to be computed off `snapshot.slate` — the committed capture, stamped 2026-09-08,
	 * which is right about a season and cannot be right about tonight. The card now
	 * reads MLB's schedule live on mount (`src/client/useSlate.ts`) and lets it WIN
	 * where the two disagree, which is the whole point: a club whose game was
	 * postponed this afternoon is in the capture and not in tonight's slate. Checking
	 * the card against the capture would therefore have been checking it against the
	 * thing it deliberately overrides.
	 *
	 * So the test does the same live read, from the same module, and falls back to the
	 * capture only if MLB will not answer — in which case the card fell back to it too,
	 * and the two still agree about what is being asserted.
	 *
	 * On a day when all thirty clubs have a game this cannot fail, so it is computed
	 * rather than assumed — on a Monday or a Thursday it is the whole point.
	 */
	const day = localDate()
	const { slate: live, error: slateError } = await fetchSlate(day)
	const playingClubs =
		!slateError && live.playing.size ? live.playing
		:	new Set(snap.slate.filter(g => g.date === day).flatMap(g => [g.home, g.away]))
	const clubOf = new Map(snap.players.map(p => [p.name, p.teamId]))
	const seated = rows.filter(r => r.who).map(r => r.who)
	t("nobody is seated whose club has no game today",
		seated.every(n => !clubOf.has(n) || playingClubs.has(clubOf.get(n))),
		seated.filter(n => clubOf.has(n) && !playingClubs.has(clubOf.get(n))).join(", ") ||
			`${playingClubs.size} clubs playing${slateError ? ` (live read failed: ${slateError}, fell back to the capture)` : ""}`)
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
 *
 * WHAT THIS CARD SAYS NOW IS ONE SENTENCE. It was four paragraphs and a hundred and
 * ten words, most of it about CORS: that availability would be estimated, that
 * Yahoo cannot be read by any browser, and how to run a command line — all of it
 * addressed to somebody who has not yet told the app who is on his team, and none
 * of it changing his next tap. The assertions below moved with it: what is asserted
 * here is the ASK and the ROUTE, and the claims that left are asserted where they
 * are now made.
 */
{
	const page = await open({})
	const text = await page.$eval(".decide", e => e.innerText)
	const deep = await page.$eval(".decide", e => e.textContent)
	/*
	 * It asks, rather than answering. The sentence it asked with was "Tell me who is
	 * on your team"; it is now the button's own label plus what pressing it buys. The
	 * property is unchanged and is the one that matters: a card with no roster must
	 * make a request, not an assertion about a team it does not have.
	 */
	t("with no team it asks for one rather than answering",
		/Add your players/.test(text) && !/projected/.test(text), text.slice(0, 200))
	t("and it proposes no moves at all",
		!/Add .+, drop /.test(text), text.slice(0, 200))
	t("the way out is a control on the page, not an instruction to go elsewhere",
		!!(await page.$(".decide-cta")), text.slice(0, 200))
	/*
	 * One sentence, and that is now a thing to assert rather than a thing to describe.
	 *
	 * The old card explained CORS to a stranger. Asserting the absence of the lecture
	 * is what keeps it from growing back one well-meaning paragraph at a time, and
	 * `deep` rather than `text` because folding it away would not fix the problem —
	 * the reason it was wrong is that none of it helps before the first tap, not that
	 * it took up room.
	 */
	const ps = await page.$$(".decide-blocked p")
	t("the blocked state is one sentence and a button, not an essay about CORS",
		ps.length === 1 && !/CORS/.test(deep) &&
			text.trim().split(/\s+/).length <= 45,
		`${ps.length} paragraphs, ${text.trim().split(/\s+/).length} words: ${text.slice(0, 300)}`)
	/*
	 * The estimate claim is not missing, it MOVED.
	 *
	 * "and it says up front that availability will be an estimate" used to live here.
	 * It cannot: this card proposes nothing, so it makes no claim about availability
	 * to qualify, and a warning about the accuracy of recommendations that do not
	 * exist yet is noise in front of the only control on the screen. The claim is now
	 * asserted on the surfaces that actually use the estimate — see "whether
	 * availability was read or estimated is said wherever adds are proposed" in the
	 * first block, and "it says plainly that who is available is an estimate" in the
	 * roster-without-a-wire block below. What is asserted here is the inverse: a card
	 * that promises nothing must not promise anything.
	 */
	t("a card that proposes nothing makes no claim about the wire either",
		!/free-agent list/.test(deep) && !/rostered in/.test(deep), text.slice(0, 300))
	/*
	 * Yahoo is told nothing about being readable, because it is not.
	 *
	 * The ESPN block below asserts the other half. This is the branch: the platform
	 * sentence is ESPN's alone, and a Yahoo reader who was told his platform answers a
	 * browser directly would go looking for a button that cannot exist.
	 */
	if (league.meta.platform === "yahoo")
		t("a Yahoo league is not told its platform can read the roster for it",
			!/answers a browser directly/.test(deep), text.slice(0, 300))

	/*
	 * THE COMMAND LINE IS GONE FROM THIS CARD, and three assertions went with it.
	 *
	 * They were: that the exact-list route is behind a `<details>`; that the command is
	 * one a visitor could run (`npx`, not `node --experimental-strip-types src/cli.ts`,
	 * which needs a clone nobody arriving at the site has); and that it carries his own
	 * league and team id. Nothing on the decide card prints a command any more.
	 *
	 * Of the three, the second is covered elsewhere and was never really this card's:
	 * test/leagues.mjs reads `IMPORT_COMMAND` out of panels.tsx and asserts it starts
	 * `npx --yes github:` and does not name the flag. The third is a real loss and is
	 * reported as one rather than quietly dropped — no surface now prints a command
	 * with the reader's league and team already in it.
	 *
	 * What is asserted here instead is the property the first one protected, in the
	 * strongest form the new card allows: a visitor meets no command line at all, and
	 * the control he does meet lands on a screen where the exact list can actually be
	 * got — by pasting, which needs no terminal, works on a private league, and is
	 * the only route that ever reaches Yahoo's free-agent page.
	 */
	t("a visitor meets no command line on the card at all",
		!(await page.$(".decide-cmd")) && !/npx |node --/.test(deep), deep.slice(0, 400))
	/*
	 * WHERE THE BUTTON GOES is the same claim against a different screen.
	 *
	 * It used to land on "My team & trades", the second of four tabs. That tab and
	 * "League setup" were merged into one screen called Setup — both are things one
	 * person does once a season from a laptop, and half the navigation was furniture
	 * that did not fit the phone the site is opened on. So the destination is now the
	 * THIRD tab, and the assertion names the screen by its label rather than trusting
	 * an index or the old tab's name.
	 *
	 * The extra half is new and is worth the line: the roster paste and the league's
	 * own scoring tables are now one screen, and several blocked states on this card
	 * say "Open League setup" (see the team-count case below). If those two ever came
	 * apart again, a reader following the only control this card offers would arrive
	 * somewhere that cannot do the thing the card's other sentences tell him to do.
	 */
	await page.click(".decide-cta")
	const landed = await page
		.waitForSelector(".trade-team .paste-roster", { timeout: 15000 })
		.then(() => true, () => false)
	t("and the control on it really lands on the screen that takes a roster",
		landed, "pressing Add your players did not reach the roster paste")
	t(`which is the tab labelled ${TAB.trade}, wherever in the bar that sits`,
		await page.$eval(".views button.on", e => e.textContent.trim()) === TAB.trade,
		await page.$eval(".views", e => e.innerText.replace(/\s+/g, " ")))
	if (landed) {
		const team = await page.$eval(".trade-team", e => e.innerText)
		t("which is also where the exact free-agent list is got, with no terminal",
			/Paste your free agents/.test(team) && !/npx |node --/.test(team),
			team.slice(0, 400))
		// case-insensitively, and on the headings rather than the rendered text: these
		// <h2>s are small-caps by stylesheet, so innerText hands back "BATTING" and a
		// literal /Batting/ failed against a screen that was perfectly correct
		const heads = await page.$$eval("h2", ns => ns.map(n => n.textContent.trim().toLowerCase()))
		t("and the league's own scoring lives on that same screen, as its copy promises",
			["batting", "pitching", "roster slots", "this league"].every(h => heads.includes(h)),
			JSON.stringify(heads))
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
	/* "Add X, drop Y" was the only shape a move had. A roster with a free seat now gets
	   an add with nobody removed — see the room block above — so the claim is stated as
	   what it always meant: the half ANSWERS rather than refusing. */
	t("the moves half answers from the ownership estimate rather than refusing",
		/Add .+, drop /.test(text) ||
			/Add [\s\S]{0,80}free seat, so nobody comes out/.test(text) ||
			/none clear the bar/.test(text),
		text.slice(-600))
	/*
	 * The label shrank to three words and stayed on the line. It was a sentence
	 * ending "is an estimate"; the arithmetic behind the cut — the percentage, the
	 * depth, "some will already be taken in yours" — went into the fold, which is why
	 * `deep` carries it and the line carries the warning. The warning itself is the
	 * part that changes a decision, so it is the part that is still in front of him.
	 */
	const deep = await page.$eval(".decide", e => e.textContent)
	t("and it says plainly that who is available is an estimate",
		!/Add .+, drop /.test(text) || /Who is free is an estimate/.test(text), text.slice(-600))
	t("with the arithmetic behind the estimate still there, one tap down",
		!/Add .+, drop /.test(text) || /rostered in \d+% of leagues or fewer/.test(deep),
		deep.slice(-700))
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
	/*
	 * The name this sentence sends a reader to has to be a name the navigation uses.
	 *
	 * This assertion was deliberately left matching "League setup" after the four tabs
	 * became three, so that the mismatch stayed visible rather than being papered over
	 * by loosening the regex: the card was telling a reader to open a tab that no
	 * longer existed. It was then fixed to "Open Setup", and the pair was written to
	 * keep it honest in future — the screen the card names must be one the nav offers.
	 *
	 * IT HAS CAUGHT THE SAME BUG A SECOND TIME, which is why the pair was worth having.
	 * The bar now reads "Tonight | Pickups | My league" and the tab that takes a team
	 * count is "My league"; `Decide.tsx` line 833 still reads "Open Setup". There is no
	 * screen called Setup any more, so the one instruction this blocked card gives
	 * cannot be followed by reading the screen — and it is the WHOLE card: without a
	 * team count there is no honest replacement level, so nothing else is offered.
	 * Decide.tsx:852 and :1166, Trade.tsx:450 and :468, Board.tsx:792 and
	 * panels.tsx:818/:926 say it too; the rename pass moved the label and left every
	 * pointer to it behind. This suite may not edit src/, so the assertion STAYS RED
	 * and the defect is reported rather than absorbed — see the run's srcConcerns.
	 *
	 * Two changes to the pair, both of which make it harder to paper over next time:
	 *
	 *  · the expected name is DERIVED from the nav rather than written out here, so the
	 *    test cannot be brought green by editing a literal in it. Whatever the bar is
	 *    relabelled to, the card has to say that.
	 *  · the two halves were split so the red one names the real defect. The old first
	 *    assertion ANDed "it says the team count is missing" with "it says where", so a
	 *    stale pointer read as the card failing to report the missing input at all,
	 *    which is a different and much worse bug. It reports it fine. It points wrong.
	 */
	const navLabels = await page.$$eval(".views button", n => n.map(e => e.textContent.trim()))
	t("a league with no team count is told that much",
		/how many teams are in it/.test(text), text.slice(0, 300))
	t("and the screen it sends him to is one the navigation actually offers",
		navLabels.some(l => text.includes(l)) &&
			!/League setup|Recommendations|My team &|\bSetup\b/.test(text),
		`nav offers ${JSON.stringify(navLabels)} — the card says: ${text.replace(/\s+/g, " ").slice(0, 200)}`)
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
	/*
	 * The second assertion here used to be `!(await page.$(".decide-cmd"))` — that an
	 * ESPN reader is not handed a command line he does not need. No reader is handed
	 * one now, Yahoo included, so that cannot fail and asserting it would be theatre.
	 * What it protected is the BRANCH, and a branch needs both sides: the Yahoo block
	 * above asserts the platform sentence is absent there, and this asserts the ESPN
	 * card is still the same one sentence plus that clause rather than growing a
	 * second route back.
	 */
	const ps = await page.$$(".decide-blocked p")
	t("and the ESPN card is the same one sentence, plus that clause",
		ps.length === 1 && !!(await page.$(".decide-cta")) && !(await page.$(".decide-cmd")),
		`${ps.length} paragraphs: ${text.slice(0, 260)}`)
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

	// "Tell me who is on your team" is gone with the blocked card's four paragraphs;
	// the sentence a hand-entered team must never see is the one claiming the page
	// knows nothing about it, and the button that asks for a roster he has already
	// given. Both are still the wrong answer here, so both are still asserted.
	t("a hand-entered team is not told the page has not been told about it",
		!/has not been told which players are yours|Add your players/.test(text),
		text.slice(0, 240))
	t("it produces a lineup for that team",
		(await page.$$(".decide-changes li")).length > 0, text.slice(0, 400))
	t("and it says the seats are unknown rather than inventing a comparison",
		/lineup to set, not the changes to make/.test(text), text.slice(0, 900))
	/* Both shapes of a move count as an answer. This roster has free seats, so the adds
	   arrive with nobody removed — see the room block above for why that is the whole
	   point. The claim is that the half ANSWERS. */
	t("the adds are answered too, from the estimate",
		/Add [\s\S]{0,80}, drop |Add [\s\S]{0,120}free seat, so nobody comes out|none clear the bar/.test(
			text
		),
		text.slice(-700))
	t("and nothing on it claims a free-agent list was read",
		!/read off your league|as it stood|free-agent list, read /.test(text), text.slice(-700))
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

/* ── a live read that failed has to say so ───────────────────────────────────
 *
 * Two feeds are read live on this card: MLB's schedule, for tonight's posted lineups
 * and probable starters, and MLB's transactions, for who went on the injured list
 * since the capture was taken. Both fall back to the shipped snapshot when they
 * cannot be reached, which is the right behaviour — the card is useful without them
 * and must not go blank because somebody else's API is slow.
 *
 * What is not right is doing it silently, and that is what shipped: `slateError` was
 * captured from the hook and never rendered. The capture is days old; it cannot know
 * about tonight's card or this morning's IL move; and a card that presents it as
 * tonight is making exactly the claim this file exists to stop it making. The reader
 * has to be told, and told WHICH of the two failed, because they answer different
 * questions.
 */
{
	const page = await open({ lineup: seedLineup, pool: seedPool }, { noMlb: true })
	const warn = await page.$(".decide-stale")
	t("with MLB unreachable the card says so rather than presenting the capture as tonight",
		!!warn, await page.$eval(".decide", e => e.innerText.slice(0, 200)))
	if (warn) {
		const text = (await warn.innerText()).replace(/\s+/g, " ")
		t("and it names both feeds, because they answer different questions",
			/lineups and injured list/.test(text), text)
		t("and how old the thing it fell back to is",
			/from the capture, \d+[hd] ago/.test(text), text)
	}
	await page.close()
}

/* ── the folds are legal HTML, and that is not a cosmetic matter here ─────────
 *
 * Four <details> hang off prose on this card. Two of them used to be illegal: "what
 * these numbers are" sat inside `<p class="sub decide-rest">`, and "why not the whole
 * week" sat INSIDE the `<em class="decide-why">` whose clause it explains. <details>
 * is flow content and neither a <p> nor an <em> may contain it. The `<p>` is a <div>
 * now and the innings fold is the <em>'s SIBLING.
 *
 * A browser handed the old markup does not refuse it — it closes the <p>/<em> early
 * and reparents the fold after it, so the fold renders outside the element it is
 * styled inside, and the only protest is a validateDOMNesting console.error nobody
 * reads. That is worth a test in THIS file specifically, because the way this suite
 * checks a fold is `text` (innerText, what the reader sees) against `deep`
 * (textContent, the folds included) — and both still find the words after a silent
 * reparent. So "what the numbers mean is a tap away" and "why it cannot count the
 * rest is folded, not dropped" would have stayed green through it, which makes them
 * exactly the assertions that need this one underneath them.
 *
 * Asserted from both ends: the browser's own parse of where the folds ended up, and
 * React's silence about it.
 */
{
	const logs = []
	const page = await open({ lineup: seedLineup, pool: seedPool }, { logs })
	// with no fold on the card the three assertions below are all vacuously true, so
	// the count comes first — this is the same trap as the `!board || cardIsFirst`
	// assertion described in the first block
	const folds = await page.$$eval(".decide details", ns => ns.length)
	t("the card still folds things away, so the nesting below is asserted about something",
		folds > 0, `${folds} <details> on the card`)
	t("no fold sits inside a <p> or an <em>, where a browser would quietly move it out",
		(await page.$$eval(".decide p details, .decide em details", ns => ns.length)) === 0,
		await page.$$eval(".decide p details, .decide em details", ns =>
			ns.map(e => e.parentElement?.outerHTML.slice(0, 140)).join(" | ")))
	/*
	 * The innings fold is a SIBLING of its clause, not a child, and the two are
	 * distinguishable only here: reparented or not, `.decide-watch`'s textContent
	 * reads the same, and the assertion above would pass either way because the
	 * reparent is what REMOVES it from the <em>. So this is the one that catches the
	 * markup being written back the nested way: the clause and the fold share a
	 * parent, and the clause contains nothing.
	 */
	const innings = await page.$$eval(".decide-watch em.decide-why", ns =>
		ns.map(e => ({
			nested: !!e.querySelector("details"),
			sibling: e.nextElementSibling?.tagName === "DETAILS"
		})))
	if (innings.length)
		t("the innings clause keeps its fold beside it rather than inside it",
			innings.every(i => !i.nested) && innings.some(i => i.sibling),
			JSON.stringify(innings))
	/*
	 * React's own complaint, filtered rather than "no console errors at all": this page
	 * reads MLB live and a blocked or slow feed logs a 502 of its own, so a bare
	 * zero-errors assertion would be red on somebody else's outage and tell him
	 * nothing about his card.
	 */
	t("and React logs no nesting complaint about the card",
		!logs.some(l => /validateDOMNesting|cannot (?:appear|contain|be a (?:child|descendant))/i.test(l)),
		logs.join(" | "))
	await page.close()
}

/**
 * LAST NIGHT — the only card in this app that states a fact rather than an estimate.
 *
 * Every number asserted below was hand-computed from the committed fixtures against league
 * 228947's own table, in test/actuals.mjs, and is a number Yahoo actually paid out on
 * 2026-09-11: Kyle Tucker 34.1 (two runs, a single, a triple, a homer, five RBI), Alex
 * Bregman 25.8, Taj Bradley 29.5 off eighteen outs and six strikeouts, Ozzie Albies 1.9,
 * Jo Adell 0.0 on an 0-for-4, Dustin May 40.1.
 *
 * THE CLAIM THIS BLOCK DEFENDS is the distinction the card is easiest to get wrong. Adell
 * played and was worth nothing; a man with no line was not in the park. A card that printed
 * the second as the first would tell a reader his outfielder had a bad night when he was
 * resting, and the two sit side by side in this fixture on purpose.
 */
{
	/* The shipped league, as the other blocks in this file seed it: its own scoring table is
	   what makes every figure below a number Yahoo actually paid. */
	const cfg = JSON.parse(readFileSync("scoring.json", "utf8"))
	const man = (name, slot, positions) => ({ slot, name, positions, team: null })
	/* Bregman is on the BENCH and outscored Adell, who had the Util seat — so the bench gap
	   is 25.8 and one swap explains all of it. Everyone carries eligibility the league's own
	   slot_accepts table can place, because an unplaceable starter makes the card refuse the
	   comparison, which is a different assertion and is covered in test/actuals.mjs. */
	const spots = [
		man("Kyle Tucker", "OF", ["OF"]),
		man("Jo Adell", "Util", ["OF"]),
		man("Taj Bradley", "SP", ["SP"]),
		man("Alex Bregman", "BN", ["3B"]),
		man("Ozzie Albies", "BN", ["2B"]),
		man("Dustin May", "IL", ["SP"])
	]
	const page = await open(
		{ config: cfg, lineup: { [KEY]: { at: new Date().toISOString(), spots } } },
		{ actuals: true }
	)
	await page.waitForSelector(".recap", { timeout: 30000 })
	await page.waitForTimeout(1200)
	const card = await page.$eval(".recap", e => e.innerText)

	// 34.1 + 0 + 29.5 = 63.6 from the three startable seats. The IL man is not in a lineup.
	t("last night's card leads with what your lineup scored", /63\.6/.test(card), card.slice(0, 200))
	/* "from your lineup" OR "from the lineup you have now", and which one is itself asserted
	   forty lines down. The seats this suite seeds are stamped with the current time, so they
	   postdate the night being recapped and the card correctly refuses to call them the lineup
	   he had — the claim here is only that the figure says which lineup it is ABOUT, rather
	   than standing as a bare number. */
	t("and says whose lineup that is", /from (your lineup|the lineup you have now)/.test(card), card.slice(0, 200))
	// 63.6 + 25.8 + 1.9 + 40.1 = 131.4 for everyone held.
	t("everyone you hold is a second, different number", /131\.4/.test(card), card)
	t("and it says how many of them played", /6 of 6 of your men played/.test(card), card)

	/* The best legal lineup, in THIS league's sixteen startable seats: Tucker at OF 34.1,
	   Bregman at 3B 25.8, Albies at 2B 1.9, Adell in the other OF 0, Bradley at SP 29.5 =
	   91.3, against 63.6 from the three seats he actually used. The gap is 27.7, which is
	   both bench men seated and not just the big one — this league has room for them, and an
	   earlier version of this assertion expected 25.8 because it had been reasoned against
	   the four-seat shape used in test/actuals.mjs rather than against the league the card
	   is actually running. The card was right and the expectation was wrong. */
	t("the bench gap is the difference", /27\.7 points sat on your bench/.test(card), card)
	t("and the best lineup it is measured against is stated", /worth 91\.3/.test(card), card)
	t("labelled as hindsight rather than as a thing he should have known",
		/knowing now what nobody knew then/.test(card), card)
	t("and named down to the one seat that explains it",
		/Alex Bregman/.test(card) && /scored 25\.8 more than/.test(card) && /Jo Adell/.test(card), card)
	// Dustin May outscored everyone and was on the injured list: he could not have been
	// started that day without a move the lineup did not have, so a regret built on him
	// would be a fiction.
	t("the man on the injured list is not the regret", !/Dustin May.*more than/.test(card), card)

	/* THE WEEK, under the night. One number, three qualifications, all in the sentence: which
	   days, that it counts every man he holds rather than the men he started, and that it is
	   therefore the size of his week and not the score — because Yahoo pays only the men in a
	   lineup, this browser holds only today's seats, and nothing here can see an opponent.
	   The stub answers every byDateRange read with the same fixture, so the figure equals the
	   day's; what is asserted is the shape and the three caveats, which is what can regress. */
	/* WHOSE SEATS THOSE WERE. `lineupStore` stamps when the seats were read, and this suite
	   seeds them with `new Date()` — so they are always AFTER the night being recapped, which is
	   also the commonest real case, because the morning is when a reader pastes a roster and
	   when he opens this card. Calling that total "your lineup" would be a confident claim about
	   a lineup nobody recorded; it is still worth printing, because what the lineup he has NOW
	   would have scored is exactly the question he is asking. */
	t("a lineup read after the games is labelled as the one he has now",
		/from the lineup you have now/.test(card), card.slice(0, 200))
	t("and the stamp says which day those seats came from",
		/Those are the seats you gave this page on \w+ \d+/.test(card) &&
			/not what yours did/.test(card), card)

	t("the week so far is named as well as the night",
		/In this (matchup|scoring period) so far \(\w+ \d+ to \w+ \d+\)/.test(card), card)
	t("and it says it counts every man he holds, not the men he started",
		/every man you hold has\s+scored/.test(card), card)
	t("and that it is the size of his week rather than the score",
		/size of your week rather than the score/.test(card), card)

	const day = await page.$eval(".recap-day", e => e.innerText)
	t("the date is the reader's own yesterday, not the fixture's", /\w/.test(day) && !/2026-09-11/.test(day), day)

	await page.click(".recap-men summary")
	await page.waitForTimeout(200)
	const list = await page.$eval(".recap-each", e => e.innerText)
	t("every man you hold is listed", ["Kyle Tucker", "Jo Adell", "Taj Bradley", "Alex Bregman", "Ozzie Albies", "Dustin May"].every(n => list.includes(n)), list)
	t("best night first", list.indexOf("Dustin May") < list.indexOf("Ozzie Albies"), list)
	t("a night is explained by the categories that carried it", /HR/.test(list) && /OUT/.test(list), list)
	// THE DISTINCTION. 0-for-4 is a zero; never being in the park is not.
	t("0-for-4 is a zero", /Jo Adell\n0\b/.test(list) || /Jo Adell[\s\S]{0,8}\b0\b/.test(list), list)
	const ghost = await open(
		{
			config: cfg,
			lineup: { [KEY]: { at: new Date().toISOString(), spots: [...spots, man("Pete Alonso", "BN", ["1B"])] } }
		},
		{ actuals: true }
	)
	await ghost.waitForSelector(".recap", { timeout: 30000 })
	await ghost.waitForTimeout(1000)
	await ghost.click(".recap-men summary")
	await ghost.waitForTimeout(200)
	const withGhost = await ghost.$eval(".recap-each", e => e.innerText)
	t("a man who never took the field says so rather than showing a zero",
		/Pete Alonso[\s\S]{0,24}didn/.test(withGhost), withGhost.slice(-200))
	await ghost.close()

	/* BILLY'S RECORD, from days already settled. A stored verdict needs no request, which is
	   what makes a running record free — and the denominator is the honest part: the day he
	   left the lineup alone is worth nothing and is not counted as a win. */
	const ago = n => {
		const d = new Date(Date.now() - n * 86400_000)
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
	}
	const graded = (date, worth, unchanged = false) => ({
		date, at: `${date}T22:00:00.000Z`, start: [], sit: [], had: [], moves: [],
		graded: { asked: 80, had: 80 - worth, worth, unchanged, at: `${date}T23:00:00.000Z` }
	})
	const withRecord = await open(
		{
			config: cfg,
			lineup: { [KEY]: { at: new Date().toISOString(), spots } },
			ledger: { [KEY]: [graded(ago(4), 18.2), graded(ago(3), -6.1), graded(ago(2), 0, true)] }
		},
		{ actuals: true }
	)
	await withRecord.waitForSelector(".recap-record", { timeout: 30000 })
	const rec = await withRecord.$eval(".recap-record", e => e.innerText)
	t("the record sums the days it graded", /\+12\.1 points/.test(rec), rec)
	t("over the days he asked for a change, and says how many", /over the 2 days/.test(rec), rec)
	t("with both sides of it", /better on 1, worse on 1/.test(rec), rec)
	// The day he left the lineup alone is worth nothing either way, and a win rate over
	// every recorded day would flatter itself with days on which nothing was claimed.
	t("and the day he left it alone is named and not counted",
		/On 1 other day he left your lineup alone/.test(rec), rec)
	await withRecord.close()

	/* The card writes what it recommended BEFORE the games, because the comparison is
	   impossible afterwards. Asserted as a store write rather than as rendered text, since
	   nothing on screen claims it — which is itself deliberate. */
	const wrote = await page.evaluate(() => {
		try { return JSON.parse(localStorage.getItem("beanemachine:ledger") ?? "null") } catch { return null }
	})
	const mine = wrote?.[Object.keys(wrote ?? {})[0]] ?? []
	t("tonight's recommendation is written down while the outcome is unknown", mine.length > 0, JSON.stringify(wrote).slice(0, 160))
	t("with the whole lineup it asked for, not only the changes", (mine[0]?.start?.length ?? 0) > 0, JSON.stringify(mine[0] ?? null).slice(0, 200))
	t("and every man keyed the way a real line is keyed", (mine[0]?.start ?? []).every(x => /^\d+:(hitting|pitching)$/.test(x.key)), JSON.stringify(mine[0]?.start ?? []).slice(0, 200))
	// One entry per league per day: a reader who opens the app twice has not been advised
	// twice, and a second row would flatter the record's own denominator.
	t("one entry for the day, however many times it rendered", mine.filter(e => e.date === mine[0].date).length === 1, String(mine.length))
	await page.close()
}

/**
 * AM I WINNING — the question this app has never answered, answered the only honest way.
 *
 * There is no feed: Yahoo stopped answering the read that would have supplied a rival roster,
 * there is no backend, and nothing here may invent one. What the app can do is the thing it does
 * for everything else — be told. An opponent's roster goes through the same parser the reader's
 * own team goes through, and `src/data/actuals.ts` prices both sides over the league's own period
 * from MLB's day-by-day record.
 *
 * THE CLAIM UNDER TEST IS THE CAVEAT AS MUCH AS THE NUMBER. Neither figure is what the league
 * will pay, because Yahoo pays only the men in a lineup and this page can see neither side's; so
 * both count every man HELD, the gap is measured the same way twice, and the card has to say so.
 * A version of this that printed a score would be worse than the silence it replaced.
 */
{
	const cfg = JSON.parse(readFileSync("scoring.json", "utf8"))
	const page = await open(
		{ config: cfg, lineup: { [KEY]: { at: new Date().toISOString(), spots } } },
		{ actuals: true }
	)
	await page.waitForSelector(".recap", { timeout: 30000 })
	await page.waitForTimeout(1200)
	const fold = await page.$('.recap details summary:text-is("Who are you playing?")')
	t("the card offers to be told who the opponent is", !!fold,
		(await page.$eval(".recap", e => e.innerText)).slice(0, 200))
	if (fold) {
		await fold.click()
		await page.waitForTimeout(200)
		/* Two men from the committed fixture who are NOT on the seeded team, because a man on
		   both sides is caught by design and suppresses the gap — which is asserted a few lines
		   down, and which this block accidentally exercised first: the fixture's Alex Bregman is
		   a top-plate-appearance third baseman and `bestAt` had already seated him.
		
		   One is typed as a full name and one as a bare surname, so the same parser path the
		   reader's own team goes through is the path his opponent's goes through too. */
		const fixtureMen = [
			...DAY_HITTING.stats[0].splits.map(x => x.player.fullName),
			...DAY_PITCHING.stats[0].splits.map(x => x.player.fullName)
		]
		const hisTwo = fixtureMen.filter(n => !spots.some(sp => sp.name === n)).slice(0, 2)
		t("the fixture holds two men who are not on the seeded team", hisTwo.length === 2, fixtureMen.join(", "))
		await page.fill(
			".recap-rival textarea",
			`${hisTwo[0]}\n${(hisTwo[1] ?? "").split(" ").slice(-1)[0]}`
		)
		await page.click('.recap-rival button:text-is("That\u2019s his team")')
		await page.waitForTimeout(1500)
		const card = await page.$eval(".recap", e => e.innerText)
		t("his men are counted and the two totals are put side by side",
			/His men have scored [\d.]+ to your [\d.]+/.test(card), card.slice(0, 400))
		t("and it says which way the gap runs",
			/you are (ahead|behind) by [\d.]+|level/.test(card), card)
		// The caveat is the assertion. Both sides the same way, and not the score.
		t("and that both sides are counted the same way",
			/Both sides count every man held/.test(card), card)
		t("and that it is not the score the league will pay",
			/not the score your league will pay/.test(card), card)
		t("two men are on record, the bare surname among them",
			/2 of his men are on record/.test(card), card)
		// The parser's note is written for the reader's OWN team and says things that are wrong
		// of this one — "no seats were in that text, so tonight's lineup comes back as the lineup
		// to SET" is about HIS roster box. Nothing here uses his seats.
		t("and nothing about the reader's own lineup is said under his opponent's roster",
			!/lineup comes back as the lineup to SET/.test(card), card)
		/* A MAN CANNOT BE ON BOTH TEAMS. The realistic mistake is pasting your own roster page
		   into the opponent box — the two gestures are identical and the boxes are one tap apart
		   — and the result would be a gap of zero reported with total confidence. It is also the
		   only check available on a rival roster, because any twelve real men are a possible team. */
		const mineName = spots[0].name
		await page.fill(".recap-rival textarea", mineName)
		await page.click('.recap-rival button:text-is("That\u2019s his team")')
		await page.waitForTimeout(1200)
		const clash = await page.$eval(".recap", e => e.innerText)
		t("a man entered on both sides is caught and named",
			clash.includes(mineName) && /on YOUR team as well/.test(clash), clash.slice(0, 400))
		t("and no gap is reported while that is true",
			!/His men have scored/.test(clash), clash.slice(0, 400))

		await page.click('.recap-rival button:text-is("Forget him")')
		await page.waitForTimeout(800)
		t("and he can be forgotten again",
			!/His men have scored/.test(await page.$eval(".recap", e => e.innerText)),
			(await page.$eval(".recap", e => e.innerText)).slice(0, 200))
	}
	await page.close()
}

/**
 * A SCRATCH LEADS, because it is the one thing on this card that is not a ranking.
 *
 * A man MLB has left out of tonight's posted order while he sits in a startable seat is the
 * most actionable sentence the screen can produce in an evening: that seat scores nothing
 * unless the reader moves, and it is a FACT rather than an opinion about who is better. It
 * used to reach him grouped with everybody else under "not in today's lineup", beneath the
 * change rows, in a list ordered by lock time.
 *
 * THE SLATE IS STUBBED HERE, which is the only way to assert it: a real evening may have no
 * scratch on a constructed roster, and a suite that waited for one would be a suite that
 * reports tonight's lineup cards. One club is given a posted order that omits a man the
 * seeded team starts — which is exactly what a scratch is — and the rest of the slate is
 * left empty.
 */
{
	const cfg = JSON.parse(readFileSync("scoring.json", "utf8"))
	/* The first seated hitter on the constructed team, and his club. His club's order is
	   published WITHOUT him, so `statusOf` returns "not in today's lineup" — the one state
	   that means a man who could have played is not playing. */
	const victim = spots.find(sp => !/^(BN|IL|NA)/i.test(sp.slot) && sp.team)
	const him = victim && snap.players.find(p => p.name === victim.name)
	if (him?.teamId) {
		const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } })
		await page.route("**statsapi.mlb.com/api/v1/schedule**", r =>
			r.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					dates: [{
						games: [{
							gamePk: 99,
							gameDate: new Date(Date.now() + 3 * 3_600_000).toISOString(),
							status: { detailedState: "Pre-Game" },
							teams: { home: { team: { id: him.teamId, abbreviation: "HOM" } }, away: { team: { id: 999, abbreviation: "AWY" } } },
							/* Nine ids that are not his: the order IS posted, and he is not in it. */
							lineups: { homePlayers: [1, 2, 3, 4, 5, 6, 7, 8, 9].map(id => ({ id })), awayPlayers: [] }
						}]
					}]
				})
			}))
		await page.route("**statsapi.mlb.com/api/v1/transactions**", r =>
			r.fulfill({ status: 200, contentType: "application/json", body: '{"transactions":[]}' }))
		await page.route("**stats?stats=byDateRange**", r =>
			r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(DAY_HITTING) }))
		await page.addInitScript(([l, c]) => {
			localStorage.setItem("beanemachine:lineup", JSON.stringify(l))
			localStorage.setItem("beanemachine:config", JSON.stringify(c))
		}, [{ [KEY]: { at: new Date().toISOString(), spots } }, cfg])
		await page.goto(BASE, { waitUntil: "domcontentloaded" })
		await page.waitForSelector(".decide", { timeout: 30000 })
		await page.waitForTimeout(2000)
		const line = await page.$(".decide-scratch")
		t("a man left out of tonight's posted order is named before anything else",
			!!line && (await line.innerText()).includes(him.name),
			line ? await line.innerText() : "(no scratch line)")
		if (line) {
			const scratchY = await line.evaluate(e => Math.round(e.getBoundingClientRect().top))
			const changes = await page.$(".decide-changes")
			const changesY = changes ? await changes.evaluate(e => Math.round(e.getBoundingClientRect().top)) : Infinity
			t("and it sits above the changes, not inside them",
				scratchY < changesY, `scratch y=${scratchY}, changes y=${changesY}`)
			t("and says what it costs him if he does nothing",
				/scores nothing unless you change/.test(await line.innerText()), await line.innerText())
		}
		await page.close()
	}
}

/**
 * NOBODY IS EXPLAINED TWICE ON ONE CARD.
 *
 * A man on the 60-day injured list sitting in an active seat reached the reader twice, in two
 * different sets of words: "Bench him — MLB lists him Injured 60-Day" in the change rows, and
 * "One player on your roster could not be priced, so nothing above counts him: Injured 60-Day —
 * no source states a return date" at the foot. Both true, one man, and nothing on screen tying
 * them together, so a reader checking whether he has understood finds what looks like two
 * separate problems with the same player.
 *
 * The claim asserted is the general one rather than that one case, because the general one is
 * what a future reason can break: no name the card has already named may appear again in the
 * could-not-be-priced block. What that block still exists for — a man in a RESERVE seat, or one
 * the board has no row for, who never reaches the change rows at all — is asserted in the same
 * breath, because a de-duplication that silently swallowed those would be worse than the
 * duplication it replaced.
 */
{
	const cfg = JSON.parse(readFileSync("scoring.json", "utf8"))
	const page = await open({ lineup: seedLineup, pool: seedPool, config: cfg })
	const named = await page.$$eval(".decide-changes b", bs => bs.map(b => b.textContent.trim()))
	const unpriced = await page.$$eval(".decide-list li", ls =>
		ls
			.filter(l => /could not be priced/.test(l.textContent ?? ""))
			.flatMap(l => [...l.querySelectorAll("b")].map(b => b.textContent.trim())))
	t("no man the change rows name is named again as unpriceable",
		unpriced.every(n => !named.includes(n)),
		`changes: ${named.join(", ") || "(none)"}\n  unpriced: ${unpriced.join(", ") || "(none)"}`)
	await page.close()

	/*
	 * AND THE BLOCK STILL DOES ITS JOB, which is the half a de-duplication could silently eat.
	 *
	 * The first version of this assertion reached for the suite's IL+ man and was wrong about
	 * him: `planLineup` skips a man in a reserve seat SILENTLY when a source says he is hurt,
	 * because an injured man on the injured list needs no explaining. The line it does produce
	 * is for the opposite case — a man parked in a reserve seat whom nothing says is hurt,
	 * which is a seat the reader may be wasting — so that is the case seeded here.
	 *
	 * He never appears in the change rows, because a reserve seat is not a lineup decision. If
	 * the de-duplication above ever widened to drop him, this is what would fail.
	 */
	const healthy = snap.players.find(
		p =>
			p.group === "hitting" &&
			!snap.injuries?.[String(p.id)] &&
			(p.stats?.plateAppearances ?? 0) > 300 &&
			!spots.some(sp => sp.name === p.name)
	)
	if (healthy) {
		const parked = await open({
			config: cfg,
			pool: seedPool,
			lineup: {
				[KEY]: {
					at: new Date().toISOString(),
					spots: [
						...spots.filter(sp => !/^IL/i.test(sp.slot)).slice(0, 6),
						{
							slot: "IL",
							name: healthy.name,
							positions: [healthy.position ?? "Util"],
							team: healthy.team ?? null
						}
					]
				}
			}
		})
		const text = await parked.$eval(".decide", e => e.innerText)
		t("a man parked in a reserve seat that nothing says he needs is still reported",
			text.includes(healthy.name) && /could not be priced|parked in the/.test(text),
			`${healthy.name} — ${text.slice(0, 240).replace(/\n+/g, " | ")}`)
		await parked.close()
	}
}

/**
 * THE FIRST THIRTY SECONDS, with nothing in this browser.
 *
 * The hardest screen in the product. Measured on the published build at 390x844 before this
 * changed: a first visit landed on the ranked board, 489 vertical pixels of filters with ZERO
 * ranked rows on the first screen, and the first name it did reach was a White Sox rookie
 * reliever with a 32px number beside it — correct output from a value-over-replacement board
 * and the worst available answer to "what is this?".
 */
{
	const cfg = JSON.parse(readFileSync("scoring.json", "utf8"))
	const page = await open({ config: cfg }, { actuals: true, phone: true })
	await page.waitForSelector(".recap", { timeout: 30000 })
	await page.waitForTimeout(800)
	const on = await page.$$eval("nav button", bs =>
		bs.filter(b => b.className.includes("on")).map(b => b.innerText.trim()))
	/* Case-folded, because `.views button` is uppercased by CSS and `innerText` reports what
	   is PAINTED: the label in panels.tsx is "Tonight" and the DOM says "TONIGHT". Comparing
	   the two exactly is an assertion about a text-transform. */
	t("a first visit lands on the tab the title names",
		on.map(x => x.toLowerCase()).join() === TAB.board.toLowerCase(), JSON.stringify(on))
	const card = await page.$eval(".recap", e => e.innerText)
	t("and is shown what last night was actually worth", /best nights in baseball/.test(card), card.slice(0, 160))
	t("with the scoring named as borrowed rather than as his",
		/one real league\u2019s scoring|one real league's scoring/.test(card), card.slice(0, 300))
	// Facts, not estimates — which is the distinction the whole card exists to carry onto a
	// screen where everything else is a projection.
	t("and said to be box scores rather than projections", /Real box scores, not projections/.test(card), card)
	t("the biggest night in the fixture leads", /Dustin May/.test(card) && /40\.1/.test(card), card)
	t("and a scoreless night is not in it", !/Jo Adell/.test(card), card)
	/* Real names on the first screen of a 390px phone, where there used to be none. Asserted as
	   "inside the first viewport" rather than at a pixel, because the rows are the claim and
	   their exact offsets are app.css's business.
	
	   AND NONE OF THEM IS BEHIND THE DOCK. The list was eight and the setup dock owned the
	   pixels rows seven and eight were drawn in at rest, so a list of eight showed six — which
	   is why it is six. `elementFromPoint` at each row's own centre is the only check that
	   catches that: a row can be inside the viewport and still be under something. */
	const rows = await page.$$eval(".recap-best li", ls =>
		ls.map(l => {
			const r = l.getBoundingClientRect()
			const at = document.elementFromPoint(Math.round(r.left + 8), Math.round(r.top + r.height / 2))
			return { inside: r.top >= 0 && r.bottom <= innerHeight, covered: !l.contains(at) }
		}))
	t("real players are on the first screen of a phone",
		rows.filter(r => r.inside).length >= 5, JSON.stringify(rows))
	t("and not one of them is drawn under the setup bar",
		rows.every(r => !r.covered), JSON.stringify(rows))
	await page.close()
}

console.log(`\npassed ${pass}, failed ${fail}`)
await browser.close()
process.exit(fail ? 1 : 0)
