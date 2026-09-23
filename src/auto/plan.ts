import { isReserveSlot, rosterCounts, startableSeats, type Rated } from "../engine/bscore.ts"
import type { RosterSpot } from "./roster.ts"
import { normalizeName } from "../data/yahoo-pool.ts"
import { indexByName } from "../data/names.ts"

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
	/**
	 * `add` when the roster has a free seat, `add-drop` when somebody has to come out.
	 *
	 * There was only ever `add-drop`, and on a roster with room that produced the most
	 * expensive sentence in the product. Measured by a stranger walking the published
	 * build: 18 men against 27 seats, and the card said "4 seats score nothing tonight"
	 * twelve inches above "Add JJ Bleday for your OF or Util seat, drop Aaron Judge".
	 * Five seats were open. Nothing had to come out, the card had already said so in its
	 * own words, and a reader told to drop Aaron Judge for JJ Bleday closes the tab — and
	 * is right to.
	 */
	kind: "add" | "add-drop"
	add: string
	addScore: number
	/** Null on an `add`: the seat was empty, so nobody is displaced. */
	drop: string | null
	dropScore: number | null
	gain: number
	/**
	 * THE SAME GAIN AND THE SAME DROP, PER TEAM GAME — the unit the decision was made in.
	 *
	 * `gain` and `dropScore` are point TOTALS over the window, which is what a reader
	 * wants to see: "worth 14 more points this week" is a sentence he can act on, and
	 * "worth 1.1 more points a game" is not. But the two bars the planner decides by are
	 * per-game now — see `PlanOptions` — so the rails that re-check a move after the fact
	 * have to re-check it in the unit it was decided in, or they are comparing a fortnight
	 * against a bar set for a day.
	 *
	 * Null where a club has no games in the window: there is no per-game rate for a man
	 * who is not playing, and inventing one is how an absence becomes a default.
	 */
	gainPerGame: number | null
	dropPerGame: number | null
	reason: string
	/**
	 * The startable seats the arriving man can fill, as the league's own eligibility
	 * grants them.
	 *
	 * Carried as data rather than left inside `reason` because the two readers want
	 * different shapes: the terminal prints the sentence, and the card needs the
	 * seats on the row and the rationale said once under the list. Rendering the
	 * whole sentence per move put an eight-line paragraph under each of two moves on
	 * a phone, most of it identical.
	 */
	seats?: string[]
}

export interface PlanOptions {
	/**
	 * Minimum improvement before a swap is worth making, PER TEAM GAME.
	 *
	 * It was a bscore total and that made it mean a different thing on every screen.
	 * bscore is an un-normalised point total over whatever window it was rated on, so a
	 * 5-point bar matched 19 men over one day, 64 over this league's six-day period, 88
	 * over a fortnight and 86 over the rest of the season — a four-and-a-half-fold swing
	 * caused by nothing but the length of the window. See `bscorePerGame`.
	 */
	minGain: number
	/**
	 * Never drop anyone at or above this, PER TEAM GAME, whatever the alternative.
	 *
	 * The worse of the two: as a total, 25 matched 2 men over six days and 28 over twenty.
	 * A constant that decides which players the app tells a reader to DROP cannot swing
	 * fourteen-fold on the horizon the reader happens to be looking at.
	 */
	keepFloor: number
	/**
	 * Hard cap on moves per run. See `DEFAULTS` below for why it is 2.
	 *
	 * This docblock used to carry its own account of the measurement, twenty lines above
	 * a different one, and it was the stale copy: it said one move was "both the safe
	 * default and the measured optimum" while `DEFAULTS.maxMoves` shipped 2. It quoted
	 * "41 of 68 weeks against season-to-date", and no run in data/results/ has a 68-week
	 * corpus — the figure cannot be re-derived from anything this repo stores. The
	 * measurement lives in one place now.
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
 * Every figure here re-derives from the stored runs, re-checked on 2026-09-11 by
 * counting weeks where bscore's points beat the opponent's:
 * `data/results/moves2_2021-2022-2023-2024-2025_moves2.json` (111 weeks) gives 63
 * against the thoughtful human, 75 hot-hand, 73 hot-hand+vorp, 80 season-to-date;
 * `anchor-off_..._moves1.json` gives 60 / 74 / 69 / 76; `moves3_..._moves3.json` gives
 * 58. All five comparisons in this paragraph hold.
 *
 * AND THE STRENGTHS ARE NOT THE SAME, which a row of win counts hides. Against the two
 * streak-chasers and the naive manager the result is decisive: 75 of 111 is p = 0.0003
 * on a two-sided sign test, 80 of 111 is below 0.0001. Against a thoughtful human it is
 * SUGGESTIVE AND NOT SIGNIFICANT: 63 of 111 is 56.8% of weeks, p = 0.18, and the one
 * move it is being compared against (60 of 111, p = 0.45) is inside the same noise. So
 * "two beats one" is a preference between two numbers neither of which is established
 * against a good manager, and the choice of 2 rests on it being better against every
 * opponent rather than on any one comparison being strong.
 *
 * The honest caveat: the simulator charges nothing for churn. A real league
 * spends waiver priority or FAAB on every claim, and this number does not know
 * that. If your league makes moves expensive, lower it.
 */
/*
 * THE TWO BARS ARE NOW PER TEAM GAME, and the numbers are the old ones divided by the
 * window they were chosen on.
 *
 * Both were picked while the board's default horizon was a fourteen-day fortnight, which
 * is about 13 team games. 25 / 13 = 1.9 and 5 / 13 = 0.38 — so on the horizon they were
 * tuned for they select exactly the men they always did, and on every OTHER horizon they
 * now select the same KIND of man instead of a different number of them.
 *
 * Rounded to two figures rather than carried to four: the precision of the original 25
 * was one significant figure and dividing it does not create more.
 */
/**
 * A RATED MAN'S SCORE IN THE UNIT THE BARS ARE NOW IN.
 *
 * `bscorePerGame` is null where his club has no games in the window — he cannot clear a
 * per-game bar and he cannot fall below one either, so the honest reading is that he is
 * not a candidate and is not droppable, which is what `Infinity` and `-Infinity` do at
 * the two call sites. Writing the fallback here rather than at each of them is what stops
 * the two disagreeing about what "no games" means.
 */
const perGame = (r: { bscorePerGame?: number | null }): number | null =>
	r.bscorePerGame ?? null

export const DEFAULTS: PlanOptions = { minGain: 0.38, keepFloor: 1.9, maxMoves: 2, lineupMinGain: 0 }

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
	/**
	 * Those same free agents WITH the eligibility your league prints beside each
	 * name, where it could be read.
	 *
	 * A name is enough to rank a man and not enough to seat him. `planSwaps` scores
	 * an add by what your lineup projects once he is in it, and that requires
	 * knowing which seats will take him — which only the platform's own eligibility
	 * says. Optional, because the older `planMoves` needs only the names, and a
	 * caller that cannot supply this gets that planner's like-for-like rule instead
	 * of a guess at where a man may play.
	 */
	available?: { name: string; positions: string[] }[]
	/**
	 * The player ids the reader's roster store says are his, as bare `${id}` strings.
	 *
	 * Purely a tiebreak for the name join, and the only evidence that separates two men
	 * of the same name in the same group — the two Max Muncys in the committed capture.
	 * See the note on `indexByName` in src/data/names.ts for the five keys that collide
	 * and what they cost. Optional because the CLI reads a roster off a rendered page
	 * with no ids on it at all; without it a genuinely ambiguous spot is REFUSED into
	 * `blocked` rather than guessed, which is the same rule as every other absent source
	 * in this file.
	 */
	ownedIds?: ReadonlySet<string>
	shape: RosterShape
	options?: PlanOptions
	/**
	 * THE LEAGUE'S OWN PER-PERIOD RULES, where its settings page states them.
	 *
	 * `options.maxMoves` is a JUDGEMENT — two a week, because two measured best over 111
	 * weeks against every opponent the simulator plays. The league's cap is a RULE: make
	 * more than it allows and the platform refuses the claim. They are different kinds of
	 * number and the planner had only the first, so on a league capped at one acquisition
	 * a week it would cheerfully offer two and the reader could act on exactly half the
	 * card. `movesAllowed` below takes the lower of the two and says which one bit.
	 *
	 * Until the browser reader landed this was nearly unreachable — the rows exist only
	 * for a league somebody had fetched or pasted, which almost nobody had. A reader who
	 * connects now hands over his settings page in the same press that brings his roster,
	 * so both numbers are his league's own. `leagueLimits` in src/import.ts reads them.
	 *
	 * Null in either field means the page did not say, and is read as unlimited moves and
	 * no innings floor — never as zero. Absent altogether is the same thing, which is what
	 * keeps every caller written before this unchanged.
	 */
	limits?: {
		movesPerPeriod: number | null
		inningsPerPeriod: number | null
		/**
		 * CAVEATS THAT TRAVEL WITH THE NUMBER, because a number whose unit was converted is
		 * not the same claim as one the league printed.
		 *
		 * ESPN states an acquisition cap PER DAY on a weekly league, so a cap of six across
		 * the period is six that cannot all be spent on Saturday. The arithmetic is honest and
		 * the constraint it drops is real, so the sentence that prints the cap prints this
		 * beside it. Empty for a Yahoo league, which states the rule in the unit this uses.
		 */
		notes?: string[]
		/**
		 * INNINGS ALREADY THROWN IN THIS SCORING PERIOD, and whether this plan's window is
		 * that period.
		 *
		 * The note below used to end "worth checking against what you have already thrown",
		 * which is the app handing a reader a subtraction it could do itself. It could not,
		 * for two reasons, and both are gone now: nothing read the innings already thrown,
		 * and nothing could say whether the window the plan was rated over was the scoring
		 * period at all. The Tonight card rates over `resolvePeriod`'s own window and reads
		 * the banked innings from MLB's day-by-day record, so for that caller both are
		 * known — and where they are not, the note stays the sentence it was.
		 *
		 * `windowIsPeriod` is stated by the caller rather than inferred, because a plan
		 * rated over a fortnight and a league that scores by the week are a comparison that
		 * looks arithmetically fine and is wrong in fact: 25 innings clears a 20-a-week
		 * floor over a fortnight and misses it badly.
		 */
		inningsBanked?: number | null
		windowIsPeriod?: boolean
	}
}

/**
 * How many moves this run may actually make, and which number decided it.
 *
 * The cap is the LOWER of the measured default and the league's own rule, and the two
 * are reported separately because they mean different things to a reader. `maxMoves`
 * biting is a preference he can raise; his league's cap biting is a fact he cannot.
 *
 * A stated cap of 0 is a real answer — a league that allows no in-season acquisitions
 * at all — and it produces a plan with no moves rather than a plan with the default
 * two. That is why this takes the minimum rather than treating 0 as "unset": `null` is
 * how "unset" is spelled here, exactly as `deriveMoveLimit` spells it.
 */
export const movesAllowed = (
	options: PlanOptions,
	limits: PlanInput["limits"]
): { cap: number; byLeague: boolean } => {
	const stated = limits?.movesPerPeriod
	if (stated === null || stated === undefined) return { cap: options.maxMoves, byLeague: false }
	return stated < options.maxMoves ?
			{ cap: stated, byLeague: true }
		:	{ cap: options.maxMoves, byLeague: false }
}

const r2 = (n: number): number => Number(n.toFixed(2))

/** "a third move", not "a 3 move". Only ever reached for a move cap, so the small
 *  words cover it and anything larger falls back to the digit. */
const ordinal = (n: number): string =>
	["zeroth", "first", "second", "third", "fourth", "fifth", "sixth"][n] ?? `${n}th`

/** BN, and only BN. A bench man is not started and CAN be dropped, which is the
 *  distinction this file needs and `isReserveSlot` deliberately does not make. */
export const isBench = (slot: string): boolean => /^BN$/i.test(slot.trim())

/**
 * The injured and minor-league seats: nobody in one is startable and nobody in one is
 * dropped, so they are held out of every plan.
 *
 * DERIVED from the engine's `isReserveSlot` rather than restated. This was
 * `/^(IL|NA)/i` written out by hand, which is the exact form that has twice lost
 * Yahoo's second injured slot "IL+" — see the note on `isReserveSlot`, which lists what
 * that cost the two components that made the same mistake.
 */
export const isReserve = (slot: string): boolean => isReserveSlot(slot) && !isBench(slot)

/**
 * Every startable seat, one entry per seat.
 *
 * This was a second implementation with the OPPOSITE precedence to the engine's —
 * `slot_order` first, counts as fallback — and the two disagreed by two seats after an
 * ordinary edit in the league editor. `startableSeats` is now the only one; see its
 * note for the measurement.
 */
export const activeSlots = (shape: RosterShape): string[] => startableSeats(shape)

/** The startable slots a set of eligibility positions can legally fill. `any` and
 *  `injured_only` are the bench and the IL, which are not startable seats. */
/**
 * The seats a man may legally fill.
 *
 * Two ways a token earns a seat, and the second one is not redundant.
 *
 * The first is the platform's own rule: the seat's `accepts` list names eligibility
 * POSITIONS, and a man carrying one of them may sit there. That is how a catcher
 * reaches the C seat and how an outfielder reaches Util, whose list is every batter
 * position this league rosters.
 *
 * The second is the seat's own NAME. A designated hitter has no fielding position to
 * be accepted by — `slotsFor` gives him "Util" and nothing else, because Util is
 * genuinely the only seat he can hold — and Util's accepts list is a list of
 * positions, which "Util" is not one of. So the one man the seat exists for matched
 * nothing and could be seated nowhere at all. Measured on the committed capture with
 * a pasted roster: Josh Bell, stored as [Util], unseatable.
 *
 * Naming a seat is the strongest possible claim that you can sit in it, so it wins
 * wherever it is made. It also costs nothing: no eligibility line anywhere writes a
 * seat name unless it means one.
 */
export const legalSlotsFor = (
	positions: string[],
	accepts: Record<string, SlotAccepts>
): string[] =>
	Object.entries(accepts).flatMap(([slot, accept]) =>
		positions.includes(slot) || (Array.isArray(accept) && accept.some(p => positions.includes(p))) ?
			[slot]
		:	[]
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
	/* ONE NAME CAN BE TWO MEN, and a plain Map silently answered with the last of them.
	   See `indexByName` in src/data/names.ts: on the committed capture "Luis Garcia Jr."
	   in a 1B seat resolved to a relief pitcher, because the suffix strip merges him into
	   Luis García. The seat's own printed eligibility settles that one; the reader's
	   owned ids settle two hitters with one name. Anything still plural is refused below
	   rather than guessed — revert this and the wrong man is priced, seated and offered
	   up with no error anywhere. */
	const board = indexByName(input.rated, r => r.player)
	const accepts = input.shape.slot_accepts
	return input.roster.map(spot => {
		const got = board.pick(spot.name, { positions: spot.positions, owned: input.ownedIds })
		const rated = got.row ?? undefined
		const legal =
			!accepts || !spot.positions.length ? null : legalSlotsFor(spot.positions, accepts)
		const blocked =
			got.why === "ambiguous" ?
				`${got.among.length} different players on the board are called ${spot.name}` +
				` — nothing here can say which is yours, so Billy will not move him`
			: !rated ? "not on the board — no projection exists for him, so Billy will not move him"
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
			: /* The engine's own predicate rather than a second hand-rolled `/^IL/i` — see
			     `isReserveSlot`, which exists precisely so there is one of these. It newly
			     catches NA, a man in an active seat whom his league says is not in the
			     majors, and it deliberately does NOT catch DTD or Q, because nothing here
			     can tell whether they will play. `isReserveSlot("")` is false, so an
			     absent flag is still absent. */
			isReserveSlot((spot.status ?? "").trim()) ? `Yahoo flags him ${(spot.status ?? "").trim()}`
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
/* Exported for src/auto/recap.ts, which seats the SAME matroid with actual points
   instead of projected ones. A hindsight lineup written out a second time would be a
   second seating rule, and this file's whole history is two of those disagreeing. */
export const seatEveryone = (
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

	// Paired by index, which makes each swap a line in a NET accounting — N men come
	// in, N go out — and not an exchange of one seat. The man at `sits[i]` may have
	// been sitting in a different slot from the one `starts[i]` takes, with shifts
	// rearranging the rest, so the reasons below say what came in and what went out
	// and never claim that this man vacated that seat.
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
					`${start.spot.name} is eligible at ${startSlot} and nobody has to come out to ` +
					`seat him, so ${r2(start.points)} projected points are currently sitting on ` +
					`your bench.`
				: out.points === null ?
					`${out.name} comes out of the lineup (${out.why}) and ${start.spot.name} goes ` +
					`in at ${startSlot}. ${out.name}'s own projection assumes he plays, so it is ` +
					`not credited against ${start.spot.name}'s ${r2(start.points)}.`
				:	`${start.spot.name} projects ${r2(start.points)} points over the horizon at ` +
					`${startSlot} and ${out.name} projects ${out.points}, so this run seats the ` +
					`first and sits the second — both are already yours, so it costs nothing and ` +
					`is undone in one click.`
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
	/** The lower of the measured default and the league's own rule — see `movesAllowed`. */
	const { cap, byLeague } = movesAllowed(options, input.limits)
	if (byLeague)
		notes.push(
			`your league allows ${cap} acquisition${cap === 1 ? "" : "s"} a week, which is fewer ` +
				`than the ${options.maxMoves} moves this run would otherwise make, so ${cap} is the cap` +
				(input.limits?.notes?.length ? ` — ${input.limits.notes.join(" ")}` : ``)
		)

	const onRoster = new Set(input.roster.map(s => normalizeName(s.name)))
	const rostered = resolved.filter(r => !isReserve(r.spot.slot))
	for (const r of rostered) if (r.blocked) skipped.push(`${r.spot.name}: ${r.blocked}`)

	const belowFloor = rostered
		.flatMap(r => (r.rated && r.rated.rateable ? [{ ...r, rated: r.rated }] : []))
		.filter(r => (perGame(r.rated) ?? Infinity) < options.keepFloor)
		.sort((a, b) => a.rated.bscore - b.rated.bscore)
	const started = belowFloor.filter(r => protect.has(normalizeName(r.spot.name)))
	const droppable = belowFloor.filter(r => !protect.has(normalizeName(r.spot.name)))
	// Protecting him is the safe half of the answer. The useful half is saying what
	// the protection cost: a run that quietly declines an obvious upgrade is worse
	// for the operator than one that declines it out loud, because he can make the
	// move by hand and this planner cannot yet (the lineup is computed against the
	// pre-move roster, so nothing would seat the man who arrives — METHODOLOGY 12.1).
	const protectedNotes = (upgrades: Map<string, { name: string; gain: number }>) => {
		for (const r of started) {
			const up = upgrades.get(normalizeName(r.spot.name))
			notes.push(
				`${r.spot.name} is ${perGame(r.rated)} a game, below the ${options.keepFloor} keep floor, but ` +
					`this run is starting him, and dropping a man the lineup needs would leave the ` +
					`seat empty — so he is not offered up` +
					(up ?
						`. ${up.name} would be worth ${up.gain} more there: a real upgrade, but one ` +
						`that has to be made by hand, because this run seats nobody it adds`
					:	"")
			)
		}
	}

	const free = input.rated.filter(
		r => r.rateable && input.availableNames.has(normalizeName(r.player.name))
	)
	const injuredFree = free
		.filter(r => r.injury)
		.sort((a, b) => b.bscore - a.bscore)
	const addable = free
		.filter(r => !r.injury && !onRoster.has(normalizeName(r.player.name)))
		.sort((a, b) => b.bscore - a.bscore)

	// same like-for-like slot rule the real moves use, so a named upgrade is one that
	// could actually have been made
	protectedNotes(
		new Map(
			started.flatMap(r => {
				const slots = r.legal ?? r.rated.slots
				const best = addable.find(a => a.slots.some(x => slots.includes(x)))
				return best && best.bscore > r.rated.bscore ?
						[[
							normalizeName(r.spot.name),
							{ name: best.player.name, gain: r2(best.bscore - r.rated.bscore) }
						] as const]
					:	[]
			})
		)
	)

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
				`everyone below the ${options.keepFloor}-a-game keep floor is in this run's lineup, so ` +
					`nothing was offered up`
			:	`nobody on the roster is below the ${options.keepFloor}-a-game keep floor, so nothing was ` +
					`offered up`
		)

	const moves: Move[] = []
	const usedAdds = new Set<string>()

	/*
	 * ROOM FIRST. Nobody comes out while a seat is free.
	 *
	 * `room` is every seat the league lets you hold — active, bench and injured — minus
	 * the men actually held. On the walk that found this it was 27 minus 18, and the card
	 * proposed dropping Aaron Judge anyway, twelve inches under its own sentence saying
	 * four seats were scoring nothing.
	 *
	 * The gain is quoted as the arriving man's bscore, which UNDERSTATES it: bscore is
	 * measured against the man who would be left at his spot, and an empty seat scores
	 * zero rather than replacement level. Understating is the safe direction — anybody
	 * who clears the bar against a replacement clears it against nothing — and it keeps
	 * every number in this planner in one unit. Saying the true, larger figure would mean
	 * mixing bscore and raw points in one list, which is the defect the board spent a
	 * whole pass removing.
	 */
	const room = Math.max(0, rosterCounts(input.shape.slots).total - input.roster.length)
	for (const a of addable) {
		if (moves.length >= Math.min(room, cap)) break
		if (usedAdds.has(a.player.id.toString())) continue
		if ((perGame(a) ?? -Infinity) < options.minGain) continue
		usedAdds.add(a.player.id.toString())
		moves.push({
			kind: "add",
			add: a.player.name,
			addScore: a.bscore,
			drop: null,
			dropScore: null,
			/* A pure add displaces nobody, so there is no drop rate and the gain IS his own
			   per-game value. */
			gainPerGame: perGame(a),
			dropPerGame: null,
			gain: a.bscore,
			reason:
				`${a.player.name} projects ${a.bscore} points above the man left at ${a.slot}, ` +
				`and you are holding ${input.roster.length} of ${rosterCounts(input.shape.slots).total} ` +
				`seats — so nobody has to come out for him.`,
			seats: a.slots
		})
	}
	if (room > 0 && moves.length < room)
		notes.push(
			`${room} of your ${rosterCounts(input.shape.slots).total} seats are free, so an add ` +
				`costs you nobody — ${
					moves.length ?
						`${moves.length} free agent${moves.length === 1 ? "" : "s"} clear the ` +
						`${options.minGain}-a-game bar`
					:	`no free agent clears the ${options.minGain}-a-game bar`
				}`
		)

	let bestSeen: { gain: number; add: string; drop: string } | null = null
	for (const drop of droppable) {
		if (moves.length >= cap) break
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
		/* Each man against his OWN club's schedule. A gain between two players on clubs
		   playing different numbers of games has no single denominator, and the difference
		   of their per-game rates is the well-defined reading of it. */
		const addPG = perGame(best)
		const dropPG = perGame(drop.rated)
		const gainPerGame = addPG === null ? null : r2(addPG - (dropPG ?? 0))
		if (!bestSeen || gain > bestSeen.gain)
			bestSeen = { gain, add: best.player.name, drop: drop.spot.name }
		if ((gainPerGame ?? -Infinity) < options.minGain) continue
		usedAdds.add(best.player.id.toString())
		moves.push({
			kind: "add-drop",
			add: best.player.name,
			addScore: best.bscore,
			drop: drop.spot.name,
			dropScore: drop.rated.bscore,
			gainPerGame,
			dropPerGame: dropPG,
			gain,
			reason:
				`${best.player.name} projects ${gain} points higher over the horizon at ` +
				`${best.slot}, and ${drop.spot.name} is ${drop.rated.bscore} — below the ` +
				`${options.keepFloor}-a-game keep floor. Slots matched on ${source}.`
		})
	}
	if (!moves.length && bestSeen)
		notes.push(
			`the best legal upgrade, ${bestSeen.add} for ${bestSeen.drop}, gains ${bestSeen.gain} — ` +
				`below the ${options.minGain}-a-game bar`
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
	/* The rail joins names to the board the same way the planner does, because a rail
	   that resolved "Luis Garcia Jr." to a different man than the planner did would audit
	   somebody else's move. The eligibility comes from whichever side of the plan the
	   name is on — a drop is a roster spot, an add is a wire row — and where the name is
	   still plural the rail says so, which is itself a plan that cannot be audited. */
	const board = indexByName(input.rated, r => r.player)
	const positions = new Map(input.roster.map(s => [normalizeName(s.name), s.positions]))
	const wire = new Map((input.available ?? []).map(a => [normalizeName(a.name), a.positions]))
	/* One line per ambiguous NAME, not one per lookup: the same man is asked about as a
	   drop and again as a starter, and a rail that said it twice would read as two bugs. */
	const saidPlural = new Set<string>()
	const rowFor = (name: string): Rated | undefined => {
		const key = normalizeName(name)
		const got = board.pick(name, {
			positions: positions.get(key) ?? wire.get(key),
			owned: input.ownedIds
		})
		if (got.why === "ambiguous" && !saidPlural.has(key)) {
			saidPlural.add(key)
			out.push(`${got.among.length} players on the board are called ${name}, so this move cannot be audited`)
		}
		return got.row ?? undefined
	}
	const onRoster = new Set(input.roster.map(s => normalizeName(s.name)))
	const reserved = new Set(
		input.roster.flatMap(s => (isReserve(s.slot) ? [normalizeName(s.name)] : []))
	)

	/* THE CAP THIS RAIL AUDITS IS THE ONE THE PLANNER WAS ACTUALLY UNDER. It read
	   `options.maxMoves` alone, so a plan that proposed two moves in a league allowing one
	   passed its own audit — the rail was checking the preference and not the rule. Both
	   are re-derived here rather than taken from the planner, which is the point of a
	   rail: the same arithmetic done independently. */
	const { cap, byLeague } = movesAllowed(options, input.limits)
	if (result.moves.length > cap)
		out.push(
			`${result.moves.length} moves proposed, above the cap of ${cap}` +
				(byLeague ? ` your league allows each week` : ``)
		)
	/* Recomputed rather than taken from the planner, which is the point of a rail: it is
	   the same arithmetic done independently, so a planner that got it wrong is caught. */
	const room = Math.max(0, rosterCounts(input.shape.slots).total - input.roster.length)
	const seenAdd = new Set<string>()
	const seenDrop = new Set<string>()
	for (const m of result.moves) {
		const add = normalizeName(m.add)
		/* Every rail about the man coming out is skipped when nobody is coming out — and
		   skipped by asking, not by a null slipping through a comparison. A keep floor has
		   nothing to hold on an empty seat, and `addScore - dropScore` is not the gain of a
		   move with no second side. The rails about the man coming IN apply either way, and
		   they are the ones that stop the planner offering somebody it cannot have. */
		if (m.kind === "add-drop" && m.drop !== null && m.dropScore !== null) {
			const drop = normalizeName(m.drop)
			const rated = rowFor(m.drop)
			if (rated && (perGame(rated) ?? Infinity) >= options.keepFloor)
				out.push(`${m.drop} is at ${perGame(rated)} a game, at or above the ${options.keepFloor} keep floor`)
			if ((m.dropPerGame ?? -Infinity) >= options.keepFloor)
				out.push(
					`${m.drop} is reported at ${m.dropPerGame} a game, at or above the keep floor`
				)
			if (r2(m.addScore - m.dropScore) !== m.gain)
				out.push(`${m.add} for ${m.drop} reports a gain of ${m.gain} that is not ${m.addScore} − ${m.dropScore}`)
			if (reserved.has(drop)) out.push(`${m.drop} sits in a reserve slot and must not be dropped`)
			if (!onRoster.has(drop)) out.push(`${m.drop} is not on the roster`)
			if (seenDrop.has(drop)) out.push(`${m.drop} is dropped twice`)
			seenDrop.add(drop)
		} else if (m.kind === "add") {
			// The one rail a pure add owes: there was actually room for him.
			if (room <= 0) out.push(`${m.add} is added with no seat free`)
			if (m.drop !== null || m.dropScore !== null)
				out.push(`${m.add} is an add with no drop but reports one (${m.drop})`)
		}
		if ((m.gainPerGame ?? -Infinity) < options.minGain)
			out.push(
				`${m.add}${m.drop ? ` for ${m.drop}` : ""} gains ${m.gainPerGame} a game, below the ` +
					`${options.minGain} bar`
			)
		if (!input.availableNames.has(add)) out.push(`${m.add} is not in the free-agent pool`)
		if (onRoster.has(add)) out.push(`${m.add} is already on the roster`)
		/* "is on the IL" was true of every value this field could hold until
		   src/data/injuries.ts started reading options, designations, outrights and
		   releases off the transactions feed. An optioned man is not on the injured list,
		   so the rail says what the field actually means — he cannot play — and quotes
		   MLB's own words for why. */
		const arriving = rowFor(m.add)
		if (arriving?.injury) out.push(`${m.add} cannot play (${arriving.injury})`)
		if (seenAdd.has(add)) out.push(`${m.add} is added twice`)
		// the two halves of a plan must agree about the same man
		if (
			m.drop !== null &&
			result.lineup.starters.some(s => normalizeName(s.name) === normalizeName(m.drop!))
		)
			out.push(`${m.drop} is started and dropped in the same plan`)
		seenAdd.add(add)
	}

	const accepts = input.shape.slot_accepts
	const filled = new Map<string, number>()
	const seenStarter = new Set<string>()
	for (const s of result.lineup.starters) {
		const key = normalizeName(s.name)
		if (!onRoster.has(key)) out.push(`${s.name} is in the lineup but not on the roster`)
		if (seenStarter.has(key)) out.push(`${s.name} is started in two slots at once`)
		seenStarter.add(key)
		if (rowFor(s.name)?.injury) out.push(`${s.name} is started while on the IL`)
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

/**
 * Add/drop planned on what your LINEUP is worth afterwards, not on a bscore gap.
 *
 * `planMoves` above scores a swap as `add.bscore - drop.bscore`, and that is wrong
 * in three ways that all point the same direction — it under-recommends, and it
 * under-recommends exactly the moves worth making.
 *
 *  1. It refuses to drop anyone the lineup is starting, because the lineup was
 *     computed BEFORE the move and nothing would seat the man arriving. So the
 *     upgrades it declines are precisely the ones at positions you actually play.
 *     On the shipped league it wrote, in its own notes, that Ryan Jeffers "would be
 *     worth 44.12 more" at catcher and then did not offer him — while the two moves
 *     it did offer were worth 16.5 and 14.2.
 *  2. A bscore gap is not what your team gains. A man you add and then bench gains
 *     you nothing, and bscore cannot tell the difference.
 *  3. Its like-for-like slot rule (the add must be eligible somewhere the drop was)
 *     is a proxy for keeping the roster legal. Roster spots are fungible; what has
 *     to stay legal is the LINEUP, and the lineup solver already enforces that.
 *
 * All three dissolve in the same change: score a swap by actually building the
 * lineup that follows it. `gain` is then denominated in the league's own points and
 * means what a reader assumes it means — how many more points this team projects
 * this period if you make this move.
 *
 * Moves are chosen one at a time, each against the roster the previous ones leave,
 * because two swaps that both fill the same hole are not worth the sum of their
 * separate gains.
 *
 * What it keeps from `planMoves`: the keep floor, so a star is never dropped for a
 * hot week; the injured-free-agent exclusion; and the refusal to add a man already
 * on the roster. What it drops is the protection of started players, which existed
 * only to paper over (1).
 *
 * NOT YET RE-MEASURED. `DEFAULTS.maxMoves = 2` is the optimum measured over 111
 * weeks against the OLD scoring, and every run in `data/results/` is evidence about
 * that planner, not this one. This function does not change any of them; it is a
 * separate export and `planMoves` is untouched and still tested. Until a backtest
 * is run against this scoring, treat the cap as inherited rather than established.
 */
export const planSwaps = (
	input: PlanInput,
	/** Candidate adds considered per round. The wire is sorted by projected points
	 *  and a man below your worst starter cannot improve any seat, so this bounds
	 *  the search without bounding the answer. Reported in `notes` when it bites. */
	widthPerRound = 60,
	/**
	 * Normalised names that may never be offered up, whatever this horizon says.
	 *
	 * The keep floor is a bscore, and bscore is denominated in the horizon it was
	 * rated over — so the same threshold protects a different set of men depending on
	 * how long the window is. Measured on the shipped roster: over a fortnight 5 of
	 * his 21 men sit below the floor, and over his league's own six-day scoring
	 * period 12 do. Juan Soto is above it on the fortnight and below it on the week,
	 * which is to say a short week is enough to offer up one of the best hitters in
	 * baseball.
	 *
	 * That is not a bug in the floor — 25 was measured against weeks — it is the
	 * floor answering the only question it can. A man's value beyond this week is a
	 * different question, and the caller answers it by rating the rest of the season
	 * and passing the men who matter there. A player safe on EITHER horizon is safe.
	 */
	protect: ReadonlySet<string> = new Set()
): { moves: Move[]; skipped: string[]; notes: string[] } => {
	const options = input.options ?? DEFAULTS
	const notes: string[] = []
	const skipped: string[] = []
	const accepts = input.shape.slot_accepts
	if (!accepts) {
		notes.push(
			"the league's slot_accepts table is absent from scoring.json, so nothing can be " +
				"seated and no swap can be priced — read the league again to fill it in"
		)
		return { moves: [], skipped, notes }
	}
	if (!input.available?.length) {
		notes.push(
			input.availableNames.size ?
				"the free agents arrived as names only, with no eligibility beside them, so a " +
					"man who was added could not be placed in a seat and no swap could be priced"
			:	"the free-agent pool is empty, so no add was possible"
		)
		return { moves: [], skipped, notes }
	}

	const board = indexByName(input.rated, r => r.player)
	const onRoster = new Set(input.roster.map(sp => normalizeName(sp.name)))

	/** The wire, joined to the board and to the eligibility the league prints. */
	const candidates = input.available
		.flatMap(a => {
			/* The wire row's own eligibility picks the man, which is what stops a free
			   agent called "Luis Garcia" at 1B being priced as the reliever of that name —
			   see `indexByName`. A name still plural after that is REFUSED into `skipped`
			   below rather than guessed: recommending an add means naming somebody the
			   reader will go and claim, and there is no undoing a claim on the wrong man. */
			const got = board.pick(a.name, { positions: a.positions })
			if (got.why === "ambiguous") {
				skipped.push(
					`${a.name}: ${got.among.length} different players on the board go by that ` +
						`name, so there is no saying which one the wire is offering`
				)
				return []
			}
			const rated = got.row ?? undefined
			return rated?.rateable && !onRoster.has(normalizeName(a.name)) ?
					[{ rated, positions: a.positions }]
				:	[]
		})
		.filter(c => {
			if (!c.rated.injury) return true
			skipped.push(`${c.rated.player.name}: MLB lists him ${c.rated.injury}`)
			return false
		})
		.sort((a, b) => b.rated.points - a.rated.points)

	if (!candidates.length) {
		notes.push("no free agent on the wire could be joined to the projection board")
		return { moves: [], skipped, notes }
	}

	const moves: Move[] = []
	/** Every seat the league lets him hold — active, bench and injured. A move only has
	 *  to take somebody out once these are all full; see the note on `d: null` below. */
	const capacity = rosterCounts(input.shape.slots).total
	/** The lower of the measured default and the league's own rule — see `movesAllowed`. */
	const { cap, byLeague } = movesAllowed(options, input.limits)
	if (byLeague)
		notes.push(
			`your league allows ${cap} acquisition${cap === 1 ? "" : "s"} a week, which is fewer ` +
				`than the ${options.maxMoves} moves this run would otherwise make, so ${cap} is the cap` +
				(input.limits?.notes?.length ? ` — ${input.limits.notes.join(" ")}` : ``)
		)
	let roster = input.roster
	/** The lineup before any of this, kept so the innings floor below can be asked of
	 *  the roster the moves LEAVE rather than the one they started from. */
	const openingStarters = planLineup({ ...input, roster }).starters
	let base = planLineup({ ...input, roster }).pointsPlanned

	for (let round = 0; round < cap; round++) {
		const resolved = resolveRoster({ ...input, roster })
		// A star is never offered up, whatever this week's arithmetic says. This is
		// the one rail carried over unchanged, and it is a rail rather than a
		// preference: a season is longer than a horizon.
		/*
		 * PER TEAM GAME, which is the unit `keepFloor` has been in since the bars were
		 * normalised — and which this function alone went on ignoring.
		 *
		 * It compared a raw bscore TOTAL against 1.9. `planMoves` and `railViolations`
		 * both read `(perGame(rated) ?? Infinity)`; `planSwaps` is the planner the web app
		 * actually runs (src/client/Decide.tsx calls it; `planMoves` is CLI-only), so the
		 * defect was the shipped one. Re-measured on data/snapshot.json, league
		 * yahoo:228947, 2026-09-22: of the top 270 rateable men, over the league's own
		 * period (2026-09-08..09-13, median 5 team games) the intended per-game rule makes
		 * 226 droppable and the total rule made 122; over the rest of the season the total
		 * rule protected 170 where the per-game rule protects 40. Roughly twice as many
		 * men held as intended, and the protect set compounding it in the same direction —
		 * so on a full roster the card could only ever offer pure adds, which need a free
		 * seat, and almost never an add/drop.
		 *
		 * `railViolations` could not catch it: it tests per-game, and a man whose TOTAL is
		 * under 1.9 is trivially under 1.9 a game. Revert this and the card silently stops
		 * proposing the drops it exists to propose.
		 */
		const droppable = resolved.filter(
			r =>
				!isReserve(r.spot.slot) &&
				r.rated?.rateable &&
				(perGame(r.rated) ?? Infinity) < options.keepFloor &&
				!protect.has(normalizeName(r.spot.name))
		)
		if (round === 0) {
			const held = resolved.filter(
				r =>
					!isReserve(r.spot.slot) &&
					r.rated?.rateable &&
					(perGame(r.rated) ?? Infinity) < options.keepFloor &&
					protect.has(normalizeName(r.spot.name))
			)
			// One note, however many men. Eight lines each saying the same thing about a
			// different name is the audit trail becoming the noise it was meant to cut.
			if (held.length)
				notes.push(
					`${held.map(r => r.spot.name).join(", ")} ${held.length === 1 ? "is" : "are"} ` +
						`below the ${options.keepFloor}-a-game keep floor over this window and still not ` +
						`offered up: worth too much over the rest of the season to give away for ` +
						`one week of it`
				)
		}
		if (!droppable.length) {
			notes.push(
				`nobody left on the roster is below the ${options.keepFloor}-a-game keep floor, so nothing ` +
					`further was offered up`
			)
			break
		}

		const width = Math.min(widthPerRound, candidates.length)
		if (width < candidates.length && round === 0)
			notes.push(
				`the ${candidates.length} free agents were searched ${width} deep by projected ` +
					`points; a man below that cannot outscore anyone already starting`
			)

		/**
		 * Two cheap passes and an exact check on the finalists, rather than a lineup
		 * solve for every pair.
		 *
		 * Scoring every (add, drop) pair exactly is |candidates| x |droppable| lineup
		 * solves a round, and on the shipped roster that measured 1,919 ms of the
		 * card's 2,600 — the whole page blocked on it. But the two halves of a swap are
		 * very nearly separable: what a man is worth to your lineup barely depends on
		 * which OTHER man you gave up, because they rarely compete for the same seat.
		 *
		 * So: what each arrival is worth on its own, what each departure costs on its
		 * own, and their difference as an ESTIMATE to rank by. Estimates do not decide
		 * anything — the top few pairs are then scored exactly, the way every pair used
		 * to be, and the exact number is what is reported and compared. Separable
		 * enough to rank on, never trusted to answer.
		 */
		const usable = candidates
			.slice(0, width)
			.filter(a => !moves.some(m => normalizeName(m.add) === normalizeName(a.rated.player.name)))
		const withAdd = (a: (typeof candidates)[number]) => [
			...roster,
			{
				slot: "BN",
				name: a.rated.player.name,
				positions: a.positions,
				team: a.rated.player.team ?? null,
				status: ""
			}
		]
		const withoutDrop = (d: Resolved) =>
			roster.filter(sp => normalizeName(sp.name) !== normalizeName(d.spot.name))
		const points = (r: RosterSpot[]) => planLineup({ ...input, roster: r }).pointsPlanned

		const addValue = new Map(usable.map(a => [a, points(withAdd(a)) - base]))
		const dropCost = new Map(droppable.map(d => [d, base - points(withoutDrop(d))]))

		/*
		 * `d: null` is an add with nobody removed, and it is offered first whenever the
		 * roster still has a seat.
		 *
		 * This paired every candidate add with a man to drop and had no other shape, so on
		 * a roster with room it invented a victim. Measured on the dev server, holding 12
		 * of 27 seats: "Add Dominic Canzone for your Util seat, drop Trevor Megill" — with
		 * fifteen seats free, three of which the same card was listing as scoring nothing
		 * tonight. A reader told to drop a man he does not have to drop stops trusting
		 * every other number on the page, and he is right to.
		 *
		 * It rides through the same `points(after)` evaluation as a swap rather than being
		 * special-cased, so the gain is the same quantity — what the lineup projects with
		 * him in it, minus what it projects now — and the two are directly comparable. A
		 * pure add is simply the case where nothing comes out, which is why it almost
		 * always wins when it is legal: it costs nothing.
		 */
		const roomLeft = capacity - roster.length
		const shortlist = [
			...(roomLeft > 0 ?
				usable.map(a => ({ a, d: null as Resolved | null, est: addValue.get(a)! }))
			:	[]),
			...usable.flatMap(a =>
				droppable.map(d => ({ a, d: d as Resolved | null, est: addValue.get(a)! - dropCost.get(d)! }))
			)
		]
			.sort((x, y) => y.est - x.est)
			.slice(0, 12)

		let best:
			| { gain: number; add: (typeof candidates)[number]; drop: Resolved | null }
			| null = null
		for (const { a, d } of shortlist) {
			const after = [
				...(d ?
					roster.filter(sp => normalizeName(sp.name) !== normalizeName(d.spot.name))
				:	roster),
				{
					slot: "BN",
					name: a.rated.player.name,
					positions: a.positions,
					team: a.rated.player.team ?? null,
					status: ""
				}
			]
			const gain = r2(points(after) - base)
			/**
			 * Ties go to the man worth least, and ties are common.
			 *
			 * Two men both out of the lineup cost the same to lose — nothing — so the
			 * swap gains the same either way and the search was picking whichever it
			 * reached first, which put two players on opposite sides of an arbitrary
			 * choice at identical gain.
			 *
			 * Broken on POINTS, not bscore, and the difference matters. bscore is points
			 * minus a per-slot bar, and once the bar is drawn from a real wire those bars
			 * stop being comparable: a slot the wire is thin at clamps to its last man
			 * (an outfield bar of 10.7 on the shipped league) while a deep slot does not
			 * (a Util bar of 30.7). Comparing two men's bscores across slots then compares
			 * two different baselines — it gave up Roman Anthony at 21.5 projected points
			 * and kept Sean Manaea at 13.0, because Anthony's bar happened to be 23 points
			 * higher. Points over the same horizon are one scale for everybody.
			 */
			/* And on a tie, taking nobody out beats taking somebody out — a free seat is
			   worth more than the same points bought with a man. */
			if (
				!best ||
				gain > best.gain ||
				(gain === best.gain && !d && best.drop) ||
				(gain === best.gain &&
					!!d &&
					!!best.drop &&
					(d.rated?.points ?? 0) < (best.drop.rated?.points ?? 0))
			)
				best = { gain, add: a, drop: d }
		}

		if (!best) break
		/*
		 * THE BAR IS PER TEAM GAME AND THE GAIN IS A WHOLE-WINDOW TOTAL, and this line
		 * compared them directly.
		 *
		 * `best.gain` is the difference of two `planLineup(...).pointsPlanned` totals over
		 * the entire horizon; `minGain` ships at 0.38 BECAUSE it is a rate (25 and 5 were
		 * divided by the ~13 team games of the fortnight they were tuned on — see the note
		 * above `DEFAULTS`). Over this league's six-game period the effective bar was
		 * therefore about a sixth of what it was set to: a swap worth 0.4 points across a
		 * whole scoring period cleared it, and the refusal note then said "worth 0.4
		 * points — below the 0.38-a-game bar" about moves it had just been accepting for
		 * exceeding that same bar. The mirror of the keepFloor defect above: too lax
		 * exactly where that one is too strict.
		 *
		 * The rate was already being computed three lines below, for the move's own
		 * `gainPerGame`, and compared to nothing. It is computed here now and the move
		 * carries it, so the number the planner DECIDED on is the number it reports —
		 * which is what lets `railViolations` (`(m.gainPerGame ?? -Infinity) < minGain`)
		 * audit this planner at all. Before this, every sub-bar swap planSwaps emitted
		 * would have been flagged by the repo's own rail, had anything run it over
		 * planSwaps output.
		 *
		 * Null games means no rate, and no rate cannot clear a rate bar — the same reading
		 * `perGame` takes for the keep floor, and honest: a man whose club is not playing
		 * inside this window is not an upgrade to anything.
		 */
		const horizonGames = best.add.rated.projection.horizonGames
		const gainPerGame = horizonGames > 0 ? r2(best.gain / horizonGames) : null
		if ((gainPerGame ?? -Infinity) < options.minGain) {
			/* Both numbers, because neither is the whole claim: the total is what a reader
			   would have gained and the rate is what was measured against the bar. The note
			   used to quote the total alone and label it with the rate's unit. */
			const worth =
				gainPerGame === null ?
					`is worth ${best.gain} points over a window his club has no games in`
				:	`is worth ${best.gain} points over this window, ${gainPerGame} a game`
			notes.push(
				best.drop ?
					`the best remaining swap, ${best.add.rated.player.name} for ${best.drop.spot.name}, ` +
						`${worth} — below the ${options.minGain}-a-game bar`
				:	`the best remaining add, ${best.add.rated.player.name}, ${worth} — below the ` +
					`${options.minGain}-a-game bar, even into a free seat`
			)
			break
		}

		const seats = legalSlotsFor(best.add.positions, accepts)
		moves.push({
			kind: best.drop ? "add-drop" : "add",
			add: best.add.rated.player.name,
			addScore: best.add.rated.points,
			drop: best.drop ? best.drop.spot.name : null,
			dropScore: best.drop ? best.drop.rated!.points : null,
			gain: best.gain,
			/* This branch prices a swap by what it does to the LINEUP TOTAL rather than by
			   the difference of two bscores, so the per-game reading is that total spread
			   over the window the lineup was projected across. Null where the window has no
			   games, which is the same absence `bscorePerGame` reports.
			   Reported from the same `gainPerGame` the bar was just applied to, rather than
			   recomputed here: the reported rate and the decided rate being two expressions
			   is how they came to disagree in the first place. */
			gainPerGame,
			dropPerGame: best.drop?.rated ? perGame(best.drop.rated) : null,
			seats: [...new Set(seats)],
			// Written for the reader, not for the model. "bscore -22.62, below the 25
			// keep floor" is two internal quantities and a threshold nobody outside
			// this file has heard of; what he needs to know is what the move is worth,
			// where the man can play, and that the one leaving is someone he can spare.
			reason:
				`Your lineup projects ${best.gain} more points this period with ` +
				`${best.add.rated.player.name} in it. ` +
				(seats.length ?
					`He can fill your ${[...new Set(seats)].join(" or ")} seat. `
				:	`Your league prints no startable position for him, so he would sit. `) +
				// What the code actually checks is `bscorePerGame < keepFloor` — not far
				// enough clear of the slot's bar — plus the season-long protect set. "Well
				// below what a free agent is worth" claimed the first without the qualifier,
				// and on the shipped roster it said so about a man whose bscore was +5.61.
				/* "A GAME", because that is the bar that was applied. This read "within 1.9
				   points", which is a rate printed in a total's unit — the same confusion
				   that made the check itself compare a total against a per-game floor. */
				(best.drop ?
					`${best.drop.spot.name} is the man to give up for him: he is within ` +
					`${options.keepFloor} a game of what the wire offers at his own slot over this ` +
					`window, and is not worth holding over the rest of the season either.`
				:	`You are holding ${roster.length} of ${capacity} seats, so nobody has to come ` +
					`out for him.`)
		})
		roster = [
			...(best.drop ?
				roster.filter(sp => normalizeName(sp.name) !== normalizeName(best.drop!.spot.name))
			:	roster),
			{
				slot: "BN",
				name: best.add.rated.player.name,
				positions: best.add.positions,
				team: best.add.rated.player.team ?? null,
				status: ""
			}
		]
		base = planLineup({ ...input, roster }).pointsPlanned
	}

	/**
	 * What stopping at the cap cost, where it cost anything.
	 *
	 * The cap is a rail, not a judgement about the third move — a reader deciding
	 * whether to spend one of the four other adds his league allows is entitled to
	 * know what the next one was worth. Reported rather than made: `maxMoves` is
	 * where the measurement put it, and a planner that quietly exceeded its own cap
	 * because the next gain looked good would be the churn the cap exists to stop.
	 */
	if (moves.length === cap) {
		const resolved = resolveRoster({ ...input, roster })
		/* Per team game, the same reading as the loop above — this probe asks "who could
		   still have come out", and an answer drawn with a different bar would price a
		   move the planner would never have made. */
		const droppable = resolved.filter(
			r =>
				!isReserve(r.spot.slot) &&
				r.rated?.rateable &&
				(perGame(r.rated) ?? Infinity) < options.keepFloor &&
				!protect.has(normalizeName(r.spot.name))
		)
		const taken = new Set(moves.map(m => normalizeName(m.add)))
		const next = candidates.find(a => !taken.has(normalizeName(a.rated.player.name)))
		if (next && droppable.length) {
			const base2 = planLineup({ ...input, roster }).pointsPlanned
			let bestNext = -Infinity
			for (const d of droppable) {
				const after = [
					...roster.filter(sp => normalizeName(sp.name) !== normalizeName(d.spot.name)),
					{
						slot: "BN",
						name: next.rated.player.name,
						positions: next.positions,
						team: next.rated.player.team ?? null,
						status: ""
					}
				]
				bestNext = Math.max(bestNext, planLineup({ ...input, roster: after }).pointsPlanned - base2)
			}
			/*
			 * The sign decides which sentence this is, and it used to decide neither.
			 *
			 * One string was emitted whenever `bestNext` was finite, negative included, and
			 * it read "a third move would gain -14.62 more on top of these two — 2 a week is
			 * where the measurement put the cap, not where the gains stop". Observed verbatim
			 * on the published build's first visit. Two defects in one sentence: "gain" for a
			 * loss, and a claim that the gains have not stopped standing next to the number
			 * showing that they have. The cap is a real caveat when another move WOULD help,
			 * and a false one when it would not.
			 */
			/* WHICH CAP IS SPEAKING. The sentence used to say "N a week is where the
			   measurement put the cap", which is true of `maxMoves` and false of a league
			   rule — a reader whose league allows one acquisition a week would have been
			   told a backtest was what stopped him, and invited to raise a number he
			   cannot raise. */
			if (Number.isFinite(bestNext) && bestNext > 0)
				notes.push(
					`a ${ordinal(cap + 1)} move would gain ${r2(bestNext)} more on top of these ` +
						`${cap} — ` +
						(byLeague ?
							`${cap} a week is all your league allows, so this one is not available`
						:	`${cap} a week is where the measurement put the cap, not where the gains stop`)
				)
			else if (Number.isFinite(bestNext))
				notes.push(
					`a ${ordinal(cap + 1)} move would LOSE ${r2(-bestNext)} here, so ` +
						`the cap is not what is stopping this list`
				)
		}
	}

	/**
	 * THE OTHER LEAGUE RULE A PLAN CAN BREAK, and it breaks it by accident.
	 *
	 * A league that sets a weekly innings minimum zeroes or forfeits the pitching side of
	 * a matchup that falls short of it, and two add/drops can take an arm out of the
	 * lineup. So a plan that is right about points can be wrong about the week, and the
	 * planner had no idea: it optimises projected points and an innings floor is not a
	 * points quantity at all.
	 *
	 * REPORTED, NOT ENFORCED, and the distinction is the whole of this block. Refusing a
	 * move here would need two numbers nobody has handed over — how many innings his
	 * staff has ALREADY thrown this period, which is on his team page and no reader here
	 * opens, and whether this board's window is his scoring period at all. Declining a
	 * good move on a guess at either is worse than naming the risk and leaving it to him.
	 *
	 * The two windows are named separately in the sentence for the same reason. The
	 * innings are over whatever horizon the board was rated on, and the floor is per
	 * week; where those differ the numbers are not comparable, and a note that quietly
	 * compared them would be the kind of sentence this project exists not to write.
	 *
	 * WHICH IS ALSO WHY THE GATE IS "THE MOVES TOOK INNINGS OUT" rather than "the result
	 * is under the floor". Gating on the level would need the two windows to be the same
	 * one, and both ways of getting that wrong are live: over a fortnight, 25 innings
	 * clears a 20-a-week floor on the arithmetic and misses it badly in fact, while over
	 * a three-day period anything at all above the floor is certain to clear it. So the
	 * condition is the thing the planner actually knows — that its own moves made this
	 * number smaller — and the floor is quoted beside it rather than tested against it.
	 * The cost is a note on a plan whose reader was never close to the floor; the
	 * alternative cost is silence on one who was.
	 */
	const floor = input.limits?.inningsPerPeriod
	if (floor !== null && floor !== undefined && moves.length) {
		const before = seatedInnings(input.rated, openingStarters)
		const after = seatedInnings(input.rated, planLineup({ ...input, roster }).starters)
		const banked = input.limits?.inningsBanked
		const comparable =
			input.limits?.windowIsPeriod === true && typeof banked === "number" && banked >= 0
		if (after < before && comparable) {
			/*
			   THE SUBTRACTION, DONE, because the caller has both halves of it.
			
			   Thrown plus projected against the floor is the only form of this a reader can
			   act on, and it is a different sentence depending on which side of the floor it
			   lands: a plan that leaves him short is a reason not to make it, and a plan that
			   leaves him clear is worth saying so he stops worrying about a rule he has
			   already met. Both are stated as PROJECTED, because the second half of the sum
			   is a projection and calling it anything else would be the app promising innings
			   its own pitchers have not thrown.
			*/
			const lands = r2(banked! + after)
			notes.push(
				lands < floor ?
					`${moves.length === 1 ? "this move takes" : `these ${moves.length} moves take`} the ` +
						`arms in your lineup from ${before} to ${after} projected innings, and you have ` +
						`thrown ${banked} — that lands at ${lands} against your league's ${floor}, which ` +
						`forfeits the pitching side of your week`
				:	`${moves.length === 1 ? "this move takes" : `these ${moves.length} moves take`} the ` +
					`arms in your lineup from ${before} to ${after} projected innings; with ${banked} ` +
					`already thrown that still lands at ${lands} against your league's ${floor}`
			)
		} else if (after < before)
			notes.push(
				`${moves.length === 1 ? "this move takes" : `these ${moves.length} moves take`} the ` +
					`arms in your lineup from ${before} to ${after} projected innings over this ` +
					`window, and your league asks for ${floor} a week — worth checking against what ` +
					`you have already thrown before you make ${moves.length === 1 ? "it" : "them"}`
			)
	}

	return { moves, skipped, notes }
}

/**
 * Innings the men in SEATS are projected to throw over the horizon.
 *
 * A league that sets a weekly innings minimum forfeits its pitching side under it,
 * so this is a quantity a plan can break: two add/drops can take a pitcher off the
 * roster, and advice that clears you at 63 innings and then tells you to drop two
 * arms has checked the wrong roster.
 *
 * Only seated men count. Summing the whole staff reported 82.5 against a floor of
 * 20 on the shipped league — a comfortable pass built out of four pitchers on the
 * bench, whose innings accrue to nobody.
 *
 * `outs` rather than any innings figure, because outs are what the projection
 * actually models and thirds of an inning are exactly where baseball's notation
 * bites. One division, at the end, where it can be seen.
 */
export const seatedInnings = (
	rated: Rated[],
	starters: { slot: string; name: string }[]
): number => {
	const seated = new Set(
		starters.filter(st => !isReserveSlot(st.slot)).map(st => normalizeName(st.name))
	)
	let outs = 0
	for (const r of rated) {
		if (!r.rateable || r.player.group !== "pitching") continue
		if (!seated.has(normalizeName(r.player.name))) continue
		outs += (r.projection?.stats?.outs as number | undefined) ?? 0
	}
	return Number((outs / 3).toFixed(1))
}

/**
 * WHAT THE PLATFORM WILL STILL ACCEPT, once some of tonight's games have started.
 *
 * A plan is made for a whole evening and read in the middle of one. Measured at 18:40 on a
 * real roster: row 1 of 9 under "Make these changes" read "SS Start Kevin McGonigle 7.35
 * projected today · locks 1:05pm" — his club had been In Progress since 13:05. The rows
 * sort by lock time ascending, so the seats that had ALREADY GONE sorted first, and the
 * list a reader works down from the top opened with the part of it he could no longer do.
 *
 * DROPPING A ROW IS NOT ENOUGH ON ITS OWN, and getting that wrong is worse than leaving the
 * row in. The changes are a NET accounting — N men in, N out — so the bench instruction
 * paired with a locked start is still live: drop "Start McGonigle", keep "Bench Gunnar
 * Henderson", and obeying the card EMPTIES the shortstop seat. 7.09 projected points turned
 * into nothing by following advice. So both halves of a swap go or neither does, and `swaps`
 * is what knows which row pairs with which.
 *
 * A SHIFT THAT CANNOT HAPPEN TAKES ITS SWAP WITH IT, for the same reason from a third
 * direction. A shift is a man already in the lineup moving seat, and the only reason the
 * planner ever asks for one is to free the seat he is in for somebody coming off the bench.
 * His lock therefore cancels more than his own row: the swap into the seat he is sitting in
 * is illegal too. Matched on the SEAT, which is what the data supports — a shift carries
 * where he is and where he was going, a swap carries the seat its incoming man is taking,
 * and the seat he is leaving is the seat the swap needs.
 *
 * And a shift whose only purpose was to free a seat nobody is now taking is not asked for
 * either. It is a move with no effect, and a card that asks for one spends the reader's
 * trust on nothing.
 *
 * Lives here rather than in the card because it is arithmetic about a plan, it is the part
 * of the freeze that can be got wrong silently, and `test/auto.mjs` can reach it.
 */
export const freezeShut = (
	plan: Pick<LineupPlan, "swaps" | "shifts">,
	/** Every man the card has a row for: men coming in and men going out. */
	named: string[],
	/** Whether that man's club is already playing. */
	shut: (name: string) => boolean
): {
	/** Normalised names of every man no change may involve. */
	frozen: Set<string>
	/** Changes given up because a man in the way cannot move — not because their own
	 *  man's game has started, which is a different sentence and a different list. */
	stuck: { in: string; mover: string }[]
	/** The shifts still worth asking for. */
	shifts: LineupPlan["shifts"]
	/** Projected points in the plan that the reader can no longer reach, so a card can
	 *  promise a total he can. */
	lostToLocks: number
} => {
	const frozen = new Set<string>()
	for (const name of named) if (shut(name)) frozen.add(normalizeName(name))

	const stuckSeats = new Map<string, string>()
	for (const sh of plan.shifts) if (shut(sh.name)) stuckSeats.set(sh.from, sh.name)
	const stuck: { in: string; mover: string }[] = []
	for (const sw of plan.swaps) {
		const mover = stuckSeats.get(sw.startSlot)
		if (!mover || frozen.has(normalizeName(sw.start))) continue
		stuck.push({ in: sw.start, mover })
		frozen.add(normalizeName(sw.start))
	}

	for (const sw of plan.swaps) {
		if (!frozen.has(normalizeName(sw.start)) && !(sw.sit && frozen.has(normalizeName(sw.sit))))
			continue
		frozen.add(normalizeName(sw.start))
		if (sw.sit) frozen.add(normalizeName(sw.sit))
	}

	const dead = plan.swaps.filter(sw => frozen.has(normalizeName(sw.start)))
	return {
		frozen,
		stuck,
		shifts: plan.shifts.filter(
			sh =>
				!frozen.has(normalizeName(sh.name)) && !dead.some(sw => sw.startSlot === sh.from)
		),
		lostToLocks: dead.reduce((a, sw) => a + sw.gain, 0)
	}
}
