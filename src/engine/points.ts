import type { League } from "../schema.ts"
import type { StatLine } from "../data/statsapi.ts"

/**
 * Converts an observed stat line into the points a specific league would award.
 *
 * The mapping below is a documented correspondence between StatsAPI field names
 * and the stat codes leagues use — not an inference. Any code a league scores
 * that has no mapping is reported in `unscoreable` rather than silently treated
 * as zero, because a quietly-dropped category would understate every player who
 * accrues it.
 */

/** Derived from observed values, not estimated: singles are hits minus extra-base hits. */
const singles = (s: StatLine): number | null =>
	s.hits === undefined ? null
	:	s.hits - (s.doubles ?? 0) - (s.triples ?? 0) - (s.homeRuns ?? 0)

type Getter = (s: StatLine) => number | null | undefined

export const HITTING_MAP: Record<string, Getter> = {
	R: s => s.runs,
	"1B": singles,
	"2B": s => s.doubles,
	"3B": s => s.triples,
	HR: s => s.homeRuns,
	RBI: s => s.rbi,
	SB: s => s.stolenBases,
	CS: s => s.caughtStealing,
	BB: s => s.baseOnBalls,
	IBB: s => s.intentionalWalks,
	HBP: s => s.hitByPitch,
	SO: s => s.strikeOuts,
	K: s => s.strikeOuts,
	SF: s => s.sacFlies,
	SH: s => s.sacBunts,
	GIDP: s => s.groundIntoDoublePlay,
	TB: s => s.totalBases,
	H: s => s.hits,
	AB: s => s.atBats,
	PA: s => s.plateAppearances
}

export const PITCHING_MAP: Record<string, Getter> = {
	W: s => s.wins,
	L: s => s.losses,
	SV: s => s.saves,
	BS: s => s.blownSaves,
	HLD: s => s.holds,
	OUT: s => s.outs,
	IP: s => (s.outs === undefined ? undefined : s.outs / 3),
	H: s => s.hits,
	ER: s => s.earnedRuns,
	R: s => s.runs,
	BB: s => s.baseOnBalls,
	IBB: s => s.intentionalWalks,
	HBP: s => s.hitBatsmen,
	K: s => s.strikeOuts,
	SO: s => s.strikeOuts,
	HR: s => s.homeRuns,
	CG: s => s.completeGames,
	SHO: s => s.shutouts,
	WP: s => s.wildPitches,
	BK: s => s.balks
}

/**
 * `Object.entries` of a league's scoring table, memoised on the table itself.
 *
 * `scoreStats` runs twice per player per board — once on the projection, once on
 * the season line — so 2,866 times for a 1,433-player pool, and each call rebuilt
 * the same array of the same ~20 pairs from the same object. A CPU profile put 8%
 * of `rateAll` in here.
 *
 * Safe because a scoring table is never mutated in place: `src/import.ts` builds a
 * fresh one and the editor in `src/client/App.tsx` replaces it with a spread rather
 * than assigning into it, so a changed table is a different object and misses the
 * cache. WeakMap, so a discarded league is collectable.
 */
/**
 * `Number(x.toFixed(d))` without the decimal round-trip.
 *
 * Every stored number in the projection and every points breakdown goes through
 * that idiom, and it is the single hottest line on the board: `toFixed` formats a
 * string and `Number` parses it back, roughly **5.6x** the cost of the arithmetic
 * (3M calls: 470ms against 84ms, measured on this machine). A board pays it about
 * 100,000 times — ~43,000 in the projected stat lines and ~57,000 in the two
 * points breakdowns per player.
 *
 * It is NOT simply `Math.round(x * 1000) / 1000`, which is a different function.
 * `toFixed` rounds the exact value of the double, half away from zero; the multiply
 * introduces its own rounding error and `Math.round` breaks ties towards +infinity.
 * The two can therefore disagree at or beside a tie — so the fast path is taken
 * only where a tie is provably out of reach.
 *
 * The bound: the multiply's error is at most |y| x 2^-53, which is under 1.2e-7 for
 * the magnitudes a stat line reaches, so requiring the scaled value to sit at least
 * 1e-6 from a half-integer leaves three orders of margin. Everything else — a tie,
 * an out-of-range magnitude, NaN, Infinity — falls back to `toFixed` and is exactly
 * as it was. The division that remains is correctly rounded by IEEE-754, so it
 * lands on the same double `Number("1.234")` does.
 *
 * Guarded rather than assumed, and then checked against the data anyway: the A/B in
 * METHODOLOGY 13 diffs every field of every rated row across all three horizons.
 */
export const roundTo = (x: number, digits: 1 | 2 | 3): number => {
	// Negative zero is the one value where the two really do disagree: `toFixed`
	// formats -0 as "0.000" and parses back POSITIVE zero, while -0 x 1000 / 1000
	// stays negative. Caught by the exhaustive check in test/engine.mjs, not by
	// reasoning — which is the reason that check exists.
	if (x === 0) return 0
	const scale = digits === 1 ? 10 : digits === 2 ? 100 : 1000
	const y = x * scale
	const r = Math.round(y)
	return Math.abs(y - r) < 0.499999 && Math.abs(y) < 1e9 ? r / scale : Number(x.toFixed(digits))
}

const TABLE_ENTRIES = new WeakMap<Record<string, number>, [string, number][]>()

const entriesOf = (table: Record<string, number>): [string, number][] => {
	let entries = TABLE_ENTRIES.get(table)
	if (entries === undefined) {
		entries = Object.entries(table)
		TABLE_ENTRIES.set(table, entries)
	}
	return entries
}

export interface PointsResult {
	points: number
	/** Per-category contribution, so a total can always be taken apart. */
	breakdown: Record<string, number>
	/** League categories we cannot source from StatsAPI — surfaced, never zeroed. */
	unscoreable: string[]
}

export const scoreStats = (
	stats: StatLine,
	table: Record<string, number>,
	group: "hitting" | "pitching"
): PointsResult => {
	const map = group === "hitting" ? HITTING_MAP : PITCHING_MAP
	const breakdown: Record<string, number> = {}
	const unscoreable: string[] = []
	let points = 0

	for (const [code, perUnit] of entriesOf(table)) {
		const getter = map[code]
		const value = getter?.(stats)
		if (getter === undefined || value === undefined || value === null) {
			unscoreable.push(code)
			continue
		}
		const contribution = value * perUnit
		breakdown[code] = roundTo(contribution, 2)
		points += contribution
	}
	return { points: roundTo(points, 2), breakdown, unscoreable }
}

/** Which side of the league's scoring applies to a player. */
export const tableFor = (league: League, group: "hitting" | "pitching") =>
	group === "hitting" ? league.scoring.batting : league.scoring.pitching
