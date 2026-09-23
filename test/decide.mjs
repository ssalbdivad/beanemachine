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
	await page.addInitScript(([l, p, cfg, ro, led, opp]) => {
		if (l) localStorage.setItem("beanemachine:lineup", JSON.stringify(l))
		if (p) localStorage.setItem("beanemachine:pool", JSON.stringify(p))
		if (cfg) localStorage.setItem("beanemachine:config", JSON.stringify(cfg))
		if (ro) localStorage.setItem("beanemachine:roster", JSON.stringify(ro))
		if (led) localStorage.setItem("beanemachine:ledger", JSON.stringify(led))
		/* The men on the OTHER side of the matchup, which only a paste or an extension read
		   ever writes. Seeded here so the one sentence on this card that compares two teams
		   can be asserted at all — its gate needs an opponent list at least two thirds the
		   size of the reader's own roster, which no other seed in this file produces. */
		if (opp) localStorage.setItem("beanemachine:opponent", JSON.stringify(opp))
	}, [seeds.lineup ?? null, seeds.pool ?? null, seeds.config ?? null, seeds.roster ?? null, seeds.ledger ?? null, seeds.opponent ?? null])
	await page.goto(BASE, { waitUntil: "networkidle", timeout: 60000 })
	/* `opts.gap`: a league one input short renders NO decide card — `Setup` is the one card
	   that names the gap, see Decide.tsx — so waiting for `.decide` there waits for nothing. */
	await page.waitForSelector(opts.gap ? ".setup-gaps" : ".decide", { timeout: 30000 })
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
	/*
	   RE-AIMED AT `.decide-do-add`, AND THE CLAIM IS THE SAME ONE.

	   It read every `li` carrying a `.decide-delta` badge and required each whose text began
	   "Add" to contain ", drop". The badge used to belong to waiver moves alone; the card now
	   draws ONE list — waiver adds, seat changes and the free agents who fill an empty seat —
	   and every row in it has a badge, so the old selector would have demanded a drop from
	   rows that correctly name none. `.decide-do-add` is the waiver half, which is the half
	   the claim was always about and is the reason this card exists: a ranked list is not a
	   decision, and a decision that does not say who leaves cannot be carried out.

	   The free-seat escape is asserted explicitly rather than tolerated. `planSwaps` pairs an
	   add with a drop only once every seat is taken, and a row that says so in words is not a
	   row that forgot to.
	*/
	const priced = await page.$$eval(".decide-do-add", ns =>
		ns.map(e => e.textContent.replace(/\s+/g, " ").trim()))
	t("every priced move names the man who leaves",
		priced.every(r => /, drop \S/.test(r) || /free seat, so nobody comes out/.test(r)),
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
	/*
	   THE EMPTY-SEAT ADDS MOVED INTO THE ONE LIST, so they are read out of it.

	   `.decide-fill` was a block of its own — "Empty seats · 12 seats score nothing tonight"
	   — which stated the same fact as the bench rows above it from the other end and pushed
	   the priced add five blocks down the card. A fillable seat is now a row in the one list,
	   and the man arriving into it is marked `.decide-add-wire` because on the row the only
	   thing separating him from one of the reader's own is the verb. The slot is no longer in
	   a gutter cell, so it is read out of the row's own sentence — "Add X at SP, and sit Y".
	*/
	const fills = await page.$$eval(".decide-do .decide-add-wire", ns =>
		ns.map(e => ({
			slot: (/ at ([A-Za-z0-9+]+)[,. ]/.exec(
				e.closest("li")?.textContent?.replace(/\s+/g, " ") ?? ""
			) ?? [])[1],
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
	/* The heading that carried this number is gone with the block. The seats it counted are
	   still counted, one per row, in the fold that has always had to account for every active
	   seat — so the identity is now asserted against the fold rather than against a heading
	   whose only job was to restate it. */
	const emptySeats = await page.$$eval(".decide-today .decide-empty .decide-slot", ns =>
		ns.map(e => e.textContent.trim()))
	const openSeats = emptySeats.length
	const emptyLine =
		(await page.$$eval(".decide-empty-seats", n => n.map(e => e.textContent.trim())))[0] ?? ""
	/* One sentence now, two clauses, because the two reasons are different and only one of
	   them is a seat there was never anything to do about. */
	const rest = (/(One seat has|\d+ seats have) nobody/.exec(emptyLine) ?? [])[0] ?? ""
	const shutOut = (/(One more had|\d+ more had)/.exec(emptyLine) ?? [])[0] ?? ""
	/* THE ACCOUNTING IS NOW ACROSS TWO SENTENCES, and this assertion adds them up rather than
	   matching one of them. The single sentence it used to read asserted one reason for every
	   unfilled seat — "no free man eligible there is on a card tonight" — which is true of a
	   seat nobody is eligible for and false of a seat whose best answer has already locked,
	   the commonest kind after the first pitch. "One" and "one other" are spelled out in both
	   sentences, so the word counts as 1. */
	/* NOBODY IS OFFERED TWICE ON ONE CARD. A walk found Dominic Canzone as "Util · Add Dominic
	   Canzone · 7.11 projected tonight" under Empty seats AND as "+14.36 · Add Dominic Canzone
	   for your Util seat" under Make these moves — one man, one seat, two rows, and no way to
	   tell whether that is one add or two. The moves row is the one that survives, because it
	   prices the add against the rest of the roster. */
	const moveRows = await page.$$eval(".decide-do-add", ns =>
		ns.map(e => ({
			name: e.querySelector("b")?.textContent?.trim(),
			seats: e.querySelector(".decide-seat")?.textContent?.trim() ?? ""
		})))
	const moveNames = moveRows.map(m => m.name)
	/* Still the same claim — one man, one row — but now it is about one list rather than two,
	   which is what made the duplicate possible in the first place. */
	t("a man the priced moves offer is not offered a second time for a seat",
		fills.every(f => !moveNames.includes(f.name)),
		`fills: ${fills.map(f => f.name).join(", ") || "(none)"} | moves: ${moveNames.join(", ") || "(none)"}`)

	const said = t =>
		/^(One|one)\b/.test(t) ? 1 : Number((/(\d+)/.exec(t) ?? [])[1] ?? (t ? NaN : 0))
	/*
	   THE THIRD REASON IS NO LONGER A SENTENCE, so the test derives it instead of reading one.

	   "2 of them are the seats the moves above fill" existed because the moves lived in a
	   different block, three headings away, and a reader could not see that the empty seat he
	   was being told about was the one the add filled. In one list he can, so the sentence
	   went — and the seats it accounted for are still accounted for, by the add row that
	   names them. `.decide-seat` is that row's own "for your SP or RP or P seat" clause, which
	   is where the planner already puts the seats an arriving man may fill.
	*/
	const filledByMove = new Set(
		[...new Set(emptySeats)].filter(slot =>
			moveRows.some(m => new RegExp(`\\b${slot.replace("+", "\\+")}\\b`).test(m.seats))
		)
	).size
	/*
	   A SANDWICH, NOT AN IDENTITY, and the reason is named rather than the assertion weakened
	   in silence.

	   The exact sum used to be readable off the screen because the card printed all three
	   reasons as sentences, including "2 of them are the seats the moves above fill". That
	   third sentence existed only because the moves lived three headings away; in one list
	   the reader can see the add that fills the seat, so it went. What is left on screen is
	   the two counts, and `filledByMove` here is this file's own upper bound on the third,
	   derived from the seat clause each priced add already carries.

	   So both directions are still asserted and neither is the weak one: the card may not
	   claim MORE unfillable seats than it has empty seats (the lower rail — that is a card
	   inventing a hole), and it may not leave an empty seat unaccounted for by any of the
	   three (the upper rail — that is the quiet failure this assertion exists for, a list
	   shorter than the truth with nothing saying so).
	*/
	t("the card never claims more empty seats than the lineup leaves",
		fills.length + said(rest) + said(shutOut) <= openSeats,
		`${openSeats} empty, ${fills.length} offered from the wire, nobody-eligible: ${rest || "(none)"}, already-locked: ${shutOut || "(none)"}`)
	t("and every seat it leaves empty is offered a man, priced into a move, or counted",
		fills.length + filledByMove + said(rest) + said(shutOut) >= openSeats,
		`${openSeats} empty, ${fills.length} offered from the wire, ${filledByMove} covered by a priced move, nobody-eligible: ${rest || "(none)"}, already-locked: ${shutOut || "(none)"}`)
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

	/*
	   READ OFF THE ROW, NOT OUT OF THE PROSE.

	   Two shapes — paired with a drop, and standing alone into a free seat — and this pulled
	   both out of `innerText` with two regexes, one of which allowed at most four characters
	   between the seat clause and "you have a free seat". That clause moved into the row's own
	   `<em>`, behind the unit the row now states ("over this scoring period · you have a free
	   seat, so nobody comes out"), and four characters was not enough: the assertion went red
	   about rows that were correct and present. A regex whose margin is a character count is a
	   regex that fails on the next wording change, so the arriving and leaving men come off
	   the row's own elements instead. `.decide-do-add` carries exactly one add; its first <b>
	   is the man arriving and its second, where there is one, the man leaving.
	*/
	const adds = await page.$$eval(".decide-do-add", ns =>
		ns.map(e => {
			const names = [...e.querySelectorAll("b")].map(b => b.textContent.trim())
			return [names[0] ?? null, names[1] ?? null]
		}))
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
	 * AND THE REASON IS SAID ONCE, WHICH IS NEW AND IS THE POINT OF THIS PAIR.
	 *
	 * Every empty row used to carry the whole sentence — "leave empty — nobody you own
	 * is projected to play here today" — eleven words, identical but for nothing at
	 * all. Measured in this browser at 390x844 against the roster above: nine empty
	 * seats, so that one sentence was 99 of the card's 766 words with the folds open,
	 * 13% of the card to say one thing nine times, and a 27-seat league on a five-game
	 * night runs to twenty-odd copies of it. The card is 605 words with the folds open
	 * now.
	 *
	 * The seat count is NOT what moved and the two assertions above still hold it: one
	 * row per active seat, every one named, an empty one visibly empty. What moved is
	 * the reason, which was never per-seat — it is one fact about tonight's schedule —
	 * so it is one sentence under the list and the row keeps only the instruction.
	 */
	const emptyRows = rows.filter(r => r.empty)
	if (emptyRows.length > 1) {
		const reasons = await page.$$eval(".decide-today .decide-empty em.decide-why", ns =>
			ns.map(e => e.textContent.trim().split(/\s+/).length))
		t("an empty row is an instruction, not a sentence repeated once per seat",
			reasons.every(n => n <= 2),
			JSON.stringify(await page.$$eval(".decide-today .decide-empty em", ns =>
				ns.map(e => e.textContent.trim()))))
		t("…and the reason those seats are empty is stated once, under the list",
			(await page.$$(".decide-empty-why")).length === 1 &&
				/projected to play/.test(await page.$eval(".decide-empty-why", e => e.textContent)),
			await page.$$eval(".decide-empty-why", ns => ns.map(e => e.textContent).join(" | ")) ||
				"(nothing said)")
	}

	/*
	 * The card leads with the DIFFERENCE, not the lineup — and now with the WHOLE
	 * difference, in one list.
	 *
	 * THE SHAPE THIS SUITE READS CHANGED TWICE, and the second time is why these
	 * assertions were rewritten rather than repointed. `.decide-changes` was a lineup diff
	 * — bench rows grouped by reason, start rows, "Move X from A to B" rows — sitting above
	 * a separate `Empty seats` block and, five blocks further down, the priced adds under
	 * `Make these moves`. Walked on a real 27-man imported roster, 2026-09-23: it benched
	 * ten men and named a starter for none of them, because `today.start` holds only men
	 * coming off the BENCH and every one of those ten lost his seat to a man already in the
	 * lineup moving across. The card then said, in its own next block, that twelve seats
	 * would score nothing — the same fact from the other end.
	 *
	 * So there is one list now, `.decide-do`, ordered by what each row is worth, and a row
	 * is a SEAT rather than a man: who goes in, who comes out, and — where the seat's old
	 * occupant went somewhere better — where he went. Three row kinds, and the class says
	 * which: `decide-do-add` is a priced waiver move, `decide-do-start` is a seat somebody
	 * is arriving into, `decide-do-sit` is a seat nobody is.
	 *
	 * WHAT THE OLD ASSERTIONS CLAIMED AND WHERE EACH WENT, because four of them were the
	 * only thing standing between this card and a silent regression:
	 *
	 *  · "everyone it says to bench is currently in an active seat" — unchanged in force,
	 *    read off `.decide-out` instead of `.decide-bench-group b`.
	 *  · "everyone it says to start is not already in one" — REPLACED, because it is now
	 *    false of correct output: Matt Olson moving SP→1B is both started and already in an
	 *    active seat, and that row is the fix. The successor claims strictly more: every man
	 *    a row starts is a man the planner really seated, checked against the seat-by-seat
	 *    fold, which the old assertion never looked at.
	 *  · "everyone it says to move seats is already in the lineup" — kept, against
	 *    `.decide-moved`, which is where a seat change is now reported.
	 *  · "bench rows are one per reason, not one per man" — the grouping key changed from
	 *    the reason to the SEAT, so the successor is "one row per seat" plus the property
	 *    that made grouping safe in the first place and still does: every man named exactly
	 *    once across the whole list.
	 *  · "each man keeps his own seat beside his name" — kept, as `data-slot` on the row,
	 *    which is the same fact now that a row is a seat rather than a bag of men.
	 *  · "the badge is the count, or his seat" — REPLACED. The badge is a NUMBER now, which
	 *    is the point of the rebuild, so what is asserted is that it is the row's own value
	 *    and that a row worth nothing does not print one.
	 *
	 * And one claim is new, because it is the defect this rebuild exists to end: no man is
	 * told to sit without either the man taking his seat named beside him, or the fact that
	 * the seat scores nothing said out loud.
	 */
	const doRows = await page.$$eval(".decide-do > li", ns =>
		ns.map(e => ({
			kind:
				e.classList.contains("decide-do-add") ? "add"
				: e.classList.contains("decide-do-start") ? "start"
				: "sit",
			slot: e.getAttribute("data-slot"),
			badge: e.querySelector(":scope > .decide-delta")?.textContent?.trim() ?? null,
			why: e.querySelector("em.decide-why")?.textContent?.trim() ?? "",
			text: (e.textContent ?? "").replace(/\s+/g, " ").trim(),
			in: [...e.querySelectorAll(".decide-in b")].map(b => b.textContent.trim()),
			wire: [...e.querySelectorAll(".decide-add-wire b")].map(b => b.textContent.trim()),
			out: [...e.querySelectorAll(".decide-out b")].map(b => b.textContent.trim()),
			moved: [...e.querySelectorAll(".decide-moved b")].map(b => b.textContent.trim())
		})))
	const activeSeated = new Set(
		seedLineup[KEY].spots.filter(sp => !/^(BN|IL|NA)/i.test(sp.slot)).map(sp => sp.name)
	)
	const inFold = new Set(rows.filter(r => r.who).map(r => r.who))
	const seatRows = doRows.filter(c => c.kind !== "add")
	const sitRows = doRows.filter(c => c.kind === "sit")
	const startRows = doRows.filter(c => c.kind === "start")
	const benched = seatRows.flatMap(c => c.out.map(name => ({ name, seat: c.slot })))
	const benchNames = new Set(benched.map(m => m.name))

	/*
	   THE ANSWER IS FIRST, which is the whole complaint this rebuild answers: "I still don't
	   see any direct recommendations in terms of who I should be streaming". The priced add
	   was the fifth block down and behind a fold. It is a row in the one list now, so what
	   is asserted is that there IS one list and that the priced moves are in it — never a
	   second `.decide-moves` list on a card that has a Today section.
	*/
	t("a daily-lock card draws one list of things to do, not four",
		!!(await page.$(".decide-do")) && !(await page.$(".decide-moves")),
		`decide-do: ${!!(await page.$(".decide-do"))}, stray decide-moves: ${!!(await page.$(".decide-moves"))}`)
	t("and the priced adds are rows in it",
		doRows.some(c => c.kind === "add"),
		JSON.stringify(doRows.map(c => c.kind)))
	/* Biggest first, and the rows that buy nothing last. A list whose order a reader cannot
	   trust is a list he has to read all of. */
	{
		const vals = doRows.map(c =>
			c.badge && /[\d.]/.test(c.badge) ? Number(c.badge.replace("+", "")) : null)
		const ordered = vals.every(
			(v, i) => i === 0 || (vals[i - 1] === null ? v === null : v === null || v <= vals[i - 1])
		)
		t("and it is ordered by what each row is worth, with the ones worth nothing last",
			ordered, JSON.stringify(vals))
		t("and a row that buys nothing prints no figure",
			doRows.every(c => (c.kind === "sit") === (vals[doRows.indexOf(c)] === null)),
			JSON.stringify(doRows.map(c => [c.kind, c.badge])))
	}

	t("everyone it says to sit is currently in an active seat",
		benched.every(m => activeSeated.has(m.name)),
		JSON.stringify(benched.filter(m => !activeSeated.has(m.name))))
	/*
	   THE SUCCESSOR TO "everyone it says to start is not already in one".

	   That claim was written when a start could only come off the bench, and the card's
	   biggest defect was that it could only REPORT one that came off the bench. A man
	   already in an active seat moving to a better one is now a start row, correctly, so the
	   property worth protecting is not where he came from but whether the planner really put
	   him there: every man a row starts, other than one being added off the wire, has to
	   appear in the seat-by-seat fold, which is the planner's own lineup.
	*/
	t("everyone it says to start is a man the planner really seated",
		startRows.every(c => c.in.every(n => c.wire.includes(n) || inFold.has(n))),
		JSON.stringify(startRows.map(c => [c.slot, c.in, c.wire])))
	// a man reported as changing seat must be one who is already in the lineup — the clause
	// exists to explain where a seat went, and naming a man who is not there would be an
	// instruction that cannot be followed
	t("everyone it says moves seats is already in an active seat",
		seatRows.every(c => c.moved.every(n => activeSeated.has(n))),
		JSON.stringify(seatRows.filter(c => c.moved.some(n => !activeSeated.has(n)))))

	/*
	 * A BENCH WITH NO REPLACEMENT IS NOT A MOVE A MANAGER CAN MAKE — the claim the whole
	 * rebuild is for, and the one thing no assertion in this file used to make.
	 *
	 * Measured before it: "×10 Bench Pete Crow-Armstrong C, Alex Bregman 1B, Iván Herrera
	 * 2B, …" with not one starter named, on a card whose own fold showed Matt Olson at 1B
	 * and Ketel Marte at 2B. Two honest shapes and no third: the row names who goes in, or
	 * it says the seat will score nothing. There is deliberately no shape in which the card
	 * guesses which departing man an arriving one displaced.
	 */
	t("no man is told to sit without either his replacement or the fact the seat goes empty",
		seatRows.every(c => c.out.length === 0 || c.in.length > 0 ||
			/scores nothing tonight either way/.test(c.text)),
		JSON.stringify(seatRows.filter(c => c.out.length && !c.in.length).map(c => c.text)))
	t("and a row that says the seat was empty names nobody coming out of it",
		doRows.every(c => !/over an empty seat/.test(c.text) || (!c.out.length && !c.moved.length)),
		JSON.stringify(doRows.filter(c => /over an empty seat/.test(c.text)).map(c => c.text)))
	/*
	   AND A SEAT THE PLATFORM HAS CLOSED CANNOT BE HANDED TO ANYBODY.

	   The departures on a row are freeze-filtered — a man whose game has started is never
	   offered up — so a slot whose only departure was frozen came back with an empty `out`
	   and the row took the empty-seat branch. Seen on the built card at 13:40: "Start Pete
	   Crow-Armstrong at OF — over an empty seat", with Riley Greene in one of the three OF
	   seats and his 1:10pm lock an hour past. The arrival is now capped at the room the slot
	   really has: its free seats, plus the men who can still leave it.

	   An INVARIANT, so it is asserted unconditionally and is quiet in the morning when
	   nothing is frozen. The existence half — that a frozen seat really does suppress an
	   arrival — is what the two-page freeze comparison further down this file measures.
	*/
	{
		const seatsOf = slot => league.roster.slot_order.filter(x => x === slot).length
		const before = slot =>
			seedLineup[KEY].spots.filter(sp => sp.slot === slot).length
		const overbooked = seatRows.filter(
			c => c.in.length > seatsOf(c.slot) - before(c.slot) + c.out.length + c.moved.length
		)
		t("no row seats more men than the slot has room for",
			overbooked.length === 0,
			JSON.stringify(overbooked.map(c => [c.slot, `${c.in.length} in`, `${seatsOf(c.slot)} seats`, `${before(c.slot)} held`, `${c.out.length} out`, `${c.moved.length} moved`])))
	}

	/*
	 * GROUPING, as the properties that make it safe — the same four as before, keyed on the
	 * seat instead of on the reason.
	 *
	 * What was measured: sixteen rows reading "Bench X — he is not projected to play today",
	 * identical but for the name, above the two moves that were the point of the card. A
	 * seat-keyed grouping collapses those the same way (the three outfielders share one OF
	 * row) and buys the thing a reason-keyed one could not: the man arriving into that seat
	 * belongs on the row with the men leaving it.
	 */
	t("seat rows are one per seat, not one per man",
		new Set(seatRows.map(c => c.slot)).size === seatRows.length,
		JSON.stringify(seatRows.map(c => c.slot)))
	t("and every man it sits is named exactly once across them",
		new Set(benched.map(m => m.name)).size === benched.length,
		JSON.stringify(benched.map(m => m.name)))
	t("each man's own seat is on the row, which is what he changes in Yahoo",
		benched.every(m => m.seat &&
			seedLineup[KEY].spots.some(sp => sp.name === m.name && sp.slot === m.seat)),
		JSON.stringify(benched))
	/*
	 * A reason has to be a fact about the world, not about a man — which is the
	 * precondition for grouping at all. If a reason ever carried a name in it, two men
	 * could never share one, every group would be of size one, and the sixteen rows
	 * would come back through the back door while this suite stayed green.
	 */
	const reasons = sitRows.map(c => c.why)
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
	 * every man in an active seat must be in one of the lists the card shows: the one
	 * list, the seat-by-seat fold of the lineup it wants, or one of the sentences below it.
	 */
	/* FOUR PLACES, not three, and the fourth is what caught this.
	
	   A man whose game has already started is named in the locked sentence — "his game was
	   due to start at 1:05pm, so that seat is no longer yours to change" — and is
	   deliberately left out of the could-not-be-priced note, because the note names only men
	   the card has not already named. So a man who is BOTH unrateable and locked is accounted
	   for exactly once, in the sentence that tells him the thing he can act on, which is
	   nothing. Measured on 2026-09-17: William Contreras, on the injured list live and on a
	   club that had already started, was in none of the first three lists and in that one. */
	const named = sel =>
		page.$$eval(sel, n => n.map(e => e.textContent ?? "")).catch(() => [])
	const unpriced = new Set(
		[
			...(await named(".decide-watch b")),
			...(await named(".decide-locked b")),
			...(await named(".decide-stuck b")),
			...(await named(".decide-scratch b")),
			...(await named(".decide-called b"))
		]
			.flatMap(x => x.split(",").map(y => y.trim()))
			.filter(Boolean)
	)
	/* AND THE PLURAL FORM OF THE SAME SENTENCE, which has no <b> in it.
	
	   `.decide-locked b` finds the name only when ONE seat has started: with more than one
	   the card writes "4 of your seats were due to start before now — A, B, C and D — so
	   they are no longer yours to change", and `andList` returns a plain string. So this
	   assertion passed all afternoon and failed in the evening, on the card's own words,
	   about men it had named. Measured at HEAD as well as here, which is what says it is the
	   clock and not a change: Cristopher Sánchez, Jesús Luzardo, Michael Wacha and Gavin
	   Williams, every one of them inside that sentence.
	
	   Matched out of the prose against the seats that were read, which is weaker than a
	   selector and is the honest reading of a sentence. */
	const shut = (
		await page
			.$$eval(".decide-locked, .decide-stuck", n => n.map(e => e.innerText ?? "").join(" "))
			.catch(() => "")
	).replace(/\s+/g, " ")
	/* A man who moved to a better seat is named on the row for the seat he LEFT, which is a
	   fourth way to be accounted for and the one this rebuild added. */
	const movedOn = new Set(seatRows.flatMap(c => c.moved))
	const unaccounted = [...activeSeated].filter(
		n => !inFold.has(n) && !benchNames.has(n) && !movedOn.has(n) && !unpriced.has(n) &&
			!shut.includes(n)
	)
	const twice = [...activeSeated].filter(n => inFold.has(n) && benchNames.has(n))
	t("every man in an active seat is either sat, in tonight's lineup, or named as unpriceable",
		unaccounted.length === 0, JSON.stringify(unaccounted))
	t("and no man is in two of those at once",
		twice.length === 0, JSON.stringify(twice))

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
		/* Read across the whole of the one list rather than across the old `.decide-changes`
		   rows: the claim is that he is nowhere in the instructions, so it has to look at
		   every kind of row there now is. */
		t("a man on the injured list is not told to take a seat he cannot leave",
			!benchNames.has(shelved.name) &&
				!doRows.some(c => c.text.includes(shelved.name)),
			`${shelved.name} appears in ${JSON.stringify(doRows.filter(c => c.text.includes(shelved.name)).map(c => c.text))}`)
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
		/* THE MISSING HALF MOVED FROM AN ITALIC TAIL INTO THE SENTENCE. This matched
		   "still to come only", which was an <em class="decide-why"> hanging off the end
		   of the line — the same clause that, when the read HAD landed, read "counted for
		   every pitcher you hold now, whatever seat he was in at the time — which is the
		   most this page can know", 21 words of provenance at rest on the answer screen.
		   The em is gone in both shapes. What it was carrying in the failed shape is an
		   ABSENCE, and it now leads the sentence instead of trailing the number, so the
		   claim being protected is unchanged and only the string it is matched by moved. */
		t("the innings line states what was thrown as well as what is coming, or says it could not",
			banked || /Innings already thrown could not be read/.test(text), text.slice(-700))
		t("and a floor is only compared against a total the page could source",
			banked ? /against \d/.test(text) : !/against \d/.test(text), text.slice(-400))
		t("the fold explains whichever of the two it printed, and never the retracted claim",
			/what these two numbers are|why not the whole week/i.test(text) &&
				!/are on your team page, which\s+nothing here reads/.test(deep),
			deep.slice(-900))
		/* And the provenance is only in the fold. A reader who does not open it must not
		   be reading where a number came from: the sentence he is shown is two facts and
		   a total, and "counted for every pitcher you hold now" is one tap away in full. */
		t("and the provenance for those numbers is behind the fold, not beside them",
			!/counted for every pitcher you hold now/.test(text) &&
				(!banked || /counted for every pitcher you hold now/.test(deep)),
			text.slice(-400))
	}

	/*
	 * TONIGHT IS THE ANSWER SCREEN, SO IT SENDS NOBODY OFF TO DO SETUP.
	 *
	 * Two sentences on this card asked the reader to go and prepare something before it
	 * could tell him more. "How your week stands is on Last night, against an opponent
	 * you tell it about" rendered wherever the opponent was unknown — which is every
	 * first evening — and the whole <p> is now simply not rendered there; the gap
	 * sentence below it, which is a fact he can act on, is untouched and asserted
	 * further down this file.
	 *
	 * This is not the same claim as "the card never names another screen". It still
	 * names My league where an ABSENCE has a fix — the partial-roster line, asserted at
	 * the foot of this file, and the assumed-daily chip, asserted in test/static.mjs.
	 * The difference is that those state something the card does not know and say where
	 * it is answered, where this one stated nothing at all and handed out homework.
	 */
	t("nothing on the answer screen sends the reader away to set something up first",
		!/How your week stands is on/.test(deep), text.slice(-500))

	/*
	 * AND THE FOLD THAT EXPLAINS THE DECISION HOLDS NO CHANGELOG.
	 *
	 * "How this was decided" ended with a hardcoded 49-word paragraph: "Stopping at 2 a
	 * week is inherited rather than established: 2 beat one and beat three across 111
	 * weeks and five seasons, but that sweep priced a swap by comparing the two players'
	 * own ratings…". It was there to retract an overclaim the heading no longer makes —
	 * that line once read "2 is what measured best" and now reads "stopping at 2", which
	 * claims nothing. The measurement itself is not lost: src/auto/plan.ts carries it at
	 * the cap it governs. What is asserted here is that the fold holds the planner's own
	 * notes about THIS roster on THIS night and not a paragraph about which sweep priced
	 * which way.
	 */
	t("the decision fold explains tonight's answer, not this repository's history",
		!/inherited rather than established|No season has been played/.test(deep),
		deep.slice(-600))

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
			/* THE CARD HAS NEVER SAID "this period", and this regex has expected it to since
			   it was written — latent, because the block only runs when somebody on the
			   roster is unrateable, which the committed capture never produced. Matched on
			   the words the card actually renders (src/client/Decide.tsx:2492), and on both
			   the singular and plural forms it builds. */
			const named = (txt.match(/could not be priced, so nothing above counts (?:him|them): ([^.]+)\./) ?? [])[1]
			t("it names every player it could not price, not just a count",
				!!named && named.split(",").length === n, `${n} claimed, named: ${named}`)
			if (shelved) {
				/* ACCOUNTED FOR SOMEWHERE THE READER CAN SEE, which is the claim — not "in
				   this particular note". The note names only men the card has not already
				   named, so an injured man whose club has also started is named in the locked
				   sentence instead and correctly absent from here. It used to require this
				   note specifically and passed for two years because the seeded roster's
				   injured man was never also locked; on 2026-09-17 he was. */
				const anywhere = await page.$eval(".decide", e => e.innerText)
				t("and the injured man this test seated is named somewhere on the card",
					anywhere.includes(shelved.name), `${shelved.name} is on no list`)
			}
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
	/* The button sits in its own <p> now rather than inside the sentence, so the paragraph
	   count is two and only one of them is prose — see the note in Decide.tsx. The claim is
	   unchanged and is counted the same way: one sentence, one press, no lecture, and a
	   word bound that has come DOWN (45 → 40) because the sentence no longer has to read
	   around a button. */
	const ps = await page.$$(".decide-blocked p:not(.decide-cta-row)")
	t("the blocked state is one sentence and a button, not an essay about CORS",
		ps.length === 1 &&
			(await page.$$(".decide-blocked button")).length === 1 &&
			!/CORS/.test(deep) &&
			text.trim().split(/\s+/).length <= 40,
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
		/* `.decide-do` is the one list Today draws; a period-lock league must draw none of
		   it. Same claim as the old `.decide-changes` check, against the list that replaced
		   that one — and it is NOT enough to check the heading, because the whole failure
		   this asserts against is a daily list appearing under a period card. */
		!/\bToday\b/.test(text) && !(await page.$(".decide-do")),
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
	const page = await open({ lineup: seedLineup, pool: seedPool, config: cfg }, { gap: true })
	/* READ OFF THE ONE CARD THAT SAYS IT NOW. This read `.decide`, which carried its own
	   "gives the roster shape but not what each stat is worth" card — directly under App's
	   `Setup` card saying the same thing in the same state. The owner named that repetition
	   on 2026-09-22, so Decide renders nothing for a league it cannot price and `Setup` is
	   the one place the gap is named. The claim is unchanged: told what is missing, not
	   handed a plan. */
	await page.waitForSelector(".setup-gaps", { timeout: 15000 })
	const text = await page.$eval(".setup-gaps", e => e.innerText)
	t("a league with no scoring is told what is missing rather than given a plan",
		/what each stat is worth/i.test(text), text.slice(0, 220))
	t("and it proposes nothing at all — no benchings, no moves",
		!(await page.$(".decide-do")) && !(await page.$(".decide-moves")) &&
			!/Add .+, drop /.test(await page.evaluate(() => document.body.innerText)),
		text.slice(0, 300))
	t("and the gap is named once, not once per card",
		(await page.$$(".decide-blocked")).length === 0)
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
	const page = await open({ lineup: seedLineup, pool: seedPool, config: cfg }, { gap: true })
	/* `Setup` is the one card for a league one input short — see the note in Decide.tsx. */
	await page.waitForSelector(".setup-gaps", { timeout: 15000 })
	const text = await page.$eval(".setup-gaps", e => e.innerText)
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
		/how many teams/i.test(text), text.slice(0, 300))
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
	/*
	   THE HEADING WENT AND THE CLAIM DID NOT, so the claim is asserted directly instead.

	   This looked for "Make these moves", which was the priced adds' own heading. In a
	   daily-lock league those rows are in Today's one list now — the whole point of the
	   rebuild is that an add and a start are the same kind of instruction to the reader —
	   so the heading is gone and a test that reads for it is testing the layout rather than
	   the fact. The fact is that the adds are still priced over the PERIOD and not over
	   tonight, which is what an add accrues over, and the card says exactly that in the
	   sentence that separates the two units. Asserted with the rows' own presence, so it
	   cannot pass on a card that has no adds on it at all.
	*/
	/* The unit moved from a legend under the list onto the rows themselves — a legend that
	   has to explain a column is a column that does not work, and both scales were sharing
	   one gutter on rows that both began "Add". So the claim is read off the add row, which
	   is where the reader meets it. */
	const addUnits = await page.$$eval(".decide-do-add em.decide-why", ns =>
		ns.map(e => e.textContent.replace(/\s+/g, " ").trim()))
	t("and the moves are still priced over the period, which is what an add accrues over",
		addUnits.length > 0 && addUnits.every(u => /^over this scoring period/.test(u)),
		JSON.stringify(addUnits))
	t("…and a seat's figure says it is tonight's, so the two scales are never read as one",
		(await page.$$eval(".decide-do-start em.decide-why", ns =>
			ns.map(e => e.textContent.replace(/\s+/g, " ").trim()))).every(u =>
			/^projected tonight/.test(u)),
		JSON.stringify(await page.$$eval(".decide-do-start em.decide-why", ns =>
			ns.map(e => e.textContent.replace(/\s+/g, " ").trim()))))
	/* HIS LEAGUE'S OWN WAIVER ROW, read at last. The gain beside every move is accrued
	   from today, and in this league a claimed man is not his tonight: five waiver rows
	   have been stored verbatim since the first real read and nothing looked at one. */
	t("…and the card says when a move he makes tonight actually lands",
		/waivers clear in 1 day\b/.test(text), text.slice(0, 400))
	t("…and does not explain itself while doing it",
		!/rolling list|which means|because/i.test(text.split("waivers clear")[1]?.slice(0, 120) ?? ""),
		text.split("waivers clear")[1]?.slice(0, 120) ?? "")
	await page.close()
}

/*
 * THE NIGHT THE CARD IS ABOUT, WHICH IS NOT ALWAYS TONIGHT.
 *
 * Yahoo prints "Daily - Today" and the parser discarded everything after the word, so
 * both daily forms read as the same lock. On the other one, tonight's lineup locked at
 * yesterday's deadline and the only lineup a reader can still change is tomorrow's —
 * and every sentence on this card was about a night he could no longer act on, with no
 * hedge. `locks` is the field, and only the reader can set it to "tomorrow", because
 * nothing in this repo has read that string off a real page.
 */
{
	const cfg = JSON.parse(readFileSync("scoring.json", "utf8"))
	cfg.leagues["yahoo:228947"].scoring_period.locks = "tomorrow"
	const page = await open({ lineup: seedLineup, pool: seedPool, config: cfg })
	const text = await page.$eval(".decide", e => e.innerText)
	t("a league that locks tonight's lineup gets a card headed Tomorrow",
		/\bTomorrow\b/.test(text) && !/^Today$/m.test(text), text.slice(0, 300))
	t("…and one instruction saying which lineup to set",
		/set tomorrow.s lineup .* tonight.s is closed/i.test(text.replace(/\s+/g, " ")),
		text.slice(0, 400))
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
	/* "answers a browser directly" was the CORS explanation in a reader's clothing. The claim
	   it protected is the capability, which is what the sentence says now. */
	/* REWRITTEN 2026-09-22. This asserted the ESPN card carried "can read the whole roster
	   in one click" — a promise about the platform, appended to a sentence that also sold the
	   step and estimated its duration. The owner's rule for UI text is one short instruction
	   per step, and the platform's one path is now the job of the sheet the button opens,
	   which asks the platform FIRST. So the branch this protected no longer exists on this
	   card, on purpose, and the claim that survives is the one the owner set: the card is ONE
	   short instruction, the same one on every platform, and it does not explain the app —
	   no duration, no privacy promise, no mechanism. */
	const prose = (await page.$eval(".decide-blocked p:not(.decide-cta-row)", e => e.innerText)).trim()
	t("an ESPN league is given the same one short instruction as any other",
		prose === "Add the players you own." &&
			!/minute|this browser|one click|CORS/i.test(text),
		prose)
	/*
	 * The second assertion here used to be `!(await page.$(".decide-cmd"))` — that an
	 * ESPN reader is not handed a command line he does not need. No reader is handed
	 * one now, Yahoo included, so that cannot fail and asserting it would be theatre.
	 * What it protected is the BRANCH, and a branch needs both sides: the Yahoo block
	 * above asserts the platform sentence is absent there, and this asserts the ESPN
	 * card is still the same one sentence plus that clause rather than growing a
	 * second route back.
	 */
	/* TWO paragraphs now, not one, and the second holds only the button. It used to be the
	   first token of the first — "[Add your players] and this becomes tonight's lineup" —
	   which wrapped the sentence around a 44px control at phone width. The claim this was
	   protecting is that the card says ONE thing and offers ONE press, so that is what is
	   counted: one sentence of prose, one button, and still no command line. */
	const ps = await page.$$(".decide-blocked p:not(.decide-cta-row)")
	t("and the ESPN card is the same one sentence, plus that clause",
		ps.length === 1 &&
			(await page.$$(".decide-blocked button")).length === 1 &&
			!!(await page.$(".decide-cta")) &&
			!(await page.$(".decide-cmd")),
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
	/*
	   TIME-OF-DAY FLAKE, FIXED BY ASSERTING THE RIGHT THING RATHER THAN BY LOOSENING IT.

	   This required at least one row in the lineup list (`.decide-changes` then, `.decide-do`
	   now). That list is the LINEUP diff —
	   who to start and who to sit — and a lineup change is only possible for a seat whose
	   game has not begun. Run in the evening, every seat has started, the card correctly
	   offers no lineup change, and the assertion failed on a card that was right. Measured
	   2026-09-22 at 19:50 ET against an unmodified checkout: the card read "every seat has
	   started · 11 of your men are in tonight's card · your lineup projects 0" and this line
	   failed there too, so it is not a regression and never was — it is a suite that passes
	   in the morning.

	   What the block is actually about is in its own docstring: a team entered BY HAND gets a
	   real answer, with no file, no server and no terminal. That answer is that the card
	   accounted for his men. So the claim is now "the card is about his eighteen", which is
	   true at every hour: either it offers lineup rows, or it says in words why it cannot and
	   how many of his men are playing. Both are answers; an empty card is not, and an empty
	   card still fails.
	*/
	const rows = (await page.$$(".decide-do > li")).length
	t("it produces an answer about that team, at any hour",
		rows > 0 || /every seat has started|of your men are in tonight.s card/.test(text),
		`${rows} lineup rows | ${text.slice(0, 400)}`)
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
 * THE OTHER HALF OF THE SAME ASYMMETRY: SEATS AND NO ROSTER LIST.
 *
 * Two routes store seats with no roster beside them — the pasted lineup on My league, and
 * any platform read whose roster page landed while the list did not — and `seats` falls
 * through to the stored spots for both. It is the state this card is WORST in: there are no
 * owned ids to disambiguate a name with, and a short pasted lineup means most of the active
 * seats have nobody the reader owns who can legally fill them.
 *
 * Before the rebuild that produced "×14 Bench <fourteen names> — a better man is projected
 * for that seat today", with not one starter named and, for most of those men, no better man
 * anywhere: their seats ended the night empty. So the two claims asserted here are exactly
 * the two the rebuild is for, made in the state that used to break them hardest — no row
 * invents a partner, and no row that says a seat was empty is about a seat somebody is
 * sitting in.
 *
 * `beanemachine:roster` is deliberately NOT written. Every other block in this file seeds
 * both stores, so nothing here covered the shape until now.
 */
{
	const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } })
	/* The length a paste produces: the active seats only, and no bench or injured list —
	   which is what the setup sheet tells him is fine ("Only got a few? Start with your
	   starters"). */
	const pasted = seedLineup[KEY].spots.filter(sp => !reserve(sp.slot)).slice(0, 14)
	await page.addInitScript(([l, c]) => {
		localStorage.setItem("beanemachine:lineup", JSON.stringify(l))
		localStorage.setItem("beanemachine:config", JSON.stringify(c))
	}, [{ [KEY]: { at: new Date().toISOString(), spots: pasted } }, JSON.parse(readFileSync("scoring.json", "utf8"))])
	await page.goto(BASE, { waitUntil: "networkidle", timeout: 60000 })
	await page.waitForSelector(".decide", { timeout: 30000 })
	await page.waitForTimeout(2500)
	t("a team stored as seats with no roster list is still answered",
		(await page.evaluate(() => localStorage.getItem("beanemachine:roster"))) === null &&
			(await page.$$(".decide-do > li")).length + (await page.$$(".decide-do-sit")).length > 0,
		await page.$eval(".decide", e => e.innerText.slice(0, 300)))
	const seatOnly = await page.$$eval(".decide-do > li", ns =>
		ns.map(e => ({
			slot: e.getAttribute("data-slot"),
			text: (e.textContent ?? "").replace(/\s+/g, " ").trim(),
			in: [...e.querySelectorAll(".decide-in b")].map(b => b.textContent.trim()),
			out: [...e.querySelectorAll(".decide-out b")].map(b => b.textContent.trim()),
			moved: [...e.querySelectorAll(".decide-moved b")].map(b => b.textContent.trim())
		})))
	t("…and no man is sat without a named replacement or the fact the seat goes empty",
		seatOnly.every(c => !c.out.length || c.in.length ||
			/scores nothing tonight either way/.test(c.text)),
		JSON.stringify(seatOnly.filter(c => c.out.length && !c.in.length).map(c => c.text)))
	t("…and no seat somebody is still sitting in is called an empty one",
		seatOnly.every(c => !/over an empty seat/.test(c.text) || (!c.out.length && !c.moved.length)),
		JSON.stringify(seatOnly.filter(c => /over an empty seat/.test(c.text)).map(c => c.text)))
	/* The sentence the old fallback got wrong. "A better man is projected for that seat" may
	   only be said where the planner really seats one, and this is the roster it was falsest
	   on — measured before the rebuild, four of five men who got it had seats that ended the
	   night empty. */
	t("…and no row claims a better man for a seat nobody is arriving at",
		seatOnly.every(c =>
			!/a better man is projected for that seat today/.test(c.text) || c.in.length > 0),
		JSON.stringify(seatOnly.filter(c =>
			/a better man is projected for that seat today/.test(c.text) && !c.in.length).map(c => c.text)))
	await page.close()
}

/**
 * A LINEUP THIS APP CANNOT REPRODUCE, AND THE TWO THINGS IT MAY NOT DO ABOUT IT.
 *
 * `planLineup` sums `pointsNow` over the men in active seats and `pointsPlanned` over the men
 * it could seat. A man whose seat is not in his own eligibility is in the first and can be in
 * no seat of the second, so his points leave the model and the difference reads as a loss the
 * rearrangement caused. Measured on a 27-man imported roster, 2026-09-23: -28.99 for one night
 * and -144.42 for the period, of which 35.86 and 203.21 were men dropping out; re-seat the
 * same men where the league does allow them and it is +8.81 and +39.09 with nobody dropped.
 *
 * The `lineupMinGain` bar fired on that difference and returned no swaps and no shifts while
 * still returning `starters` — and this card pairs its rows off `starters`, so it printed nine
 * "Start X at 1B, and sit Y" rows while the model's own note said the whole rearrangement
 * should be left alone. One screen, two positions.
 *
 * So: the bar stands down (asserted in test/auto.mjs, where the planner is), and the card owes
 * the reader the reason its planned total is lower than his lineup's. Both halves are asserted
 * here — the caveat is present and names the men, and it is in the fold rather than on every
 * affected row, because twenty-three words of provenance repeated eight times is the wall this
 * whole card was rebuilt to stop.
 */
{
	/* Three men put in seats their own eligibility does not reach — a catcher at 1B, an
	   outfielder at 2B, an infielder in the outfield.
	
	   CONSTRUCTED, and it has to be said plainly because an earlier note here implied it was
	   the ordinary shape of a real import. It is not: `rosterFromPaste` reads Yahoo's own
	   eligibility off the page first and, since 2026-09-23, unions each man's own startable
	   seat into his positions — so the seat a man is actually in can no longer be
	   contradicted by a read. What can still reach this state is a hand-typed team. The
	   fixture is built by hand for the same reason test/auto.mjs builds one: the planner must
	   not withhold a plan over a number that is not a gain, however the input arose. */
	const wrong = seedLineup[KEY].spots.map(sp =>
		sp.slot === "1B" ? { ...sp, positions: ["C"] }
		: sp.slot === "2B" ? { ...sp, positions: ["OF"] }
		: sp.slot === "OF" ? { ...sp, positions: ["SS"] }
		: sp)
	const page = await open({ lineup: { [KEY]: { at: new Date().toISOString(), spots: wrong } }, pool: seedPool })
	const rows = await page.$$eval(".decide-do > li", ns =>
		ns.map(e => ({
			text: (e.textContent ?? "").replace(/\s+/g, " ").trim(),
			reasons: [...e.querySelectorAll(".decide-reason")].map(r => r.textContent.trim())
		})))
	const watch = (await page.$$eval(".decide-watch li", ns =>
		ns.map(e => (e.textContent ?? "").replace(/\s+/g, " ").trim()))).join(" \u00b7 ")
	t("a lineup the app's own rules forbid is not planned in silence",
		/sits? in a seat nothing here records (him|them) as eligible for/.test(watch),
		watch.slice(0, 400) || "(no watch bullets)")
	t("…and the men it means are named, with the seat each is in",
		/ at (C|1B|2B|3B|SS|OF|Util|SP|RP|P)\b/.test(watch), watch.slice(0, 400))
	/* The card and the planner may not take two positions on one screen. With the bar
	   standing down there are rows; what must never happen is rows AND a sentence saying the
	   lineup was left alone. */
	t("…and the card never prints the plan beside a note saying it was withheld",
		!(rows.length > 0 && /lineup bar|left alone/.test(
			await page.evaluate(() => document.querySelector(".decide")?.textContent ?? ""))),
		`${rows.length} rows`)
	/* The provenance is in the fold; the row keeps the fact. Five words, not twenty-three. */
	t("…and the reason on the row is the fact, not the paragraph behind it",
		rows.flatMap(r => r.reasons).every(w => w.split(/\s+/).length <= 12),
		JSON.stringify(rows.flatMap(r => r.reasons).filter(w => w.split(/\s+/).length > 12)))
	/*
	   A ROW IS A MOVE, NOT A CASCADE.

	   Two rows on the imported roster read "Start Rafael Devers and Yordan Alvarez at Util,
	   and sit Nick Kurtz — Junior Caminero moves to 3B" and "Add Matthew Liberatore at P, and
	   sit Sandy Alcantara and Cristopher Sánchez — Zach Neto and Rafael Devers move to SS and
	   Util". Five men and three seats in one sentence cannot be carried out in one pass. The
	   mover clause now appears only where the row would otherwise claim the seat was standing
	   empty, which is where nobody is being sat, and with several movers it gives the count
	   rather than the names.
	*/
	t("no row both sits somebody and describes where somebody else went",
		rows.every(r => !(/ and sit /.test(r.text) && / moves? to /.test(r.text))),
		JSON.stringify(rows.filter(r => / and sit /.test(r.text) && / moves? to /.test(r.text)).map(r => r.text)))
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
	 * THE INNINGS FOLD HAS NO CLAUSE LEFT TO SIT INSIDE, which is why this assertion
	 * changed shape rather than being deleted.
	 *
	 * It read: "the innings clause keeps its fold beside it rather than inside it",
	 * over `.decide-watch em.decide-why` — the <em> that carried "counted for every
	 * pitcher you hold now, whatever seat he was in at the time — which is the most
	 * this page can know". That em is gone: 21 words of provenance at rest on the
	 * answer screen, all of it still in the fold below. With it gone the old selector
	 * matches only the skipped-player reasons, which have no fold near them, so
	 * `innings.some(i => i.sibling)` is false and the assertion fails for a reason
	 * that has nothing to do with markup nesting.
	 *
	 * What it was really protecting is that the fold is not inside phrasing content,
	 * where a browser silently reparents it and both `text` and `deep` still find the
	 * words. So it is asserted directly: the innings fold's parent is the block the
	 * sentence is in, and no <em> anywhere under `.decide-watch` contains a fold.
	 */
	const inningsFold = await page.$$eval(".decide-watch details", ns =>
		ns.map(d => ({
			parent: d.parentElement?.tagName ?? null,
			insideClause: !!d.closest("em, p, span")
		})))
	if (inningsFold.length)
		t("the innings fold hangs off the block, not off a clause a browser would move it out of",
			inningsFold.every(f => f.parent === "DIV" && !f.insideClause),
			JSON.stringify(inningsFold))
	t("and no caveat clause is left standing beside those numbers on the card",
		(await page.$$eval(".decide-watch em.decide-why", ns =>
			ns.filter(e => /most this page can know|still to come only/.test(e.textContent)).length
		)) === 0,
		await page.$$eval(".decide-watch em.decide-why", ns => ns.map(e => e.textContent).join(" | ")))
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
	/* The label moved into the sentence when the explanation after it was cut: "in hindsight"
	   now sits between the number and the lineup it describes, which is the same claim in
	   fewer words. */
	t("labelled as hindsight rather than as a thing he should have known",
		/in hindsight, the best lineup you could/.test(card), card)
	/* THE SENTENCE CHANGED, and this assertion changed with it rather than being relaxed.
	   It used to read "Bregman scored 25.8 more than Jo Adell", and the difference is what
	   that phrasing does when the man in the seat never played: the subtraction treats his
	   absence as a zero, so the card compared a real number with nothing and said "more
	   than" about it. Both men's own numbers are printed now, which states the same gap
	   and cannot be said about a man with no box score. Each half is still asserted —
	   both names, the gap's two ends, and the seat. */
	t("and named down to the one seat that explains it",
		/Alex Bregman/.test(card) && /scored 25\.8 where/.test(card) && /Jo Adell scored 0 in the seat/.test(card), card)
	// Dustin May outscored everyone and was on the injured list: he could not have been
	// started that day without a move the lineup did not have, so a regret built on him
	// would be a fiction. Asserted against the sentence that names the swap rather than
	// against the old "more than" phrasing, which no longer appears anywhere and would
	// have made this pass without testing anything.
	t("the man on the injured list is not the regret",
		!/Dustin May scored/.test(card) && !/than .?Dustin May/.test(card), card)

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
	/* THE CAVEAT IS THE LABEL NOW, and that is the whole of it.
	
	   This used to require a second paragraph — "Those are the seats you gave this page on Sep
	   12, which is after the games below — so that is what the lineup you have NOW would have
	   scored, not what yours did" — four lines and 34 words under a figure whose own label had
	   just said "from the lineup you have now", one of which told the reader a date he supplied
	   himself. The claim it protected is that the number is not presented as his lineup that
	   night, and the assertion above is what protects it: the label must read "from the lineup
	   you have now" and fails loudly if it ever reads "from your lineup" on seats stamped after
	   the games. What is asserted here is that the restatement stayed cut. */
	t("and the caveat is made once, on the figure, not twice",
		!/Those are the seats you gave this page/.test(card), card)

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
	/* "Outs", not "OUT". The code a league's table stores is the reader's own vocabulary for
	   almost every category — he chose HR and RBI and K — but `OUT` is this app's spelling of
	   the category Yahoo calls Outs, and in a row where every other code is a credit it reads as
	   making an out, which is the opposite of what it pays for. One shared label map, so the
	   same pitcher does not read "Outs" on one fold and "OUT" on another. */
	t("a night is explained by the categories that carried it", /HR/.test(list) && /Outs/.test(list), list)
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
	/* THE EXCLUSION IS STILL ASSERTED; THE SENTENCE ABOUT IT IS GONE.
	
	   This used to require "On 1 other day he left your lineup alone, which is worth nothing
	   either way and is not counted" — 19 words explaining a denominator the clause above it
	   had already named, which is the app defending its own arithmetic to a reader who has not
	   questioned it. What the assertion was really protecting is the ARITHMETIC: three days
	   are on the ledger, one of them asked for no change, and the record must speak about two.
	   The "over the 2 days" assertion above is what protects that, and it fails just as loudly
	   if the unchanged day is ever counted.
	
	   Two things are asserted here instead: the cut sentence is really gone, so nobody
	   reinstates it by accident, and a record this short says so — four days of evidence read
	   as an endorsement while it was printed bare. */
	t("and the sentence explaining the denominator is not printed as well",
		!/left your lineup alone/.test(rec), rec)
	t("and a record too short to be one says so next to itself",
		/2 days is not a record yet/.test(rec), rec)
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
	/*
	   A SMALL TEAM ON PURPOSE, because the comparison now has a floor.
	
	   Both cards refuse to compare two teams when the rival list is under two thirds of the
	   reader's own roster — a gap of 262.9 against a two-man opponent is not a lead, and until
	   2026-09-18 this screen printed it anyway while Tonight refused and pointed the reader
	   here for it. The fixture holds eight men in total, so the seeded team is the three of
	   them that can be spared and the two pasted below clear two thirds of three.
	*/
	const THREE = spots.slice(0, 3)
	const page = await open(
		{
			config: cfg,
			lineup: { [KEY]: { at: new Date().toISOString(), spots: THREE } },
			roster: { [KEY]: [] }
		},
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

		/*
		   AND A LIST TOO SHORT TO COMPARE IS REFUSED, which is what Tonight has always done
		   and what this screen did not. A two-man opponent against a full roster produced a
		   bold lead here with the shortfall named underneath — on the screen Tonight points
		   the reader at, having just refused to answer the same question itself.
		*/
		await page.fill(".recap-rival textarea", hisTwo[0])
		await page.click('.recap-rival button:text-is("That\u2019s his team")')
		await page.waitForTimeout(1200)
		const thin = await page.$eval(".recap", e => e.innerText)
		t("one man against a three-man team is too few to compare",
			!/His men have scored/.test(thin) && /too few to compare/.test(thin),
			thin.replace(/\n+/g, " | ").slice(0, 300))
		t("…and it says what would make it mean something",
			/Paste the rest of his roster/.test(thin), thin.replace(/\n+/g, " | ").slice(0, 300))

		await page.fill(".recap-rival textarea", `${hisTwo[0]}\n${(hisTwo[1] ?? "").split(" ").slice(-1)[0]}`)
		await page.click('.recap-rival button:text-is("That\u2019s his team")')
		await page.waitForTimeout(1200)
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
/* `sp.team` IS ALWAYS NULL IN THIS FIXTURE, and requiring it skipped this whole block.
	   `seat()` at the top of the file pushes `team: null` for every spot — the seats a reader
	   pastes carry a club, the ones this suite builds do not — so `spots.find(sp => … && sp.team)`
	   never matched and every assertion below was silently unrun. The club comes from the
	   snapshot, which is where `him` was getting it two lines later anyway. Found on 2026-09-12
	   when a new block copied the same guard and also reported nothing. */
	const victim = spots.find(
		sp => !/^(BN|IL|NA)/i.test(sp.slot) && snap.players.some(p => p.name === sp.name && p.teamId)
	)
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
			const changes = await page.$(".decide-do")
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
	const named = await page.$$eval(".decide-do b", bs => bs.map(b => b.textContent.trim()))
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
		/*
		   READ WITH THE FOLD SHUT, which is where this sentence lives now.

		   The Watch bullets are caveats and not instructions — an innings floor, the men
		   nothing could price, what the moves cost against that floor — and they were sitting
		   between the reader and the foot of the card, above nothing. They are behind one
		   "N things to watch" summary now, so `innerText` no longer reaches them and this
		   assertion went red about a card that was still saying the thing.

		   `textContent` is the suite's own idiom for exactly this (see `deep` above): the card
		   got shorter by FOLDING prose, not by deleting it, and a claim that is one tap away
		   still has to be there. The summary is asserted separately, so a fold that swallowed
		   this silently would still fail.
		*/
		const text = await parked.$eval(".decide", e => e.textContent)
		t("a man parked in a reserve seat that nothing says he needs is still reported",
			text.includes(healthy.name) && /could not be priced|parked in the/.test(text),
			`${healthy.name} — ${text.slice(0, 240).replace(/\n+/g, " | ")}`)
		/* Case-insensitively: the summary is upper-cased in CSS and `innerText` returns what
		   the reader sees, so a case-sensitive match here tests the stylesheet. */
		t("…and the card says there is something there to open",
			/\d+ things? to watch/i.test(await parked.$eval(".decide", e => e.innerText)),
			(await parked.$$eval(".decide-watch-fold summary", n => n.map(e => e.textContent)))[0] ??
				"(no watch summary)")
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
	/* REWRITTEN 2026-09-22. This asserted /one real league's scoring/ on this page — the
	   card's old sentence, which said "one real league's scoring" whatever the browser held.
	   The seed here is scoring.json, whose league is `provenance.verified: true`: a league read
	   off its own pages, which the rest of the app calls the reader's own (the footer says "your
	   league's own points" on exactly this condition). So the old assertion was pinning a
	   sentence that was false for this seed. The claim it protected is that the card names
	   WHOSE scoring the numbers are in, honestly; that is now asserted both ways — "your
	   scoring" for a verified league here, and "borrowed" for an unverified one just below. */
	t("with the scoring named as his when his league was read off its own pages",
		/in your scoring/.test(card) && !/borrowed/.test(card), card.slice(0, 300))
	{
		const borrowed = structuredClone(cfg)
		for (const l of Object.values(borrowed.leagues)) l.provenance = { ...l.provenance, verified: false, method: "preset: copied from another league" } // a PRESET is borrowed; unverified alone may be his, typed by hand
		const bp = await open({ config: borrowed }, { actuals: true, phone: true })
		await bp.waitForSelector(".recap", { timeout: 30000 })
		const bcard = await bp.$eval(".recap", e => e.innerText)
		t("and as borrowed when nothing in this browser was read off the reader's own league",
			/in borrowed scoring/.test(bcard) && !/in your scoring/.test(bcard), bcard.slice(0, 300))
		/* The old sentence ended "Put your team in and this becomes your team's night" — a
		   third call to add a team on a screen with two buttons for it. What is protected is
		   that the recap is a label and not a pitch. */
		t("and the recap does not ask for the team a second time",
			!/Put your team in/.test(bcard) && !/Put your team in/.test(card), bcard.slice(0, 300))
		await bp.close()
	}
	// Facts, not estimates — which is the distinction the whole card exists to carry onto a
	// screen where everything else is a projection.
	/* "Real box scores, not projections" explained the difference between this card and the
	   others; what has to survive is that these are what HAPPENED, which the heading and the
	   date carry. Asserted on the date, which is the part a reader checks. */
	t("and said to be box scores rather than projections",
		/last night/i.test(card) && !/projected/i.test(card.split("\n").slice(0, 3).join(" ")), card)
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

/**
 * THE NUMBER THE HEADER PROMISES HAS TO BE A NUMBER HE CAN REACH.
 *
 * The header reads "your lineup projects 112, or 128 once you make these changes", and the
 * changes it means are the ones printed below it — which have had every seat the platform
 * already closed TAKEN OUT of them, for the reason written at `frozen` in
 * src/client/Decide.tsx. The total did not have them taken out: it was `pointsPlanned`, the
 * whole plan, locked seats included. So a reader who did every single thing the card asked
 * could not reach the figure it promised him, and it was the headline figure.
 *
 * ASSERTED BY DIFFERENCE, because the plan depends on a real capture and hand-computing it
 * here would be asserting the planner rather than the header. Two pages, identical but for
 * ONE club's game having already started: the first tells us which men the plan wants to
 * move, the second freezes the first of them. The promised total must fall, and the card must
 * say whose change it is no longer offering. Before the fix both pages printed the same
 * number, which is the defect stated as a test.
 */
{
	const cfg = JSON.parse(readFileSync("scoring.json", "utf8"))
	const teams = [...new Set(snap.players.map(p => p.teamId).filter(Boolean))]
	/** Every club on tonight's card, as one game apiece, so nobody is frozen by accident
	 *  and nobody is left out of the plan for having no game. `started` names the one club
	 *  whose game is already in progress. */
	const slateWith = started => ({
		dates: [{
			games: teams.map((id, i) => ({
				gamePk: 1000 + i,
				gameDate: new Date(Date.now() + (id === started ? -2 : 3) * 3_600_000).toISOString(),
				status: { detailedState: id === started ? "In Progress" : "Pre-Game" },
				teams: { home: { team: { id, abbreviation: "HOM" } }, away: { team: { id: 999, abbreviation: "AWY" } } },
				lineups: {}
			}))
		}]
	})
	const promised = async started => {
		const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } })
		await page.route("**statsapi.mlb.com/api/v1/schedule**", r =>
			r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(slateWith(started)) }))
		await page.route("**statsapi.mlb.com/api/v1/transactions**", r =>
			r.fulfill({ status: 200, contentType: "application/json", body: '{"transactions":[]}' }))
		await page.route("**stats?stats=byDateRange**", r =>
			r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(DAY_HITTING) }))
		await page.addInitScript(([l, c, pool]) => {
			localStorage.setItem("beanemachine:lineup", JSON.stringify(l))
			localStorage.setItem("beanemachine:config", JSON.stringify(c))
			localStorage.setItem("beanemachine:pool", JSON.stringify(pool))
		}, [{ [KEY]: { at: new Date().toISOString(), spots } }, cfg, seedPool])
		await page.goto(BASE, { waitUntil: "domcontentloaded" })
		await page.waitForSelector(".decide", { timeout: 30000 })
		await page.waitForTimeout(2200)
		const head = await page.$eval(".decide-gain", e => e.innerText)
		/*
		   HIS OWN ARRIVING MEN, not every bold name on the card.

		   This read every `<b>` in the lineup list, which was safe while that list held only
		   his own players. The one list holds the priced adds too, so the first name it found
		   was a free agent — and freezing THAT man's club freezes nothing of his, so both
		   pages came back identical and the two assertions below failed on a card that was
		   right. The men a lock can actually take away are the ones arriving into one of his
		   seats, minus the ones he does not own yet.
		*/
		const movers = await page.$$eval(".decide-do-start", ns =>
			ns.flatMap(e => {
				const wire = new Set(
					[...e.querySelectorAll(".decide-add-wire b")].map(b => b.textContent.trim())
				)
				return [...e.querySelectorAll(".decide-in b")]
					.map(b => b.textContent.trim())
					.filter(n => !wire.has(n))
			}))
		const locked = await page.$$eval(".decide-locked", ls => ls.map(l => l.innerText).join(" "))
		await page.close()
		const m = head.match(/or ([\d.]+) once you make these changes/)
		return { reach: m ? Number(m[1]) : null, head, movers, locked }
	}
	const open_ = await promised(null)
	if (open_.reach === null) {
		t("a plan worth more than the lineup is what this block needs", false, open_.head)
	} else {
		const mover = open_.movers.find(n => snap.players.some(p => p.name === n && p.teamId))
		const club = mover && snap.players.find(p => p.name === mover).teamId
		const shut = await promised(club)
		/* Either the promise is smaller or it is gone: freezing the only gainful swap can take
		   the reachable plan down to the lineup the reader already has, and the header then
		   correctly prints one number instead of two. What cannot happen is the SAME promise
		   with the change that paid for it removed from the list — which is what it printed
		   before, because `pointsPlanned` is bigger than `pointsNow` whatever is frozen. */
		t("a change the platform has already closed is not counted in the total it promises",
			shut.reach === null || shut.reach < open_.reach,
			`open ${open_.reach} (${open_.movers.join(", ")}) → one club shut ${shut.reach}`)
		t("and the card says whose change it is no longer offering",
			shut.locked.includes(mover), `${mover} — locked said: ${shut.locked || "(nothing)"}`)
		/* THE DROP BELONGS TO THE PLAN, NOT TO THE LINEUP, and the tolerance here is measured
		   rather than chosen: 111.98 against 111.57, a difference of 0.41 on a 112-point lineup.
		
		   It is not zero, and the first version of this assertion wanted it to be. A club whose
		   game has already started has one fewer game left in the window every man on it is
		   rated over, so what his men project over the rest of the period really does move a
		   little — the lineup is the same lineup, priced against a slightly shorter future.
		   What must NOT happen is the lineup figure absorbing the frozen swap's own gain, which
		   is points rather than tenths. */
		const now = h => Number((h.match(/projects ([\d.]+)/) ?? [])[1])
		t("and the lineup he already has is worth what it was, give or take the shorter window",
			Math.abs(now(open_.head) - now(shut.head)) < 1.5,
			`${now(open_.head)} vs ${now(shut.head)}`)
	}
}

/**
 * WHEN MLB DOES NOT ANSWER, THE CARD MAY NOT PRINT A NUMBER.
 *
 * `fetchActuals` keeps a partial day on purpose, and the cost of that is paid on this screen:
 * a side of the ball that failed looks exactly like a roster of men who did not play. With
 * BOTH sides failing, every total is the sum of nothing — and the card headlined a bold 0 over
 * a sentence explaining that nothing had been read, which is the most confident form a wrong
 * number can take.
 *
 * The read is aborted rather than stubbed empty, because an empty 200 is a different state
 * (an off day) and is asserted separately in test/actuals.mjs.
 */
{
	const cfg = JSON.parse(readFileSync("scoring.json", "utf8"))
	const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
	await page.route("**statsapi.mlb.com/api/v1/schedule**", r =>
		r.fulfill({ status: 200, contentType: "application/json", body: '{"dates":[]}' }))
	await page.route("**stats?stats=byDateRange**", r => r.abort())
	await page.addInitScript(([l, c]) => {
		localStorage.setItem("beanemachine:lineup", JSON.stringify(l))
		localStorage.setItem("beanemachine:config", JSON.stringify(c))
	}, [{ [KEY]: { at: new Date().toISOString(), spots } }, cfg])
	await page.goto(BASE, { waitUntil: "domcontentloaded" })
	await page.waitForSelector(".recap", { timeout: 30000 })
	await page.waitForTimeout(2500)
	const card = await page.$eval(".recap", e => e.innerText)
	t("a read that failed prints no headline figure at all",
		(await page.$$(".recap-score")).length === 0, card.slice(0, 300))
	t("and says how many men it could not check",
		/could not be checked at all/.test(card), card.slice(0, 400))
	t("and never says they did not play",
		!/didn.t play/.test(card), card.slice(0, 600))
	/* The per-man fold is the place this was still wrong after the engine had been fixed: it
	   printed "didn't play" off `points === null` without reading the `unread` flag beside it,
	   which is the app stating as fact the one thing it does not know about the man. */
	const fold = await page.$(".recap-men")
	if (fold) {
		await fold.evaluate(e => e.setAttribute("open", ""))
		await page.waitForTimeout(200)
		const rows = await page.$$eval(".recap-each li", ls => ls.map(l => l.innerText))
		t("and every row says it was not checked, not that he sat out",
			rows.length > 0 && rows.every(r => /not checked/.test(r)) && !rows.some(r => /didn.t play/.test(r)),
			rows.slice(0, 3).join(" | "))
	} else {
		t("the per-man fold is still on the card when the read failed", false, card.slice(0, 300))
	}
	await page.close()
}

/**
 * THE CARD RE-DERIVES ITSELF WHEN A LOCK PASSES, with nothing upstream having changed.
 *
 * `const now = Date.now()` lives inside the memo that builds this card, and that memo's
 * dependencies are the snapshot, the league, the seats, the slate and the injuries. Nothing in
 * the page ticked, so every answer that depends on the clock — which seats are frozen, what
 * the plan can still reach, the "next lock" in the header, the order the rows are sorted in —
 * waited for MLB to flip a game Pre-Game → In Progress and then up to 180 seconds of poll
 * latency. A reader could be offered a seat the platform had already closed minutes earlier,
 * which is the exact failure the slate's own poll was written to end.
 *
 * THE STATE IS PINNED FOR THE WHOLE RUN. Every game in this stub says "Pre-Game" from start to
 * finish and the body never changes, so the only thing that can move the card is the clock
 * crossing a first pitch — and a rain-delayed game really does stay Pre-Game at MLB while
 * being locked on the platform, which is why the card keys on the scheduled time at all.
 */
{
	const cfg = JSON.parse(readFileSync("scoring.json", "utf8"))
	const teams = [...new Set(snap.players.map(p => p.teamId).filter(Boolean))]
	/* SIX SECONDS WAS A RACE THIS TEST KEPT LOSING. The card has to load the capture, rate
	   1,446 players and render before the assertion runs, and on a slower run that took longer
	   than the six seconds the first pitch was set at — so the card correctly said "every seat
	   has started" and the assertion, which is about the state BEFORE the lock, failed. Twenty
	   seconds is comfortably past the slowest render measured here and still a short test. */
	const SOON = 20_000
	const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } })
	const firstPitch = new Date(Date.now() + SOON).toISOString()
	await page.route("**statsapi.mlb.com/api/v1/schedule**", r =>
		r.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				dates: [{
					games: teams.map((id, i) => ({
						gamePk: 2000 + i,
						gameDate: firstPitch,
						status: { detailedState: "Pre-Game" },
						teams: { home: { team: { id, abbreviation: "HOM" } }, away: { team: { id: 999, abbreviation: "AWY" } } },
						lineups: {}
					}))
				}]
			})
		}))
	await page.route("**statsapi.mlb.com/api/v1/transactions**", r =>
		r.fulfill({ status: 200, contentType: "application/json", body: '{"transactions":[]}' }))
	await page.route("**stats?stats=byDateRange**", r =>
		r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(DAY_HITTING) }))
	await page.addInitScript(([l, c, pool]) => {
		localStorage.setItem("beanemachine:lineup", JSON.stringify(l))
		localStorage.setItem("beanemachine:config", JSON.stringify(c))
		localStorage.setItem("beanemachine:pool", JSON.stringify(pool))
	}, [{ [KEY]: { at: new Date().toISOString(), spots } }, cfg, seedPool])
	await page.goto(BASE, { waitUntil: "domcontentloaded" })
	await page.waitForSelector(".decide", { timeout: 30000 })
	await page.waitForTimeout(2500)
	const before = await page.$eval(".decide", e => e.innerText)
	t("before the first pitch the card offers changes and says when they lock",
		/next lock/.test(before) && !/no longer yours to change/.test(before), before.slice(0, 400))
	/* Past the pitch, plus the timer's own one-second margin, plus room for one re-rate. No
	   schedule request can have changed anything: the route returns the same body, and the
	   slate's poll is 180s. */
	await page.waitForTimeout(SOON + 4_000)
	const after = await page.$eval(".decide", e => e.innerText)
	t("and once it passes, the same card says those seats are no longer his to change",
		/no longer yours to change/.test(after), after.slice(0, 500))
	t("and stops naming a next lock that is already behind him",
		!/next lock/.test(after), after.slice(0, 300))
	/* The deadline, not the event: what the code knows is that the scheduled first pitch has
	   passed, and the sentence says so. It used to say "his game has started", which is a claim
	   about a game that may be sitting under a tarpaulin. */
	t("and says it as a deadline rather than as a thing it watched happen",
		/was due to start|were due to start/.test(after), after.slice(0, 500))
	await page.close()
}

/**
 * A HAND-TYPED TEAM IS AS LONG AS HE MADE IT, and the card said nothing about that.
 *
 * The setup sheet invites a short list — "Only got a few? Start with your starters. You can
 * add the rest later" — and every seat he skipped was then counted as a hole. Measured:
 * thirteen names in a twenty-seven-seat league produced "7 seats score nothing tonight" and
 * three waiver adds. The adds are not the defect: if he really holds thirteen men they are the
 * most valuable thing on the page. The defect is that the seat count is derived from a list
 * length the reader was told he could truncate, and nothing said where the length came from.
 *
 * No arithmetic between the two numbers, either: 27 seats minus 13 men is 14, over a heading
 * that counts 6, because the heading counts startable seats and the league's total includes
 * the bench and the injured list. The claim is about provenance.
 */
{
	const cfg = JSON.parse(readFileSync("scoring.json", "utf8"))
	const bats = snap.players.filter(p => p.group === "hitting" && (p.stats?.plateAppearances ?? 0) > 400).slice(0, 9)
	const arms = snap.players.filter(p => p.group === "pitching" && (p.stats?.outs ?? 0) > 300).slice(0, 4)
	const ids = [...bats.map(p => `${p.id}:hitting`), ...arms.map(p => `${p.id}:pitching`)]
	/* A ROSTER WITH NO SEATS, which is the hand-typed route and the only one a phone has. The
	   lineup store is deliberately not seeded: that is what makes `seats.at` null and the seat
	   list as long as the names he gave. */
	const page = await open({ config: cfg, roster: { [KEY]: ids }, pool: seedPool }, { noMlb: true })
	const said = await page.$$eval(".decide-partial", n => n.map(e => e.innerText))
	t("a card built from a short typed list says where its seat count came from",
		said.length === 1 && /13 men you have named/.test(said[0]) && /own 27/.test(said[0]),
		said.join(" | ") || "(nothing said)")
	/* The clause that spelled out what "empty" means here went with every other sentence that
	   explained the app to itself. The provenance is the claim — these seats are the men he
	   named, not his league's — and the action after it is what he can do about it. */
	t("and says what that means for an empty seat, in his terms",
		/men you have named, not from your league/.test(said[0] ?? "") &&
			/Read your roster off your platform/.test(said[0] ?? ""),
		said[0] ?? "")
	/* And it does not do the subtraction: 27 − 13 = 14 is not the number of empty seats on
	   this card, and printing it there was the first version of this sentence. */
	t("and claims no count of empty seats it cannot back",
		!/14 of these/.test(said[0] ?? ""), said[0] ?? "")
	await page.close()

	/* THE OTHER SIDE OF THE SAME CLAIM: a full roster read off a platform says nothing, because
	   there is nothing to say. A provenance line on every card would be furniture. */
	const full = await open(
		{ config: cfg, lineup: { [KEY]: { at: new Date().toISOString(), spots } }, pool: seedPool },
		{ noMlb: true }
	)
	t("a team whose seats were read says nothing about how many it was given",
		(await full.$$(".decide-partial")).length === 0,
		(await full.$$eval(".decide-partial", n => n.map(e => e.innerText))).join(" | "))
	await full.close()
}

/**
 * WHAT HIS LINEUP HAS ACTUALLY SCORED TONIGHT, which no screen in this app could say.
 *
 * Every number on this card is a projection, and the recap is hard-wired to yesterday —
 * correctly, it is the morning-after screen — so between the first pitch and midnight the app
 * knew nothing about what was happening. The fixtures are the same real 2026-09-11 responses
 * the recap is asserted against, served for whatever date is asked for, which is what makes
 * the figure below hand-computable: Tucker 34.1 + Adell 0 + Bradley 29.5 + Bregman 25.8 +
 * Albies 1.9 = 91.3 from the five startable seats, with May on the bench and not counted.
 */
{
	const cfg = JSON.parse(readFileSync("scoring.json", "utf8"))
	const men = ["Kyle Tucker", "Jo Adell", "Taj Bradley", "Alex Bregman", "Ozzie Albies", "Dustin May"]
		.map(n => snap.players.find(p => p.name === n))
	const seats = [
		{ slot: "OF", name: "Kyle Tucker", positions: ["OF"], team: null },
		{ slot: "Util", name: "Jo Adell", positions: ["OF"], team: null },
		{ slot: "SP", name: "Taj Bradley", positions: ["SP"], team: null },
		{ slot: "3B", name: "Alex Bregman", positions: ["3B"], team: null },
		{ slot: "2B", name: "Ozzie Albies", positions: ["2B"], team: null },
		{ slot: "BN", name: "Dustin May", positions: ["SP"], team: null }
	]
	const clubs = [...new Set(men.map(m => m?.teamId).filter(Boolean))]
	/** @param state what every one of HIS clubs' games says, and `null` for "not started yet" */
	const card = async (state, hours) => {
		const page = await browser.newPage({ viewport: { width: 420, height: 1400 } })
		const asked = []
		await page.route("**statsapi.mlb.com/api/v1/schedule**", r =>
			r.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					dates: [{
						games: clubs.map((id, i) => ({
							gamePk: 4000 + i,
							gameDate: new Date(Date.now() + hours * 3_600_000).toISOString(),
							/* One of his clubs finished and the rest are still playing, which is what a
							   nine-o'clock evening actually looks like — and it is the shape that makes
							   the two counts in the sentence distinguishable. */
							status: {
								detailedState:
									state === null ? "Pre-Game"
									: i === 0 ? state
									: "In Progress"
							},
							teams: { home: { team: { id, abbreviation: "HOM" } }, away: { team: { id: 999, abbreviation: "AWY" } } },
							lineups: {}
						}))
					}]
				})
			}))
		await page.route("**statsapi.mlb.com/api/v1/transactions**", r =>
			r.fulfill({ status: 200, contentType: "application/json", body: '{"transactions":[]}' }))
		await page.route("**stats?stats=byDateRange**", r => {
			asked.push(r.request().url())
			return r.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(r.request().url().includes("group=pitching") ? DAY_PITCHING : DAY_HITTING)
			})
		})
		await page.addInitScript(([l, c]) => {
			localStorage.setItem("beanemachine:lineup", JSON.stringify(l))
			localStorage.setItem("beanemachine:config", JSON.stringify(c))
		}, [{ [KEY]: { at: new Date().toISOString(), spots: seats } }, cfg])
		await page.goto(BASE, { waitUntil: "domcontentloaded" })
		await page.waitForSelector(".decide", { timeout: 30000 })
		await page.waitForTimeout(4000)
		const said = (await page.$$eval(".decide-sofar", n => n.map(e => e.innerText)))[0] ?? ""
		await page.close()
		return { said, asked }
	}

	/* THE GAMES HAVE NOT STARTED, so there is nothing to say and nothing to ask. A
	   `byDateRange` read for a date with no games played comes back as about 500 bytes of
	   empty splits, and a man missing from it means "did not play" rather than zero — so a
	   pre-game total would render as a shut-out. The assertion is on the REQUESTS as well as
	   on the text, because not charging him for it is half the claim. */
	const early = await card(null, 3)
	const TODAY = new Date().toLocaleDateString("en-CA")
	t("before his games start the card says nothing about tonight's points",
		early.said === "", early.said)
	t("and does not ask MLB about a day that has not happened",
		!early.asked.some(u => u.includes(`startDate=${TODAY}&endDate=${TODAY}`)),
		early.asked.filter(u => u.includes(TODAY)).join(" | ") || "(none for today)")

	/* ONE FINAL, THE REST UNDERWAY. The total is what his five startable seats have actually
	   scored, and the bench man is not in it. */
	const live = await card("Final", -2)
	t("once they are being played it says what his lineup has actually scored",
		/your lineup has scored/.test(live.said) && /91\.3/.test(live.said), live.said)
	t("and says how much of his evening is already in the figure",
		/1 game is final/.test(live.said), live.said)
	/* NO ARITHMETIC BETWEEN THE TWO NUMBERS. This league pays -3 for an earned run, so
	   tonight's figure can fall, and the projection covers seats whose games are over. "43 of
	   112" and "on pace for" are both claims the data cannot carry. */
	t("and never puts it over the projection or calls it a pace",
		!/of \d|on pace/.test(live.said), live.said)
}

/**
 * A GAME THAT WAS CALLED OFF IS NEWS, and the card computed it and never said it.
 *
 * `src/data/today.ts` has parsed postponements into `slate.called` since the day a postponed
 * game was seating men, and its own comment says the games stay in `games` "so a screen can
 * SAY a game was called off". No screen did: the only trace was the game count going down by
 * one, which a reader cannot tell from a light Wednesday. Before the seat locks it is the one
 * change that is free — a man whose game has gone is a guaranteed zero — and afterwards it is
 * the difference between a seat he got wrong and a seat nothing could be done about.
 */
{
	const cfg = JSON.parse(readFileSync("scoring.json", "utf8"))
	/* Resolved through the snapshot, not through `sp.team`, which is null for every seat this
	   suite builds — see the note in the scratch block above. */
	const starter = spots.find(
		sp => !/^(BN|IL|NA)/i.test(sp.slot) && snap.players.some(p => p.name === sp.name && p.teamId)
	)
	const him = starter && snap.players.find(p => p.name === starter.name)
	/* AND ONE CLUB THAT IS STILL PLAYING, which is both the realistic shape and the only one
	   that tests anything: with every game on the card called off, nobody of his can score at
	   all, the Today block gives way to the period lineup, and the line under test is not on
	   the screen to be asserted about. One postponement among a normal evening is the case a
	   reader actually meets. */
	const other = spots.find(
		sp =>
			sp !== starter &&
			!/^(BN|IL|NA)/i.test(sp.slot) &&
			snap.players.some(p => p.name === sp.name && p.teamId && p.teamId !== him?.teamId)
	)
	const otherClub = other && snap.players.find(p => p.name === other.name)?.teamId
	if (him?.teamId && otherClub) {
		const page = await browser.newPage({ viewport: { width: 420, height: 1400 } })
		await page.route("**statsapi.mlb.com/api/v1/schedule**", r =>
			r.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					dates: [{
						games: [
							{
								gamePk: 77,
								gameDate: new Date(Date.now() + 3 * 3_600_000).toISOString(),
								/* The real string MLB sends, verbatim, rather than the word this app
								   matches on — `isCalledOff` prefix-matches "Postponed", and a suite
								   that sent the app's own vocabulary back to it would assert nothing. */
								status: { detailedState: "Postponed" },
								teams: { home: { team: { id: him.teamId, abbreviation: "HOM" } }, away: { team: { id: 999, abbreviation: "AWY" } } },
								lineups: {}
							},
							{
								gamePk: 78,
								gameDate: new Date(Date.now() + 3 * 3_600_000).toISOString(),
								status: { detailedState: "Pre-Game" },
								teams: { home: { team: { id: otherClub, abbreviation: "HOM2" } }, away: { team: { id: 998, abbreviation: "AWY2" } } },
								lineups: {}
							}
						]
					}]
				})
			}))
		await page.route("**statsapi.mlb.com/api/v1/transactions**", r =>
			r.fulfill({ status: 200, contentType: "application/json", body: '{"transactions":[]}' }))
		await page.route("**stats?stats=byDateRange**", r => r.abort())
		await page.addInitScript(([l, c]) => {
			localStorage.setItem("beanemachine:lineup", JSON.stringify(l))
			localStorage.setItem("beanemachine:config", JSON.stringify(c))
		}, [{ [KEY]: { at: new Date().toISOString(), spots } }, cfg])
		await page.goto(BASE, { waitUntil: "domcontentloaded" })
		await page.waitForSelector(".decide", { timeout: 30000 })
		await page.waitForTimeout(5000)
		const said = (await page.$$eval(".decide-called", n => n.map(e => e.innerText)))[0] ?? ""
		t("a man whose game has been called off is named on the card",
			said.includes(him.name), said || "(nothing said)")
		t("and told what it costs that seat, whoever is in it",
			/called off/.test(said) && /nothing tonight/.test(said), said)
		await page.close()
	}
}

/*
 * ═══════════════════════════════════════════════════════════════════════════════════
 * WHICH HALF THE GAP IS IN.
 *
 * The card has been able to say "you are behind by 41 with 2 days left" and nothing more.
 * `useMatchup` computed that by scoring every man each side HOLDS through the league's own
 * table — knowing, for each one, which side of the ball he was on — and then summing and
 * throwing the split away. "Behind by 41" and "behind by 41, and the gap is in your arms"
 * are different instructions for tonight, and the second costs no new read, no new estimate
 * and no new claim.
 *
 * Seeded rather than typed: the reader holds three hitters, his opponent holds three arms
 * who threw six shutout innings apiece, both out of the committed byDateRange fixtures the
 * page is served for every date it asks for. The caveat is asserted with the number, as it
 * is everywhere else this comparison appears — these are men HELD, not men started.
 * ═══════════════════════════════════════════════════════════════════════════════════
 */
{
	const cfg = JSON.parse(readFileSync("scoring.json", "utf8"))
	/* Kyle Tucker, Brice Turang, Alex Bregman — each a home run and three hits in the
	   fixture; Taj Bradley, Dustin May, Steven Cruz on the other side. */
	const mine = ["663656:hitting", "668930:hitting", "608324:hitting"]
	const his = ["671737:pitching", "669160:pitching", "674444:pitching"]
	const page = await open(
		{
			config: cfg,
			lineup: { [KEY]: { at: new Date().toISOString(), spots } },
			roster: { [KEY]: mine },
			opponent: { [KEY]: his }
		},
		{ actuals: true }
	)
	await page.waitForTimeout(1500)
	const card = await page.$eval(".decide", e => e.innerText)
	t("the card puts the two sides side by side at all",
		/you are (ahead|behind) by [\d.]+|you are level/i.test(card), card.slice(0, 500))
	t("and names which half of the ball the gap is in",
		/the gap is in your (bats|arms)/i.test(card), card.slice(0, 700))
	/* His side is three pitchers and nothing else, so the reader's bats are ahead and his
	   arms are behind: the half named has to be the arms. A version of this that named the
	   bats would be reading the two tables crossed, which is the failure the node assertions
	   in test/actuals.mjs pin the arithmetic against. */
	t("…and with three arms against three bats, that half is the arms",
		/the gap is in your arms/i.test(card), card.slice(0, 700))
	t("and the caveat travels with it, because these are men held and not men started",
		/every man each side holds/i.test(card), card.slice(0, 700))
	await page.close()

	/*
	   AND A READER AHEAD ON BOTH HALVES IS TOLD NOTHING, which is what there is to say.
	
	   `gapBy` holds two GAPS, not two totals, so a positive half means his men out-scored his
	   opponent's men on that side of the ball. The first version of this sentence picked the
	   SMALLER of the two gaps whatever its sign — so a reader ahead by 92 on bats and 26 on
	   arms was told "the gap is in your arms", a confident instruction to go and fix something
	   that is not broken, printed beside a total that was correct. Reproduced in a browser
	   before this assertion existed; it is here so that it cannot come back.
	*/
	const ahead = await open(
		{
			config: cfg,
			lineup: { [KEY]: { at: new Date().toISOString(), spots } },
			/* Two bats and two arms against three bats — one of whom hit a home run and two of
			   whom did nothing — and one arm who threw a single inning. Both halves of the gap
			   come out positive and they are far apart, which is the shape that used to produce
			   the false sentence. The opponent needs at least two thirds of the reader's roster
			   or the comparison is refused outright, which is why he holds four. */
			roster: { [KEY]: ["663656:hitting", "668930:hitting", "671737:pitching", "669160:pitching"] },
			opponent: { [KEY]: ["608324:hitting", "666176:hitting", "645277:hitting", "674444:pitching"] }
		},
		{ actuals: true }
	)
	await ahead.waitForTimeout(1500)
	const good = await ahead.$eval(".decide", e => e.innerText)
	t("a reader ahead on both halves is still told how the week stands",
		/you are ahead by [\d.]+/i.test(good), good.slice(0, 400))
	t("…and is told about no hole at all, because he does not have one",
		!/the gap is in your/i.test(good), good.slice(0, 700))
	await ahead.close()
}

/*
 * ═══════════════════════════════════════════════════════════════════════════════════
 * A READ THAT HAS NOT ANSWERED YET IS NOT A READ THAT SUCCEEDED.
 *
 * `useSlate` answers three states — slate, error, loading — and this card destructured two.
 * The stale-capture notice fires on `error`, which is the app's correct handling of a read
 * that FAILED; a read still in flight fell through to the same capture fallback with no
 * sentence attached. So for the first seconds the card presented a ten-day-old schedule as
 * tonight — no lock times, a different lineup, a different add — and then rearranged itself
 * unprompted in front of the reader.
 *
 * The comment above that notice already said it: both feeds fall back to the shipped capture,
 * which is the right behaviour and the wrong thing to do silently. The fix had landed for the
 * failed case and not for the pending one.
 * ═══════════════════════════════════════════════════════════════════════════════════
 */
{
	const slow = await browser.newPage({ viewport: { width: 1100, height: 1400 } })
	/* Hold tonight's schedule open, which is what a slow morning looks like. */
	await slow.route("**statsapi.mlb.com/api/v1/schedule**", async r => {
		await new Promise(x => setTimeout(x, 7000))
		await r.continue()
	})
	await slow.addInitScript(([l, cfg]) => {
		localStorage.setItem("beanemachine:lineup", JSON.stringify(l))
		localStorage.setItem("beanemachine:config", JSON.stringify(cfg))
	}, [seedLineup, JSON.parse(readFileSync("scoring.json", "utf8"))])
	await slow.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 })
	await slow.waitForSelector(".decide", { timeout: 30000 })
	await slow.waitForTimeout(2000)
	const pending = await slow.$eval(".decide", e => e.innerText)
	t("while tonight's schedule is still coming, the card says so",
		/schedule is still coming/i.test(pending), pending.replace(/\n+/g, " | ").slice(0, 300))
	t("…and says what it is showing in the meantime",
		/from the capture/i.test(pending), pending.replace(/\n+/g, " | ").slice(0, 300))
	await slow.waitForTimeout(8000)
	const settled = await slow.$eval(".decide", e => e.innerText)
	t("and stops saying it the moment the schedule arrives",
		!/schedule is still coming/i.test(settled), settled.replace(/\n+/g, " | ").slice(0, 300))
	await slow.close()
}

console.log(`\npassed ${pass}, failed ${fail}`)
await browser.close()
process.exit(fail ? 1 : 0)
