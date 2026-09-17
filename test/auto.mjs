// The autonomous manager's safety rails, asserted against constructed rosters.
// Pure planning only: no network, no Playwright, no snapshot. Every rail here is
// a thing Billy must never do on a real team, so each is checked twice — once by
// asserting the planner does not do it, and once by handing railViolations a plan
// that does it and asserting the audit catches it.
import { readFileSync } from "node:fs"
import {
	activeSlots, DEFAULTS, freezeShut, legalSlotsFor, movesAllowed, plan, planLineup, planMoves,
	planSwaps, railViolations, resolveRoster, seatedInnings
} from "../src/auto/plan.ts"
import { normalizeName } from "../src/data/yahoo-pool.ts"

let pass = 0, fail = 0
const t = (n, ok, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : "  " + x}`) }

const near2 = (a, b) => typeof a === "number" && Math.abs(a - b) < 0.005

let nextId = 1
/** Only the fields the planner reads — a Rated carries far more, and none of it
 *  changes a decision. */
const rated = (name, { points = 0, bscore = 0, slots = ["Util"], injury, rateable = true, group = "hitting" } = {}) => ({
	player: { id: nextId++, name, team: null, teamId: 1, position: slots[0], group, stats: {} },
	injury,
	slots,
	slot: slots[0],
	points,
	bscore,
	rateable,
	replacement: 0,
	confidence: { value: 1, reasons: [] },
	regressionGap: null
})
const spot = (slot, name, positions, status = "") => ({ slot, name, positions, team: null, status })

const SHAPE = {
	slots: { C: 1, "1B": 1, OF: 2, Util: 1, BN: 3, IL: 2 },
	slot_order: ["C", "1B", "OF", "OF", "Util", "BN", "BN", "BN", "IL", "IL"],
	slot_accepts: {
		C: ["C"], "1B": ["1B"], OF: ["OF"],
		Util: ["C", "1B", "2B", "3B", "SS", "OF"],
		BN: "any", IL: "injured_only"
	}
}
const shape = (slots, accepts, order = null) => ({ slots, slot_order: order, slot_accepts: accepts })
const opts = o => ({ ...DEFAULTS, ...o })

/* ---------------- the roster shape itself ---------------- */

t("only startable seats are planned for — the bench and the IL are not lineup slots",
	activeSlots(SHAPE).join(",") === "C,1B,OF,OF,Util" && activeSlots(SHAPE).length === 5,
	activeSlots(SHAPE).join(","))
t("with no slot_order the counts produce the same seats",
	activeSlots({ ...SHAPE, slot_order: null }).filter(s => s === "OF").length === 2 &&
		activeSlots({ ...SHAPE, slot_order: null }).length === 5)

/*
 * THE COUNTS DECIDE HOW MANY MEN START, and `slot_order` only what order they print in.
 *
 * There were two implementations of this with opposite precedence — this file's, which
 * read `slot_order` first, and the engine's, which read the counts — and both were
 * reachable from the My league screen: the deal pricer seated one team and the lineup
 * planner, three hundred pixels away, seated another. Measured on the dev league by
 * bumping OF from 3 to 5 in the editor and saving: the editor's own totals went from 18
 * active seats to 20, and the Tonight card went on seating 18 and never mentioned the
 * other two. The league editor appends to `slot_order` once per slot added whatever the
 * count, and seeds it from `Object.keys(slots)` when it is null, which destroys every
 * multiplicity — so a stale order is the normal case, not an edge one.
 *
 * This is the shape that was wrong, and it is the one the editor actually produces.
 */
{
	const bumped = { ...SHAPE, slots: { ...SHAPE.slots, OF: 4 } }
	t("a count raised in the editor seats the men it says, against a stale print order",
		activeSlots(bumped).filter(s => s === "OF").length === 4 &&
			activeSlots(bumped).length === 7,
		activeSlots(bumped).join(","))
	// and the order is still Yahoo's, which is the only thing slot_order is for
	t("and the seats still print in the order the league listed them",
		activeSlots(bumped).join(",") === "C,1B,OF,OF,OF,OF,Util", activeSlots(bumped).join(","))
	const seeded = { ...SHAPE, slot_order: Object.keys(SHAPE.slots) }
	t("a print order that lost its multiplicity does not lose the seats with it",
		activeSlots(seeded).length === 5 && activeSlots(seeded).filter(s => s === "OF").length === 2,
		activeSlots(seeded).join(","))
}

/*
 * Yahoo's second injured slot, IL+, through the predicate this file used to hand-write.
 * `/^(IL|NA)/i` caught it by luck; `isReserveSlot` catches it by name AND by prefix, and
 * is the same answer the engine and the two rendered components give. The bug that made
 * it one list was a league with an IL+ seat being told it starts one more man than it
 * does.
 */
t("IL+ is a reserve seat and starts nobody",
	!activeSlots({ ...SHAPE, slots: { ...SHAPE.slots, "IL+": 1 }, slot_order: null }).includes("IL+"))
t("and so is a numbered one, which an exact-match list would miss",
	!activeSlots({ ...SHAPE, slots: { ...SHAPE.slots, IL60: 1 }, slot_order: null }).includes("IL60"))

/* ---------------- lineup: the scarce slot ---------------- */

// A points-only ranking starts the two best bats and leaves C empty, which is
// illegal and scores nothing there. The scarce seat has to be paid for.
const scarce = {
	roster: [spot("BN", "Andy Mask", ["C"]), spot("Util", "Bo Slug", ["OF"]), spot("BN", "Cy Slug", ["OF"])],
	rated: [
		rated("Andy Mask", { points: 10, slots: ["C", "Util"] }),
		rated("Bo Slug", { points: 50, slots: ["OF", "Util"] }),
		rated("Cy Slug", { points: 40, slots: ["OF", "Util"] })
	],
	availableNames: new Set(),
	shape: shape({ C: 1, Util: 1, BN: 2 }, { C: ["C"], Util: ["C", "OF"], BN: "any" })
}
const scarceLineup = planLineup(scarce)
t("lineup planning fills the scarce slot even with a worse player",
	scarceLineup.starters.some(s => s.slot === "C" && s.name === "Andy Mask") &&
		scarceLineup.starters.some(s => s.slot === "Util" && s.name === "Bo Slug") &&
		scarceLineup.starters.length === 2,
	JSON.stringify(scarceLineup.starters))
t("and the better bat who fits nowhere scarce sits",
	!scarceLineup.starters.some(s => s.name === "Cy Slug"))

// The case a slot-at-a-time greedy gets wrong: the man eligible everywhere must
// be spent on the seat only he can also cover.
const swing = {
	roster: [spot("BN", "Ann Both", ["C", "1B"]), spot("BN", "Bob Mask", ["C"]), spot("BN", "Cal Cold", ["1B"])],
	rated: [
		rated("Ann Both", { points: 50, slots: ["C", "Util"] }),
		rated("Bob Mask", { points: 40, slots: ["C", "Util"] }),
		rated("Cal Cold", { points: 35, slots: ["1B", "Util"] })
	],
	availableNames: new Set(),
	shape: shape({ C: 1, "1B": 1, BN: 2 }, { C: ["C"], "1B": ["1B"], BN: "any" })
}
const swingLineup = planLineup(swing)
t("the multi-position player is assigned where he is worth the most, not where he lands first",
	swingLineup.pointsPlanned === 90 &&
		swingLineup.starters.some(s => s.slot === "1B" && s.name === "Ann Both") &&
		swingLineup.starters.some(s => s.slot === "C" && s.name === "Bob Mask"),
	`${swingLineup.pointsPlanned}: ${JSON.stringify(swingLineup.starters)}`)

// The shift a swap genuinely needs is still reported: Ann has to move off 1B for
// Bob to have a seat at all, and both are worth more than the man they replace.
const rotation = planLineup({
	roster: [spot("1B", "Ann Both", ["C", "1B"]), spot("C", "Cy Cold", ["C"]), spot("BN", "Bob Corner", ["1B"])],
	rated: [
		rated("Ann Both", { points: 50, slots: ["1B"] }),
		rated("Cy Cold", { points: 5, slots: ["C"] }),
		rated("Bob Corner", { points: 40, slots: ["1B"] })
	],
	availableNames: new Set(),
	shape: shape({ C: 1, "1B": 1, BN: 2 }, { C: ["C"], "1B": ["1B"], BN: "any" })
})
t("a shift that a swap actually requires is reported alongside it",
	rotation.shifts.length === 1 && rotation.shifts[0].name === "Ann Both" &&
		rotation.shifts[0].from === "1B" && rotation.shifts[0].to === "C" &&
		rotation.swaps.length === 1 && rotation.swaps[0].start === "Bob Corner" &&
		rotation.swaps[0].sit === "Cy Cold" && rotation.gain === 35,
	JSON.stringify([rotation.swaps, rotation.shifts, rotation.gain]))

/* ---------------- lineup: the swaps it reports ---------------- */

const benchInput = {
	roster: [
		spot("C", "Andy Mask", ["C"]), spot("1B", "Deb Bag", ["1B"]),
		spot("OF", "Ed Green", ["OF"]), spot("OF", "Fay Weak", ["OF"]),
		spot("Util", "Gil Ok", ["OF"]), spot("BN", "Hal Hot", ["OF"])
	],
	rated: [
		rated("Andy Mask", { points: 30, slots: ["C"] }), rated("Deb Bag", { points: 40, slots: ["1B"] }),
		rated("Ed Green", { points: 45, slots: ["OF"] }), rated("Fay Weak", { points: 12, slots: ["OF"] }),
		rated("Gil Ok", { points: 25, slots: ["OF"] }), rated("Hal Hot", { points: 55, slots: ["OF"] })
	],
	availableNames: new Set(),
	shape: SHAPE
}
const benchPlan = planLineup(benchInput)
t("a bench bat better than a starter is reported as a swap, with both numbers",
	benchPlan.swaps.length === 1 && benchPlan.swaps[0].start === "Hal Hot" &&
		benchPlan.swaps[0].sit === "Fay Weak" && benchPlan.swaps[0].gain === 43,
	JSON.stringify(benchPlan.swaps))
t("no seat is shuffled for nothing — a Util bat eligible in OF stays where he is",
	benchPlan.shifts.length === 0, JSON.stringify(benchPlan.shifts))
t("the reported gain is the whole lineup's, in projected points",
	benchPlan.pointsNow === 152 && benchPlan.pointsPlanned === 195 && benchPlan.gain === 43,
	`${benchPlan.pointsNow} → ${benchPlan.pointsPlanned}`)

// An optimal lineup and an unplannable one must not read alike.
const settled = planLineup({ ...benchInput, roster: benchInput.roster.filter(s => s.name !== "Hal Hot") })
t("an already-optimal lineup is a plan with no swaps, not a blocked one",
	settled.blocked === null && settled.swaps.length === 0 && settled.starters.length === 5,
	JSON.stringify(settled.starters))
t("a lineup that could not be planned says so instead of coming back empty",
	planLineup({ ...benchInput, shape: { ...SHAPE, slot_accepts: null } }).blocked !== null)
t("an unreadable slot cell blocks the lineup rather than inventing today's one",
	planLineup({ ...benchInput, roster: [spot("", "Andy Mask", ["C"]), ...benchInput.roster.slice(1)] })
		.blocked?.includes("Andy Mask") === true)

// A player nobody can price, and a player Yahoo gave no eligibility for, keep the
// seat they are in — Billy knows too little to move them, and says so.
const opaque = planLineup({
	...benchInput,
	roster: [spot("OF", "Zed Ghost", []), ...benchInput.roster.filter(s => s.slot !== "OF" || s.name !== "Ed Green")],
	rated: [...benchInput.rated, rated("Zed Ghost", { points: 99, slots: ["OF"] })]
})
t("a player with no readable eligibility keeps his seat and is named, never quietly benched",
	!opaque.starters.some(s => s.name === "Zed Ghost") &&
		opaque.skipped.some(s => s.startsWith("Zed Ghost") && /eligibility/.test(s)) &&
		opaque.starters.filter(s => s.slot === "OF").length === 1,
	JSON.stringify(opaque.skipped))
t("a rostered player who is not on the board is reported, not counted as zero",
	planLineup({ ...benchInput, rated: benchInput.rated.filter(r => r.player.name !== "Gil Ok") })
		.skipped.some(s => s.startsWith("Gil Ok") && /not on the board/.test(s)))
t("a startable seat nobody is eligible for is reported empty",
	planLineup({ ...benchInput, roster: benchInput.roster.filter(s => s.name !== "Andy Mask") })
		.emptySlots.includes("C"))

/* ---------------- rail: nobody on the IL is ever started ---------------- */

const hurt = planLineup({
	...benchInput,
	rated: benchInput.rated.map(r =>
		r.player.name === "Ed Green" ? { ...r, injury: "Injured 15-Day" } : r)
})
t("a player MLB lists on the IL is never put in the lineup",
	!hurt.starters.some(s => s.name === "Ed Green") &&
		hurt.skipped.some(s => s.startsWith("Ed Green") && /Injured 15-Day/.test(s)),
	JSON.stringify(hurt.skipped))
t("and his projection, which assumes he plays, is not credited to today's lineup",
	hurt.pointsNow === 107, String(hurt.pointsNow))
t("the seat he vacates is attributed to him, not reported as an empty slot",
	hurt.swaps.length === 1 && hurt.swaps[0].start === "Hal Hot" && hurt.swaps[0].sit === "Ed Green" &&
		hurt.swaps[0].sitPoints === null && /Injured 15-Day/.test(hurt.swaps[0].reason),
	JSON.stringify(hurt.swaps))

const stranded = planLineup({
	...benchInput,
	roster: benchInput.roster.filter(sp => sp.name !== "Hal Hot"),
	rated: benchInput.rated.map(r => r.player.name === "Ed Green" ? { ...r, injury: "Injured 15-Day" } : r)
})
t("a man who cannot play still comes out when nobody on the bench can replace him",
	stranded.swaps.length === 0 && stranded.sits.length === 1 && stranded.sits[0].name === "Ed Green" &&
		stranded.sits[0].points === null && stranded.emptySlots.includes("OF"),
	JSON.stringify([stranded.sits, stranded.emptySlots]))
t("Yahoo's own IL flag is enough on its own",
	!planLineup({ ...benchInput, roster: benchInput.roster.map(s =>
		s.name === "Ed Green" ? { ...s, status: "IL" } : s) }).starters.some(s => s.name === "Ed Green"))
t("a man in the IL slot is left there rather than activated",
	!planLineup({ ...benchInput, roster: benchInput.roster.map(s =>
		s.name === "Hal Hot" ? { ...s, slot: "IL" } : s) }).starters.some(s => s.name === "Hal Hot"))

/* ---------------- the lineup bar, and what it may not silence ---------------- */

const marginal = {
	roster: [spot("OF", "Ed Green", ["OF"]), spot("BN", "Hal Hot", ["OF"])],
	rated: [rated("Ed Green", { points: 45, slots: ["OF"] }), rated("Hal Hot", { points: 46, slots: ["OF"] })],
	availableNames: new Set(),
	shape: shape({ OF: 1, BN: 2 }, { OF: ["OF"], BN: "any" }),
	options: opts({ lineupMinGain: 5 })
}
const held = planLineup(marginal)
t("a lineup change below the lineup bar is not proposed",
	held.swaps.length === 0 && held.shifts.length === 0 && held.sits.length === 0,
	JSON.stringify(held.swaps))
t("and the bar, not an absence of options, is named as the reason",
	held.skipped.some(n => /lineup bar/.test(n) && /worth 1 more/.test(n)), JSON.stringify(held.skipped))
// The bar governs whether a marginal optimisation is worth reading about. It must
// never leave a seat held by a man who is not going to play in it.
const forcedOut = planLineup({
	...marginal,
	rated: [
		rated("Ed Green", { points: 45, slots: ["OF"], injury: "Injured 60-Day" }),
		rated("Hal Hot", { points: 3, slots: ["OF"] })
	]
})
t("the lineup bar never silences a man who cannot play coming out of the lineup",
	forcedOut.sits.length === 1 && forcedOut.sits[0].name === "Ed Green" &&
		forcedOut.sits[0].points === null && forcedOut.swaps.length === 1 &&
		forcedOut.swaps[0].start === "Hal Hot",
	JSON.stringify([forcedOut.sits, forcedOut.swaps, forcedOut.skipped]))
t("an already-optimal lineup reports no gain, so it cannot be printed as one held back by the bar",
	settled.gain === 0 && held.gain === 1, `${settled.gain} / ${held.gain}`)

/* ---------------- rail: the keep floor ---------------- */

/*
 * A FULL ROSTER, which is what every assertion in this block was always about and what
 * none of them said.
 *
 * `planSwaps` now fills a free seat before it offers anybody up — measured on the
 * published build, a reader holding 18 men against 27 seats was told to drop Aaron Judge
 * while the same card said four seats were scoring nothing. These fixtures held three men
 * against SHAPE's ten seats, so with the new rule every one of them correctly produced a
 * pure add and stopped testing the drop choice at all.
 *
 * The claims below are about WHO COMES OUT when somebody must, so the fixture now says
 * somebody must: `slots` is trimmed to exactly the seats these men occupy. The
 * assertions themselves are unchanged. The room case is asserted in its own block below.
 */
const FULL = { ...SHAPE, slots: { C: 1, OF: 2 }, slot_order: ["C", "OF", "OF"] }

const wire = {
	roster: [
		spot("C", "Andy Mask", ["C"]), spot("OF", "Stu Stud", ["OF"]), spot("OF", "Wes Weak", ["OF"])
	],
	rated: [
		rated("Andy Mask", { points: 30, bscore: 30, slots: ["C"] }),
		rated("Stu Stud", { points: 80, bscore: 60, slots: ["OF"] }),
		rated("Wes Weak", { points: 12, bscore: 4, slots: ["OF"] }),
		rated("Free Agent", { points: 90, bscore: 70, slots: ["OF"] })
	],
	availableNames: new Set(["free agent"]),
	shape: FULL,
	options: opts({ minGain: 5, keepFloor: 25, maxMoves: 1 })
}
const wirePlan = planMoves(wire)
t("the best add takes the worst man's spot, never the keeper's",
	wirePlan.moves.length === 1 && wirePlan.moves[0].drop === "Wes Weak" &&
		wirePlan.moves[0].add === "Free Agent",
	JSON.stringify(wirePlan.moves))
/* Taking Wes Weak off leaves two men in three seats, so there is now ROOM — and the
   claim has to be stated as what it always meant. It read "0 moves", which was a proxy
   for "nobody was dropped" that only held while a full roster was the only case. With a
   seat free the planner correctly offers a pure add, and the thing that must never
   happen is a man at or above the keep floor being offered up for it. */
{
	const spared = planMoves({ ...wire, roster: wire.roster.filter(s => s.name !== "Wes Weak") })
	t("nobody at or above the keep floor is ever offered up",
		spared.moves.every(m => m.drop === null), JSON.stringify(spared.moves))
	t("and the explanation says which of the two reasons it is",
		spared.notes.some(n => /keep floor/.test(n)) || spared.notes.some(n => /seats are free/.test(n)),
		JSON.stringify(spared.notes))
}

/* ---------------- rail: nobody comes out while a seat is free ---------------- */

/*
 * THE MOST EXPENSIVE SENTENCE THE PRODUCT EVER PRINTED.
 *
 * Measured by a stranger walking the published build on a phone: 18 men, 27 seats
 * (18 active + 5 bench + 4 injured, read off My league), and the card said
 *
 *     Empty seats — 4 seats score nothing tonight
 *     Make these moves — +20.76  Add JJ Bleday for your OF or Util seat, drop Aaron Judge
 *
 * twelve inches apart. Five seats were open. Nobody had to come out, the card had
 * already said so in its own words, and a reader told to drop Aaron Judge for JJ Bleday
 * closes the tab and is right to.
 *
 * `planSwaps` and `planMoves` never asked how many men the roster may hold. They do now,
 * and they fill the free seats first. The gain on a pure add is quoted as the arriving
 * man's bscore, which UNDERSTATES it — an empty seat scores zero, not replacement level
 * — and understating is the safe direction as well as the one that keeps every number in
 * the planner in one unit.
 */
{
	const room = {
		roster: [spot("C", "My Catcher", ["C"]), spot("OF", "My Fielder", ["OF"])],
		rated: [
			rated("My Catcher", { points: 40, bscore: 30, slots: ["C"] }),
			rated("My Fielder", { points: 40, bscore: 30, slots: ["OF"] }),
			rated("Free Bat", { points: 70, bscore: 40, slots: ["OF"] })
		],
		availableNames: new Set(["free bat"]),
		// four seats, two men
		shape: shape({ C: 1, OF: 2, BN: 1 }, { C: ["C"], OF: ["OF"], BN: "any" },
			["C", "OF", "OF", "BN"]),
		options: opts({ minGain: 5, keepFloor: 25, maxMoves: 1 })
	}
	const p = planMoves(room)
	t("with a seat free the add is an add, and nobody is offered up for it",
		p.moves.length === 1 && p.moves[0].kind === "add" && p.moves[0].drop === null,
		JSON.stringify(p.moves))
	t("and it says so, rather than leaving the reader to count his own seats",
		p.notes.some(n => /seats are free/.test(n)), JSON.stringify(p.notes))
	/* The rails have to agree with the planner, or the audit is checking a different rule
	   from the one that ships. `railViolations` wants a whole plan, so this asks for one. */
	const whole = plan(room)
	t("the audit passes a move with no drop",
		railViolations(whole, room).length === 0, railViolations(whole, room).join(" | "))
	t("and catches one that claims a drop it does not have",
		railViolations(
			{ ...whole, moves: [{ ...whole.moves[0], drop: "My Catcher", dropScore: null }] },
			room
		).length > 0,
		railViolations(
			{ ...whole, moves: [{ ...whole.moves[0], drop: "My Catcher", dropScore: null }] },
			room
		).join(" | "))
	// and the same roster with every seat taken goes back to trading one man for another
	const full = {
		...room,
		// two seats, two men — and My Fielder at 30 has to be under the keep floor for
		// anyone to be offered up at all, which is the OTHER rail and is asserted above
		rated: room.rated.map(r => (r.player.name === "My Fielder" ? { ...r, bscore: 4 } : r)),
		shape: shape({ C: 1, OF: 1 }, { C: ["C"], OF: ["OF"] }, ["C", "OF"])
	}
	const q = planMoves(full)
	t("with every seat taken it trades, which is the case it was always tested on",
		q.moves.length === 1 && q.moves[0].kind === "add-drop" && q.moves[0].drop === "My Fielder",
		JSON.stringify({ moves: q.moves, notes: q.notes }))
}

/* ---------------- rail: the move cap ---------------- */

const churn = {
	roster: ["A", "B", "C", "D"].map((n, i) => spot("OF", `Weak ${n}`, ["OF"])),
	rated: [
		...["A", "B", "C", "D"].map(n => rated(`Weak ${n}`, { bscore: 2, slots: ["OF"] })),
		...["W", "X", "Y", "Z"].map(n => rated(`Star ${n}`, { bscore: 70, slots: ["OF"] }))
	],
	availableNames: new Set(["star w", "star x", "star y", "star z"]),
	shape: SHAPE,
	options: opts({ maxMoves: 1 })
}
t("at most --max-moves are ever proposed, however many upgrades exist",
	planMoves(churn).moves.length === 1, String(planMoves(churn).moves.length))
t("raising the cap raises the count, so the cap is what is doing the work",
	planMoves({ ...churn, options: opts({ maxMoves: 3 }) }).moves.length === 3)
t("no player is added or dropped twice inside one run",
	new Set(planMoves({ ...churn, options: opts({ maxMoves: 3 }) }).moves.map(m => m.add)).size === 3)

/* ---------------- rail: the minimum gain ---------------- */

const thin = {
	...wire,
	rated: wire.rated.map(r => r.player.name === "Free Agent" ? { ...r, bscore: 7 } : r),
	options: opts({ minGain: 5, keepFloor: 25, maxMoves: 1 })
}
t("a swap below the minimum gain is not proposed",
	planMoves({ ...thin, options: opts({ minGain: 5 }) }).moves.length === 0)
t("the near miss is reported with its actual margin",
	planMoves({ ...thin, options: opts({ minGain: 5 }) }).notes.some(n => /gains 3/.test(n)),
	JSON.stringify(planMoves(thin).notes))
t("lowering the bar lets the same swap through, so the bar is what is doing the work",
	planMoves({ ...thin, options: opts({ minGain: 2 }) }).moves.length === 1)
t("every proposed gain is the arithmetic it claims to be",
	wirePlan.moves.every(m => Math.abs(m.gain - (m.addScore - m.dropScore)) < 0.01))

/* ---------------- rail: never add a man on the IL ---------------- */

const ilWire = {
	...wire,
	rated: [...wire.rated, rated("Hurt Ace", { points: 200, bscore: 120, slots: ["OF"], injury: "Injured 60-Day" })],
	availableNames: new Set(["free agent", "hurt ace"])
}
const ilPlan = planMoves(ilWire)
t("the best free agent on the board is not proposed when MLB lists him on the IL",
	ilPlan.moves.length === 1 && ilPlan.moves[0].add === "Free Agent",
	JSON.stringify(ilPlan.moves))
t("and he is named as the reason the obvious add was passed over",
	ilPlan.notes.some(n => /Hurt Ace/.test(n) && /Injured 60-Day/.test(n)), JSON.stringify(ilPlan.notes))
t("a player already on your roster is never proposed as an add",
	planMoves({ ...wire, availableNames: new Set(["free agent", "stu stud"]) })
		.moves.every(m => m.add !== "Stu Stud"))
t("a man with no projection is never proposed as an add",
	planMoves({ ...wire, rated: wire.rated.map(r =>
		r.player.name === "Free Agent" ? { ...r, rateable: false } : r) }).moves.length === 0)

/* ---------------- the audit catches what the planner might stop catching ---------------- */

const full = plan(wire)
t("a real plan passes its own audit", railViolations(full, wire).length === 0,
	JSON.stringify(railViolations(full, wire)))

const forged = (move, lineup) => ({
	lineup: { ...full.lineup, ...(lineup ?? {}) },
	moves: [{ kind: "add-drop", add: "Free Agent", addScore: 70, drop: "Wes Weak", dropScore: 4, gain: 66, reason: "", ...(move ?? {}) }],
	skipped: [], notes: []
})
const caught = (name, forgery, pattern, input = wire) =>
	t(`the audit catches ${name}`,
		railViolations(forgery, input).some(v => pattern.test(v)),
		JSON.stringify(railViolations(forgery, input)))

caught("a drop above the keep floor", forged({ drop: "Stu Stud", dropScore: 60, gain: 10 }), /keep floor/)
/* THE OLD TRUTH: this matched /on the IL/, because every value the `injury` field could hold
   was an injured-list status. src/data/injuries.ts now also reads options, designations,
   outrights and releases off MLB's transactions feed — an optioned man cannot appear in a
   major-league box score either, and calling him "on the IL" would be a false sentence. So the
   rail says what the field means, and quotes MLB's own words for why. The claim is unchanged:
   a man the feed says cannot play is never proposed as an add. */
caught("an add MLB says cannot play",
	forged({ add: "Hurt Ace", addScore: 120, gain: 116 }), /cannot play \(Injured 60-Day\)/, ilWire)
caught("an add nobody could actually claim", forged({ add: "Some Guy", addScore: 70 }), /free-agent pool/)
caught("a swap below the bar", forged({ addScore: 5, gain: 1 }), /below the 5 bar/)
caught("a gain that is not the difference it claims", forged({ gain: 66.5 }), /is not/)
caught("more moves than the cap",
	{ ...full, moves: [...forged().moves, { ...forged().moves[0], add: "Other Guy", drop: "Andy Mask" }] },
	/above the cap/)
caught("an illegal starter",
	forged(null, { starters: [{ slot: "C", name: "Stu Stud", points: 80 }] }),
	/not legal at C/)
caught("a starter used twice",
	forged(null, { starters: [{ slot: "OF", name: "Stu Stud", points: 80 }, { slot: "Util", name: "Stu Stud", points: 80 }] }),
	/two slots at once/)
caught("more men in a slot than the league has seats",
	forged(null, { starters: [{ slot: "C", name: "Andy Mask", points: 30 }, { slot: "C", name: "Andy Mask", points: 30 }] }),
	/1 seat/)
caught("a starter who is not even on the roster",
	forged(null, { starters: [{ slot: "OF", name: "Hurt Man", points: 12 }] }), /not on the roster/)

const ilAudit = {
	...wire,
	rated: wire.rated.map(r => r.player.name === "Stu Stud" ? { ...r, injury: "Injured 15-Day" } : r)
}
t("the audit catches a starter MLB lists on the IL",
	railViolations(forged(null, { starters: [{ slot: "OF", name: "Stu Stud", points: 80 }] }), ilAudit)
		.some(v => /started while on the IL/.test(v)))

/* ---------------- what resolveRoster admits it does not know ---------------- */

const resolved = resolveRoster({
	roster: [spot("OF", "Ed Green", ["OF"]), spot("BN", "Zed Ghost", ["OF"]), spot("BN", "Nu Guy", [])],
	rated: [rated("Ed Green", { points: 45, slots: ["OF"] }), rated("Nu Guy", { points: 5, slots: ["OF"] })],
	availableNames: new Set(),
	shape: SHAPE
})
t("eligibility comes from the league's own slot_accepts, not from a primary position",
	JSON.stringify(resolved[0].legal) === JSON.stringify(["OF", "Util"]),
	JSON.stringify(resolved[0].legal))
t("a man off the board is blocked with the reason, and his slots stay null",
	resolved[1].legal !== null && resolved[1].blocked !== null && resolved[1].rated === undefined)
t("no eligibility read means no legal slots — never a guessed one",
	resolved[2].legal === null && /position eligibility/.test(resolved[2].blocked))

// --- execution gates: the one place in this repo where being wrong is expensive ---
const { permits, alreadyApplied, describeMoves } = await import("../src/auto/execute.ts")

t("dry run is the default and permits nothing",
  (() => { const p = permits({ execute: false, allowDrops: false }); return !p.lineup && !p.moves })())
t("--allow-drops alone still permits nothing",
  (() => { const p = permits({ execute: false, allowDrops: true }); return !p.lineup && !p.moves })(),
  "the drop flag must never be sufficient on its own")
t("--execute permits lineups but withholds add/drop",
  (() => { const p = permits({ execute: true, allowDrops: false }); return p.lineup && !p.moves })())
t("both flags are required before an irreversible action",
  (() => { const p = permits({ execute: true, allowDrops: true }); return p.lineup && p.moves })())
t("every withheld capability says why",
  permits({ execute: false, allowDrops: false }).reasons.length > 0 &&
    permits({ execute: true, allowDrops: false }).reasons.length > 0)

// idempotence is decided from the world, not from a record of what we did — a run
// that half-applied and died leaves no such record
t("a seat already filled correctly is not re-applied",
  alreadyApplied({ start: "Kyle Tucker", startSlot: "OF" },
    [{ name: "Kyle Tucker", slot: "OF" }]))
t("a seat filled by someone else is still pending",
  !alreadyApplied({ start: "Kyle Tucker", startSlot: "OF" },
    [{ name: "Aaron Judge", slot: "OF" }]))
t("the same man in the wrong seat is still pending",
  !alreadyApplied({ start: "Kyle Tucker", startSlot: "OF" },
    [{ name: "Kyle Tucker", slot: "BN" }]))
t("name matching is case-insensitive, since Yahoo's casing is not ours",
  alreadyApplied({ start: "kyle tucker", startSlot: "OF" },
    [{ name: "Kyle Tucker", slot: "OF" }]))

t("add/drop is described for a human rather than clicked",
  describeMoves([{ add: "A", drop: "B", gain: 9 }]).every(s => /by hand/.test(s)))

/* ---------------- a swap reason must not invent a seat ---------------- */

// starts and sits are paired by index — a net accounting of N in and N out — so the
// man coming out need not have been sitting in the seat the man coming in takes.
// The reasons used to assert exactly that, and the shifts that rearrange everyone
// else are what make it false.
const crossSlot = planLineup({
	roster: [
		spot("C", "Andy Mask", ["C"]), spot("1B", "Deb Bag", ["1B"]),
		spot("OF", "Ed Green", ["OF"]), spot("OF", "Fay Weak", ["OF"]),
		spot("Util", "Gil Ok", ["1B"]), spot("BN", "Hal Hot", ["OF"])
	],
	rated: [
		rated("Andy Mask", { points: 30, slots: ["C"] }), rated("Deb Bag", { points: 40, slots: ["1B"] }),
		rated("Ed Green", { points: 45, slots: ["OF"] }), rated("Fay Weak", { points: 12, slots: ["OF"] }),
		rated("Gil Ok", { points: 35, slots: ["1B"] }), rated("Hal Hot", { points: 55, slots: ["OF"] })
	],
	availableNames: new Set(),
	shape: SHAPE
})
t("a swap reason never claims the man coming out vacated the seat being taken",
	crossSlot.swaps.every(w => !w.reason.includes("is being vacated by")),
	JSON.stringify(crossSlot.swaps.map(w => w.reason)))
t("and it still names both men, both numbers and the seat", (() => {
	const w = crossSlot.swaps[0]
	return !!w && w.reason.includes(w.start) && w.reason.includes(w.sit) &&
		w.reason.includes(String(w.startPoints)) && w.reason.includes(w.startSlot)
})(), JSON.stringify(crossSlot.swaps))

/* ---------------- the two halves of a plan must agree ---------------- */

// planLineup ranks on projected points and planMoves on bscore, so the only legal
// body at a scarce slot is routinely started AND below the keep floor. Before the
// halves were introduced, one run could say START him and DROP him, and the audit
// passed it — an operator following both instructions ends the week with an empty
// seat.
const contradiction = {
	roster: [
		spot("C", "Solo Catcher", ["C"]), spot("1B", "Deb Bag", ["1B"]),
		spot("OF", "Ed Green", ["OF"]), spot("OF", "Fay Weak", ["OF"]),
		spot("Util", "Gil Ok", ["OF"])
	],
	rated: [
		rated("Solo Catcher", { points: 82, bscore: 8, slots: ["C"] }),
		rated("Deb Bag", { points: 40, bscore: 40, slots: ["1B"] }),
		rated("Ed Green", { points: 45, bscore: 45, slots: ["OF"] }),
		rated("Fay Weak", { points: 30, bscore: 30, slots: ["OF"] }),
		rated("Gil Ok", { points: 25, bscore: 26, slots: ["OF"] }),
		rated("Better Catcher", { points: 90, bscore: 41, slots: ["C"] })
	],
	availableNames: new Set(["better catcher"]),
	/* Exactly these five seats. SHAPE has ten, so five men left five free, and
	   `planSwaps` now fills a free seat before it offers anybody up — which is right, and
	   turns every assertion in this block into a test of a case it is not about. Every
	   claim below is about WHO COMES OUT when somebody must. */
	shape: { ...SHAPE, slots: { C: 1, "1B": 1, OF: 2, Util: 1 }, slot_order: ["C", "1B", "OF", "OF", "Util"] }
}
const both = plan(contradiction)
const startedNames = new Set(both.lineup.starters.map(s => s.name))
t("the only body at a scarce slot is not dropped by the same run that starts him",
	!both.moves.some(m => startedNames.has(m.drop)),
	JSON.stringify({ starters: [...startedNames], moves: both.moves.map(m => `${m.add}/${m.drop}`) }))
t("and the plan says why he was spared rather than leaving a silent gap",
	both.notes.some(n => n.includes("Solo Catcher") && n.includes("keep floor")),
	JSON.stringify(both.notes))
t("and it names the upgrade the sparing cost, so the operator can make it by hand",
	both.notes.some(n =>
		n.includes("Solo Catcher") && n.includes("Better Catcher") && n.includes("33") &&
			n.includes("by hand")),
	JSON.stringify(both.notes))
t("a run that spares everyone below the floor does not then claim nobody was below it",
	!both.notes.some(n => n.includes("nobody on the roster is below")) &&
		both.notes.some(n => n.includes("everyone below the 25 keep floor is in this run's lineup")),
	JSON.stringify(both.notes))
t("a plan that does contradict itself is caught by the audit", (() => {
	const forged = {
		...both,
		moves: [{
			kind: "add-drop", add: "Better Catcher", addScore: 41, drop: "Solo Catcher",
			dropScore: 8, gain: 33, reason: "forged"
		}]
	}
	return railViolations(forged, contradiction)
		.some(v => v.includes("started and dropped in the same plan"))
})())
t("protecting a starter does not block a move against anyone else", (() => {
	// Hot Bat takes the Util seat, so Gil Ok is on the roster, below the floor, and
	// NOT in the lineup — exactly the man the move half exists to trade away
	const spare = {
		...contradiction,
		roster: [...contradiction.roster, spot("BN", "Hot Bat", ["OF"])],
		// six men, six seats — still full, so this stays a test of the drop choice
		shape: {
			...contradiction.shape,
			slots: { ...contradiction.shape.slots, BN: 1 },
			slot_order: [...contradiction.shape.slot_order, "BN"]
		},
		rated: [
			...contradiction.rated.map(r => (r.player.name === "Gil Ok" ? { ...r, bscore: 3 } : r)),
			rated("Hot Bat", { points: 70, bscore: 50, slots: ["OF"] }),
			rated("Free Bat", { points: 60, bscore: 44, slots: ["OF"] })
		],
		availableNames: new Set(["better catcher", "free bat"])
	}
	const p = plan(spare)
	const started = new Set(p.lineup.starters.map(s => s.name))
	return !started.has("Gil Ok") && p.moves.some(m => m.drop === "Gil Ok") &&
		!p.moves.some(m => m.drop === "Solo Catcher")
})())

// normalizeName is the join key every add/drop decision runs through: plan.ts
// looks a roster spot up by it, and looks the addable pool up by it. It used to
// carry two straight apostrophes in its punctuation class where one of them was
// meant to be the curly U+2019, so a Yahoo spelling of Ke\u2019Bryan Hayes kept the
// character, matched nothing, and dropped him with no error. Both spellings must
// collapse to one key.
t("normalizeName strips the curly apostrophe as well as the straight one",
	normalizeName("Ke\u2019Bryan Hayes") === "kebryan hayes" &&
	normalizeName("Ke'Bryan Hayes") === "kebryan hayes",
	`${normalizeName("Ke\u2019Bryan Hayes")} vs ${normalizeName("Ke'Bryan Hayes")}`)
t("so the two spellings of a name are the same join key",
	normalizeName("O\u2019Neill Cruz") === normalizeName("O'Neill Cruz"),
	`${normalizeName("O\u2019Neill Cruz")} vs ${normalizeName("O'Neill Cruz")}`)
t("and the rest of the key is unchanged: accents, suffix, case, spacing",
	normalizeName("Ronald Acu\u00f1a Jr.") === "ronald acuna" &&
	normalizeName("  Travis  d\u2019Arnaud  ") === "travis darnaud",
	`${normalizeName("Ronald Acu\u00f1a Jr.")} | ${normalizeName("  Travis  d\u2019Arnaud  ")}`)

/**
 * `planSwaps` — an add is worth what your LINEUP is worth afterwards.
 *
 * `planMoves` scores `add.bscore - drop.bscore` and will not drop anyone it is
 * starting, because it decided the lineup before the move and nothing would seat
 * the arriving man. Both of those are wrong, and they are wrong together: the
 * upgrades it declines are exactly the ones at positions you play.
 */
{
  const board = [
    rated("My Catcher", { points: 10, bscore: -30, slots: ["C"] }),
    rated("My First", { points: 40, bscore: -5, slots: ["1B"] }),
    rated("Free Catcher", { points: 60, bscore: 10, slots: ["C"] }),
    rated("Free Bench Bat", { points: 5, bscore: -50, slots: ["1B"] })
  ]
  const input = {
    roster: [spot("C", "My Catcher", ["C"]), spot("1B", "My First", ["1B"])],
    rated: board,
    availableNames: new Set(["free catcher", "free bench bat"].map(normalizeName)),
    available: [
      { name: "Free Catcher", positions: ["C"] },
      { name: "Free Bench Bat", positions: ["1B"] }
    ],
    /* Two seats, two men — FULL, which is what this block has always been about. It
       carried two bench seats as well, so with `planSwaps` now filling a free seat before
       it takes anybody out (see the room block above) the right answer became a pure add
       and the claim below stopped being exercised at all. The bench seats are gone; the
       assertions are unchanged. */
    shape: shape({ C: 1, "1B": 1 }, { C: ["C"], "1B": ["1B"] }, ["C", "1B"]),
    options: { ...DEFAULTS, maxMoves: 1 }
  }

  const r = planSwaps(input)
  t("it drops a man it is STARTING when the arrival fills his seat better",
    r.moves[0]?.drop === "My Catcher" && r.moves[0]?.add === "Free Catcher",
    JSON.stringify(r.moves))
  t("and the gain is the lineup's, in points, not a bscore gap",
    Math.abs(r.moves[0].gain - 50) < 0.01, String(r.moves[0]?.gain))

  // planMoves, on the same input, declines it and says so
  const old = planMoves(input, new Set([normalizeName("My Catcher")]))
  /* "no moves" was the old form of this claim, and it stopped being the right form once
     `planSwaps` and `planMoves` fill a free seat before offering anybody up: this roster
     is two men in four seats, so a pure add is correct and appears. What the claim is
     about is the SWAP — `planMoves` will not drop a man it is starting — so it is stated
     as that, plus the note it owes. */
  t("the older planner declines that same swap because it is starting him",
    old.moves.every(m => m.drop === null) && old.notes.some(n => /starting him/.test(n)),
    JSON.stringify({ moves: old.moves, notes: old.notes }))

  // a man who would ride the bench is worth nothing, and bscore cannot see that
  const benchOnly = planSwaps({
    ...input,
    availableNames: new Set([normalizeName("Free Bench Bat")]),
    available: [{ name: "Free Bench Bat", positions: ["1B"] }]
  })
  t("a free agent who would not crack the lineup is worth nothing and is refused",
    !benchOnly.moves.length, JSON.stringify(benchOnly.moves))

  // the keep floor is the one rail carried over from planMoves unchanged
  const starRoster = {
    ...input,
    rated: [
      rated("My Star", { points: 10, bscore: 99, slots: ["C"] }),
      rated("Free Catcher", { points: 60, bscore: 10, slots: ["C"] })
    ],
    roster: [spot("C", "My Star", ["C"])]
  }
  t("a man above the keep floor is never offered up, whatever the arithmetic says",
    !planSwaps(starRoster).moves.length, JSON.stringify(planSwaps(starRoster).moves))

  /*
   * A man safe on EITHER horizon is safe.
   *
   * The keep floor is a bscore and bscore is denominated in the window it was rated
   * over, so the same 25 protects a different set of men depending on how long the
   * window is. On the shipped roster, 5 of 21 sit below it over a fortnight and 12
   * do over the league's own six-day period — Juan Soto among them. A short week
   * must not be enough to offer up one of the best hitters in baseball, and the week
   * cannot see that, because within the week it is true that he is not worth much.
   */
  const protectedRun = planSwaps(input, 60, new Set([normalizeName("My Catcher")]))
  t("a man the caller protects is never offered up, however low this window rates him",
    !protectedRun.moves.some(m => m.drop === "My Catcher"), JSON.stringify(protectedRun.moves))
  t("and holding him is said out loud rather than leaving a silent gap",
    protectedRun.notes.some(n => /My Catcher/.test(n) && /rest of the season/.test(n)),
    JSON.stringify(protectedRun.notes))
  t("however many are held, it is one note rather than one line each",
    protectedRun.notes.filter(n => /keep floor over this window/.test(n)).length === 1,
    JSON.stringify(protectedRun.notes))

  /*
   * Ties go to the man worth least, and ties are the common case: two men both out
   * of the lineup cost the same to lose — nothing — so the swap gains the same
   * either way. The search used to take whichever it reached first, which put two
   * players on opposite sides of an arbitrary choice at identical gain.
   */
  {
    const tie = {
      ...input,
      rated: [
        // the two differ on POINTS, which is the one scale shared across slots;
        // bscore is points minus a per-slot bar and those bars are not comparable
        rated("Keeper", { points: 9, bscore: -40, slots: ["1B"] }),
        rated("Scrub", { points: 5, bscore: -1, slots: ["1B"] }),
        rated("Starter", { points: 50, bscore: 20, slots: ["C"] }),
        rated("Free Catcher", { points: 60, bscore: 10, slots: ["C"] })
      ],
      roster: [
        spot("C", "Starter", ["C"]),
        spot("BN", "Keeper", ["1B"]),
        spot("BN", "Scrub", ["1B"])
      ],
      availableNames: new Set([normalizeName("Free Catcher")]),
      available: [{ name: "Free Catcher", positions: ["C"] }],
      shape: shape({ C: 1, BN: 2 }, { C: ["C"], BN: "any" }, ["C", "BN", "BN"])
    }
    const r = planSwaps(tie)
    t("at equal gain it gives up the man worth least, not whichever it reached first",
      r.moves[0]?.drop === "Scrub", JSON.stringify(r.moves))
  }

  /*
   * The cap is a rail, not a judgement about the third move. A reader deciding
   * whether to spend one of the other adds his league allows is entitled to know
   * what the next one was worth — reported, never made, because a planner that
   * quietly exceeded its own cap because the next gain looked good would be the
   * churn the cap exists to stop.
   */
  {
    const many = {
      ...input,
      rated: [
        rated("Mine A", { points: 1, bscore: -50, slots: ["C"] }),
        rated("Mine B", { points: 1, bscore: -50, slots: ["1B"] }),
        rated("Mine C", { points: 1, bscore: -50, slots: ["OF"] }),
        rated("Free A", { points: 90, bscore: 5, slots: ["C"] }),
        rated("Free B", { points: 80, bscore: 5, slots: ["1B"] }),
        rated("Free C", { points: 70, bscore: 5, slots: ["OF"] })
      ],
      roster: [spot("C", "Mine A", ["C"]), spot("1B", "Mine B", ["1B"]), spot("OF", "Mine C", ["OF"])],
      availableNames: new Set(["Free A", "Free B", "Free C"].map(normalizeName)),
      available: [
        { name: "Free A", positions: ["C"] },
        { name: "Free B", positions: ["1B"] },
        { name: "Free C", positions: ["OF"] }
      ],
      shape: shape({ C: 1, "1B": 1, OF: 1, BN: 2 },
        { C: ["C"], "1B": ["1B"], OF: ["OF"], BN: "any" }, ["C", "1B", "OF", "BN", "BN"]),
      options: { ...DEFAULTS, maxMoves: 2 }
    }
    const r = planSwaps(many)
    t("it stops at the cap even when a third move would gain",
      r.moves.length === 2, JSON.stringify(r.moves.map(m => m.add)))
    t("and says what the third would have been worth rather than leaving it silent",
      /* The note is now conditional on the sign, because it was emitted for a negative
         too: "a third move would gain -14.62 more on top of these two — 2 a week is where
         the measurement put the cap, not where the gains stop", observed on the published
         build, which calls a loss a gain and denies the very thing the number shows. This
         case is the positive one and the wording is unchanged for it. */
      r.notes.some(n => /third move would gain [\d.]+ more/.test(n)), JSON.stringify(r.notes))
  }

  // names alone cannot seat anyone, so they cannot price a swap either
  const noEligibility = planSwaps({ ...input, available: undefined })
  t("with no eligibility beside the names it refuses rather than guessing a seat",
    !noEligibility.moves.length && noEligibility.notes.some(n => /names only/.test(n)),
    JSON.stringify(noEligibility.notes))

  // a man already yours is not an add
  const dupe = planSwaps({
    ...input,
    availableNames: new Set([normalizeName("My First")]),
    available: [{ name: "My First", positions: ["1B"] }]
  })
  t("a player already on the roster is never proposed as an add",
    !dupe.moves.length, JSON.stringify(dupe.moves))
}

/**
 * `seatedInnings` — the quantity a weekly innings floor is a question about.
 *
 * A league that sets one forfeits its pitching side under it, so a plan that drops
 * arms can break it. Advice that clears you on the roster you have and then tells
 * you to drop two pitchers has checked the wrong roster.
 */
{
  const arms = [
    rated("Ace", { group: "pitching", slots: ["SP", "P"] }),
    rated("Middle", { group: "pitching", slots: ["SP", "P"] }),
    rated("Benchwarmer", { group: "pitching", slots: ["SP", "P"] }),
    rated("Bat", { slots: ["OF"] })
  ]
  arms[0].projection = { stats: { outs: 18 } }   // six innings
  arms[1].projection = { stats: { outs: 16 } }   // five and a third
  arms[2].projection = { stats: { outs: 30 } }   // ten, and on the bench
  arms[3].projection = { stats: { outs: 99 } }   // a hitter; must not be counted

  t("it counts the outs of seated pitchers, in thirds",
    seatedInnings(arms, [{ slot: "SP", name: "Ace" }, { slot: "P", name: "Middle" }]) ===
      Number(((18 + 16) / 3).toFixed(1)),
    String(seatedInnings(arms, [{ slot: "SP", name: "Ace" }, { slot: "P", name: "Middle" }])))
  t("a pitcher on the bench throws innings for nobody",
    seatedInnings(arms, [
      { slot: "SP", name: "Ace" },
      { slot: "BN", name: "Benchwarmer" }
    ]) === 6,
    String(seatedInnings(arms, [{ slot: "SP", name: "Ace" }, { slot: "BN", name: "Benchwarmer" }])))
  t("nor does one on the injured list",
    seatedInnings(arms, [{ slot: "IL", name: "Ace" }]) === 0)
  t("a hitter in a seat contributes no innings, whatever his line says",
    seatedInnings(arms, [{ slot: "OF", name: "Bat" }]) === 0)
  t("and dropping a seated arm lowers it, which is the whole point",
    seatedInnings(arms, [{ slot: "SP", name: "Ace" }, { slot: "P", name: "Middle" }]) >
      seatedInnings(arms, [{ slot: "SP", name: "Ace" }]),
    "")
  t("an unrateable pitcher is not counted, because he has no projection to count",
    seatedInnings(
      [{ ...arms[0], rateable: false }],
      [{ slot: "SP", name: "Ace" }]
    ) === 0)
}

/* ── the seat a designated hitter can hold ───────────────────────────────────
 *
 * A seat's `accepts` list names eligibility POSITIONS. Util's list is every batter
 * position the league rosters — C, 1B, 2B, 3B, SS, OF — and a designated hitter has
 * none of them, because he has no fielding position at all. `slotsFor` gives him
 * "Util" and nothing else, correctly: Util is genuinely the only seat he can hold.
 * And "Util" is not in Util's own accepts list, so the one man the seat exists for
 * matched nothing and could be seated nowhere. Measured on the committed capture
 * with a pasted roster: Josh Bell, stored as [Util], unseatable.
 *
 * Naming a seat is the strongest claim there is that you can sit in it, so it wins
 * wherever it is made — and it costs nothing, because no eligibility line writes a
 * seat's name unless it means that seat.
 */
{
  const accepts = {
    C: ["C"], "1B": ["1B"], OF: ["OF"],
    Util: ["C", "1B", "2B", "3B", "SS", "OF"],
    SP: ["SP"], RP: ["RP"], P: ["SP", "RP"],
    BN: "any", IL: "injured_only"
  }
  const legal = (...pos) => legalSlotsFor(pos, accepts).sort().join(",")
  t("a designated hitter reaches the Util seat, which is the only one he can hold",
    legal("Util") === "Util", legal("Util"))
  t("an outfielder still reaches OF and Util through the accepts list",
    legal("OF", "Util") === "OF,Util", legal("OF", "Util"))
  t("a starter reaches SP and P",
    legal("SP", "P") === "P,SP", legal("SP", "P"))
  // The seat name is an addition, not a replacement: a token that is nobody's seat
  // and nobody's position still earns nothing.
  t("a token that is neither a position nor a seat earns no seat",
    legal("CF") === "", legal("CF"))
  t("and a man with no tokens at all is seated nowhere, rather than everywhere",
    legal() === "", legal())
}

// --- what the platform will still accept, once some games have started -------------
//
// A plan is made for an evening and read in the middle of one. The case that made this a
// function rather than four lines inside the card is the SHIFT: a card cannot easily be
// driven into producing one, and getting it wrong empties a seat silently. Three synthetic
// plans, one per direction of the rule.

/** A plan shaped like `planLineup`'s output, with only the parts the freeze reads. */
const planOf = (swaps, shifts = []) => ({ swaps, shifts })
const swap = (start, sit, startSlot, gain) => ({
  start, sit, startSlot, gain, startPoints: gain, sitPoints: 0, reason: ""
})

// ONE. His own game has started, so he cannot be seated — and the man he was replacing
// must not be benched into an empty seat either. Both halves go, or neither does.
{
  const f = freezeShut(
    planOf([swap("Late Arrival", "Sitting Duck", "SS", 7.1)]),
    ["Late Arrival", "Sitting Duck"],
    n => n === "Late Arrival"
  )
  t("a man whose game has started is frozen", f.frozen.has(normalizeName("Late Arrival")))
  t("and so is the man who was coming out for him, or the seat ends up empty",
    f.frozen.has(normalizeName("Sitting Duck")), [...f.frozen].join(","))
  t("the points that change was worth are no longer promised", near2(f.lostToLocks, 7.1), String(f.lostToLocks))
}

// TWO. The man going OUT is the one who has started. Same rule from the other side: his
// seat cannot be emptied, so the man who was coming in cannot be seated there.
{
  const f = freezeShut(
    planOf([swap("Eager Sub", "Already Playing", "SS", 4)]),
    ["Eager Sub", "Already Playing"],
    n => n === "Already Playing"
  )
  t("a seat whose man is already playing takes its incoming man with it",
    f.frozen.has(normalizeName("Eager Sub")) && f.frozen.has(normalizeName("Already Playing")),
    [...f.frozen].join(","))
  t("and nothing is reported as stuck, because nobody was in the way", f.stuck.length === 0)
}

// THREE. THE SHIFT. A man already in the lineup was going to move out of SS to make room,
// and his game has started, so he is staying in SS. The swap into SS is illegal now even
// though the incoming man's own game has not started — and the reason is a different
// sentence, so it comes back in a different list.
{
  const f = freezeShut(
    planOf(
      [swap("Blocked Man", null, "SS", 6.5), swap("Unrelated", "Spare", "OF", 2)],
      [{ name: "Cannot Move", from: "SS", to: "2B" }]
    ),
    ["Blocked Man", "Unrelated", "Spare"],
    n => n === "Cannot Move"
  )
  t("a swap into the seat a stuck man is sitting in is frozen",
    f.frozen.has(normalizeName("Blocked Man")), [...f.frozen].join(","))
  t("and it is reported as stuck, naming the man in the way",
    f.stuck.length === 1 && f.stuck[0].in === "Blocked Man" && f.stuck[0].mover === "Cannot Move",
    JSON.stringify(f.stuck))
  t("the shift itself is not asked for", !f.shifts.some(s => s.name === "Cannot Move"), JSON.stringify(f.shifts))
  t("a change with nothing to do with it is still offered",
    !f.frozen.has(normalizeName("Unrelated")) && !f.frozen.has(normalizeName("Spare")), [...f.frozen].join(","))
  t("and only the frozen change's points come off the promise", near2(f.lostToLocks, 6.5), String(f.lostToLocks))
}

// FOUR. A shift whose only purpose was to free a seat nobody is now taking is a move with
// no effect, and a card that asks for one spends the reader's trust on nothing.
{
  const f = freezeShut(
    planOf([swap("Locked Out", null, "SS", 9)], [{ name: "Free Mover", from: "SS", to: "2B" }]),
    ["Locked Out"],
    n => n === "Locked Out"
  )
  t("a shift freeing a seat nobody will take is dropped too",
    f.shifts.length === 0, JSON.stringify(f.shifts))
}

// And with nothing started at all, a plan comes back exactly as it went in.
{
  const p = planOf([swap("A", "B", "SS", 3)], [{ name: "C", from: "OF", to: "Util" }])
  const f = freezeShut(p, ["A", "B", "C"], () => false)
  t("an evening nobody has started yet freezes nothing",
    f.frozen.size === 0 && f.stuck.length === 0 && f.shifts.length === 1 && f.lostToLocks === 0,
    JSON.stringify({ frozen: [...f.frozen], stuck: f.stuck, shifts: f.shifts, lost: f.lostToLocks }))
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LEAGUE'S OWN LIMITS, AND THE PLANNER OBEYING THEM.
 *
 * `maxMoves` is a JUDGEMENT — two a week, because two measured best across 111 weeks —
 * and a league's "Max Acquisitions per Week" is a RULE: exceed it and the platform
 * refuses the claim. The planner knew only the first, so in a league capped at one it
 * would offer two and the reader could act on half the card.
 *
 * This was nearly unreachable before the browser reader: the settings rows exist only
 * for a league somebody had fetched or pasted, which almost nobody had. A reader who
 * connects now hands over his settings page in the same press that brings his roster,
 * so both numbers are his league's own — which is why this is worth enforcing now and
 * was not worth building before.
 * ─────────────────────────────────────────────────────────────────────────────
 */
{
  const { deriveMoveLimit, deriveInningsMinimum, leagueLimits } = await import("../src/import.ts")
  const { leagueFromSettingsText } = await import("../src/data/paste-settings.ts")
  const real = JSON.parse(readFileSync("scoring.json", "utf8")).leagues["yahoo:228947"]

  /*
   * FIRST, THAT THE NUMBERS SURVIVE THE ROUTE THEY NOW ARRIVE BY.
   *
   * The reader hands over the settings page as TEXT — what a browser gives for the
   * page a person is looking at, which for a table is one row per line with tabs
   * between the cells. So the fixture is built the way test/settings.mjs builds it, out
   * of the rows the league really carries, and the two derivations are run on what
   * comes back out of the parser rather than on the stored map. That is the join that
   * could silently break: `leagueFromSettingsText` keeps every `Label<tab>value` row
   * verbatim, and both derivations look their row up by its exact label.
   */
  const asText = Object.entries(real.league_rules.raw_settings)
    .map(([k, v]) => `${k}\t${v}`).join("\n")
  const parsed = leagueFromSettingsText(asText).settings
  t("the settings page as text still carries every row the league stated",
    Object.keys(parsed).length === Object.keys(real.league_rules.raw_settings).length,
    `${Object.keys(parsed).length} of ${Object.keys(real.league_rules.raw_settings).length}`)
  t("the weekly acquisition cap is read off that text, not typed",
    deriveMoveLimit(parsed).perPeriod === 6, JSON.stringify(deriveMoveLimit(parsed)))
  t("and so is the weekly innings floor",
    deriveInningsMinimum(parsed).perPeriod === 20, JSON.stringify(deriveInningsMinimum(parsed)))
  t("and both quote the row they came from, so a screen can say where the number is from",
    deriveMoveLimit(parsed).source.includes("6") &&
      deriveInningsMinimum(parsed).source.includes("20"),
    `${deriveMoveLimit(parsed).source} | ${deriveInningsMinimum(parsed).source}`)

  // one call for the pair, which is what the planner is handed
  const limits = leagueLimits(real)
  t("leagueLimits reads both off the league in one call",
    limits.movesPerPeriod === 6 && limits.inningsPerPeriod === 20 && limits.sources.length === 2,
    JSON.stringify(limits))
  // A league whose page said neither: null is UNLIMITED and NO FLOOR, never zero.
  const silent = leagueLimits({ league_rules: { raw_settings: {} } })
  t("a league whose page stated neither gets null for both, which is not zero",
    silent.movesPerPeriod === null && silent.inningsPerPeriod === null && !silent.sources.length,
    JSON.stringify(silent))

  /* ── the cap arithmetic ─────────────────────────────────────────────────── */
  t("a league stricter than the planner's default is what binds",
    movesAllowed(opts({ maxMoves: 2 }), { movesPerPeriod: 1, inningsPerPeriod: null })
      .cap === 1)
  t("and it says the league is why, because that is a limit the reader cannot raise",
    movesAllowed(opts({ maxMoves: 2 }), { movesPerPeriod: 1, inningsPerPeriod: null })
      .byLeague === true)
  t("a league more generous than the default leaves the measured default standing",
    movesAllowed(opts({ maxMoves: 2 }), { movesPerPeriod: 6, inningsPerPeriod: null })
      .cap === 2 &&
      !movesAllowed(opts({ maxMoves: 2 }), { movesPerPeriod: 6, inningsPerPeriod: null }).byLeague)
  t("an unstated cap is unlimited, so the default stands",
    movesAllowed(opts({ maxMoves: 2 }), { movesPerPeriod: null, inningsPerPeriod: null })
      .cap === 2 &&
      movesAllowed(opts({ maxMoves: 2 }), undefined).cap === 2)
  /* A league that allows NO in-season acquisitions is a real answer, and it is the one
     a "0 means unset" reading gets exactly backwards: it would hand such a reader the
     default two moves, both of which his league will refuse. */
  t("a league that allows no acquisitions at all allows none, rather than falling back to two",
    movesAllowed(opts({ maxMoves: 2 }), { movesPerPeriod: 0, inningsPerPeriod: null }).cap === 0)

  /* ── the planners, on a roster where three moves are all worth making ───── */
  const board = [
    rated("Mine A", { points: 1, bscore: -50, slots: ["C"] }),
    rated("Mine B", { points: 1, bscore: -50, slots: ["1B"] }),
    rated("Mine C", { points: 1, bscore: -50, slots: ["OF"] }),
    rated("Free A", { points: 90, bscore: 40, slots: ["C"] }),
    rated("Free B", { points: 80, bscore: 30, slots: ["1B"] }),
    rated("Free C", { points: 70, bscore: 20, slots: ["OF"] })
  ]
  const three = {
    roster: [spot("C", "Mine A", ["C"]), spot("1B", "Mine B", ["1B"]), spot("OF", "Mine C", ["OF"])],
    rated: board,
    availableNames: new Set(["Free A", "Free B", "Free C"].map(normalizeName)),
    available: [
      { name: "Free A", positions: ["C"] },
      { name: "Free B", positions: ["1B"] },
      { name: "Free C", positions: ["OF"] }
    ],
    shape: shape({ C: 1, "1B": 1, OF: 1 }, { C: ["C"], "1B": ["1B"], OF: ["OF"] }, ["C", "1B", "OF"]),
    options: opts({ maxMoves: 3 })
  }
  t("with no league limit the planner makes the moves its own cap allows",
    planSwaps(three).moves.length === 3, JSON.stringify(planSwaps(three).moves.map(m => m.add)))
  const capped = planSwaps({ ...three, limits: { movesPerPeriod: 1, inningsPerPeriod: null } })
  t("a league that allows one acquisition a week gets one move, not three",
    capped.moves.length === 1, JSON.stringify(capped.moves.map(m => m.add)))
  t("and the card says the league is what stopped it, not a backtest",
    capped.notes.some(n => /league allows 1 acquisition a week/.test(n)), JSON.stringify(capped.notes))
  /* The sentence about the move it did NOT make used to read "N a week is where the
     measurement put the cap, not where the gains stop" whatever the cap was — an
     invitation to raise a number the reader's league sets and he cannot. */
  t("and the note about the next move does not invite him to raise a limit he does not own",
    !capped.notes.some(n => /where the measurement put the cap/.test(n)) &&
      capped.notes.some(n => /all your league allows/.test(n)),
    JSON.stringify(capped.notes))
  // the older planner is under the same rule
  const cappedOld = planMoves({ ...three, limits: { movesPerPeriod: 1, inningsPerPeriod: null } })
  t("the older planner obeys the league's cap too",
    cappedOld.moves.length <= 1, JSON.stringify(cappedOld.moves.map(m => m.add)))

  /* ── and the rail catches a plan that broke it ──────────────────────────── */
  const forged = {
    lineup: { starters: [], swaps: [], shifts: [], gain: 0, pointsPlanned: 0, emptySlots: [], skipped: [], blocked: null },
    moves: planSwaps(three).moves,
    skipped: [],
    notes: []
  }
  t("a plan with three moves passes the audit in a league that allows three",
    !railViolations(forged, { ...three, limits: { movesPerPeriod: 3, inningsPerPeriod: null } })
      .some(v => /above the cap/.test(v)),
    JSON.stringify(railViolations(forged, { ...three, limits: { movesPerPeriod: 3, inningsPerPeriod: null } })))
  /* The rail audited `options.maxMoves` alone, so this exact plan — three moves, in a
     league that allows one, planned with a generous default — passed its own audit. */
  t("and the same plan is caught in a league that allows one",
    railViolations(forged, { ...three, limits: { movesPerPeriod: 1, inningsPerPeriod: null } })
      .some(v => /above the cap of 1 your league allows/.test(v)),
    JSON.stringify(railViolations(forged, { ...three, limits: { movesPerPeriod: 1, inningsPerPeriod: null } })))

  /* ── the innings floor: reported, never enforced ────────────────────────── */
  {
    /*
     * A ROSTER WHERE THE BEST MOVE IS THE ONE THAT EMPTIES THE MOUND.
     *
     * Two seats, both full. The outfielder is above the keep floor and cannot be offered
     * up, so the only man who can come out is the arm — and the free agent is worth so
     * much more than either that taking him is right on points even with the pitching
     * seat left empty: 200 against the 115 the roster projects now. That is the exact
     * shape an innings floor is broken by, and every number on the card gets better
     * while it happens, which is why it needs saying out loud.
     */
    const arms = [
      rated("My Arm", { points: 20, bscore: -50, slots: ["SP", "P"], group: "pitching" }),
      rated("Free Bat", { points: 200, bscore: 40, slots: ["OF"] })
    ]
    arms[0].projection = { stats: { outs: 60 } }   // twenty innings, and he is the only arm
    arms[1].projection = { stats: {} }
    const swapArmForBat = {
      roster: [spot("SP", "My Arm", ["SP"]), spot("OF", "Keep Me", ["OF"])],
      rated: [...arms, rated("Keep Me", { points: 95, bscore: 99, slots: ["OF"] })],
      availableNames: new Set([normalizeName("Free Bat")]),
      available: [{ name: "Free Bat", positions: ["OF"] }],
      shape: shape({ SP: 1, OF: 1 }, { SP: ["SP"], OF: ["OF"] }, ["SP", "OF"]),
      options: opts({ maxMoves: 1 })
    }
    const quiet = planSwaps(swapArmForBat)
    t("a league that sets no innings floor is told nothing about innings",
      !quiet.notes.some(n => /innings/.test(n)), JSON.stringify(quiet.notes))
    const loud = planSwaps({
      ...swapArmForBat,
      limits: { movesPerPeriod: null, inningsPerPeriod: 20 }
    })
    /* THE MOVE IS STILL MADE. The planner cannot know how many innings his staff has
       already thrown this period — that is on his team page and no reader here opens it
       — so declining a good move on a guess at it would be worse than naming the risk.
       What changes is that the risk is named. */
    t("a move that takes an arm out of the lineup is still offered",
      loud.moves.length === quiet.moves.length, JSON.stringify(loud.moves.map(m => m.add)))
    t("the move it makes really is the one that takes the arm out",
      loud.moves.length === 1 && loud.moves[0].drop === "My Arm" &&
        loud.moves[0].add === "Free Bat",
      JSON.stringify(loud.moves.map(m => `${m.add} for ${m.drop}`)))
    t("but the innings it costs are reported, against the floor the league stated",
      loud.notes.some(n => /projected innings over this window/.test(n) && /20 a week/.test(n)),
      JSON.stringify(loud.notes))
    /* The number, not just the shape of the sentence: his one arm's 60 outs are twenty
       innings, and after the move nobody in a seat throws any. A note that said
       "from 0 to 0" would pass a regex for the words and tell the reader nothing. */
    t("and it quotes both sides of the fall, so the sentence carries the fact",
      loud.notes.some(n => /from 20 to 0 projected innings/.test(n)), JSON.stringify(loud.notes))
  }
}

console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
