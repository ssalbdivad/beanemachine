import type { PlayerSeason, StatLine } from "../data/statsapi.ts"

/**
 * Matchups: who a player is actually booked against over the horizon.
 *
 * Shared by the live board and the season simulator so that a weight change in
 * `model.json` moves both — a knob that only steers the backtest is a knob that
 * lies about what the app is doing.
 */
/**
 * Linear-weights wOBA numerator per plate appearance. Used two ways from the same
 * formula: over a team's hitters it is how much offence that team produces, over
 * its pitchers how much it allows. Both are computed from the leak-free prior
 * window, never from what the opponent went on to do.
 */
const wobaish = (line: StatLine, volume: number | undefined): number | null => {
	if (!volume || volume <= 0) return null
	const hr = line.homeRuns ?? 0, tr = line.triples ?? 0, db = line.doubles ?? 0
	const singles = (line.hits ?? 0) - db - tr - hr
	const n =
		0.69 * (line.baseOnBalls ?? 0) + 0.72 * (line.hitByPitch ?? 0) +
		0.89 * singles + 1.27 * db + 1.62 * tr + 2.1 * hr
	return n / volume
}

export interface TeamStrength {
	/** How much offence the team produces, relative to the league. */
	offense: Map<number, number>
	/** How much offence the team's staff allows, relative to the league. */
	defense: Map<number, number>
}

export const teamStrength = (prior: PlayerSeason[]): TeamStrength => {
	const acc = {
		hitting: new Map<number, { line: StatLine; v: number }>(),
		pitching: new Map<number, { line: StatLine; v: number }>()
	}
	for (const p of prior) {
		if (!p.teamId) continue
		const v = p.group === "hitting" ? p.stats.plateAppearances : p.stats.battersFaced
		if (!v) continue
		const bucket = acc[p.group]
		const cur = bucket.get(p.teamId) ?? { line: {} as StatLine, v: 0 }
		for (const [k, val] of Object.entries(p.stats)) cur.line[k] = (cur.line[k] ?? 0) + val
		cur.v += v
		bucket.set(p.teamId, cur)
	}
	const rel = (bucket: Map<number, { line: StatLine; v: number }>) => {
		const raw = new Map<number, number>()
		for (const [team, { line, v }] of bucket) {
			const r = wobaish(line, v)
			if (r !== null) raw.set(team, r)
		}
		const mean = [...raw.values()].reduce((a, c) => a + c, 0) / Math.max(raw.size, 1)
		const out = new Map<number, number>()
		if (mean > 0) for (const [team, r] of raw) out.set(team, r / mean)
		return out
	}
	return { offense: rel(acc.hitting), defense: rel(acc.pitching) }
}

/**
 * The schedule-strength index for one player over the horizon.
 *
 * Both sides come out meaning the same thing — "more events than a league-average
 * week" — which is what makes one multiplier correct for both. A hitter booked
 * against generous staffs gets an index above 1 and more hits; a pitcher booked
 * against strong lineups also gets an index above 1, and since the scaled set on
 * his side is what he ALLOWS, that costs him points.
 */
export const matchupIndexFor = (
	p: PlayerSeason,
	opps: Map<number, number[]>,
	strength: TeamStrength
): number | null => {
	if (!p.teamId) return null
	const list = opps.get(p.teamId)
	if (!list?.length) return null
	const table = p.group === "hitting" ? strength.defense : strength.offense
	const vals = list.map(o => table.get(o)).filter((v): v is number => v !== undefined)
	if (!vals.length) return null
	return vals.reduce((a, c) => a + c, 0) / vals.length
}


/**
 * The sharper matchup: WHO is actually starting against you.
 *
 * Team-level staff quality averages an ace and a fifth starter into one number,
 * and a hitter does not face a staff — he faces the man on the mound. MLB
 * publishes probable starters about a week out, so for the streaming horizon the
 * specific pitcher is an observation rather than an estimate.
 *
 * A starter covers roughly 58% of a game's innings league-wide (about 5.2 of 9),
 * so the two indices are blended in that proportion rather than by a tuned
 * weight: the starter's own quality for his share, the opponent staff's for the
 * bullpen innings behind him. Where no probable is published the blend collapses
 * to the team index, which is what the model did before.
 *
 * This cannot be backtested — probables are announced and then overwritten, and
 * nothing archives what was announced at the time. It ships because it replaces
 * an average with an observation, which is the same reason scheduled starts ship,
 * and it is flagged here rather than dressed up as a measured gain.
 */
const STARTER_INNINGS_SHARE = 0.58

/** Each pitcher's wOBA allowed, relative to the league. >1 means easier to hit. */
export const pitcherQuality = (players: PlayerSeason[]): Map<number, number> => {
	const raw = new Map<number, number>()
	for (const p of players) {
		if (p.group !== "pitching") continue
		const r = wobaish(p.stats, p.stats.battersFaced)
		// a September call-up with nine batters faced is not a matchup signal
		if (r !== null && (p.stats.battersFaced ?? 0) >= 100) raw.set(p.id, r)
	}
	const mean = [...raw.values()].reduce((a, c) => a + c, 0) / Math.max(raw.size, 1)
	const out = new Map<number, number>()
	if (mean > 0) for (const [id, r] of raw) out.set(id, r / mean)
	return out
}

export const starterBlendedIndex = (
	player: PlayerSeason,
	teamIndex: number | null,
	opposingStarters: Map<number, number[]> | undefined,
	quality: Map<number, number>
): number | null => {
	if (player.group !== "hitting" || !player.teamId) return teamIndex
	const facing = opposingStarters?.get(player.teamId)
	if (!facing?.length) return teamIndex
	const known = facing.map(id => quality.get(id)).filter((v): v is number => v !== undefined)
	if (!known.length) return teamIndex
	const starters = known.reduce((a, c) => a + c, 0) / known.length
	// with no team index there is no bullpen estimate, so the starter carries it all
	if (teamIndex === null) return starters
	return STARTER_INNINGS_SHARE * starters + (1 - STARTER_INNINGS_SHARE) * teamIndex
}
