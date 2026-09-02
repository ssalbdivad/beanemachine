import { num, parseCsv } from "./csv.ts"
import { aggregateStatcast } from "./statcast-window.ts"

/**
 * Baseball Savant — the *underlying* record. These are still measurements (of
 * batted balls and pitches), but the expected stats derived from them describe
 * what a player's contact deserved rather than what it produced. That gap is the
 * regression signal this app uses to find undervalued players.
 */
const BASE = "https://baseballsavant.mlb.com/leaderboard"

export interface Underlying {
	id: number
	/** Which window `xwoba`/`woba` describe. The rolling window is the one the
	 *  predictive test was run on; the season-long leaderboard is kept for the
	 *  richer batted-ball fields, which have no point-in-time equivalent. */
	window?: "rolling" | "season"
	/** Expected wOBA from batted-ball quality; null when the player is below the
	 *  leaderboard's qualifying minimum rather than assumed to be average. */
	xwoba: number | null
	woba: number | null
	/** est_woba − woba. Positive = producing less than the contact deserved. */
	xwobaGap: number | null
	xba: number | null
	xslg: number | null
	pa: number | null
	barrelRate: number | null
	hardHitRate: number | null
	avgExitVelocity: number | null
	sweetSpotRate: number | null
}

const csv = async (url: string): Promise<Record<string, string>[]> => {
	const res = await fetch(url, { headers: { accept: "text/csv" } })
	if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
	return parseCsv(await res.text())
}

const idOf = (row: Record<string, string>): number | null => num(row.player_id)

/**
 * Expected statistics + batted-ball quality, joined on player_id, which is the
 * same MLBAM id StatsAPI uses — so no fuzzy name matching is ever needed.
 */
export const fetchUnderlying = async (
	season: number,
	type: "batter" | "pitcher"
): Promise<Map<number, Underlying>> => {
	const [expected, statcast] = await Promise.all([
		// min=1 instead of the default `q` (qualified): qualified covers only ~240 of
		// ~720 hitters, and the players this app exists to surface — waiver-wire and
		// part-time bats — are exactly the ones below the qualifying line.
		csv(`${BASE}/expected_statistics?type=${type}&year=${season}&min=1&csv=true`),
		csv(`${BASE}/statcast?type=${type}&year=${season}&min=1&csv=true`).catch(() => [])
	])

	const out = new Map<number, Underlying>()
	for (const row of expected) {
		const id = idOf(row)
		if (id === null) continue
		const xwoba = num(row.est_woba)
		const woba = num(row.woba)
		out.set(id, {
			id,
			xwoba,
			woba,
			xwobaGap:
				xwoba !== null && woba !== null ?
					Number((xwoba - woba).toFixed(4))
				:	null,
			xba: num(row.est_ba),
			xslg: num(row.est_slg),
			pa: num(row.pa),
			barrelRate: null,
			hardHitRate: null,
			avgExitVelocity: null,
			sweetSpotRate: null
		})
	}
	for (const row of statcast) {
		const id = idOf(row)
		if (id === null) continue
		const base = out.get(id)
		if (!base) continue
		base.barrelRate = num(row.brl_percent)
		base.hardHitRate = num(row.ev95percent)
		base.avgExitVelocity = num(row.avg_hit_speed)
		base.sweetSpotRate = num(row.anglesweetspotpercent)
	}
	return out
}

/**
 * Park factors are NOT available and are no longer pretended to be.
 *
 * There was a `fetchParkFactors` here that asked
 * `leaderboard/statcast-park-factors?...&csv=true` and parsed the response. That
 * endpoint returns HTML and ignores `csv=true` — the parser dutifully produced
 * 1,852 rows of nulls, and nothing ever noticed because nothing consumed them.
 * The same failure mode as the expected-stats leaderboard ignoring its own date
 * range: HTTP 200, plausible shape, wrong content.
 *
 * The honest state is that no readable park-factor source has been found, so the
 * projection carries no park term rather than a silently empty one. Computing
 * park factors from the pitch-level data this repo already caches is the obvious
 * route if it is ever wanted.
 */

/**
 * Underlying stats with the expected-stat pair taken from a ROLLING window.
 *
 * Two sources, because neither alone is right. The pitch-level endpoint is the
 * only one that honours a date range, so wOBA and xwOBA — the pair the whole
 * regression signal is built on — come from there. It computes nothing else, so
 * barrel rate, exit velocity, xBA and xSLG still come from the season-long
 * leaderboard, and are labelled as season-long rather than passed off as recent.
 *
 * The window matters more than it looks. Over a season, contact quality and
 * results converge (gap~wOBA -0.36); over three weeks they diverge far more
 * (-0.61), and that divergence is the signal.
 */
export const fetchUnderlyingRolling = async (
	season: number,
	type: "batter" | "pitcher",
	start: string,
	end: string
): Promise<Map<number, Underlying>> => {
	const [seasonLong, rolling] = await Promise.all([
		fetchUnderlying(season, type).catch(() => new Map<number, Underlying>()),
		aggregateStatcast(season, type, start, end)
	])
	const out = new Map<number, Underlying>()
	for (const [id, base] of seasonLong) out.set(id, { ...base, window: "season" })
	for (const [id, r] of rolling) {
		const base = out.get(id)
		out.set(id, {
			id,
			window: "rolling",
			xwoba: r.xwoba,
			woba: r.woba,
			xwobaGap: Number((r.xwoba - r.woba).toFixed(4)),
			pa: r.pa,
			// season-long, and only meaningful as such
			xba: base?.xba ?? null,
			xslg: base?.xslg ?? null,
			barrelRate: base?.barrelRate ?? null,
			hardHitRate: base?.hardHitRate ?? null,
			avgExitVelocity: base?.avgExitVelocity ?? null,
			sweetSpotRate: base?.sweetSpotRate ?? null
		})
	}
	return out
}
