import { wasPlayed } from "../data/statsapi.ts"
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
 * src/data/statsapi.ts has a fourth reader of the same endpoint, `fetchSchedule`.
 *
 * IT USED TO SAY THE TWO MUST NOT SHARE A RULE, and that argument is retracted here
 * rather than quietly removed, because it was the reason this bug survived. It ran:
 * `fetchSchedule` counts only `abstractGameState === "Final"` while this counts a game
 * whose status is MISSING ENTIRELY, so routing the backtest through the app's version
 * would drop games from historical denominators and change what every stored run means.
 *
 * Both halves of that were wrong. The missing-status case does not exist — 1,798,000
 * game rows in the cache, every one of them carrying both status fields — and the rule
 * they were being kept apart to preserve was itself the defect: MLB reports a POSTPONED
 * game as `abstractGameState: "Final"`, so BOTH counters were counting games nobody
 * played. 36,399 of those 1,798,000 rows, 2.02%.
 *
 * So they now share one predicate, `wasPlayed` in src/data/statsapi.ts, and the reason
 * they share it is the reason they were split: there is only one right answer to "did
 * this game happen" and two copies of the question is how one of them stayed wrong.
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
			if (!wasPlayed(g)) continue
			for (const side of ["home", "away"] as const) {
				const id = g.teams?.[side]?.team?.id
				if (typeof id === "number") counts.set(id, (counts.get(id) ?? 0) + 1)
			}
		}
	return counts
}

/**
 * EVERY GAME ON THE SLATE, played or not — the FORWARD count, and a different question.
 *
 * A denominator asks what happened; a horizon asks what is booked. A manager setting
 * his lineup on Monday sees seven games on his shortstop's schedule and does not know
 * which of them will be rained out, so projecting him over six because one was later
 * postponed is not a better estimate, it is hindsight — the same kind of hindsight this
 * repo marks `cheats` elsewhere and refuses to file as a result.
 *
 * So the fix to `countGamesPlayed` is deliberately NOT applied here. One function used
 * to serve both meanings and the docblock said neither.
 *
 * HONEST LIMIT, because it is a real one: MLB adds makeup games to the schedule after
 * the fact, so a response fetched today for a week in 2021 contains games that were
 * booked into that week AFTER it began. A manager could not have seen those. Measured
 * separately at about 1.8% of rows; it is a leak, it is small, and it is stated here
 * rather than discovered later.
 */
export const countGamesScheduled = (data: any): Map<number, number> => {
	const counts = new Map<number, number>()
	for (const day of data.dates ?? [])
		for (const g of day.games ?? [])
			for (const side of ["home", "away"] as const) {
				const id = g.teams?.[side]?.team?.id
				if (typeof id === "number") counts.set(id, (counts.get(id) ?? 0) + 1)
			}
	return counts
}

/** Games each team played inside a window — the real volume denominator. */
export const gamesPlayedIn = async (
	start: string,
	end: string
): Promise<Map<number, number>> =>
	countGamesPlayed(JSON.parse(await cachedFetch(scheduleUrl(start, end))))

/** Games each team is BOOKED for inside a window — the horizon, not the denominator. */
export const gamesScheduledIn = async (
	start: string,
	end: string
): Promise<Map<number, number>> =>
	countGamesScheduled(JSON.parse(await cachedFetch(scheduleUrl(start, end))))
