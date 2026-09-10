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
 * "Setup" by reading it, not by counting.
 */
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
	t("Today carries the decision and no ranked board under it",
		!(await page.$(".board")) && !!(await page.$(".decide")),
		text.slice(0, 60))
	t("and the card is the tab labelled Today, which is the one that opens",
		await page.$eval(".views button.on", e => e.textContent.trim()) === "Today",
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
			t("and it really lands on Wire, where the ranked board now lives",
				onWire && await page.$eval(".views button.on", e => e.textContent.trim()) === "Wire",
				onWire ? "the board arrived but the tab did not follow" : "no ranked row ever appeared")
			// back to Today by LABEL, because everything below this point is about the
			// card and the tab it sits behind has moved once already
			await tab(page, "Today")
			t("and Today is still the card when you come back to it",
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
	 * The seat phrase has to come off the name before the name is compared.
	 *
	 * A row reads "Add Yordan Alvarez for your 1B or OF or Util seat, drop Tyler
	 * Locklear", and `Add ([^,]+), drop` captured "Yordan Alvarez for your 1B or OF or
	 * Util seat" — a string that can never equal a roster name, so both assertions
	 * below passed unconditionally and protected nothing. They are the two that catch
	 * the card telling him to add a man he already owns or drop one he does not, so
	 * they are worth having actually armed.
	 */
	const adds = [...text.matchAll(/Add (.+?)(?: for your [^,]*seat)?, drop (.+)/g)].map(m => [m[1], m[2]])
	t("it proposes at least one move, so the two rules below are tested against something",
		adds.length > 0 || /none clear the bar|None worth making/.test(text), text.slice(-400))
	t("it never proposes adding a player already on the roster",
		adds.every(([a]) => !spots.some(s => s.name === a)), JSON.stringify(adds))
	t("it never proposes dropping a player who is not on the roster",
		adds.every(([, d]) => spots.some(s => s.name === d)), JSON.stringify(adds))
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
	t("and it says how old the seats it compared against are",
		new RegExp(`as read ${AGE.source}`).test(text), text.slice(-400))
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
	 * Same shape, same reasoning, for the innings-floor caveat.
	 *
	 * The line can only count innings STILL TO COME — what has already been thrown is
	 * on his team page, which nothing here reads — and that is a fact about this page
	 * rather than about his week. It is the thing a reader has to know before acting,
	 * so the clause stays on the line; why the page cannot do better is folded.
	 */
	if (/innings a week/.test(text)) {
		t("the innings line says it counts only what is still to come",
			/still to come only/.test(text), text.slice(-700))
		t("and why it cannot count the rest is folded, not dropped",
			/why not the whole week/i.test(text) &&
				!/Innings already thrown this period are on your team page/.test(text) &&
				/Innings already thrown this period are on your team page/.test(deep),
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
	t("which is the tab labelled Setup, wherever in the bar that sits",
		await page.$eval(".views button.on", e => e.textContent.trim()) === "Setup",
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
	t("the moves half answers from the ownership estimate rather than refusing",
		/Add .+, drop /.test(text) || /none clear the bar/.test(text), text.slice(-600))
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
	 * longer existed. The copy is fixed now — Decide.tsx says "Open Setup" — so the
	 * assertion moves to the new name, and the pair below is what keeps it honest in
	 * future: the screen it names must be one the nav actually offers.
	 */
	t("a league with no team count is told that, and where to set it",
		/how many teams are in it/.test(text) && /\bSetup\b/.test(text), text.slice(0, 300))
	t("and the screen it names is one the navigation actually offers",
		(await page.$$eval(".views button", n => n.map(e => e.textContent.trim()))).includes("Setup") &&
			!/League setup|Recommendations|My team &/.test(text),
		text.slice(0, 300))
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
	t("the adds are answered too, from the estimate",
		/Add .+, drop |none clear the bar/.test(text), text.slice(-700))
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

console.log(`\npassed ${pass}, failed ${fail}`)
await browser.close()
process.exit(fail ? 1 : 0)
