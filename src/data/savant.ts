import { num, parseCsv } from "./csv.ts"

/**
 * Baseball Savant — the *underlying* record. These are still measurements (of
 * batted balls and pitches), but the expected stats derived from them describe
 * what a player's contact deserved rather than what it produced. That gap is the
 * regression signal this app uses to find undervalued players.
 */
const BASE = "https://baseballsavant.mlb.com/leaderboard"

export interface Underlying {
	id: number
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

export interface ParkFactor {
	teamId: number | null
	venue: string
	runs: number | null
	hr: number | null
}

/** Park factors, so a hitter's context is stated rather than ignored. */
export const fetchParkFactors = async (season: number): Promise<ParkFactor[]> => {
	const rows = await csv(
		`${BASE}/statcast-park-factors?type=year&year=${season}&csv=true`
	)
	return rows.map(r => ({
		teamId: num(r.venue_id ?? r.team_id),
		venue: r.venue_name ?? r.name_display_club ?? "",
		runs: num(r.index_runs ?? r.runs),
		hr: num(r.index_hr ?? r.hr)
	}))
}
