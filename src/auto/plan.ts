import type { Rated } from "../engine/bscore.ts"
import type { RosterSpot } from "./roster.ts"
import { normalizeName } from "../data/yahoo-pool.ts"

/**
 * Turns a ranked board plus your actual roster into what Billy would do: the
 * starting lineup he would set, and the add/drop he would make.
 *
 * Deliberately conservative, and the rails are stated as code rather than as
 * intentions — `railViolations` re-checks the finished plan against every one of
 * them, so a plan that breaks its own rules is withheld instead of printed. An
 * autonomous agent operating on someone's team should be boring.
 *
 * Nothing here touches the network. It is a pure function of the roster Yahoo
 * rendered, the rated board and the league's own roster shape, which is what
 * makes the rails testable against constructed rosters.
 */

export interface Move {
	kind: "add-drop"
	add: string
	addScore: number
	drop: string
	dropScore: number
	gain: number
	reason: string
}

export interface PlanOptions {
	/** Minimum bscore improvement before a swap is worth making. */
	minGain: number
	/** Never drop anyone at or above this bscore, whatever the alternative. */
	keepFloor: number
	/**
	 * Hard cap on moves per run.
	 *
	 * One is both the safe default and the measured optimum. Played across 2023-2025,
	 * bscore wins the season outright at one waiver move per week (41 of 68 weeks
	 * against season-to-date) and loses its edge entirely at three, where naive
	 * streak-chasing beats it. The model is worth using for one high-conviction move,
	 * not for churn.
	 */
	maxMoves: number
	/**
	 * Minimum projected points a lineup change must be worth.
	 *
	 * Zero on purpose, and it is a decision rather than an omission: the churn the
	 * move cap exists to prevent is a property of add/drops — a dropped player is
	 * gone and a waiver claim is spent. Sitting one of your own players costs
	 * nothing and is undone in one click, so there is no reason to require a
	 * margin. Raise it if you would rather not read about half-point changes.
	 */
	lineupMinGain: number
}

/**
 * maxMoves is 2 because that is what measured best, not because two feels safe.
 *
 * An earlier version of this project shipped 1 and claimed selectivity beat
 * activity. Re-measured across 111 weeks and five seasons against every opponent
 * the simulator plays, two moves a week beats one on all of them — 63 of 111
 * weeks against a thoughtful human versus 60 at one move, and better against the
 * two streak-chasers and the naive manager as well. Three is worse than two
 * (58/111), so the curve does have a peak; it is just not at one.
 *
 * The honest caveat: the simulator charges nothing for churn. A real league
 * spends waiver priority or FAAB on every claim, and this number does not know
 * that. If your league makes moves expensive, lower it.
 */
export const DEFAULTS: PlanOptions = { minGain: 5, keepFloor: 25, maxMoves: 2, lineupMinGain: 0 }

/** What a slot will accept, as the league's own settings page states it. */
export type SlotAccepts = string[] | "any" | "injured_only"

/**
 * The league's real roster shape, read from the league and stored in scoring.json.
 *
 * Passed in rather than derived, because a lineup planned against an assumed
 * roster shape is exactly the kind of plausible, unsourced answer this project
 * refuses to produce.
 */
export interface RosterShape {
	slots: Record<string, number>
	slot_order: string[] | null
	slot_accepts: Record<string, SlotAccepts> | null
}

export interface PlanInput {
	/** Your team, as Yahoo actually rendered it. */
	roster: RosterSpot[]
	/** The whole rated board — your players and everyone else's. */
	rated: Rated[]
	/** Normalised names of the free agents you could actually add. */
	availableNames: Set<string>
	shape: RosterShape
	options?: PlanOptions
}

const r2 = (n: number): number => Number(n.toFixed(2))

/** Yahoo writes the reserve slots as IL, IL+ and NA. Nobody in one is startable
 *  and nobody in one is dropped, so they are held out of every plan. */
export const isReserve = (slot: string): boolean => /^(IL|NA)/i.test(slot.trim())
export const isBench = (slot: string): boolean => /^BN$/i.test(slot.trim())

/**
 * Every startable seat, one entry per seat.
 *
 * `slot_order` is used when the league gave us one, because it is the order Yahoo
 * itself lists the slots in and keeps the printed lineup recognisable; the counts
 * are the fallback and produce the same multiset.
 */
export const activeSlots = (shape: RosterShape): string[] =>
	shape.slot_order ?
		shape.slot_order.filter(s => !isReserve(s) && !isBench(s))
	:	Object.entries(shape.slots).flatMap(([slot, count]) =>
			isReserve(slot) || isBench(slot) ? [] : Array.from({ length: count }, () => slot)
		)

/** The startable slots a set of eligibility positions can legally fill. `any` and
 *  `injured_only` are the bench and the IL, which are not startable seats. */
export const legalSlotsFor = (
	positions: string[],
	accepts: Record<string, SlotAccepts>
): string[] =>
	Object.entries(accepts).flatMap(([slot, accept]) =>
		Array.isArray(accept) && accept.some(p => positions.includes(p)) ? [slot] : []
	)

export interface Resolved {
	spot: RosterSpot
	rated: Rated | undefined
	/** Startable slots he may legally fill, from the league's own `slot_accepts`
	 *  crossed with the eligibility Yahoo prints beside his name. Null when either
	 *  source was missing — never inferred from his primary position. */
	legal: string[] | null
	/** Why he cannot be started, when a source says he cannot play. */
	unavailable: string | null
	/** Why he cannot be planned with at all, when he cannot. */
	blocked: string | null
}

/** Joins the roster Yahoo rendered to the rated board, and says what is missing. */
export const resolveRoster = (input: PlanInput): Resolved[] => {
	const byName = new Map(input.rated.map(r => [normalizeName(r.player.name), r]))
	const accepts = input.shape.slot_accepts
	return input.roster.map(spot => {
		const rated = byName.get(normalizeName(spot.name))
		const legal =
			!accepts || !spot.positions.length ? null : legalSlotsFor(spot.positions, accepts)
		const blocked =
			!rated ? "not on the board — no projection exists for him, so Billy will not move him"
			: !rated.rateable ? "no projection could be made for him, so he has no number to compare"
			: !accepts ?
				"the league's slot_accepts table is absent from scoring.json, so no slot's rules are known"
			: !spot.positions.length ?
				"Yahoo printed no position eligibility beside his name, so no slot can be proven legal for him"
			: legal && !legal.length ?
				`Yahoo lists him at ${spot.positions.join("/")}, which fills none of this league's slots`
			:	null
		// Two independent sources, and either one is enough to sit him. The
		// projection knows neither: it assumes everyone plays the whole horizon.
		const unavailable =
			rated?.injury ? `MLB lists him ${rated.injury}`
			: /^IL/i.test(spot.status.trim()) && spot.status.trim() ? `Yahoo flags him ${spot.status}`
			: null
		return { spot, rated, legal, unavailable, blocked }
	})
}

/**
 * The best legal lineup, not merely a good one.
 *
 * What a player is worth does not depend on which seat he fills, so the startable
 * sets form a transversal matroid and taking players in descending projected
 * points — keeping each one that still leaves a legal assignment for everyone
 * already kept — is provably optimal. Filling slots in order is not: even
 * scarcest-first benches a 40-point catcher to put a 50-point corner infielder in
 * the C slot when he was the only man who could cover 1B.
 *
 * Which legal seat each man ends up in is free once the set is chosen, so each is
 * offered the seat he is already in first. That is not cosmetic: without it the
 * planner reports a man moving from Util to OF for no points at all, and a
 * proposal you have to talk yourself out of is worse than no proposal.
 *
 * Returns slot index → candidate index; candidates must arrive best-first.
 */
const seatEveryone = (
	legalByCandidate: string[][],
	seats: string[],
	currentSeat: (string | null)[]
): Map<number, number> => {
	const held = new Map<number, number>()
	const order = legalByCandidate.map((_, ci) =>
		seats
			.map((slot, si) => ({ si, mine: slot === currentSeat[ci] }))
			.sort((a, b) => Number(b.mine) - Number(a.mine) || a.si - b.si)
			.map(x => x.si)
	)
	const seat = (ci: number, tried: Set<number>): boolean => {
		for (const si of order[ci]!) {
			if (tried.has(si) || !legalByCandidate[ci]!.includes(seats[si]!)) continue
			tried.add(si)
			const sitting = held.get(si)
			if (sitting === undefined || seat(sitting, tried)) {
				held.set(si, ci)
				return true
			}
		}
		return false
	}
	for (let ci = 0; ci < legalByCandidate.length; ci++) seat(ci, new Set())
	return held
}

export interface Starter {
	slot: string
	name: string
	points: number
}

/** A man leaving the lineup. `points` is null when his projection is known but
 *  refused — he is not going to play, so it is not what he will produce. */
export interface LineupExit {
	name: string
	points: number | null
	why: string | null
}

export interface LineupSwap {
	start: string
	startPoints: number
	startSlot: string
	/** Null when the seat was empty, so nobody has to come out for him. */
	sit: string | null
	sitPoints: number | null
	gain: number
	reason: string
}

export interface LineupPlan {
	/** The lineup Billy would set. Empty only when none could be planned. */
	starters: Starter[]
	swaps: LineupSwap[]
	/** Everyone coming out of the lineup, whether or not a swap paired them with an
	 *  incoming man — a seat freed by a shift would otherwise go unreported. */
	sits: LineupExit[]
	/** Players staying in the lineup but changing seat to make a swap legal. */
	shifts: { name: string; from: string; to: string }[]
	pointsNow: number
	pointsPlanned: number
	gain: number
	/** Startable seats no rostered player can legally fill. */
	emptySlots: string[]
	/** Everyone left out of the planning, each with the reason. */
	skipped: string[]
	/** Set when no lineup could be planned at all. An already-optimal lineup is
	 *  not blocked — it is a plan with no swaps, and the two must not read alike. */
	blocked: string | null
}

const noLineup = (blocked: string): LineupPlan => ({
	starters: [],
	swaps: [],
	sits: [],
	shifts: [],
	pointsNow: 0,
	pointsPlanned: 0,
	gain: 0,
	emptySlots: [],
	skipped: [],
	blocked
})

/**
 * Which of your own players should be in the lineup this period.
 *
 * The highest-value autonomous action available, and the one a manager actually
 * forgets: it is fully reversible, it cannot lose you a player, and a bench spot
 * scores nothing at all. Ranked on projected POINTS rather than bscore, because
 * the replacement subtraction exists to compare a player against the waiver wire
 * — a question that is already settled for men you own.
 */
export const planLineup = (input: PlanInput): LineupPlan => {
	const options = input.options ?? DEFAULTS
	const accepts = input.shape.slot_accepts
	if (!accepts)
		return noLineup(
			"the league's slot_accepts table is absent from scoring.json, so which players may " +
				"fill which slots is unknown — re-import the league before Billy sets a lineup"
		)
	const seats = activeSlots(input.shape)
	if (!seats.length)
		return noLineup("the league's roster shape lists no startable slots, so there is no lineup to set")
	if (!input.roster.length)
		return noLineup("no roster rows were given, so there is nobody to put in a lineup")
	// Today's lineup is half of every swap. A row whose slot cell did not parse
	// means we cannot say who is starting now, and a plan built on that would
	// confidently propose changes that may already be in place.
	const unslotted = input.roster.filter(s => !s.slot.trim()).map(s => s.name)
	if (unslotted.length)
		return noLineup(
			`the slot cell did not parse for ${unslotted.join(", ")}, so today's lineup cannot be ` +
				`established and no change to it can be proposed`
		)

	const skipped: string[] = []
	const pool: { spot: RosterSpot; rated: Rated; legal: string[]; points: number }[] = []
	const heldSeats: string[] = []
	const vacated: { name: string; why: string }[] = []
	for (const r of resolveRoster(input)) {
		if (isReserve(r.spot.slot)) {
			if (!r.unavailable && r.rated)
				skipped.push(
					`${r.spot.name}: parked in the ${r.spot.slot} slot but no source lists him hurt — ` +
						`he may be activatable, which Billy will not do for you`
				)
			continue
		}
		if (r.blocked) {
			skipped.push(`${r.spot.name}: ${r.blocked}`)
			// He keeps his seat: Billy knows too little about him to move him, so
			// the rest of the lineup is optimised around where he already is.
			if (!isBench(r.spot.slot)) heldSeats.push(r.spot.slot)
			continue
		}
		if (r.unavailable) {
			skipped.push(
				`${r.spot.name}: ${r.unavailable}` +
					(isBench(r.spot.slot) ? " — not started"
					:	" — sat down, and counted as zero in today's lineup, because his projection " +
						"assumes he plays the whole horizon")
			)
			// He is coming out of a seat somebody else will fill, so he is named as
			// that seat's outgoing man rather than leaving it looking empty.
			if (!isBench(r.spot.slot)) vacated.push({ name: r.spot.name, why: r.unavailable })
			continue
		}
		pool.push({ spot: r.spot, rated: r.rated!, legal: r.legal!, points: r.rated!.points })
	}

	const open = [...seats]
	for (const slot of heldSeats) {
		const i = open.indexOf(slot)
		if (i >= 0) open.splice(i, 1)
	}

	// name order only to keep an exact tie deterministic between runs
	const ranked = [...pool].sort(
		(a, b) => b.points - a.points || a.spot.name.localeCompare(b.spot.name)
	)
	const held = seatEveryone(
		ranked.map(c => c.legal),
		open,
		ranked.map(c => (isBench(c.spot.slot) ? null : c.spot.slot))
	)

	const starters: Starter[] = []
	const seatedBy = new Map<string, string>()
	for (const si of [...held.keys()].sort((a, b) => a - b)) {
		const c = ranked[held.get(si)!]!
		starters.push({ slot: open[si]!, name: c.spot.name, points: r2(c.points) })
		seatedBy.set(normalizeName(c.spot.name), open[si]!)
	}
	const emptySlots = open.filter((_, si) => !held.has(si))

	const startingNow = pool.filter(c => !isBench(c.spot.slot))
	const pointsNow = r2(startingNow.reduce((a, c) => a + c.points, 0))
	const pointsPlanned = r2(starters.reduce((a, s) => a + s.points, 0))
	const gain = r2(pointsPlanned - pointsNow)

	const starts = pool
		.filter(c => isBench(c.spot.slot) && seatedBy.has(normalizeName(c.spot.name)))
		.sort((a, b) => b.points - a.points)
	// Everyone leaving the lineup, worst first, so the best addition is paired with
	// the seat that costs least to empty. A man no source says will play leads,
	// with a null rather than a number: his projection is known and is refused.
	const sits: LineupExit[] = [
		...vacated.map(v => ({ name: v.name, points: null, why: v.why })),
		...startingNow
			.filter(c => !seatedBy.has(normalizeName(c.spot.name)))
			.sort((a, b) => a.points - b.points)
			.map(c => ({ name: c.spot.name, points: r2(c.points), why: null }))
	]
	const shifts = pool.flatMap(c => {
		const to = seatedBy.get(normalizeName(c.spot.name))
		return to === undefined || isBench(c.spot.slot) || to === c.spot.slot ?
				[]
			:	[{ name: c.spot.name, from: c.spot.slot, to }]
	})

	const swaps: LineupSwap[] = starts.map((start, i) => {
		const out = sits[i]
		const startSlot = seatedBy.get(normalizeName(start.spot.name))!
		return {
			start: start.spot.name,
			startPoints: r2(start.points),
			startSlot,
			sit: out?.name ?? null,
			sitPoints: out?.points ?? null,
			gain: r2(start.points - (out?.points ?? 0)),
			reason:
				!out ?
					`${startSlot} is empty and ${start.spot.name} is eligible there, so ${r2(start.points)} ` +
					`projected points are currently being left on the bench.`
				: out.points === null ?
					`${startSlot} is being vacated by ${out.name} (${out.why}), whose own projection ` +
					`assumes he plays and so is not credited against ${start.spot.name}'s ${r2(start.points)}.`
				:	`${start.spot.name} projects ${r2(start.points)} points over the horizon at ` +
					`${startSlot} against ${out.name}'s ${out.points}, and both are ` +
					`already yours — the swap costs nothing and is undone in one click.`
		}
	})

	// A man no source says will play comes out whatever the bar says. The bar decides
	// whether a marginal optimisation is worth reading about; it does not get to
	// leave a seat held by somebody who is not going to fill it.
	if (!vacated.length && swaps.length + shifts.length > 0 && gain < options.lineupMinGain)
		return {
			starters,
			swaps: [],
			sits: [],
			shifts: [],
			pointsNow,
			pointsPlanned,
			gain,
			emptySlots,
			skipped: [
				...skipped,
				`the best legal lineup is worth ${gain} more than today's, below the ` +
					`${options.lineupMinGain}-point lineup bar, so the lineup is left alone`
			],
			blocked: null
		}

	return {
		starters,
		swaps,
		sits,
		shifts,
		pointsNow,
		pointsPlanned,
		gain,
		emptySlots,
		skipped,
		blocked: null
	}
}

export interface MovePlan {
	moves: Move[]
	skipped: string[]
	/** Why there is no move, when there is none. An empty move list is a decision
	 *  and says so; it is never the shape a failed read leaves behind. */
	notes: string[]
}

export const planMoves = (
	input: PlanInput,
	/**
	 * Normalised names the lineup half of the run is counting on.
	 *
	 * The two halves rank on different quantities — the lineup on projected points,
	 * because a seat you leave empty scores nothing, and the moves on bscore,
	 * because a waiver body is what a dropped man is replaced by — and until they
	 * were introduced they could contradict each other in one run. A man who is the
	 * only legal body at a scarce slot is routinely below the keep floor AND started,
	 * so the plan would say START him and DROP him at once. He is protected here, and
	 * the note says why rather than leaving a silent gap where a move should be.
	 */
	protect: ReadonlySet<string> = new Set()
): MovePlan => {
	const options = input.options ?? DEFAULTS
	const resolved = resolveRoster(input)
	const skipped: string[] = []
	const notes: string[] = []

	const onRoster = new Set(input.roster.map(s => normalizeName(s.name)))
	const rostered = resolved.filter(r => !isReserve(r.spot.slot))
	for (const r of rostered) if (r.blocked) skipped.push(`${r.spot.name}: ${r.blocked}`)

	const belowFloor = rostered
		.flatMap(r => (r.rated && r.rated.rateable ? [{ ...r, rated: r.rated }] : []))
		.filter(r => r.rated.bscore < options.keepFloor)
		.sort((a, b) => a.rated.bscore - b.rated.bscore)
	const started = belowFloor.filter(r => protect.has(normalizeName(r.spot.name)))
	const droppable = belowFloor.filter(r => !protect.has(normalizeName(r.spot.name)))
	for (const r of started)
		notes.push(
			`${r.spot.name} is ${r.rated.bscore}, below the ${options.keepFloor} keep floor, but ` +
				`this run is starting him — dropping a man the lineup needs would leave the seat ` +
				`empty, so he is not offered up`
		)

	const free = input.rated.filter(
		r => r.rateable && input.availableNames.has(normalizeName(r.player.name))
	)
	const injuredFree = free
		.filter(r => r.injury)
		.sort((a, b) => b.bscore - a.bscore)
	const addable = free
		.filter(r => !r.injury && !onRoster.has(normalizeName(r.player.name)))
		.sort((a, b) => b.bscore - a.bscore)

	if (!input.availableNames.size)
		notes.push("the free-agent pool is empty, so no add was possible")
	if (injuredFree[0])
		notes.push(
			`${injuredFree[0].player.name} (bscore ${injuredFree[0].bscore}) is the best free agent ` +
				`on the board and is never proposed: MLB lists him ${injuredFree[0].injury}`
		)
	if (!droppable.length)
		notes.push(
			started.length ?
				`everyone below the ${options.keepFloor} keep floor is in this run's lineup, so ` +
					`nothing was offered up`
			:	`nobody on the roster is below the ${options.keepFloor} keep floor, so nothing was ` +
					`offered up`
		)

	const moves: Move[] = []
	const usedAdds = new Set<string>()
	let bestSeen: { gain: number; add: string; drop: string } | null = null
	for (const drop of droppable) {
		if (moves.length >= options.maxMoves) break
		// Yahoo's own eligibility when we could read it; the projection's single
		// primary position only as a stated fallback, never as a silent one.
		const dropSlots = drop.legal ?? drop.rated.slots
		const source = drop.legal ? "Yahoo's own eligibility" : "his primary position, since Yahoo's eligibility could not be read"
		const best = addable.find(
			a =>
				!usedAdds.has(a.player.id.toString()) &&
				// only swap like for like, so the roster stays legal
				a.slots.some(s => dropSlots.includes(s))
		)
		if (!best) continue
		const gain = r2(best.bscore - drop.rated.bscore)
		if (!bestSeen || gain > bestSeen.gain)
			bestSeen = { gain, add: best.player.name, drop: drop.spot.name }
		if (gain < options.minGain) continue
		usedAdds.add(best.player.id.toString())
		moves.push({
			kind: "add-drop",
			add: best.player.name,
			addScore: best.bscore,
			drop: drop.spot.name,
			dropScore: drop.rated.bscore,
			gain,
			reason:
				`${best.player.name} projects ${gain} points higher over the horizon at ` +
				`${best.slot}, and ${drop.spot.name} is ${drop.rated.bscore} — below the ` +
				`${options.keepFloor} keep floor. Slots matched on ${source}.`
		})
	}
	if (!moves.length && bestSeen)
		notes.push(
			`the best legal upgrade, ${bestSeen.add} for ${bestSeen.drop}, gains ${bestSeen.gain} — ` +
				`below the ${options.minGain}-point bar`
		)
	if (!moves.length && droppable.length && !bestSeen)
		notes.push(
			`no free agent on the board can fill a slot belonging to any of the ` +
				`${droppable.length} player(s) below the keep floor`
		)
	return { moves, skipped, notes }
}

export interface Plan {
	lineup: LineupPlan
	moves: Move[]
	skipped: string[]
	notes: string[]
}

export const plan = (input: PlanInput): Plan => {
	const lineup = planLineup(input)
	// the lineup is decided first and the moves are told about it, because a plan
	// that starts a man and drops him in the same breath is worse than no plan
	const { moves, skipped, notes } = planMoves(
		input,
		new Set(lineup.starters.map(s => normalizeName(s.name)))
	)
	return {
		lineup,
		moves,
		skipped: [...new Set([...lineup.skipped, ...skipped])],
		notes
	}
}

/**
 * The rails, re-checked against the finished plan.
 *
 * Stating them in the planner is not the same as keeping them: a refactor can
 * quietly drop a filter and every test that only asserts the happy path will
 * still pass. This audits the output itself, and `run.ts` prints nothing at all
 * when it comes back non-empty. Any string here is a bug, not a warning.
 */
export const railViolations = (result: Plan, input: PlanInput): string[] => {
	const options = input.options ?? DEFAULTS
	const out: string[] = []
	const byName = new Map(input.rated.map(r => [normalizeName(r.player.name), r]))
	const onRoster = new Set(input.roster.map(s => normalizeName(s.name)))
	const reserved = new Set(
		input.roster.flatMap(s => (isReserve(s.slot) ? [normalizeName(s.name)] : []))
	)

	if (result.moves.length > options.maxMoves)
		out.push(`${result.moves.length} moves proposed, above the cap of ${options.maxMoves}`)
	const seenAdd = new Set<string>()
	const seenDrop = new Set<string>()
	for (const m of result.moves) {
		const add = normalizeName(m.add)
		const drop = normalizeName(m.drop)
		const rated = byName.get(drop)
		if (rated && rated.bscore >= options.keepFloor)
			out.push(`${m.drop} is at ${rated.bscore}, at or above the ${options.keepFloor} keep floor`)
		if (m.dropScore >= options.keepFloor)
			out.push(`${m.drop} is reported at ${m.dropScore}, at or above the keep floor`)
		if (m.gain < options.minGain)
			out.push(`${m.add} for ${m.drop} gains ${m.gain}, below the ${options.minGain} bar`)
		if (r2(m.addScore - m.dropScore) !== m.gain)
			out.push(`${m.add} for ${m.drop} reports a gain of ${m.gain} that is not ${m.addScore} − ${m.dropScore}`)
		if (!input.availableNames.has(add)) out.push(`${m.add} is not in the free-agent pool`)
		if (onRoster.has(add)) out.push(`${m.add} is already on the roster`)
		if (byName.get(add)?.injury) out.push(`${m.add} is on the IL (${byName.get(add)!.injury})`)
		if (reserved.has(drop)) out.push(`${m.drop} sits in a reserve slot and must not be dropped`)
		if (!onRoster.has(drop)) out.push(`${m.drop} is not on the roster`)
		if (seenAdd.has(add)) out.push(`${m.add} is added twice`)
		if (seenDrop.has(drop)) out.push(`${m.drop} is dropped twice`)
		// the two halves of a plan must agree about the same man
		if (result.lineup.starters.some(s => normalizeName(s.name) === drop))
			out.push(`${m.drop} is started and dropped in the same plan`)
		seenAdd.add(add)
		seenDrop.add(drop)
	}

	const accepts = input.shape.slot_accepts
	const positions = new Map(input.roster.map(s => [normalizeName(s.name), s.positions]))
	const filled = new Map<string, number>()
	const seenStarter = new Set<string>()
	for (const s of result.lineup.starters) {
		const key = normalizeName(s.name)
		if (!onRoster.has(key)) out.push(`${s.name} is in the lineup but not on the roster`)
		if (seenStarter.has(key)) out.push(`${s.name} is started in two slots at once`)
		seenStarter.add(key)
		if (byName.get(key)?.injury) out.push(`${s.name} is started while on the IL`)
		if (reserved.has(key)) out.push(`${s.name} is started out of a reserve slot`)
		if (accepts) {
			const accept = accepts[s.slot]
			const eligible = positions.get(key) ?? []
			if (!Array.isArray(accept) || !accept.some(p => eligible.includes(p)))
				out.push(`${s.name} (${eligible.join("/") || "no eligibility"}) is not legal at ${s.slot}`)
		}
		filled.set(s.slot, (filled.get(s.slot) ?? 0) + 1)
	}
	for (const [slot, n] of filled) {
		const allowed = input.shape.slots[slot] ?? 0
		if (n > allowed) out.push(`${n} players started at ${slot}, which has ${allowed} seat(s)`)
	}
	if (result.lineup.swaps.length && result.lineup.gain < options.lineupMinGain)
		out.push(
			`the lineup change is worth ${result.lineup.gain}, below the ` +
				`${options.lineupMinGain}-point lineup bar`
		)
	return out
}
