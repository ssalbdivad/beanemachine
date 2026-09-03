import { type } from "arktype"
import {
	fetchGamesByTeam,
	fetchSlate,
	type SlateGame,
	fetchWindowStats,
	fetchInjuries,
	fetchSeason,
	fetchTeamGamesPlayed,
	type PlayerSeason,
	type StatLine
} from "./statsapi.ts"
import { fetchUnderlyingRolling, type Underlying } from "./savant.ts"
import { fetchOwnership, normalizeName } from "./yahoo-pool.ts"
import { RECENT_WINDOW_WEIGHTS } from "../engine/project.ts"
import { MODEL } from "../engine/weights.ts"
import { windowFrom } from "../engine/period.ts"

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
	/** Every regular-season game from the capture date to the end of the season, one
	 *  row each. Counts are NOT stored: which window matters is a property of the
	 *  reader's league, not of the capture, so `windowFrom` in src/engine/period.ts
	 *  counts whichever window is asked for. This replaced eight schedule reads that
	 *  each baked in one window, two of which disagreed with each other. */
	slate: SlateGame[]
	/** Yahoo "% Ros", keyed by MLBAM id. Absent for anyone Yahoo did not list;
	 *  absent means unknown, never unowned. */
	ownership?: Record<string, number>
	/** Multi-position eligibility as the platform prints it, by MLBAM id. Absent
	 *  means the platform did not list him, not that he plays one position. */
	eligibility?: Record<string, string[]>
	/** Volume per team game over the recent window, keyed "id:group". The backtest
	 *  showed recent playing time is the strongest predictor available. */
	recentVolumeByWindow: Record<string, Record<number, number>>
	recentWindow: { hitting: number[]; pitching: number[] }
	/** Recent lines, keyed "id:group". Populated for pitchers only, who are the
	 *  only side where blending the recent rate measured as a real improvement. */
	recentStats: Record<string, StatLine>
	sources: { name: string; url: string; rows: number }[]
}

const iso = (d: Date) => d.toISOString().slice(0, 10)

export const buildSnapshot = async (
	season: number,
	now: Date,
	horizonDays = 14,
	/** Whose market prices to read. Ownership is league-platform-specific, so it is
	 *  a parameter rather than a constant. */
	leagueId = "228947"
): Promise<Snapshot> => {
	const start = iso(now)
	const end = iso(new Date(now.getTime() + horizonDays * 86400_000))

	// Every window the weights reference, per side. Short windows carry the most
	// recent series, which measured as real extra signal over a single flat window.
	const WINDOWS = {
		hitting: Object.keys(RECENT_WINDOW_WEIGHTS.hitting).map(Number),
		pitching: Object.keys(RECENT_WINDOW_WEIGHTS.pitching).map(Number)
	}
	const back = (d: number) => iso(new Date(now.getTime() - d * 86400_000))
	const [
		hitting, pitching, xBat, xPit, slate, owned, teamGamesPlayed, injuries,
		hitWindows, pitWindows
	] = await Promise.all([
			fetchSeason(season, "hitting"),
			fetchSeason(season, "pitching"),
			// A rolling window for the expected-stat pair: that is the window the
			// predictive signal was measured on, and a season-long xwOBA has already
			// converged toward the wOBA it exists to disagree with.
			fetchUnderlyingRolling(season, "batter", back(MODEL.statcast.windowDays || 21), start),
			fetchUnderlyingRolling(season, "pitcher", back(MODEL.statcast.windowDays || 21), start),
			// ONE schedule read, out to the end of the regular season, carrying the games
			// themselves rather than counts. A scoring period belongs to the league and a
			// snapshot serves many, so the window has to be chosen at read time; and
			// deriving every count from one set of rows is what makes it impossible for a
			// coverage fraction's numerator and denominator to come from different windows.
			fetchSlate(start, `${season}-11-05`).catch(() => [] as SlateGame[]),
			fetchOwnership(leagueId).catch(() => ({
				byName: new Map<string, number>(),
				eligibility: new Map<string, string[]>(),
				read: 0,
				note: ""
			})),
			fetchTeamGamesPlayed(season),
			fetchInjuries(),
			Promise.all(
				WINDOWS.hitting.map(async d => ({
					d,
					rows: await fetchWindowStats(season, "hitting", back(d), start),
					games: await fetchGamesByTeam(back(d), start, true)
				}))
			),
			Promise.all(
				WINDOWS.pitching.map(async d => ({
					d,
					rows: await fetchWindowStats(season, "pitching", back(d), start),
					games: await fetchGamesByTeam(back(d), start, true)
				}))
			)
		])

	// per-team-game volume over the recent window, the input the backtest favoured
	// per-window volume per team game, keyed "id:group" then window length
	const recentVolumeByWindow: Record<string, Record<number, number>> = {}
	const recentStats: Record<string, StatLine> = {}
	for (const [sets, group] of [
		[hitWindows, "hitting"],
		[pitWindows, "pitching"]
	] as const)
		for (const { d, rows, games } of sets)
			for (const r of rows) {
				const g = r.teamId ? (games.get(r.teamId) ?? 0) : 0
				if (!g) continue
				const v = group === "hitting" ? r.stats.plateAppearances : r.stats.battersFaced
				if (v === undefined) continue
				const key = `${r.id}:${group}`
				;(recentVolumeByWindow[key] ??= {})[d] = Number((v / g).toFixed(4))
				// the recent line itself, for the pitchers-only rate blend
				if (group === "pitching" && d === Math.max(...WINDOWS.pitching))
					recentStats[key] = r.stats
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
		slate,
		// joined on normalised name, because Yahoo exposes its own player ids and
		// never the MLBAM one. A player Yahoo did not list is simply absent.
		eligibility: Object.fromEntries(
			players.flatMap(pl => {
				const e = owned.eligibility.get(normalizeName(pl.name))
				return e === undefined ? [] : [[String(pl.id), e] as const]
			})
		),
		ownership: Object.fromEntries(
			players.flatMap(pl => {
				const pct = owned.byName.get(normalizeName(pl.name))
				return pct === undefined ? [] : [[String(pl.id), pct] as const]
			})
		),
		recentVolumeByWindow,
		recentStats,
		recentWindow: { hitting: WINDOWS.hitting, pitching: WINDOWS.pitching },
		sources: [
			{ name: "MLB StatsAPI · season hitting", url: "statsapi.mlb.com/api/v1/stats", rows: hitting.length },
			{ name: "MLB StatsAPI · season pitching", url: "statsapi.mlb.com/api/v1/stats", rows: pitching.length },
			{ name: "MLB StatsAPI · schedule", url: "statsapi.mlb.com/api/v1/schedule?hydrate=probablePitcher", rows: slate.length },
			{ name: "MLB StatsAPI · probable starters", url: "statsapi.mlb.com/api/v1/schedule?hydrate=probablePitcher", rows: slate.filter(g => g.homeProbable !== null || g.awayProbable !== null).length },
			{ name: "Yahoo · multi-position eligibility", url: "baseball.fantasysports.yahoo.com/b1/players", rows: owned.eligibility.size },
			{ name: "Yahoo · % rostered", url: "baseball.fantasysports.yahoo.com/b1/players", rows: owned.byName.size },
			{ name: "MLB StatsAPI · roster status", url: "statsapi.mlb.com/api/v1/teams/{id}/roster", rows: injuries.size },
			{ name: `Baseball Savant · rolling ${MODEL.statcast.windowDays}d xwOBA (batters)`, url: "baseballsavant.mlb.com/statcast_search", rows: [...xBat.values()].filter(u => u.window === "rolling").length },
			{ name: `Baseball Savant · rolling ${MODEL.statcast.windowDays}d xwOBA (pitchers)`, url: "baseballsavant.mlb.com/statcast_search", rows: [...xPit.values()].filter(u => u.window === "rolling").length },
			{ name: "Baseball Savant · expected stats (batters)", url: "baseballsavant.mlb.com/leaderboard/expected_statistics", rows: xBat.size },
			{ name: "Baseball Savant · expected stats (pitchers)", url: "baseballsavant.mlb.com/leaderboard/expected_statistics", rows: xPit.size }
		]
	}
}

/** Rehydrate the string-keyed maps a JSON snapshot has to use. */
/**
 * The snapshot with its lookups built, and every schedule-derived count taken from
 * the slate rather than stored.
 *
 * The fortnight is the default horizon and is derived here; the WEEK deliberately is
 * not, because a week is a property of the league and this function has not been
 * shown one. `src/client/useBoard.ts` resolves the league's own scoring period and
 * calls `windowFrom` with it.
 */
export const hydrate = (s: Snapshot) => {
	const slate = s.slate ?? []
	const seasonEnd = slate.reduce((a, g) => (g.date > a ? g.date : a), s.horizon.end)
	const horizon = windowFrom(slate, s.horizon.start, s.horizon.end)
	const rest = windowFrom(slate, s.horizon.start, seasonEnd)
	return {
	slate,
	seasonEnd,
	players: s.players,
	underlying: {
		hitting: new Map(Object.entries(s.underlying.hitting).map(([k, v]) => [Number(k), v])),
		pitching: new Map(Object.entries(s.underlying.pitching).map(([k, v]) => [Number(k), v]))
	},
	injuries: new Map(Object.entries(s.injuries).map(([k, v]) => [Number(k), v])),
	teamGamesPlayed: new Map(
		Object.entries(s.teamGamesPlayed).map(([k, v]) => [Number(k), v])
	),
	gamesByTeam: horizon.games,
	opponentsByTeam: horizon.opponents,
	probableStarts: horizon.probableStarts,
	opposingStarters: horizon.opposingStarters,
	probableCoverage: horizon.coverage,
	gamesRemaining: rest.games,
	// The rest-of-season opponent list, which no earlier capture carried at all: the
	// Stash tab used to rate a months-long horizon against the next fortnight's
	// opponents, which METHODOLOGY 11.1 recorded as an open gap. One slate closes it.
	opponentsRemaining: rest.opponents,
	ownership: new Map(Object.entries(s.ownership ?? {}).map(([k, v]) => [Number(k), v])),
	eligibility: new Map(
		Object.entries(s.eligibility ?? {}).map(([k, v]) => [Number(k), v])
	),
	recentVolumeByWindow: s.recentVolumeByWindow ?? {},
	recentStats: s.recentStats ?? {}
	}
}
