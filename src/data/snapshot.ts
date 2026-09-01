import { type } from "arktype"
import {
	fetchGamesByTeam,
	fetchWindowStats,
	fetchInjuries,
	fetchSeason,
	fetchTeamGamesPlayed,
	type PlayerSeason
} from "./statsapi.ts"
import { fetchUnderlying, type Underlying } from "./savant.ts"
import { RECENT_WINDOW_DAYS } from "../engine/project.ts"

/**
 * A point-in-time capture of every source, so the app has one consistent view of
 * the world. It exists for three reasons: browsers cannot call MLB or Savant
 * directly (neither sends CORS headers), the static build has no backend at all,
 * and nothing should hammer these APIs on every page load.
 *
 * The snapshot stores only OBSERVED data. Projections and bscores are computed
 * from it at request time against whichever league config the user has, because
 * the same player is worth different amounts in different leagues.
 */
export interface Snapshot {
	season: number
	capturedAt: string
	horizon: { start: string; end: string }
	players: PlayerSeason[]
	underlying: { hitting: Record<string, Underlying>; pitching: Record<string, Underlying> }
	injuries: Record<string, string>
	teamGamesPlayed: Record<string, number>
	gamesByTeam: Record<string, number>
	/** Volume per team game over the recent window, keyed "id:group". The backtest
	 *  showed recent playing time is the strongest predictor available. */
	recentVolumePerGame: Record<string, number>
	recentWindow: { hitting: number; pitching: number }
	sources: { name: string; url: string; rows: number }[]
}

const iso = (d: Date) => d.toISOString().slice(0, 10)

export const buildSnapshot = async (
	season: number,
	now: Date,
	horizonDays = 14
): Promise<Snapshot> => {
	const start = iso(now)
	const end = iso(new Date(now.getTime() + horizonDays * 86400_000))

	// Side-specific windows: measured best at 7 days for hitters and 21 for
	// pitchers across ten seasons. A starter works every fifth day, so a week of
	// his data is one or two starts of noise.
	const recentHitStart = iso(new Date(now.getTime() - RECENT_WINDOW_DAYS.hitting * 86400_000))
	const recentPitStart = iso(new Date(now.getTime() - RECENT_WINDOW_DAYS.pitching * 86400_000))
	const [
		hitting, pitching, xBat, xPit, gamesByTeam, teamGamesPlayed, injuries,
		recentHit, recentPit, recentHitGames, recentPitGames
	] = await Promise.all([
			fetchSeason(season, "hitting"),
			fetchSeason(season, "pitching"),
			fetchUnderlying(season, "batter"),
			fetchUnderlying(season, "pitcher"),
			fetchGamesByTeam(start, end),
			fetchTeamGamesPlayed(season),
			fetchInjuries(),
			fetchWindowStats(season, "hitting", recentHitStart, start),
			fetchWindowStats(season, "pitching", recentPitStart, start),
			fetchGamesByTeam(recentHitStart, start),
			fetchGamesByTeam(recentPitStart, start)
		])

	// per-team-game volume over the recent window, the input the backtest favoured
	const recentVolumePerGame: Record<string, number> = {}
	for (const [rows, group, games] of [
		[recentHit, "hitting", recentHitGames],
		[recentPit, "pitching", recentPitGames]
	] as const)
		for (const r of rows) {
			const g = r.teamId ? (games.get(r.teamId) ?? 0) : 0
			if (!g) continue
			const v = group === "hitting" ? r.stats.plateAppearances : r.stats.battersFaced
			if (v === undefined) continue
			recentVolumePerGame[`${r.id}:${group}`] = Number((v / g).toFixed(4))
		}

	// Keyed by side, NOT merged. 133 players appear in both pools, so a flat
	// `new Map([...xBat, ...xPit])` let each pitcher row overwrite the batter row —
	// 37 real hitters were being projected off their xwOBA-AGAINST as pitchers.
	// A batter's xwOBA and a pitcher's xwOBA-against are opposite quantities.

	// Pool hygiene: a pitcher who took three plate appearances is not a fantasy
	// hitter, and listing him as a 0-PA Util bat both pollutes the board and drags
	// the replacement level. Two-way players legitimately appear on both sides.
	const isTwoWay = (id: number) =>
		hitting.some(h => h.id === id && h.position === "TWP") ||
		pitching.some(q => q.id === id && q.position === "TWP")
	const players = [
		...hitting.filter(
			h => (h.position !== "P" || isTwoWay(h.id)) && (h.stats.plateAppearances ?? 0) > 0
		),
		// Symmetric to the hitting filter: a first baseman who mopped up an inning is
		// not a fantasy pitcher. Position is the signal, not workload.
		...pitching.filter(
			q => (q.position === "P" || isTwoWay(q.id)) && (q.stats.battersFaced ?? 0) > 0
		)
	]

	return {
		season,
		capturedAt: now.toISOString(),
		horizon: { start, end },
		players,
		underlying: {
			hitting: Object.fromEntries([...xBat].map(([k, v]) => [String(k), v])),
			pitching: Object.fromEntries([...xPit].map(([k, v]) => [String(k), v]))
		},
		injuries: Object.fromEntries([...injuries].map(([k, v]) => [String(k), v])),
		teamGamesPlayed: Object.fromEntries(
			[...teamGamesPlayed].map(([k, v]) => [String(k), v])
		),
		gamesByTeam: Object.fromEntries([...gamesByTeam].map(([k, v]) => [String(k), v])),
		recentVolumePerGame,
		recentWindow: { ...RECENT_WINDOW_DAYS },
		sources: [
			{ name: "MLB StatsAPI · season hitting", url: "statsapi.mlb.com/api/v1/stats", rows: hitting.length },
			{ name: "MLB StatsAPI · season pitching", url: "statsapi.mlb.com/api/v1/stats", rows: pitching.length },
			{ name: "MLB StatsAPI · schedule", url: "statsapi.mlb.com/api/v1/schedule", rows: gamesByTeam.size },
			{ name: "MLB StatsAPI · roster status", url: "statsapi.mlb.com/api/v1/teams/{id}/roster", rows: injuries.size },
			{ name: "Baseball Savant · expected stats (batters)", url: "baseballsavant.mlb.com/leaderboard/expected_statistics", rows: xBat.size },
			{ name: "Baseball Savant · expected stats (pitchers)", url: "baseballsavant.mlb.com/leaderboard/expected_statistics", rows: xPit.size }
		]
	}
}

/** Rehydrate the string-keyed maps a JSON snapshot has to use. */
export const hydrate = (s: Snapshot) => ({
	players: s.players,
	underlying: {
		hitting: new Map(Object.entries(s.underlying.hitting).map(([k, v]) => [Number(k), v])),
		pitching: new Map(Object.entries(s.underlying.pitching).map(([k, v]) => [Number(k), v]))
	},
	injuries: new Map(Object.entries(s.injuries).map(([k, v]) => [Number(k), v])),
	teamGamesPlayed: new Map(
		Object.entries(s.teamGamesPlayed).map(([k, v]) => [Number(k), v])
	),
	gamesByTeam: new Map(Object.entries(s.gamesByTeam).map(([k, v]) => [Number(k), v])),
	recentVolumePerGame: s.recentVolumePerGame ?? {}
})
