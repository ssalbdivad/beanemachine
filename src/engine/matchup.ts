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

/**
 * The only fields `wobaish` reads.
 *
 * `teamStrength` used to sum EVERY key of every player's line — about thirty per
 * player, 1,433 players, on every horizon switch — and then read six of them. It
 * also summed rate stats, so a club's `avg` was the sum of its hitters' batting
 * averages: a number with no meaning, which nothing ever looked at. Six named adds
 * replace an `Object.entries` allocation and a generic loop, and the six summed are
 * exactly the six consumed, so every team index is unchanged to the last bit.
 */
const WOBA_FIELDS = ["homeRuns", "triples", "doubles", "hits", "baseOnBalls", "hitByPitch"] as const

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
		for (const f of WOBA_FIELDS) cur.line[f] = (cur.line[f] ?? 0) + (p.stats[f] ?? 0)
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
 * A starter covers roughly 58% of a game's innings league-wide, so the two indices
 * are blended in that proportion rather than by a tuned weight. Where no probable
 * is published the blend collapses to the team index, which is what the model did
 * before.
 *
 * Two things about that sentence were being overstated, and both are stated
 * straight here instead.
 *
 * FIRST, the remaining share is NOT "the bullpen innings behind him", which is what
 * this comment used to claim. `teamIndex` is the opponent's WHOLE staff, starters
 * included, so the named starter is counted twice: once at 58% on his own, and
 * again inside the 42%. On a fully covered window his effective weight is about
 * 0.58 + 0.42 x 0.58 = 0.82, and the bullpen's about 0.18. Splitting the opponent's
 * staff into rotation and bullpen would fix it, and would also reorder the board
 * for every hitter, which probables cannot be backtested to justify (METHODOLOGY
 * 3.5) — so the term is left alone and the arithmetic is written down.
 *
 * SECOND, 0.58 was justified as "about 5.2 of 9", and neither number reproduces on
 * the committed capture. Pro-rating each swingman's outs by his share of starts,
 * starters throw 55.7% of league innings (39.9% by pure starters, 27.4% by pure
 * relievers, 32.7% by pitchers who do both); the median start by a pure starter is
 * 16.6 outs, 5.53 innings, not 5.2. 0.58 sits just above the measured share and is
 * kept — moving it moves every hitter's index and there is no leak-free way to
 * replay probables and say whether that helped.
 *
 * That 58% is the share of ONE game, and it only applies to the games actually
 * published. MLB fills today and tomorrow and then thins out fast, so over a
 * fortnight two names are typical — letting those two speak for fourteen games is
 * the same error that read a partial probable count as a complete one and dropped
 * a top-five starter 350 places. The share is therefore scaled by how much of the
 * window is covered, and the published list is its own coverage count: one entry
 * per game whose opposing starter is known.
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

/**
 * The lineups a PITCHER is actually booked against, rather than his club's week.
 *
 * `matchupIndexFor` averages every opponent the club faces in the window, because
 * that is the right question for a hitter — he plays them all. A starter does not:
 * he takes one turn in five, and which lineup falls on his turn is most of what a
 * streaming decision is about. A man announced against the weakest offence in the
 * league was being priced on his club's whole week, and a man announced against the
 * best was getting the same discount.
 *
 * Where MLB has named him the opponent is known, so it is used. The starts it has
 * not yet named fall back to the club average, weighted by how many of his expected
 * turns are still unannounced — the same observed-plus-modelled split the start
 * COUNT uses, applied to the opponent instead of the number.
 */
export const pitcherMatchupIndex = (
	player: PlayerSeason,
	startOpponents: Map<number, number[]> | undefined,
	teamIndex: number | null,
	strength: TeamStrength,
	/** His total expected starts, announced and modelled together. */
	expectedStarts: number | null
): number | null => {
	if (player.group !== "pitching") return teamIndex
	const faced = startOpponents?.get(player.id)
	if (!faced?.length) return teamIndex
	// a pitcher is scored on what the opposing lineup produces against him
	const vals = faced.map(o => strength.offense.get(o)).filter((v): v is number => v !== undefined)
	if (!vals.length) return teamIndex
	const named = vals.reduce((a, c) => a + c, 0) / vals.length
	if (teamIndex === null) return named
	// share of his expected turns MLB has actually named an opponent for
	const share =
		expectedStarts && expectedStarts > 0 ? Math.min(1, vals.length / expectedStarts) : 1
	return share * named + (1 - share) * teamIndex
}

export const starterBlendedIndex = (
	player: PlayerSeason,
	teamIndex: number | null,
	opposingStarters: Map<number, number[]> | undefined,
	quality: Map<number, number>,
	/** Games in the same window `opposingStarters` was read over. Omitted means the
	 *  caller asserts the published list covers that window. */
	horizonGames?: number
): number | null => {
	if (player.group !== "hitting" || !player.teamId) return teamIndex
	const facing = opposingStarters?.get(player.teamId)
	if (!facing?.length) return teamIndex
	const known = facing.map(id => quality.get(id)).filter((v): v is number => v !== undefined)
	if (!known.length) return teamIndex
	const starters = known.reduce((a, c) => a + c, 0) / known.length
	// with no team index there is no bullpen estimate, so the starter carries it all
	if (teamIndex === null) return starters
	// Unrated names do not count as covered: a call-up with 40 batters faced is a
	// published starter the model has nothing to say about, so his game belongs to
	// the team index like an unpublished one.
	const covered =
		horizonGames && horizonGames > 0 ? Math.min(1, known.length / horizonGames) : 1
	const share = STARTER_INNINGS_SHARE * covered
	return share * starters + (1 - share) * teamIndex
}
