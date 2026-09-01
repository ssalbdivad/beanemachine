import { cachedFetch } from "./cache.ts"

/** Real regular-season boundaries per year. 2020 ran 23 Jul – 27 Sep; assuming a
 *  April–October window would silently produce empty folds for it. */
export const seasonRange = async (season: number): Promise<{ start: string; end: string }> => {
	const data = JSON.parse(
		await cachedFetch(`https://statsapi.mlb.com/api/v1/seasons?sportId=1&season=${season}`)
	)
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
