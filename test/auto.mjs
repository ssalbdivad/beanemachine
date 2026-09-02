// The autonomous manager's safety rails, asserted against constructed rosters.
// Pure planning only: no network, no Playwright, no snapshot. Every rail here is
// a thing Billy must never do on a real team, so each is checked twice — once by
// asserting the planner does not do it, and once by handing railViolations a plan
// that does it and asserting the audit catches it.
import {
	activeSlots, DEFAULTS, plan, planLineup, planMoves, railViolations, resolveRoster
} from "../src/auto/plan.ts"

let pass = 0, fail = 0
const t = (n, ok, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : "  " + x}`) }

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
	shape: SHAPE,
	options: opts({ minGain: 5, keepFloor: 25, maxMoves: 1 })
}
const wirePlan = planMoves(wire)
t("the best add takes the worst man's spot, never the keeper's",
	wirePlan.moves.length === 1 && wirePlan.moves[0].drop === "Wes Weak" &&
		wirePlan.moves[0].add === "Free Agent",
	JSON.stringify(wirePlan.moves))
t("nobody at or above the keep floor is ever offered up",
	planMoves({ ...wire, roster: wire.roster.filter(s => s.name !== "Wes Weak") }).moves.length === 0)
t("and the empty move list explains itself rather than looking like a failed read",
	planMoves({ ...wire, roster: wire.roster.filter(s => s.name !== "Wes Weak") })
		.notes.some(n => /keep floor/.test(n)))

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
caught("an add MLB lists on the IL",
	forged({ add: "Hurt Ace", addScore: 120, gain: 116 }), /on the IL/, ilWire)
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
	shape: SHAPE
}
const both = plan(contradiction)
const startedNames = new Set(both.lineup.starters.map(s => s.name))
t("the only body at a scarce slot is not dropped by the same run that starts him",
	!both.moves.some(m => startedNames.has(m.drop)),
	JSON.stringify({ starters: [...startedNames], moves: both.moves.map(m => `${m.add}/${m.drop}`) }))
t("and the plan says why he was spared rather than leaving a silent gap",
	both.notes.some(n => n.includes("Solo Catcher") && n.includes("keep floor")),
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

console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
