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

	for (const [code, perUnit] of Object.entries(table)) {
		const getter = map[code]
		const value = getter?.(stats)
		if (getter === undefined || value === undefined || value === null) {
			unscoreable.push(code)
			continue
		}
		const contribution = value * perUnit
		breakdown[code] = Number(contribution.toFixed(2))
		points += contribution
	}
	return { points: Number(points.toFixed(2)), breakdown, unscoreable }
}

/** Which side of the league's scoring applies to a player. */
export const tableFor = (league: League, group: "hitting" | "pitching") =>
	group === "hitting" ? league.scoring.batting : league.scoring.pitching
