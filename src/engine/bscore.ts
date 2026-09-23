import type { League } from "../schema.ts"
import type { PlayerSeason, StatLine } from "../data/statsapi.ts"
import type { Underlying } from "../data/savant.ts"
import {
	matchupIndexFor, pitcherMatchupIndex, pitcherQuality, starterBlendedIndex, teamStrength
} from "./matchup.ts"
import { scoreStats, tableFor, type PointsResult } from "./points.ts"
import {
	blendWindows, confidenceOf, leagueRatesFrom, project, RECENT_BLEND_WEIGHT,
	RECENT_RATE_WEIGHT, RECENT_WINDOW_WEIGHTS, SHORT_WINDOW_WEIGHTS, type Projection
} from "./project.ts"
import { MODEL } from "./weights.ts"


/**
 * Slots that start nobody, so they create no demand for a position and set no
 * replacement bar. One list, exported, because `src/engine/trade.ts` needs exactly
 * the same answer and the two drifted: this one omitted Yahoo's second injured slot
 * "IL+", which `src/import.ts` already marks `injured_only`, so a league carrying
 * one would have priced a spot nobody can start.
 */
/** The injured and minor-league seats, as Yahoo writes them. A list rather than a
 *  predicate because `src/import.ts` walks it to mark each one `injured_only`, which
 *  needs the names and not a test. */
export const IL_SLOTS = ["IL", "IL+", "NA"]

/** Exported for one reader only: `test/engine.mjs` checks that every name in here is
 *  also a reserve seat by the predicate below. No code in src/ tests the Set any more —
 *  five sites did, including the two that decide which seats get a replacement bar, and
 *  each of them was the drift `isReserveSlot` was extracted to end. */
export const RESERVE_SLOTS = new Set(["BN", ...IL_SLOTS])

/**
 * The same question, asked the way callers actually ask it.
 *
 * `RESERVE_SLOTS` was exported so there would be one list, and then six places went
 * on writing `slot !== "BN" && slot !== "IL" && slot !== "NA"` by hand — a form that
 * silently omits Yahoo's second injured slot, "IL+". Two of them are rendered
 * components (the roster summary on League setup, and the scarcity panel under the
 * board), so a league carrying an IL+ seat was told it starts one more man than it
 * does, and every replacement bar drawn from that count was one seat too deep.
 *
 * A predicate rather than the Set, because the drift was never about the contents:
 * it was about the shape of the check being easy to retype and easy to get wrong.
 */
export const isReserveSlot = (slot: string): boolean =>
	RESERVE_SLOTS.has(slot.trim()) || /^(BN|IL|NA)/i.test(slot.trim())

/**
 * EVERY STARTABLE SEAT, ONE ENTRY PER SEAT, and one function for the whole app.
 *
 * There were two, with opposite precedence, and both reachable from My league:
 * `src/engine/trade.ts` read the validated COUNTS, and `src/auto/plan.ts` read
 * `slot_order` and fell back to the counts. Each docblock argued for the opposite rule.
 * So the deal pricer and the lineup planner, three hundred pixels apart, were seating
 * different teams — measured on the dev league by bumping OF from 3 to 5 and saving:
 * the editor said 20 active seats, the Tonight card went on seating 18 and never
 * mentioned the other two.
 *
 * THE COUNTS WIN, for the reason trade.ts gave: a `slot_order` parsed off a raw roster
 * string can disagree with the validated counts, and the counts are the number the
 * league actually stated. `slot_order` survives as PRINT ORDER only — it seeds the
 * sequence, never the multiplicity — which keeps a Yahoo lineup recognisable without
 * letting a stale order decide how many men start.
 */
/**
 * How many men a roster shape starts. The same question `startableSeats` answers,
 * asked by the three places that only want the number.
 *
 * `src/import.ts`, `src/data/paste-settings.ts` and the league editor each had their
 * own copy of `slot !== "BN" && !IL_SLOTS.includes(slot)` — the exact hand-written form
 * `isReserveSlot` was extracted to kill, and the form that loses a seat name nobody
 * anticipated. Measured against the canonical predicate: on the reference Yahoo league
 * all of them agree at 17, but a roster carrying "IL-60" or "NA(b)" — both typeable in
 * the editor's own Add slot field — gave 11 and 10 against the predicate's 9 and 9.
 * Latent rather than live, because no platform emits those names today; one function
 * so it stays that way.
 */
export const startableCount = (slots: Record<string, number>): number =>
	Object.entries(slots).reduce((sum, [slot, n]) => (isReserveSlot(slot) ? sum : sum + n), 0)

/**
 * The four counts a league's roster shape produces, in ONE place.
 *
 * `src/import.ts`, `src/data/paste-settings.ts` and the league editor each computed these
 * — Yahoo fetched, Yahoo pasted, and typed by hand — from their own copy of
 * `["IL", "NA", "IL+"]` and their own `slot !== "BN" && !IL_SLOTS.includes(slot)`. Three
 * routes to the same four numbers, all written out by hand, and the editor's answer is
 * rendered four hundred pixels from `leagueGaps`'s, which used the canonical predicate.
 *
 * Measured against that predicate: on the reference Yahoo league all three agree at 17
 * active, but a roster carrying "IL-60" or "NA(b)" — both typeable in the editor's own
 * Add slot field — gave 11 and 10 where the predicate gives 9 and 9. Latent rather than
 * live, because no platform emits those names today, and one function so it stays that
 * way.
 */
export const rosterCounts = (
	slots: Record<string, number>
): { active: number; bench: number; injured_list: number; total: number } => {
	const entries = Object.entries(slots)
	const sum = (keep: (slot: string) => boolean) =>
		entries.reduce((a, [slot, n]) => (keep(slot) ? a + n : a), 0)
	return {
		active: startableCount(slots),
		bench: sum(slot => /^BN$/i.test(slot.trim())),
		// every reserve seat that is not the bench: IL, IL+, NA, and whatever a platform
		// calls its second injured list next season
		injured_list: sum(slot => isReserveSlot(slot) && !/^BN$/i.test(slot.trim())),
		total: sum(() => true)
	}
}

export const startableSeats = (shape: {
	slots: Record<string, number>
	slot_order: string[] | null
}): string[] => {
	const counts = shape.slots
	const order = [...new Set([...(shape.slot_order ?? []), ...Object.keys(counts)])]
	return order.flatMap(slot =>
		isReserveSlot(slot) || !(slot in counts) ?
			[]
		:	Array.from({ length: counts[slot] ?? 0 }, () => slot)
	)
}

/**
 * WHICH SLOTS A FREE-AGENT LIST ACTUALLY SPEAKS FOR, given the positions it was read at.
 *
 * A wire is read one POSITION at a time — Yahoo's player table takes `pos=C`, `pos=SP`
 * and so on — and a league's SLOTS are not that set of names. This league seats four men
 * at "P" and Yahoo has no P page; it seats two at "Util" and Yahoo's Util page is a
 * different population from the union of its infield pages.
 *
 * The league already states the mapping, and states it exactly: `slot_accepts` is the
 * list of eligibility positions each seat will take. So a slot is covered when EVERY
 * position it accepts was read, and not otherwise. That is the direction that is safe to
 * be wrong in — claiming coverage a sweep does not have is what puts a bar of zero under
 * a whole side of the ball, while declining coverage it does have only falls back to the
 * estimate this app used before any wire existed.
 *
 * Worked on league 228947's own seats. A complete nine-position sweep
 * (C, 1B, 2B, 3B, SS, OF, Util, SP, RP) covers all ten startable slots, including the two
 * Yahoo never names: P accepts SP and RP and both were read, Util accepts the six batting
 * positions and all six were read. A sweep throttled after C, 1B, 2B and 3B covers
 * exactly those four — Util is NOT covered, because SS and OF feed it and neither was
 * read, and Util is the case a rule written the other way round ("does the read touch
 * anything this seat takes?") gets wrong.
 *
 * `null` means the caller stated nothing about coverage, which is what every caller
 * written before this did, and it is read as "every slot is covered" so their behaviour
 * is unchanged. A league with no `slot_accepts` table falls back to the slot's own name,
 * which is right for the eight seats Yahoo and the league spell identically and wrong
 * only for P and Util — and wrong in the direction of declining coverage.
 */
export const slotsCoveredBy = (
	league: League,
	positionsRead: string[] | undefined
): Set<string> | null => {
	if (positionsRead === undefined) return null
	const read = new Set(positionsRead.map(p => p.trim()))
	const accepts = league.roster.slot_accepts
	const out = new Set<string>()
	for (const slot of Object.keys(league.roster.slots)) {
		if (isReserveSlot(slot)) continue
		const takes = accepts?.[slot]
		// "any" is the bench and "injured_only" the IL, both already dropped by
		// `isReserveSlot`; a seat whose list is empty states nothing, so its own name is
		// the only claim left to test.
		const needed = Array.isArray(takes) && takes.length ? takes : [slot]
		if (needed.every(p => read.has(p))) out.add(slot)
	}
	return out
}

/**
 * The bscore: a player's projected points over the horizon, minus what a freely
 * available replacement at the same roster slot would produce, in THIS league's
 * scoring. Points above replacement is the honest unit — it is denominated in the
 * league's own currency, so a bscore of 40 literally means "forty more points than
 * the next man up".
 */

/**
 * Which roster slots a player can fill.
 *
 * StatsAPI reports one primary position, which was the largest known accuracy
 * gap here: a catcher who also qualifies at first base was scored only as a
 * catcher, and since a player is worth the most at his scarcest slot, that
 * understated him. `eligible` is your platform's own printed eligibility — read,
 * not inferred — and where it exists it wins. Where it does not, the primary
 * position is still all we honestly have.
 */
/** The eligibility groups, as sets rather than array literals rebuilt per player. */
const PITCHER_POS = new Set(["SP", "RP", "P"])
const OUTFIELD_POS = new Set(["LF", "CF", "RF", "OF"])
const INFIELD_POS = new Set(["C", "1B", "2B", "3B", "SS"])

export const slotsFor = (player: PlayerSeason, eligible?: string[]): string[] => {
	if (eligible?.length) {
		const slots = new Set<string>()
		for (const pos of eligible) {
			if (PITCHER_POS.has(pos)) {
				slots.add(pos)
				slots.add("P")
			} else if (OUTFIELD_POS.has(pos)) {
				slots.add("OF")
				slots.add("Util")
			} else if (INFIELD_POS.has(pos)) {
				slots.add(pos)
				slots.add("Util")
			} else if (pos === "DH" || pos === "Util") slots.add("Util")
		}
		// an unrecognised eligibility line is not a reason to claim he plays nowhere
		if (slots.size) return [...slots]
	}
	return primarySlotsFor(player)
}

const primarySlotsFor = (player: PlayerSeason): string[] => {
	const p = player.position
	if (player.group === "pitching")
		return (player.stats.gamesStarted ?? 0) > 0 ? ["SP", "P"] : ["RP", "P"]
	if (OUTFIELD_POS.has(p)) return ["OF", "Util"]
	if (p === "DH") return ["Util"]
	if (INFIELD_POS.has(p)) return [p, "Util"]
	return ["Util"]
}

export interface Rated {
	player: PlayerSeason
	underlying: Underlying | undefined
	injury: string | undefined
	slots: string[]
	projection: Projection
	projected: PointsResult
	season: PointsResult
	/** Projected points over the horizon. */
	points: number
	/** Points above the replacement-level player at this slot. Goes deeply negative,
	 *  on purpose — see `addValue` and METHODOLOGY 4.4. */
	bscore: number
	/**
	 * What ADDING this player is worth: the bscore, floored at zero.
	 *
	 * bscore is a difference of two point totals, and points are bounded below by
	 * zero while the replacement bar is not, so the range is asymmetric by
	 * construction. The floor is NOT simply minus the bar, which this comment used to
	 * claim: a pitcher is docked for hits, walks and earned runs, so a bad arm over a
	 * fortnight projects BELOW zero and sits further under the bar than a man who
	 * projects for nothing ever could. On the 2026-09-08 capture the deepest is
	 * -112.34, against a bar of 53.79, on -58.55 projected points. That is arithmetic,
	 * not a defect, and the great majority of rateable players sit below zero.
	 *
	 * It is still the wrong number to PRINT against an add. Below the bar every
	 * candidate is the same decision — you take the free replacement instead — so the
	 * depth of the hole is not a quantity anyone can act on, and -111 next to a best
	 * available of +60 reads as a broken scale rather than as "no".
	 *
	 * Floored here rather than in each view so the board and the trade panel cannot
	 * invent two different floors. `bscore` itself is untouched: it is what every
	 * stored backtest in `data/results/` is denominated in, it is what
	 * `src/auto/plan.ts` sorts by to pick which of YOUR OWN players to drop, and
	 * flooring it there would tie 1,101 players at zero and make that choice
	 * arbitrary. Comparing two players you already own is exactly where the negative
	 * carries information.
	 */
	addValue: number
	/** The slot where the player is most valuable. */
	slot: string
	replacement: number
	confidence: { value: number; reasons: string[] }
	/** False when no projection was possible — such a player is reported, never
	 *  silently ranked at zero alongside real ones. */
	rateable: boolean
	/** est_woba − woba: positive means results trail contact quality. */
	regressionGap: number | null
	/** Starts actually scheduled in the horizon. Null when MLB has not published
	 *  them yet, which is why a null falls back to the team-games estimate. */
	scheduledStarts?: number | null
	/** Why this player carries no ranking, when he does not. Null when he is
	 *  rateable — an empty string and "no reason given" are different claims. */
	unrateable?: string | null
	/** Yahoo "% Ros" — the share of leagues this player is rostered in. Null when
	 *  the platform did not list him, which is not the same as nobody owning him. */
	rosteredPct?: number | null
	/**
	 * BSCORE PER TEAM GAME — the same quantity, in a unit that does not change meaning
	 * when the window does.
	 *
	 * bscore is an un-normalised point TOTAL over whatever horizon it was rated on, so
	 * every constant built on it means something different per window. Measured on the
	 * committed capture, same league, same pool, counting men who clear each bar:
	 *
	 *     horizon      rateable   bscore>0   bscore>=25   bscore>=5
	 *     1 day          1082        108          2           19
	 *     period 6d      1240        110          2           64
	 *     14 days        1248        106         20           88
	 *     rest 20d       1248        110         28           86
	 *
	 * `bscore > 0` is stable at 106-113 because it is a rank test — it asks whether a man
	 * beats his bar, which is true or false whatever the window. The planner's two
	 * constants are not rank tests: `keepFloor` 25 matches 2 men over six days and 28 over
	 * twenty, a fourteen-fold swing driven by nothing but the length of the window, and
	 * `minGain` 5 swings four-and-a-half-fold. Those constants decide which men the app
	 * tells a reader to drop.
	 *
	 * Null where the horizon is zero games — a player whose club is not playing has no
	 * per-game rate, and dividing by nothing to get a number is how an absence becomes a
	 * default.
	 */
	bscorePerGame: number | null
}

export interface RateOptions {
	league: League
	players: PlayerSeason[]
	underlying: { hitting: Map<number, Underlying>; pitching: Map<number, Underlying> }
	injuries: Map<number, string>
	teamGamesPlayed: Map<number, number>
	gamesByTeam: Map<number, number>
	/** Who each team plays over the horizon. Absent means no matchup adjustment is
	 *  applied — the index stays null rather than being assumed neutral. */
	opponentsByTeam?: Map<number, number[]>
	/** keyed "id:group" */
	/** keyed "id:group" then window length */
	recentVolumeByWindow?: Record<string, Record<number, number>>
	/** keyed "id:group" */
	recentStats?: Record<string, StatLine>
	/** Market price by MLBAM id — how many leagues have already taken him. */
	ownership?: Map<number, number>
	/** Scheduled starts over the horizon, by MLBAM id. */
	probableStarts?: Map<number, number>
	/** For each team, the opposing starters its hitters face over the horizon. */
	opposingStarters?: Map<number, number[]>
	/** Who each announced starter is booked against — a pitcher faces only the
	 *  lineups his own turns fall on, not his club's whole week. */
	startOpponents?: Map<number, number[]>
	/** Multi-position eligibility as the platform prints it, by MLBAM id. */
	eligibility?: Map<number, string[]>
	/**
	 * Published-vs-scheduled probables per team. A scheduled-start count is only an
	 * observation where it covers the whole horizon; MLB typically publishes today
	 * and tomorrow and then stops, so a partial count read as a complete one says a
	 * starter makes ONE start in a fortnight and buries him.
	 */
	probableCoverage?: Map<number, { published: number; games: number }>
	/**
	 * What to do with a player currently on the injured list.
	 *
	 * "exclude" refuses to rank him over this horizon; "keep" ranks him anyway.
	 * The right answer depends on the horizon and nothing else: over the next week
	 * a man on the 10-day IL cannot help you, while over the rest of the season he
	 * may be the best thing on your bench.
	 */
	injuryPolicy?: "exclude" | "keep"
	/**
	 * Which playing-time model the projection uses. Defaults to the shipped "blend".
	 * Passed through rather than read from MODEL so a backtest can race the two, and
	 * so no caller silently changes what every stored result is denominated in.
	 */
	volumeModel?: "blend" | "state"
	/**
	 * Who the reader could actually get, as a test the engine can apply to any rated
	 * player. Absent means the wire is unknown and replacement level is simulated
	 * from the whole pool — see the comment where it is used.
	 */
	available?: (r: { player: { id: number; name: string } }) => boolean
	/**
	 * WHICH POSITIONS THAT LIST WAS ACTUALLY READ AT — the difference between "nobody
	 * is free at shortstop" and "we never looked at shortstop".
	 *
	 * A league's own wire is read one POSITION at a time, nine separate page requests,
	 * and Yahoo throttles by serving an EMPTY page rather than an error (commit de44045
	 * records 150 players, then 25, then 0, then "Request denied"). So a sweep that
	 * asked for nine positions and got four arrives looking exactly like a league with
	 * four positions' worth of free agents, and the engine had no way to tell the two
	 * apart. It did not try: `available` was applied at every slot alike.
	 *
	 * Measured on data/snapshot.json against league 228947 over the committed fortnight,
	 * with a wire derived from the capture's own ownership column (611 men at or below
	 * this league's 35% cut) and then truncated to the 300 of them the engine seats at
	 * C, 1B, 2B or 3B — the four-position throttle above. Replacement bars, points over
	 * the fortnight:
	 *
	 * DENOMINATED IN THE DEPTH THAT SHIPPED WHEN IT WAS TAKEN — `teams × count` down a wire
	 * — which changed to `count` later the same day. Left as measured rather than restated
	 * from memory: what this table is evidence FOR is the shape of the failure, that six of
	 * ten slots were corrupted by a read that was right about four and three were set to
	 * zero, and that shape does not depend on the depth. Re-derive it against the shipped
	 * rule with `node --experimental-strip-types src/backtest/wire/bars.ts`, which
	 * cross-checks itself against what `rateAll` actually did.
	 *
	 *   slot   complete wire   truncated, before this   truncated, with this
	 *   C             48.85    48.85                    48.85
	 *   1B            62.39    62.39                    62.39
	 *   2B            66.89    66.89                    66.89
	 *   3B            61.67    61.67                    61.67
	 *   SS            57.20    47.90                    92.52  ← the no-wire bar
	 *   OF            60.73    28.93                    88.47  ← the no-wire bar
	 *   Util          72.81    64.84                   106.43  ← the no-wire bar
	 *   SP            39.74     0                       73.56
	 *   RP            37.00     0                       53.79
	 *   P             35.34     0                       63.29
	 *
	 * Six of the ten startable slots were corrupted by a read that was right about four,
	 * and three of them were set to zero — which says a freely available pitcher
	 * produces nothing, so every pitcher's bscore became his whole projected total. The
	 * top of that board is Pete Crow-Armstrong 103.47, Jake McCarthy 94.23, Kyle
	 * Schwarber 89.20, where the complete wire has those three at 71.67, 62.43 and
	 * 57.40 and puts Ben Rice at 84.59 above all of them.
	 *
	 * Given this list, a slot whose positions were not all read falls back to the
	 * whole-pool simulation — the same bar a page with no wire at all uses, which is
	 * this app's own stated answer for "unknown". Absent, every slot is treated as
	 * covered, which is exactly the behaviour before this existed: on the committed
	 * capture with a complete wire, passing it or omitting it produces a board that is
	 * identical row for row, bscore and bar included.
	 */
	availablePositions?: string[]
	/** Teams in the league — sets how deep the replacement level sits. Required:
	 *  defaulting it would silently move every replacement level and therefore
	 *  every bscore, which is exactly the kind of quiet assumption this app exists
	 *  to refuse. */
	teams: number
}

/**
 * ═══ ONE ASSIGNMENT, NOT TEN INDEPENDENT WALKS ═══════════════════════════════════
 *
 * The bar at a slot is the man you would be left with there once the league has taken
 * everyone better. That sentence contains a fact the old arithmetic did not: a man can
 * only be taken ONCE. Walking each slot's own eligible list down to `teams x count` and
 * reading off the next name counts the same player at every position he qualifies for,
 * so every bar is set by men who are already sitting somewhere else, and every bar is
 * therefore too high.
 *
 * Measured on data/snapshot.json, league 228947, over 2026-09-08 → 09-22, against a
 * joint fill of the league's 180 real seats:
 *
 *     C    75.04 → 75.04   ( 0.00)     Util 106.43 → 91.65  (-14.78)
 *     1B  103.90 → 90.72   (-13.18)    SP    73.56 → 49.21  (-24.35)
 *     3B   94.23 → 83.54   (-10.69)    P     63.29 → 49.21  (-14.08)
 *     SS   92.52 → 82.18   (-10.34)    OF    88.47 → 72.69  (-15.78)
 *
 * Catcher is the one slot the old rule got right, because almost nobody else qualifies
 * there — which is exactly why the error was invisible: the position everyone checks by
 * hand was the position that was correct.
 *
 * WHAT IT COST. Top-25 overlap between the two rules is 22 of 25 and top-100 is 91 of
 * 100. The men with a bscore above zero — the addable universe the board offers — go
 * from 106 to 180 of 1,248. Catchers move up to 266 rank places. And because SP and P
 * drew independent bars, the effective gap between a starter's bar and a reliever's was
 * 9.50 points where jointly it is 0.98: a standing nine-and-a-half-point tilt toward
 * relievers on every fortnight board this app has ever drawn.
 *
 * THE RULE. Walk the pool best-first. Seat each man in the SCARCEST of his eligible
 * slots that still has a seat open — scarcest by how few men in the pool can fill it,
 * which is the same ordering `fillRoster` uses and for the same reason: a catcher lost
 * to a Util seat is a catcher the league has to replace from nowhere. When every seat a
 * man qualifies for is full he is not seated, and the first unseated man at a slot is
 * that slot's bar.
 *
 * `capacity` is what the pool means. Given every player in baseball it is `teams x
 * count` — the seats the whole league has to fill. Given a WIRE, the other rosters have
 * already been removed from the pool, so it is `count`: the reader's own seats, and
 * walking the league's depth a second time is the double-count the note at the call
 * site measures.
 *
 * THE MAN, NOT ONLY HIS POINTS. The walk identifies a person — "the first man left at
 * this slot" — and threw him away on the way out, so the one screen that has to NAME a
 * bar (`replacementPlayerBySlot`, for the lineup card) kept a second copy of the retired
 * independent walk to get a name from. That copy drifted the moment this one was
 * corrected: measured on the committed capture, league 228947, the card printed this
 * function's number beside that walk's man, 23.12 points apart at Util (bar 81.23,
 * "Matt Olson 104.35") and 19.08 at SP, and named 99%-rostered stars as free bodies.
 * Returning `T` makes name and number the same row by construction; the numeric form
 * below is the same map with `.points` read off it, for the four callers that only
 * price seats.
 */
export const jointReplacementMen = <
	T extends { points: number; slots: readonly string[]; rateable?: boolean }
>(
	pool: readonly T[],
	slotCounts: Record<string, number>,
	capacity: (slot: string, count: number) => number
): Map<string, T | null> => {
	const seats = new Map<string, number>()
	const eligibleCount = new Map<string, number>()
	for (const [slot, count] of Object.entries(slotCounts)) {
		/* `isReserveSlot`, not the Set it wraps: the Set misses "IL-60" and "NA(b)", both
		   typeable in the league editor's own Add slot field, and a reserve seat that got
		   past here would be given a replacement bar and real players spent filling it. */
		if (isReserveSlot(slot)) continue
		seats.set(slot, Math.max(0, Math.round(capacity(slot, count))))
		eligibleCount.set(slot, 0)
	}
	const ranked = pool
		.filter(r => r.rateable !== false)
		.filter(r => r.slots.some(sl => seats.has(sl)))
		.slice()
		.sort((a, b) => b.points - a.points)
	for (const r of ranked)
		for (const sl of r.slots)
			if (eligibleCount.has(sl)) eligibleCount.set(sl, eligibleCount.get(sl)! + 1)

	const bars = new Map<string, T | null>()
	for (const r of ranked) {
		/* Scarcest first, and ties broken by the slot's own name so the assignment is
		   deterministic — a bar that depends on object key order is a bar that moves
		   between runs for no reason anybody can see. */
		const open = r.slots
			.filter(sl => (seats.get(sl) ?? 0) > 0)
			.sort((a, b) =>
				(eligibleCount.get(a)! - eligibleCount.get(b)!) || (a < b ? -1 : a > b ? 1 : 0)
			)
		if (open.length) {
			seats.set(open[0]!, seats.get(open[0]!)! - 1)
			continue
		}
		/* Unseated. He is the first man left at every slot he qualifies for that has not
		   already found one — which is the definition of replacement level. */
		for (const sl of r.slots) if (seats.has(sl) && !bars.has(sl)) bars.set(sl, r)
	}
	/* A slot nobody is left for: everyone eligible is seated somewhere. Nobody is the
	   honest reading only when nobody qualifies at all; where the pool simply ran out,
	   the last man in it is what you would be left with. */
	for (const slot of seats.keys())
		if (!bars.has(slot)) {
			const last = [...ranked].reverse().find(r => r.slots.includes(slot))
			bars.set(slot, last ?? null)
		}
	return bars
}

/** The same assignment, priced. A slot no rated player qualifies for is 0 — the one
 *  case that zero was ever written for, and the caller that must not print it as a bar
 *  (`replacementBySlot`) tests eligibility itself rather than reading a 0 back. */
export const jointReplacement = (
	pool: readonly { points: number; slots: readonly string[]; rateable?: boolean }[],
	slotCounts: Record<string, number>,
	capacity: (slot: string, count: number) => number
): Map<string, number> =>
	new Map(
		[...jointReplacementMen(pool, slotCounts, capacity)].map(([slot, man]) => [
			slot,
			man?.points ?? 0
		])
	)

export const rateAll = (o: RateOptions): Rated[] => {
	const slotCounts = o.league.roster.slots
	/**
	 * A league that scores nothing must not produce a board of zeros.
	 *
	 * The roster templates ship a shape, not a scoring table — you supply that by
	 * importing your league or entering values. Until then every projection scores
	 * exactly 0, and a ranked list of 1,432 players all worth 0 reads as a working
	 * board rather than as an unconfigured one. That is the project's own rule
	 * broken in the most visible place: absent was being rendered as zero.
	 */
	const scores = {
		hitting: Object.values(o.league.scoring.batting).some(v => v !== 0),
		pitching: Object.values(o.league.scoring.pitching).some(v => v !== 0)
	}
	// Opponent quality is derived from the same pool being rated, so it moves with
	// whatever the board is showing and never needs a separate capture.
	const strength = teamStrength(o.players)
	// each pitcher's own wOBA allowed, so a hitter can be matched against the man on
	// the mound rather than against an average of an ace and a fifth starter
	const quality = pitcherQuality(o.players)
	/**
	 * THE POPULATION EVERY RATE IS SHRUNK TOWARD, which this function never built.
	 *
	 * `project` regresses a man's per-stat rate toward a league rate in proportion to how
	 * little volume backs it — `(value + k * leagueRate) / (volume + k)` — and its own
	 * comment calls the absence of that "the single biggest source of bad
	 * recommendations". It happens only when the caller passes `rates`. This caller, which
	 * is every board and every card in the app, passed nothing, so model.json's whole
	 * `shrinkage` section was inert in the shipped product.
	 *
	 * Built from the SAME pool being rated, per side, so it moves with whatever board is
	 * on screen and needs no separate capture — the same argument `teamStrength` two lines
	 * up already makes for itself. Per side and never merged: a pitcher's plate
	 * appearances and a hitter's are not the same population and pooling them is the bug
	 * `Context.underlying` in the simulator documents at length.
	 *
	 * Applied at `MODEL.shrinkage.scale`, which is a half. See model.json: at full
	 * strength it takes 20 to 27 points off every elite reliever, because the population
	 * pools closers with mop-up men.
	 */
	const rates = {
		hitting: leagueRatesFrom(o.players.filter(p => p.group === "hitting"), "hitting"),
		pitching: leagueRatesFrom(o.players.filter(p => p.group === "pitching"), "pitching")
	}

	const rated: Rated[] = o.players.map(player => {
		const underlying = o.underlying[player.group].get(player.id)
		const injury = o.injuries.get(player.id)
		const horizonGames = player.teamId ? (o.gamesByTeam.get(player.teamId) ?? 0) : 0
		const eligible = o.eligibility?.get(player.id)
		// only trust the count where MLB has published every game of this team's window
		const cov = player.teamId ? o.probableCoverage?.get(player.teamId) : undefined
		const startsUsable =
			o.probableStarts !== undefined && cov !== undefined && cov.games > 0 && cov.published >= cov.games
		/**
		 * Inside a COVERED window, absence is an observation rather than a gap.
		 *
		 * `startsUsable` already establishes the only condition under which that is
		 * true — every game of this team's window has a named starter — and the
		 * count was then thrown away for anyone not on the list, because `null`
		 * means "unknown" and `project` falls back to outs per team game. So a
		 * 28-start pitcher whose club has published all four of its starters, none
		 * of them him, was ranked on the streaming board for a period he provably
		 * does not pitch in.
		 *
		 * Only for a pitcher who is predominantly a starter: a covered window says
		 * nothing about when a reliever appears, so relievers and swingmen keep the
		 * fallback. The share bar is the same constant project.ts uses, so the two
		 * places that ask "are this man's appearances starts" cannot drift apart.
		 */
		const gp = player.stats.gamesPitched ?? 0
		const mostlyStarts =
			player.group === "pitching" &&
			gp > 0 &&
			(player.stats.gamesStarted ?? 0) / gp >= MODEL.probables.minStartShare

		/**
		 * Two starts in a scoring period is roughly double the innings, and it is the
		 * single largest edge in streaming — so the count has to survive a window MLB
		 * has only partly published, which is every window longer than a few days.
		 *
		 * Measured on the reference capture, from the snapshot's own horizon start:
		 * over 3 days 26 of 30 clubs have every game published, over 5 days 8, and
		 * **over 7 days none at all** — 98 of 192 games carry a named starter. The
		 * all-or-nothing gate above therefore never opened on a normal week, so the
		 * starts basis never fired there and a confirmed two-start man was projected
		 * off the same team-games average as everybody else.
		 *
		 * Opening the gate naively is what the gate was built to prevent, and that
		 * failure is on the record (METHODOLOGY 3.5): read a partial window as
		 * complete and a starter named for today carries ONE start across a fortnight
		 * while the field is projected at two or three, and he falls about 350 places.
		 *
		 * So the count is split rather than gated. What MLB has published is an
		 * observation and is used as one; the games it has not yet named are credited
		 * at this pitcher's own rate of starting, which is what the team-games
		 * fallback was silently doing for the whole window anyway:
		 *
		 *     starts = published(him) + unpublished(his club) × (his GS / his club's GP)
		 *
		 * The two ends behave correctly by construction. Fully published: the second
		 * term is zero and this reduces to exactly the previous behaviour, including a
		 * covered window meaning zero for a starter nobody named. Nothing published:
		 * the first term is zero and the second reproduces the team-games estimate. In
		 * between — the normal case — a man named twice gets at least two, and a man
		 * named once gets one plus his share of what is still unnamed.
		 */
		const published = o.probableStarts?.get(player.id) ?? 0
		const unnamed = cov ? Math.max(cov.games - cov.published, 0) : 0
		const teamGP = player.teamId ? o.teamGamesPlayed.get(player.teamId) : undefined
		/**
		 * The recency-blended playing time, hoisted because two things need it: the
		 * projection itself, and the start count below.
		 */
		const windows = o.recentVolumeByWindow?.[`${player.id}:${player.group}`] ?? {}
		const recentVolumePerGame = blendWindows(windows, RECENT_WINDOW_WEIGHTS[player.group])
		// the same evidence cut to the newest windows only — what the state volume
		// model reads availability off. See `SHORT_WINDOW_WEIGHTS`.
		const recentShortPerGame = blendWindows(windows, SHORT_WINDOW_WEIGHTS[player.group])
		/**
		 * His own rate of starting, for the games MLB has NOT named yet.
		 *
		 * This was `gamesStarted ÷ his club's games played`, and that is a numerator
		 * and a denominator drawn from different populations — the shape every bug
		 * found in this codebase has had. His starts accrue only over the part of the
		 * season he was actually in a rotation; his club's games count the whole of
		 * it. So every pitcher who missed time reads as a man who rarely starts.
		 *
		 * Measured on the committed capture over the resolved scoring period, 44 of
		 * 193 predominantly-starting pitchers carried a start rate below 0.10 despite
		 * four or more starts — against the ~0.20 a five-man rotation actually runs
		 * at. Blake Snell, a full-time starter who missed most of the season, was
		 * credited with **0.11 starts and 1.7 outs** for a week in which his club had
		 * three unnamed games: half an inning, for a man who takes a turn every fifth
		 * day. Chris Bassitt read 0.40 starts across four unnamed games.
		 *
		 * The rate is therefore taken from the same recency-blended per-team-game
		 * volume the fallback itself uses, divided by his own measured outs per start
		 * — both already observed, both already trusted elsewhere in the model, and
		 * no new constant introduced:
		 *
		 *     startRate = blended outs per team game ÷ outs per start
		 *
		 * This GENERALISES the old formula rather than replacing it. Where no recent
		 * window exists the blend IS the season rate, and
		 * (outs ÷ teamGP) ÷ (outs ÷ GS) = GS ÷ teamGP exactly — verified on the
		 * capture: all 43 such pitchers reproduce the previous number to the last
		 * digit. It is also what finally makes METHODOLOGY 3.5.0's "nothing published
		 * reproduces the team-games estimate" true. The season-only version did not:
		 * it reproduced only the season half of a fallback that is 50% recent, so a
		 * starter's projection silently lost the recency blend §3.3 calls the single
		 * largest source of accuracy in the model.
		 *
		 * Like everything else built on probables this cannot be backtested (§3.5).
		 * It is reported as a correction to a wrong population, not as a measured
		 * gain: 95 of 193 start counts move, median 0.00 and mean +0.08 starts.
		 */
		const outsPerStart =
			mostlyStarts && player.stats.outs !== undefined && (player.stats.gamesStarted ?? 0) > 0 ?
				player.stats.outs / player.stats.gamesStarted!
			:	null
		const seasonOutsPerTeamGame =
			teamGP && player.stats.outs !== undefined ? player.stats.outs / teamGP : null
		const blendedOutsPerTeamGame =
			seasonOutsPerTeamGame === null ? null
			: recentVolumePerGame === null ? seasonOutsPerTeamGame
			: (1 - RECENT_BLEND_WEIGHT.pitching) * seasonOutsPerTeamGame +
				RECENT_BLEND_WEIGHT.pitching * recentVolumePerGame
		const startRate =
			outsPerStart !== null && outsPerStart > 0 && blendedOutsPerTeamGame !== null ?
				// never more turns than his club has games
				Math.min(blendedOutsPerTeamGame / outsPerStart, 1)
			:	0
		const scheduled =
			o.probableStarts === undefined || cov === undefined || cov.games === 0 ? null
			: !mostlyStarts ?
				// a published count says nothing about when a reliever next appears
				startsUsable ? (o.probableStarts?.get(player.id) ?? null) : null
			:	Number((published + unnamed * startRate).toFixed(2))
		// The club's week, which is the right question for a hitter.
		const teamIndex = o.opponentsByTeam ? matchupIndexFor(player, o.opponentsByTeam, strength) : null
		const matchupIndex =
			player.group === "pitching" ?
				// ...but a starter faces only the lineups his own turns fall on
				pitcherMatchupIndex(player, o.startOpponents, teamIndex, strength, scheduled)
			:	starterBlendedIndex(player, teamIndex, o.opposingStarters, quality, horizonGames)
		const projection = project(
			player,
			underlying,
			player.teamId ? o.teamGamesPlayed.get(player.teamId) : undefined,
			horizonGames,
			{
				recentVolumePerGame,
				recentShortPerGame,
				volumeModel: o.volumeModel ?? "blend",
				recentWeight: RECENT_BLEND_WEIGHT[player.group],
				recentStats: o.recentStats?.[`${player.id}:${player.group}`] ?? null,
				recentRateWeight: RECENT_RATE_WEIGHT[player.group],
				rates: rates[player.group],
				matchupIndex,
				projectedStarts: scheduled
			}
		)
		const table = tableFor(o.league, player.group)
		return {
			player,
			underlying,
			injury,
			slots: slotsFor(player, eligible),
			projection,
			projected: scoreStats(projection.stats, table, player.group),
			season: scoreStats(player.stats, table, player.group),
			points: 0,
			bscore: 0,
			/* Filled in with `bscore` below, once the bar is known. */
			bscorePerGame: null,
			addValue: 0,
			slot: "",
			replacement: 0,
			confidence: confidenceOf(player, underlying, injury),
			/**
			 * An injured player is not projectable over a short horizon, and pretending
			 * otherwise is the most expensive mistake this board can make: he was
			 * healthy for most of the window the recent-volume blend reads, so he
			 * projects at a full-time rate and ranks among the best available while
			 * being unable to play at all. No source states a return date, so rather
			 * than invent a discount the honest answer is that he cannot be projected
			 * over this window — and that is reported, not hidden.
			 */
			rateable:
				scores[player.group] &&
				projection.projectedVolume !== null &&
				projection.projectedVolume > 0 &&
				!(injury !== undefined && (o.injuryPolicy ?? "exclude") === "exclude"),
			/**
			 * Every unrateable player owes a reason, and three of the four ways to
			 * become one gave none.
			 *
			 * The field's own contract says null means rateable. It did not hold: an
			 * unconfigured league, a missing volume line and a volume that rounds to
			 * nothing all produced `rateable: false` with `unrateable: null`, which is
			 * the "absent reported as absent" rule broken in the one place whose whole
			 * job is reporting absence. Measured on the committed capture over the
			 * resolved scoring period, 7 of 221 unrateable players carried no reason
			 * (1 of 200 over the fortnight) — men with a single plate appearance all
			 * season, whose projected volume rounds to 0.0.
			 */
			unrateable:
				// injury wins: it is the more informative reason, and it is the one the
				// Stash view's own copy answers
				injury !== undefined && (o.injuryPolicy ?? "exclude") === "exclude" ?
					`${injury} — no source states a return date, so there is no honest ` +
						`projection over this horizon. The Stash view ranks him anyway.`
				: scheduled === 0 ?
					/* SIX WORDS, NOT TWENTY-SIX. This read "MLB has published a starter for every
					   game of this window and he is not one of them, so he is not scheduled to
					   pitch in it" — three lines on a card where five benched pitchers share one
					   grouped row, which made the explanation four times the size of the fact. The
					   fact is the whole of what a reader does anything with; how the page knows is
					   the kind of sentence that makes a screen feel like it is arguing with him. */
					`not scheduled to pitch in this window.`
				: !scores[player.group] ?
					`this league scores nothing on the ${player.group} side, so there is no ` +
						`points total to rank him by — import your league's scoring, or enter it.`
				: projection.projectedVolume === null ?
					`no projection is possible: ${projection.missing.join("; ")}.`
				: projection.projectedVolume === 0 ?
					`his projected ${player.group === "hitting" ? "plate appearances" : "outs"} ` +
						`over ${projection.horizonGames} games round to none, so there is no line ` +
						`to score.`
				:	null,
			regressionGap: underlying?.xwobaGap ?? null,
			scheduledStarts: scheduled
		}
	})

	for (const r of rated) r.points = r.projected.points

	/**
	 * Replacement level per slot, and the depth is not the same in the two pools.
	 *
	 * Simulating a wire this app cannot see, it is the (teams × slots)-th best eligible
	 * player: literally the best man still on waivers once every team has filled the slot,
	 * so the depth follows the league's own roster configuration rather than a rule of
	 * thumb. Given the reader's OWN free-agent list, it is his own seats deep instead —
	 * that list is the same pool with the other rosters already taken out of it, and
	 * walking the league's depth down it removes them twice. The measurement is at the
	 * `depth` line below; this paragraph used to state only the first depth and was the
	 * wording two screens copied their now-corrected sentences from.
	 */
	const replacementBySlot = new Map<string, number>()
	/** The whole rateable pool, kept by identity so the loop below can tell "this slot
	 *  fell back to all of baseball" from "this slot has its own wire". */
	const allRated = rated.filter(r => r.rateable)
	/** Which slots the availability list is entitled to speak for. Null when the caller
	 *  named no positions, which reads as "all of them" — see `availablePositions`. */
	const covered = o.available ? slotsCoveredBy(o.league, o.availablePositions) : null
	/*
	 * TWO POOLS, EACH SEATED ONCE. Every argument below about WHICH pool a slot's bar is
	 * drawn from, and how far down it, is unchanged. What changed is that the men above
	 * the line are now seated once BETWEEN them rather than once per slot each — see
	 * `jointReplacement`, which measures what the old independent walk cost.
	 */
	/**
	 * Whom the bar is drawn from.
	 *
	 * The depth arithmetic below is a SIMULATION of the wire: take everybody, walk
	 * down to where the rosters run out, and call the next man replacement level.
	 * It is the right answer for a page that cannot see your league. It is the
	 * wrong one when your league's own free-agent list is loaded, and wrong in a
	 * way that shows: with "only players I can add" ticked and the board filtered
	 * to catchers, every gettable catcher sat below a bar set by the eleventh-best
	 * catcher in baseball — a man on somebody's roster — so the card said "Nobody"
	 * about a list it had just finished ranking.
	 *
	 * Given the wire, the same depth is walked down the wire instead, and clamped
	 * to it. Where the wire is shorter than the depth the bar is its last man,
	 * which is the honest reading: if you do not take this one, you take the worst
	 * thing still out there.
	 *
	 * Opt-in, and off by default. `bscore` is the unit every run in data/results/
	 * is denominated in and the quantity src/auto/plan.ts sorts by, so the CLI and
	 * the backtests keep the number they were measured on; only a page that has
	 * actually read a wire passes this.
	 *
	 * ── TWO WAYS A LIST STOPS BEING THE TRUTH ABOUT THIS SLOT ──────────────────
	 *
	 * IT WAS NEVER READ HERE. `covered` is the league's own `slot_accepts` crossed
	 * with the positions the sweep actually came back with, and a slot outside it
	 * falls back to the whole-pool simulation rather than to whatever the sweep's
	 * other positions happened to sweep up. Measured on the committed capture with a
	 * four-position read, the six slots it never looked at were priced against
	 * bars of 47.90, 28.93, 64.84, 0, 0 and 0 against a complete wire's 57.20,
	 * 60.73, 72.81, 39.74, 37.00 and 35.34 — the table is under `availablePositions`.
	 *
	 * IT WAS READ AND CAME BACK EMPTY. That used to set the bar to 0, which is the
	 * most expensive number in this function: a bar of zero says a freely available
	 * man at this seat produces nothing, so everyone eligible there is credited with
	 * his whole projected total. Zero is not what "nobody is free" means either — if
	 * you genuinely cannot add a catcher, the value of the next catcher up is not
	 * nothing, it is unknown — so the honest answer is the one a page with no wire
	 * uses. The 0 stays for the case it was actually written for: no rateable player
	 * is eligible at this slot AT ALL, which is an unconfigured league or a seat
	 * nobody in baseball qualifies for, where there is no pool to simulate from.
	 *
	 * Both branches are inert on a complete read: measured on the committed capture,
	 * all ten startable slots are covered, none comes back empty, and the board is
	 * identical row for row with and without the declaration.
	 */
	/*
	 * HOW FAR DOWN THE POOL REPLACEMENT SITS, and it is not the same distance in the two
	 * pools — which it was, and that was a double-count.
	 *
	 * `teams x count` is the right depth in a pool of EVERY player in baseball: the man
	 * you could actually get is the one below all the men the other nine rosters have
	 * taken, and walking past them is how you find him. A WIRE is that pool with those
	 * rosters already removed — it is the list of men nobody has — so walking `teams x
	 * count` down it takes the same nine rosters out a second time, and lands on a man far
	 * worse than the one a reader can actually add today.
	 *
	 * MEASURED, three ways, all refuting the old line by an order of magnitude. On the
	 * committed capture's own wire, the number of men who out-project the whole-pool bar is
	 * 0 to 2 per slot (mean 0.7). In a simulated ten-team league over 111 weeks of
	 * 2021-2025 the weekly median is 0 to 5 (mean 1.8). This league's own `count` is 1.8
	 * seats per slot. The line this replaced walked 10 to 40 — `teams x count` — and that
	 * sentence stood here as "today's line" for a day after the line below stopped being it.
	 *
	 * AND IT IS WORTH POINTS, which is the part that decides it. Against the rule this
	 * REPLACED — `teams x count` walked down the wire — over 20 configurations of field
	 * composition and move budget, each 111 paired weeks: 19 of 20 favour walking `count`,
	 * mean +28.0 points a week, significant in 13, and it wins 78 of 100
	 * season-comparisons. (The `own - depth` row of grid.txt. "Against the shipped rule"
	 * stood here while `count` WAS the shipped rule, which made the sentence claim the
	 * engine had been measured against itself.) At the shipped two moves a week against a mixed
	 * field it is 62W-44L, +21.1/wk, z +1.75, p 0.080 — suggestive there, and significant
	 * at three moves (79W-26L, +58.7/wk, p below the resolution the run prints — its own
	 * line in data/results/wire-depth/grid.txt reads `p0.000`, and quoting a rounder
	 * number than the evidence carries is how a measurement drifts from what it measured). At ONE move a week everything in this
	 * question is inside the noise; about 23 decisions a season cannot separate any of it.
	 *
	 * THE OTHER CANDIDATE WAS MEASURED AND REJECTED. "A known wire means replacement is its
	 * BEST man" loses to the rule that ships here in 20 of 20 configurations, mean
	 * -36.7 points a week, significant in 13 of them and winning 15 of 100 seasons — the
	 * `best - own` row. The figures quoted here before were `best - depth`, its margin
	 * against the RETIRED rule (4 positive of 20, mean -8.7/wk), which understated the
	 * rejection fourfold and measured it against a line the engine no longer walks. It also
	 * degenerates: under it no man on the wire can score above zero, so "who should I add"
	 * becomes a tie at 0.00 broken arbitrarily — six men tied on the committed capture.
	 *
	 * BOTH FALLBACK POOLS KEEP THE OLD DEPTH, and that is deliberate rather than timid: a
	 * slot the sweep never reached, and a slot whose wire came back empty, are drawn from
	 * the whole of baseball, where the league's depletion has NOT already been taken out.
	 *
	 * Nothing in data/results/ moves: no backtest passes `available` — src/backtest/
	 * season.ts computes its own whole-pool bar and never calls this — and neither does
	 * src/auto/run.ts. The two browser screens are the only callers that do.
	 */
	/*
	 * ONE ASSIGNMENT, NOT TEN WALKS — see `jointReplacement` above, which measures what
	 * the independent walk cost: bars 10 to 24 points too high at every slot but
	 * catcher, because a man who qualifies at three positions was counted as taken at
	 * all three. Catcher was right, which is why nobody caught it: the position
	 * everybody checks by hand was the one position with almost no overlap.
	 *
	 * The DEPTH argument is unchanged and is still the thing this block spent a page
	 * arguing: `count` down a wire, `teams x count` down the whole of baseball. What
	 * changes is that the men above the line are seated once between them instead of
	 * once per slot each.
	 *
	 * Measured over 111 weeks of real roster decisions with the league's own bench, in
	 * combination with switching the shrinkage on: 69W-42L against the previously
	 * shipped model, +25.3 points a week, p 0.013 on a sign test and 0.0003 paired.
	 * Chosen on 2021-2023 and validated on 2024-2025, which it was not fitted on:
	 * 33W-13L there, +42.6/wk, p 0.0045 / 0.0001.
	 */
	const speaksFor = (slot: string): boolean =>
		o.available !== undefined && (covered === null || covered.has(slot))
	// the predicate, not the Set: `RESERVE_SLOTS.has` is the hand-shaped check that
	// loses "IL-60" and "NA(b)", and this is the line that decides which seats get a
	// replacement bar at all — a reserve seat that slipped through would be priced and
	// filled, moving every bscore on the board
	const startable = Object.keys(slotCounts).filter(sl => !isReserveSlot(sl))
	const wirePool = o.available ? allRated.filter(r => o.available!(r)) : []
	/** The whole-of-baseball simulation: the league's own seats, filled once between
	 *  everybody, and the first man left at a slot is that slot's bar. */
	const wholeBars = jointReplacement(
		allRated,
		Object.fromEntries(startable.map(sl => [sl, slotCounts[sl] ?? 1])),
		(_sl, count) => o.teams * count
	)
	/** The same assignment run down the reader's OWN wire, and only for the slots that
	 *  wire is entitled to speak for. `count` rather than `teams x count`, for the reason
	 *  argued above: a wire is the pool with the other rosters already taken out. */
	const wireSlots = Object.fromEntries(
		startable
			.filter(sl => speaksFor(sl) && wirePool.some(r => r.slots.includes(sl)))
			.map(sl => [sl, slotCounts[sl] ?? 1])
	)
	const wireBars =
		Object.keys(wireSlots).length ?
			jointReplacement(wirePool, wireSlots, (_sl, count) => count)
		:	new Map<string, number>()
	for (const slot of startable) {
		/* Nobody in baseball qualifies here: an unconfigured league or a seat with no
		   pool to simulate from, which is the one case 0 was ever written for. */
		if (!allRated.some(r => r.slots.includes(slot))) {
			replacementBySlot.set(slot, 0)
			continue
		}
		replacementBySlot.set(slot, wireBars.get(slot) ?? wholeBars.get(slot) ?? 0)
	}

	for (const r of rated) {
		let best = { slot: r.slots[0] ?? "Util", value: -Infinity, replacement: 0 }
		for (const slot of r.slots) {
			const replacement = replacementBySlot.get(slot)
			if (replacement === undefined) continue
			const value = r.points - replacement
			if (value > best.value) best = { slot, value, replacement }
		}
		r.slot = best.slot
		r.replacement = Number(best.replacement.toFixed(2))
		r.bscore = Number((best.value === -Infinity ? 0 : best.value).toFixed(2))
		/* Derived from the ROUNDED bscore for the same reason `addValue` is: two numbers on
		   one row that disagree in the last decimal place is a defect a reader can see. */
		r.bscorePerGame =
			r.projection.horizonGames > 0 ?
				Number((r.bscore / r.projection.horizonGames).toFixed(3))
			:	null
		// the display floor, derived from the rounded bscore so the two can never
		// disagree in the last decimal place
		r.addValue = Math.max(r.bscore, 0)
	}

	return rated.sort((a, b) => b.bscore - a.bscore)
}

/** Percentile of the regression gap within the rated pool — the undervaluation
 *  signal, expressed relative to the players actually being compared. */
/**
 * A rated player plus the comparative numbers, which need the whole pool to compute
 * and so cannot live on Rated itself.
 *
 * `uscore` — "underrated score" — is what he adds times the share of leagues where
 * he is still free: value you can realistically capture, in the same points bscore
 * is in. bscore answers who is best, uscore answers who is the best you can
 * actually get. It is `null` wherever Yahoo lists no ownership figure, because
 * unknown is not the same as unowned.
 */
export type Ranked = Rated & {
	undervaluation: number | null
	rosteredPct: number | null
	marketEdge: number | null
	uscore: number | null
}

export const withUndervaluation = (
	rated: Rated[]
): (Rated & { undervaluation: number | null })[] => {
	// Percentile WITHIN a side. For a batter a positive est_woba − woba means his
	// results trail his contact; for a pitcher it means the opposite. Ranking both
	// in one pool, as an earlier version did, produced a number with no meaning.
	// The sign flip happens on the way into the pool, which is what lets one sort
	// serve both sides — the old per-row negation reversed the order it just built.
	const signed = (r: Rated) =>
		r.player.group === "hitting" ? r.regressionGap! : -r.regressionGap!
	const gapsBySide = {
		hitting: [] as number[],
		pitching: [] as number[]
	}
	for (const r of rated)
		if (r.regressionGap !== null && r.rateable) gapsBySide[r.player.group].push(signed(r))
	for (const key of ["hitting", "pitching"] as const) gapsBySide[key].sort((a, b) => a - b)

	// strictly below, so ties share a percentile exactly as the filter did
	const below = (arr: number[], x: number) => {
		let lo = 0,
			hi = arr.length
		while (lo < hi) {
			const m = (lo + hi) >> 1
			if (arr[m]! < x) lo = m + 1
			else hi = m
		}
		return lo
	}

	return rated.map(r => {
		if (r.regressionGap === null || !r.rateable) return { ...r, undervaluation: null }
		const pool = gapsBySide[r.player.group]
		return {
			...r,
			undervaluation: Number(
				((below(pool, signed(r)) / Math.max(pool.length, 1)) * 100).toFixed(1)
			)
		}
	})
}


/**
 * Market edge: how far a player's bscore sits above what the field's ownership
 * implies he is worth.
 *
 * A bare bscore ranking answers "who is best", which on a waiver wire is only
 * half the question — the best players are already taken. This answers "who is
 * the field wrong about", by comparing each player against the players the field
 * prices the same way he is priced.
 *
 * Implemented as a residual rather than as a percentile difference, so the answer
 * stays denominated in league points: an edge of +18 means eighteen points more
 * than the typical player rostered in about as many leagues. A percentile gap
 * would have made every unrostered replacement-level body look like a find.
 */
/**
 * uscore — what you can realistically ADD, in points.
 *
 * It was `bscore / owned%`, a literal quotient, and the shape was wrong in three
 * ways at once. A ratio is scale-free, so it read 1.8 where bscore reads 21 and
 * there was no way to compare the two columns. Dividing by a number in [0,100]
 * explodes at the bottom and collapses at the top, so the ranking was decided by
 * whoever happened to be barely owned rather than by who was worth having: a
 * marginal 5%-owned arm at 1.7 outranked a 21-point player at 42% ownership. And
 * three quarters of the board rounded to 0.0 or below.
 *
 * This is `addValue × (1 − owned)` instead: what he adds, times the share of
 * leagues where he is still there to be added. Same units as bscore, so the two
 * columns can be read against each other; monotone in both inputs, so being
 * better and being freer both help and neither can be gamed by a small
 * denominator; and bounded by bscore itself, so nothing can run away.
 *
 * `addValue` rather than raw bscore, because a player below the waiver bar is not
 * a negative pickup — he is simply one you do not make (METHODOLOGY 4.4). Using
 * bscore here would have produced a large NEGATIVE uscore for the least-owned
 * players, i.e. the ranking upside down.
 *
 * Measured on the reference capture: the top of the column becomes Ryan Jeffers
 * at 12.3 (21.2 points, rostered in 42%) ahead of Drew Anderson at 8.2 (8.6
 * points, rostered in 5%) — the quotient had that pair the other way round.
 */

const BUCKETS = 10

export const withMarketEdge = (
	rated: (Rated & { undervaluation: number | null })[],
	ownership: Map<number, number> | undefined,
	/**
	 * The same quantity, read off the reader's OWN league page minutes ago.
	 *
	 * It overrides the capture per player and deliberately does NOT build the curve.
	 * The bar every row is measured against stays a whole-board median off a capture
	 * that passed the leak tripwire; a wire sweep is ~225 free agents, which is the
	 * bottom of the market by construction, and a decile curve built from it would put
	 * par where the unowned live and call every rostered man a bargain.
	 *
	 * One number then feeds `rosteredPct`, `uscore` and the `parAt` lookup, so the row
	 * and its drill-down cannot disagree about how owned a man is.
	 */
	wire?: Map<number, number>
): Ranked[] => {
	const priced = rated.flatMap(r => {
		const pct = ownership?.get(r.player.id)
		return pct === undefined || !r.rateable ? [] : [{ pct, bscore: r.bscore }]
	})

	// median rather than mean: the top bucket contains superstars whose bscores are
	// long-tailed, and a mean there would set an unreachable bar for everyone in it
	const curve: { pct: number; par: number }[] = []
	if (priced.length >= BUCKETS * 4) {
		const byPct = [...priced].sort((a, b) => a.pct - b.pct)
		const size = Math.floor(byPct.length / BUCKETS)
		for (let i = 0; i < BUCKETS; i++) {
			const slice = byPct.slice(i * size, i === BUCKETS - 1 ? byPct.length : (i + 1) * size)
			if (!slice.length) continue
			const scores = slice.map(x => x.bscore).sort((a, b) => a - b)
			curve.push({
				pct: slice.reduce((a, c) => a + c.pct, 0) / slice.length,
				par: scores[Math.floor(scores.length / 2)]!
			})
		}
	}

	/** What a player rostered this widely typically produces. */
	const parAt = (pct: number): number | null => {
		if (curve.length < 2) return null
		if (pct <= curve[0]!.pct) return curve[0]!.par
		if (pct >= curve[curve.length - 1]!.pct) return curve[curve.length - 1]!.par
		for (let i = 1; i < curve.length; i++) {
			const a = curve[i - 1]!, b = curve[i]!
			if (pct <= b.pct) return a.par + ((pct - a.pct) / (b.pct - a.pct)) * (b.par - a.par)
		}
		return null
	}

	return rated.map(r => {
		const pct = wire?.get(r.player.id) ?? ownership?.get(r.player.id) ?? null
		const par = pct === null || !r.rateable ? null : parAt(pct)
		return {
			...r,
			rosteredPct: pct,
			marketEdge: par === null ? null : Number((r.bscore - par).toFixed(1)),
			uscore:
				pct === null || !r.rateable ? null
				:	Number((r.addValue * (1 - Math.min(pct, 100) / 100)).toFixed(1))
		}
	})
}


/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Who the reader can actually ADD, without a server.
 *
 * The board's whole streaming answer was unreachable on beanemachine.com. "Free
 * agents only" reads the league's live free-agent list through the local API, and
 * the hosted page has no API — so the control was permanently disabled there and
 * the streaming list opened, measured on the live capture of 2026-09-04, with
 * Tyler Glasnow (94% rostered), Blake Snell, Chris Sale (99%) and Drew Rasmussen
 * (95%). To stream a starter is to pick one up. Four men nobody can pick up is not
 * an answer to that question.
 *
 * The snapshot already carries Yahoo's "% Ros" for everyone Yahoo listed, so the
 * estimate below needs nothing the hosted page does not already have.
 *
 * ── AND NOW THAT A REAL LIST CAN ARRIVE, HOW GOOD WAS THE ESTIMATE? ──────────
 *
 * A reader can now hand over his own league's free-agent list in one press, so the
 * estimate is no longer the only answer and can be measured against the thing it was
 * standing in for. Measured on data/snapshot.json against league 228947 over the
 * committed fortnight, with a wire read out of the capture's own ownership column —
 * the 611 men it prices at or below this league's 35% cut — and passed as
 * `available`:
 *
 *  · THE FIGURES BELOW WERE TAKEN AT THE OLD DEPTH, and are restated rather than
 *    left standing. They read: seven of ten bars identical to the cent, three moving
 *    by about a point, the top 20 the same 20 men, first reordering at row 3 on a
 *    1.64-point move. All four were measured on 2026-09-17, hours before the
 *    replacement depth on a real wire changed from `teams x count` to `count` — see
 *    the docblock on that line — and a shallower bar on the real list moves the two
 *    answers further apart.
 *  · WHAT IT IS AT THE SHIPPED DEPTH: most bars still land close, the largest move is
 *    7.60, and the top 20 overlaps 16 of 20. Those are the figures test/engine.mjs
 *    asserts, which is what keeps them from going stale again — the assertions are the
 *    measurement, and running the suite re-derives them.
 *  · WHICH IS NOT THE ESTIMATE GETTING WORSE. It is the real list finally being read
 *    at the right depth, and it makes the estimate matter MORE than this block used to
 *    say: the bar it stands in for is further from the truth than 1.64 points.
 *  · WHAT DOES MOVE IS WHO IS SHOWN. The estimate calls 1,010 of 1,248 rateable men
 *    gettable; the real list calls 540. All 470 of the difference are men Yahoo never
 *    priced at all, which the estimate treats as probably free — see
 *    `likelyAvailable`, which argues for that and is the rule being measured here.
 *
 * So the estimate was good AT THE JOB THE BAR NEEDS IT FOR, and the real list's worth
 * is that it halves the list of men it will offer you. That is a finding about this
 * league and this capture, not a theorem: a 12-team league cuts deeper and an
 * ownership column read on a day of heavy waiver activity is staler.
 *
 * The comparison is also narrower than it looks, and saying so is the point. The wire
 * it measures against is DERIVED from the same ownership column the estimate reads,
 * so the only thing separating the two is how each treats a man Yahoo never listed.
 * It cannot say anything about men Yahoo prices wrongly, and nothing here has been
 * checked against a wire actually read off Yahoo — that needs a reader's own league
 * and a captured sweep, and when one exists this measurement should be re-run on it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * How many players this league can hold at once: every seat on every roster.
 *
 * Deliberately NOT `RESERVE_SLOTS`-filtered, which is the mistake waiting to be
 * made here. That set exists because a bench seat starts nobody and therefore sets
 * no replacement bar — a question about VALUE. This is a question about SUPPLY, and
 * a player on somebody's bench is every bit as unavailable as one in his lineup. An
 * IL seat counts for the same reason and for one more: the ownership column being
 * ranked below prices injured stars too, so dropping IL seats from the count while
 * leaving injured players in the ranking would be a numerator and a denominator
 * drawn from different populations, which is the shape of every bug this codebase
 * has found in itself.
 *
 * League 228947: 10 teams x 27 seats (18 active, 5 bench, 4 IL) = 270 players.
 */
export const rosterableDepth = (league: League): number | null => {
	const teams = league.meta.max_teams
	if (teams == null) return null
	const seats = Object.values(league.roster.slots).reduce((a, b) => a + b, 0)
	return seats > 0 ? teams * seats : null
}

/**
 * The ownership percentage that separates "probably taken" from "probably free" —
 * calibrated to this league's own size rather than to a threshold somebody picked.
 *
 * Rank everyone Yahoo priced by how widely he is rostered and count down to the
 * (teams x seats)-th name. That player is, by construction, the last one the league
 * has room for; the field agrees he is roughly the most-owned player still gettable.
 * A 12-team league reaches further down that list than a 10-team one and gets a
 * lower cut out of the same data, which is the point — `WIDELY_ROSTERED = 70` in
 * Board.tsx was one number standing in for every league in the world.
 *
 * The comparison is STRICTLY above the cut, so a tie at the boundary falls on the
 * available side. That is the deliberate direction: showing a man who turns out to
 * be taken costs the reader a click on Yahoo, hiding one who was free costs him the
 * pickup.
 */
export interface OwnershipCut {
	/** Whether this capture's ownership can support the estimate at all. */
	usable: boolean
	/** The boundary percentage. Meaningless when `usable` is false. */
	cut: number
	/** teams x seats — how many players the league can hold. */
	depth: number
	/** Seats on ONE roster, which is the bar the tie test below is measured against. */
	seats: number
	/** How many players this capture priced at all. */
	priced: number
	/** How many of them sit on exactly the cut, unable to be ordered against it. */
	tied: number
	/** One sentence naming what the estimate is, or why there isn't one. */
	basis: string
}

export const ownershipCut = (
	league: League,
	ownership: Map<number, number> | undefined
): OwnershipCut | null => {
	const depth = rosterableDepth(league)
	const teams = league.meta.max_teams
	if (depth === null || teams == null) return null
	const seats = depth / teams
	const values = [...(ownership?.values() ?? [])].sort((a, b) => b - a)
	const priced = values.length
	const nothing = (basis: string): OwnershipCut => ({
		usable: false, cut: 0, depth, seats, priced, tied: 0, basis
	})
	/**
	 * A capture that priced fewer players than the league has seats cannot locate
	 * the boundary at all — the cut would fall off the end of the list and every
	 * unpriced player, which is most of baseball, would be called free on no
	 * evidence.
	 */
	if (priced < depth)
		return nothing(
			`this capture carries a rostered share for only ${priced} players, fewer than the ` +
				`${depth} a ${teams}-team league with ${seats} seats can hold, so there is no ` +
				`point in the list where the league runs out of room`
		)
	const cut = values[depth - 1]!
	const tied = values.filter(v => v === cut).length
	/**
	 * The gate, and it is not decoration: it is what stops this estimate repeating
	 * the failure it exists to fix.
	 *
	 * Yahoo's "% Ros" is swept off player pages whose tooltip also carries a
	 * per-game weather line, and a sweep that reads the wrong cell puts a whole
	 * club on one identical percentage. `leakedByTeam` in data/yahoo-pool.ts
	 * discards those at capture time; the capture that went in BEFORE it — stamped
	 * 2026-09-02 and no longer the committed one — had 225 of 848 priced players at
	 * exactly 51%, 83% of the 270-deep boundary inside a single tie the column cannot
	 * order. Ranking by it there produced a "who you can get" list headed by Zack
	 * Wheeler, Jacob deGrom and Logan Gilbert: the same unreachable aces, differently
	 * spelled. That capture is kept here as the failure, not as the present state —
	 * this comment used to call it "the snapshot committed", which it has not been
	 * since 2026-09-08.
	 *
	 * So the tie at the cut must be smaller than ONE roster. Past that the estimate
	 * cannot even say which team's worth of players the boundary falls in, and a
	 * boundary that cannot be located to within a single roster is not a boundary.
	 * The bar is the league's own seat count, not a constant.
	 *
	 * Measured, 10 teams x 27 seats, depth 270. The third row is the capture that is
	 * actually committed, re-derived 2026-09-11 — 880 priced, 270th value 35, 4 tied:
	 *   2026-09-02 (leaked, superseded)    cut 51%, 225 tied — 8.3x one roster, refused
	 *   2026-09-04 (live, deleaked)        cut 35%,   4 tied — 0.15x one roster, used
	 *   2026-09-08 (committed, deleaked)   cut 35%,   4 tied — 0.15x one roster, used
	 */
	if (tied > seats)
		return nothing(
			`${tied} players in this capture are rostered in exactly ${cut}% of leagues, which ` +
				`is more than the ${seats} seats on one roster — the boundary between taken and ` +
				`free lands inside a tie this column cannot order, so it is not read`
		)
	return {
		usable: true,
		cut,
		depth,
		seats,
		priced,
		tied,
		basis:
			`estimated: a ${teams}-team league with ${seats} seats holds ${depth} players, and the ` +
			`${depth}th most widely rostered player in this capture is rostered in ${cut}% of ` +
			`leagues — so above ${cut}% is treated as taken`
	}
}

/**
 * Is this player likely to be sitting on the wire in a league of this size?
 *
 * An UNLISTED player counts as available, and that is a decision rather than an
 * oversight, so here is the argument and the measurement behind it.
 *
 * Yahoo's sweep walks 8 pages of 25 across 9 positions — about 200 deep per
 * position, ordered by ownership. A player it never reached is therefore below
 * roughly the 200th-most-owned man at his position, which is far below a
 * 270-player boundary. Measured on the live 2026-09-04 capture: 0 of the top 270
 * players by season points are unlisted, the listed pool's median season total is
 * 337 points against the unlisted pool's 36, and the single best unlisted player
 * scored 386 where the best listed one scored 1,531. Deep unlisted arms are exactly
 * who a streamer picks up, and dropping them would cut 19 of the 106 pitchers with
 * a start in the window — so they are shown.
 *
 * The rule is only safe because `ownershipCut` refuses first. On the thin, leaked
 * 2026-09-02 capture the same measurement reads 67 of the top 270 unlisted —
 * Ohtani, Harper, Schwarber, Alonso — and calling those free would be the original
 * complaint with worse manners. The gate catches that capture before this function
 * is ever consulted.
 *
 * A single hole in an otherwise clean read is caught by the VALUE test instead.
 * Blake Snell and Garrett Crochet are both unlisted on the 2026-09-04 capture and
 * both rostered everywhere; Snell came out top of the gettable list. The reasoning
 * that makes unlisted mean gettable is precisely what rules them out: the sweep is
 * ordered by Yahoo's own rank and reaches ~200 deep per position, so a player good
 * enough to sit inside a league's rostered depth CANNOT also be too obscure for the
 * sweep to have reached. If he is both, the read has a hole and the honest answer
 * about him is that we do not know — not that he is free.
 *
 * So an unlisted player counts as gettable only while his own projection puts him
 * outside the rostered depth. No new constant: it is the same `teams x seats`
 * boundary the ownership cut uses, applied to the ranking instead of to ownership.
 * A listed player is unaffected — his percentage is a real read and answers for
 * itself.
 */
export const likelyAvailable = (
	rosteredPct: number | null,
	cut: OwnershipCut,
	/** Where this player sits in the value ranking, and how deep the league rosters.
	 *  Omitted keeps the old behaviour, which is correct wherever the caller has no
	 *  ranking to hand — a name search, a single row. */
	value?: { rank: number; depth: number }
): boolean =>
	rosteredPct === null ?
		// unlisted: gettable only if he is not also good enough to be rostered
		value === undefined || value.rank >= value.depth
	:	rosteredPct <= cut.cut
