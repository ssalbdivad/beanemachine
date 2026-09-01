import { type } from "arktype"
import {
	fetchGamesByTeam,
	fetchInjuries,
	fetchSeason,
	fetchTeamGamesPlayed,
	type PlayerSeason
} from "./statsapi.ts"
import { fetchUnderlying, type Underlying } from "./savant.ts"

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
	underlying: Record<string, Underlying>
	injuries: Record<string, string>
	teamGamesPlayed: Record<string, number>
	gamesByTeam: Record<string, number>
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

	const [hitting, pitching, xBat, xPit, gamesByTeam, teamGamesPlayed, injuries] =
		await Promise.all([
			fetchSeason(season, "hitting"),
			fetchSeason(season, "pitching"),
			fetchUnderlying(season, "batter"),
			fetchUnderlying(season, "pitcher"),
			fetchGamesByTeam(start, end),
			fetchTeamGamesPlayed(season),
			fetchInjuries()
		])

	const underlying = new Map([...xBat, ...xPit])
	const players = [...hitting, ...pitching]

	return {
		season,
		capturedAt: now.toISOString(),
		horizon: { start, end },
		players,
		underlying: Object.fromEntries([...underlying].map(([k, v]) => [String(k), v])),
		injuries: Object.fromEntries([...injuries].map(([k, v]) => [String(k), v])),
		teamGamesPlayed: Object.fromEntries(
			[...teamGamesPlayed].map(([k, v]) => [String(k), v])
		),
		gamesByTeam: Object.fromEntries([...gamesByTeam].map(([k, v]) => [String(k), v])),
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
	underlying: new Map(Object.entries(s.underlying).map(([k, v]) => [Number(k), v])),
	injuries: new Map(Object.entries(s.injuries).map(([k, v]) => [Number(k), v])),
	teamGamesPlayed: new Map(
		Object.entries(s.teamGamesPlayed).map(([k, v]) => [Number(k), v])
	),
	gamesByTeam: new Map(Object.entries(s.gamesByTeam).map(([k, v]) => [Number(k), v]))
})
