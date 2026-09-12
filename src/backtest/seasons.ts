import { cachedFetch } from "./cache.ts"

const SAPI = "https://statsapi.mlb.com/api/v1"

/** Real regular-season boundaries per year. 2020 ran 23 Jul – 27 Sep; assuming a
 *  April–October window would silently produce empty folds for it. */
export const seasonRange = async (season: number): Promise<{ start: string; end: string }> => {
	const data = JSON.parse(await cachedFetch(`${SAPI}/seasons?sportId=1&season=${season}`))
	const s = data.seasons?.[0]
	if (!s?.regularSeasonStartDate) throw new Error(`no season range for ${season}`)
	return { start: s.regularSeasonStartDate, end: s.regularSeasonEndDate }
}

export const addDays = (d: string, n: number) =>
	new Date(Date.parse(d) + n * 86400_000).toISOString().slice(0, 10)

export const daysBetween = (a: string, b: string) =>
	Math.round((Date.parse(b) - Date.parse(a)) / 86400_000)

/** As-of dates spread through a season, leaving room for the evaluation window. */
export const foldsFor = (
	range: { start: string; end: string },
	horizon: number,
	count = 5
): string[] => {
	const span = daysBetween(range.start, range.end)
	const usable = span - horizon - 21
	if (usable < 40) return []
	const out: string[] = []
	for (let i = 1; i <= count; i++)
		out.push(addDays(range.start, Math.round((usable * i) / (count + 1)) + 21))
	return out
}

/**
 * The schedule URL the backtest reads, and the game count it reads out of it.
 *
 * THE LOOP BELOW EXISTED THREE TIMES — corpus.ts, season.ts and harness.ts — and
 * src/data/statsapi.ts has a fourth reader of the same endpoint, `fetchSchedule`,
 * which this deliberately does NOT call. They disagree on one case, and the
 * disagreement is load-bearing: `fetchSchedule(playedOnly)` counts a game only when
 * `abstractGameState === "Final"`, whereas this counts a game whose status is MISSING
 * ENTIRELY, and skips only a status that is present and says something other than
 * Final. Routing the backtest through the app's version would therefore drop games
 * from historical denominators, which is a different measurement from the one every
 * run under data/results was taken with.
 *
 * So the three copies collapse into one, and it is this one — the backtest's — kept
 * here rather than in src/data/ precisely because it is not the app's rule.
 *
 * `scheduleUrl` is shared with `opponentsOf` in season.ts, which pulls the same window
 * for who-plays-whom: same string, same disk-cache key, one request.
 */
export const scheduleUrl = (startDate: string, endDate: string) =>
	`${SAPI}/schedule?sportId=1&startDate=${startDate}&endDate=${endDate}&gameType=R`

/** Kept separate from the fetch so harness.ts, which goes to the network uncached on
 *  purpose, runs the identical counting rather than its own transcription of it. */
export const countGamesPlayed = (data: any): Map<number, number> => {
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

/** Games each team played inside a window — the real volume denominator. */
export const gamesPlayedIn = async (
	start: string,
	end: string
): Promise<Map<number, number>> =>
	countGamesPlayed(JSON.parse(await cachedFetch(scheduleUrl(start, end))))
