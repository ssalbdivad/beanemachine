import { parseCsv, num } from "../data/csv.ts"
import type { PlayerSeason, StatLine } from "../data/statsapi.ts"
import type { Underlying } from "../data/savant.ts"

/**
 * Backtest harness. The only way to know whether bscore predicts anything is to
 * stand at a past date, project forward using ONLY what was knowable then, and
 * score the projection against what actually happened.
 *
 * Leak-free by construction: both the StatsAPI line and the Savant expected stats
 * are pulled with explicit date ranges ending at the as-of date, so no information
 * from the evaluation window reaches the projection.
 */

const SAPI = "https://statsapi.mlb.com/api/v1"
const SAVANT = "https://baseballsavant.mlb.com/leaderboard/custom"

const json = async (url: string) => {
	const r = await fetch(url, { headers: { accept: "application/json" } })
	if (!r.ok) throw new Error(`${url} → ${r.status}`)
	return r.json()
}

const asNum = (v: unknown): number | null => {
	const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN
	return Number.isFinite(n) ? n : null
}

/** Stats accumulated strictly inside [startDate, endDate]. */
export const fetchWindow = async (
	season: number,
	group: "hitting" | "pitching",
	startDate: string,
	endDate: string
): Promise<PlayerSeason[]> => {
	const data = await json(
		`${SAPI}/stats?stats=byDateRange&group=${group}&season=${season}&sportId=1` +
			`&playerPool=All&limit=3000&startDate=${startDate}&endDate=${endDate}`
	)
	const splits = data.stats?.[0]?.splits ?? []
	return splits
		.map((s: any): PlayerSeason => {
			const stats: StatLine = {}
			for (const [k, v] of Object.entries(s.stat ?? {})) {
				const n = asNum(v)
				if (n !== null) stats[k] = n
			}
			return {
				id: s.player?.id,
				name: s.player?.fullName ?? "",
				team: s.team?.name ?? null,
				teamId: s.team?.id ?? null,
				position: s.position?.abbreviation ?? "",
				group,
				stats
			}
		})
		.filter((p: PlayerSeason) => typeof p.id === "number")
}

/** Expected stats computed only from batted balls inside the window. */
export const fetchUnderlyingWindow = async (
	season: number,
	type: "batter" | "pitcher",
	startDate: string,
	endDate: string
): Promise<Map<number, Underlying>> => {
	const url =
		`${SAVANT}?year=${season}&type=${type}&filter=&min=1` +
		`&selections=pa%2Cwoba%2Cxwoba%2Cbarrel_batted_rate%2Chard_hit_percent` +
		`&chart=false&x=pa&y=pa&r=no&chartType=beeswarm&sort=xwoba&sortDir=desc` +
		`&start_dt=${startDate}&end_dt=${endDate}&csv=true`
	const res = await fetch(url, { headers: { accept: "text/csv" } })
	if (!res.ok) throw new Error(`${url} → ${res.status}`)
	const out = new Map<number, Underlying>()
	for (const row of parseCsv(await res.text())) {
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

/** Games each team played inside a window — the real volume denominator. */
export const fetchGamesPlayedWindow = async (
	startDate: string,
	endDate: string
): Promise<Map<number, number>> => {
	const data = await json(
		`${SAPI}/schedule?sportId=1&startDate=${startDate}&endDate=${endDate}&gameType=R`
	)
	const counts = new Map<number, number>()
	for (const day of data.dates ?? [])
		for (const g of day.games ?? []) {
			if (g.status?.abstractGameState && g.status.abstractGameState !== "Final") continue
			for (const side of ["home", "away"] as const) {
				const id = g.teams?.[side]?.team?.id
				if (typeof id === "number") counts.set(id, (counts.get(id) ?? 0) + 1)
			}
		}
	return counts
}

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
