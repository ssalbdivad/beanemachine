import { mapPlayerSeasons, windowStatsUrl, type PlayerSeason } from "../data/statsapi.ts"
import type { Underlying } from "../data/savant.ts"
import { cachedFetch, stats as cacheStats } from "./cache.ts"
import { parseUnderlyingCsv, underlyingWindowUrl } from "./harness.ts"
import { addDays, foldsFor, gamesPlayedIn, gamesScheduledIn, seasonRange } from "./seasons.ts"

/**
 * Assembles the evaluation corpus: for each (season, as-of date, side) a fold
 * holding everything knowable at that moment plus what actually happened next.
 * All reads go through the disk cache, so the first build is slow and every
 * subsequent sweep is instant.
 *
 * This file used to carry its own copy of all three reads, and 63 of its 119
 * substantive lines were verbatim in season.ts (53%, measured by stripping comments,
 * normalising whitespace and keeping lines over 8 characters). What is left is the
 * only thing a corpus builder should be: which windows to ask for. The reads
 * themselves now come from src/data/statsapi.ts (the StatsAPI URL and the splits
 * mapping), ./seasons.ts (the game count) and ./harness.ts (the Savant URL and its
 * parse) — one place to change each, and one cache key per request.
 */

const windowStats = async (
	season: number,
	group: "hitting" | "pitching",
	start: string,
	end: string
): Promise<PlayerSeason[]> => {
	const text = await cachedFetch(windowStatsUrl(season, group, start, end))
	return mapPlayerSeasons(JSON.parse(text).stats?.[0]?.splits ?? [], group)
}

const underlyingWindow = async (
	season: number,
	type: "batter" | "pitcher",
	start: string,
	end: string
): Promise<Map<number, Underlying>> =>
	parseUnderlyingCsv(await cachedFetch(underlyingWindowUrl(season, type, start, end), "text/csv"))

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
		gamesPlayedIn(seasonStart, asOf),
		/* The horizon is what was BOOKED, the same distinction `countGamesScheduled`
		   argues: an evaluation fold must be scored on the slate a manager could see. */
		gamesScheduledIn(addDays(asOf, 1), end)
	])
	const recent: Record<number, PlayerSeason[]> = {}
	const recentGames: Record<number, Map<number, number>> = {}
	for (const days of RECENT_WINDOWS) {
		const start = addDays(asOf, -days)
		const [rows, games] = await Promise.all([
			windowStats(season, group, start, asOf),
			gamesPlayedIn(start, asOf)
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
