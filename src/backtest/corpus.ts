import { num, parseCsv } from "../data/csv.ts"
import type { PlayerSeason, StatLine } from "../data/statsapi.ts"
import type { Underlying } from "../data/savant.ts"
import { cachedFetch, stats as cacheStats } from "./cache.ts"
import { addDays, foldsFor, seasonRange } from "./seasons.ts"

/**
 * Assembles the evaluation corpus: for each (season, as-of date, side) a fold
 * holding everything knowable at that moment plus what actually happened next.
 * All reads go through the disk cache, so the first build is slow and every
 * subsequent sweep is instant.
 */
const SAPI = "https://statsapi.mlb.com/api/v1"
const SAVANT = "https://baseballsavant.mlb.com/leaderboard/custom"

const asNum = (v: unknown): number | null => {
	const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN
	return Number.isFinite(n) ? n : null
}

const windowStats = async (
	season: number,
	group: "hitting" | "pitching",
	start: string,
	end: string
): Promise<PlayerSeason[]> => {
	const text = await cachedFetch(
		`${SAPI}/stats?stats=byDateRange&group=${group}&season=${season}&sportId=1` +
			`&playerPool=All&limit=3000&startDate=${start}&endDate=${end}`
	)
	const splits = JSON.parse(text).stats?.[0]?.splits ?? []
	return splits
		.map((s: any): PlayerSeason => {
			const stat: StatLine = {}
			for (const [k, v] of Object.entries(s.stat ?? {})) {
				const n = asNum(v)
				if (n !== null) stat[k] = n
			}
			return {
				id: s.player?.id, name: s.player?.fullName ?? "",
				team: s.team?.name ?? null, teamId: s.team?.id ?? null,
				position: s.position?.abbreviation ?? "", group, stats: stat
			}
		})
		.filter((p: PlayerSeason) => typeof p.id === "number")
}

const gamesPlayed = async (start: string, end: string): Promise<Map<number, number>> => {
	const data = JSON.parse(
		await cachedFetch(`${SAPI}/schedule?sportId=1&startDate=${start}&endDate=${end}&gameType=R`)
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

const underlyingWindow = async (
	season: number,
	type: "batter" | "pitcher",
	start: string,
	end: string
): Promise<Map<number, Underlying>> => {
	const url =
		`${SAVANT}?year=${season}&type=${type}&filter=&min=1` +
		`&selections=pa%2Cwoba%2Cxwoba%2Cbarrel_batted_rate%2Chard_hit_percent` +
		`&chart=false&x=pa&y=pa&r=no&chartType=beeswarm&sort=xwoba&sortDir=desc` +
		`&start_dt=${start}&end_dt=${end}&csv=true`
	const out = new Map<number, Underlying>()
	for (const row of parseCsv(await cachedFetch(url, "text/csv"))) {
		const id = num(row.player_id)
		if (id === null) continue
		const xwoba = num(row.xwoba), woba = num(row.woba)
		out.set(id, {
			id, xwoba, woba,
			xwobaGap: xwoba !== null && woba !== null ? Number((xwoba - woba).toFixed(4)) : null,
			xba: null, xslg: null, pa: num(row.pa),
			barrelRate: num(row.barrel_batted_rate), hardHitRate: num(row.hard_hit_percent),
			avgExitVelocity: null, sweetSpotRate: null
		})
	}
	return out
}

export interface Fold {
	season: number
	asOf: string
	group: "hitting" | "pitching"
	prior: PlayerSeason[]
	recent: Record<number, PlayerSeason[]>
	actual: PlayerSeason[]
	underlying: Map<number, Underlying>
	priorGames: Map<number, number>
	recentGames: Record<number, Map<number, number>>
	futureGames: Map<number, number>
}

export const RECENT_WINDOWS = [3, 5, 7, 10, 14, 21, 30]

export const buildFold = async (
	season: number,
	seasonStart: string,
	asOf: string,
	group: "hitting" | "pitching",
	horizon: number
): Promise<Fold> => {
	const end = addDays(asOf, horizon)
	const [prior, underlying, actual, priorGames, futureGames] = await Promise.all([
		windowStats(season, group, seasonStart, asOf),
		underlyingWindow(season, group === "hitting" ? "batter" : "pitcher", seasonStart, asOf),
		windowStats(season, group, addDays(asOf, 1), end),
		gamesPlayed(seasonStart, asOf),
		gamesPlayed(addDays(asOf, 1), end)
	])
	const recent: Record<number, PlayerSeason[]> = {}
	const recentGames: Record<number, Map<number, number>> = {}
	for (const days of RECENT_WINDOWS) {
		const start = addDays(asOf, -days)
		const [rows, games] = await Promise.all([
			windowStats(season, group, start, asOf),
			gamesPlayed(start, asOf)
		])
		recent[days] = rows
		recentGames[days] = games
	}
	return { season, asOf, group, prior, recent, actual, underlying, priorGames, recentGames, futureGames }
}

export const buildCorpus = async (
	seasons: number[],
	horizon: number,
	foldsPerSeason: number,
	onProgress?: (msg: string) => void
): Promise<Fold[]> => {
	const folds: Fold[] = []
	for (const season of seasons) {
		const range = await seasonRange(season)
		const asOfs = foldsFor(range, horizon, foldsPerSeason)
		if (!asOfs.length) {
			onProgress?.(`  ${season}: skipped (season too short for a ${horizon}d horizon)`)
			continue
		}
		for (const group of ["hitting", "pitching"] as const)
			for (const asOf of asOfs)
				folds.push(await buildFold(season, range.start, asOf, group, horizon))
		onProgress?.(
			`  ${season}: ${asOfs.length} folds × 2 sides  (${range.start}→${range.end})` +
				`  cache ${cacheStats.hits}h/${cacheStats.misses}m`
		)
	}
	return folds
}
