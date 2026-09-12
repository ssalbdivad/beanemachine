import { num, parseCsv } from "../data/csv.ts"
import { mapPlayerSeasons, windowStatsUrl, type PlayerSeason } from "../data/statsapi.ts"
import type { Underlying } from "../data/savant.ts"
import { countGamesPlayed, scheduleUrl } from "./seasons.ts"

/**
 * Backtest harness. The only way to know whether bscore predicts anything is to
 * stand at a past date, project forward using ONLY what was knowable then, and
 * score the projection against what actually happened.
 *
 * Leak-free by construction: both the StatsAPI line and the Savant expected stats
 * are pulled with explicit date ranges ending at the as-of date, so no information
 * from the evaluation window reaches the projection.
 *
 * THE READS HERE GO TO THE NETWORK UNCACHED, unlike corpus.ts and season.ts which go
 * through src/backtest/cache.ts. That is kept deliberately: run.ts and tune.ts, the two
 * callers, measure one fold at a time against live data. So the duplication that was
 * removed from this file is the SHAPE of each read — the URL and the mapping — and not
 * the transport, which is the part that was never the same.
 */

const SAVANT = "https://baseballsavant.mlb.com/leaderboard/custom"

const json = async (url: string) => {
	const r = await fetch(url, { headers: { accept: "application/json" } })
	if (!r.ok) throw new Error(`${url} → ${r.status}`)
	return r.json()
}

/** Stats accumulated strictly inside [startDate, endDate]. */
export const fetchWindow = async (
	season: number,
	group: "hitting" | "pitching",
	startDate: string,
	endDate: string
): Promise<PlayerSeason[]> => {
	const data = await json(windowStatsUrl(season, group, startDate, endDate))
	// no `keepOnly`: the backtest reads every stat MLB returns, because nothing here is
	// paying to put them on a wire. See `mapPlayerSeasons`.
	return mapPlayerSeasons(data.stats?.[0]?.splits ?? [], group)
}

/**
 * The Savant window, as a URL and as a parse.
 *
 * corpus.ts wants the identical request through the disk cache and used to carry its
 * own transcription of both halves. The URL in particular is not something to keep two
 * copies of: the `selections` list decides which columns come back, so a drifted copy
 * does not fail, it quietly returns nulls for barrel rate and hard-hit rate and the
 * quality adjustment goes flat.
 *
 * This is NOT the same request season.ts makes. That one asks for a narrower
 * `selections` and, since the date parameters on this leaderboard are ignored (see
 * src/data/statcast-window.ts), has been superseded there by day-by-day aggregation.
 * Unifying the two would change season.ts's URL, which would change its cache key and
 * put the stored competition runs out of reach offline.
 */
export const underlyingWindowUrl = (
	season: number,
	type: "batter" | "pitcher",
	startDate: string,
	endDate: string
) =>
	`${SAVANT}?year=${season}&type=${type}&filter=&min=1` +
	`&selections=pa%2Cwoba%2Cxwoba%2Cbarrel_batted_rate%2Chard_hit_percent` +
	`&chart=false&x=pa&y=pa&r=no&chartType=beeswarm&sort=xwoba&sortDir=desc` +
	`&start_dt=${startDate}&end_dt=${endDate}&csv=true`

export const parseUnderlyingCsv = (csv: string): Map<number, Underlying> => {
	const out = new Map<number, Underlying>()
	for (const row of parseCsv(csv)) {
		const id = num(row.player_id)
		if (id === null) continue
		const xwoba = num(row.xwoba)
		const woba = num(row.woba)
		out.set(id, {
			id,
			xwoba,
			woba,
			xwobaGap: xwoba !== null && woba !== null ? Number((xwoba - woba).toFixed(4)) : null,
			xba: null,
			xslg: null,
			pa: num(row.pa),
			barrelRate: num(row.barrel_batted_rate),
			hardHitRate: num(row.hard_hit_percent),
			avgExitVelocity: null,
			sweetSpotRate: null
		})
	}
	return out
}

/** Expected stats computed only from batted balls inside the window. */
export const fetchUnderlyingWindow = async (
	season: number,
	type: "batter" | "pitcher",
	startDate: string,
	endDate: string
): Promise<Map<number, Underlying>> => {
	const url = underlyingWindowUrl(season, type, startDate, endDate)
	const res = await fetch(url, { headers: { accept: "text/csv" } })
	if (!res.ok) throw new Error(`${url} → ${res.status}`)
	return parseUnderlyingCsv(await res.text())
}

/** Games each team played inside a window — the real volume denominator. */
export const fetchGamesPlayedWindow = async (
	startDate: string,
	endDate: string
): Promise<Map<number, number>> => countGamesPlayed(await json(scheduleUrl(startDate, endDate)))

/* ---------- evaluation ---------- */

export const spearman = (pairs: [number, number][]): number => {
	if (pairs.length < 3) return NaN
	const rank = (vals: number[]) => {
		const idx = vals.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0])
		const r = new Array<number>(vals.length)
		for (let i = 0; i < idx.length; ) {
			let j = i
			while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++
			const avg = (i + j) / 2 + 1
			for (let k = i; k <= j; k++) r[idx[k]![1]] = avg
			i = j + 1
		}
		return r
	}
	const rx = rank(pairs.map(p => p[0]))
	const ry = rank(pairs.map(p => p[1]))
	const n = pairs.length
	const mx = rx.reduce((a, b) => a + b, 0) / n
	const my = ry.reduce((a, b) => a + b, 0) / n
	let num = 0, dx = 0, dy = 0
	for (let i = 0; i < n; i++) {
		const a = rx[i]! - mx, b = ry[i]! - my
		num += a * b; dx += a * a; dy += b * b
	}
	return num / Math.sqrt(dx * dy)
}

export const rmse = (pairs: [number, number][]): number =>
	Math.sqrt(pairs.reduce((s, [p, a]) => s + (p - a) ** 2, 0) / Math.max(pairs.length, 1))

/** Mean actual points of the top-N by prediction — what a manager actually gets. */
export const topNValue = (pairs: [number, number][], n: number): number => {
	const top = [...pairs].sort((a, b) => b[0] - a[0]).slice(0, n)
	return top.reduce((s, [, a]) => s + a, 0) / Math.max(top.length, 1)
}
