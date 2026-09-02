import { num, parseCsv } from "./csv.ts"

/**
 * Point-in-time xwOBA, computed from pitch-level Statcast.
 *
 * This exists because of a silent data bug worth recording. Savant's `custom`
 * leaderboard ACCEPTS `start_dt` and `end_dt` and then ignores them: three
 * different ranges over 2023 return byte-identical rows and the same 184,104
 * plate appearances. Anything built on it that believed it was reading "the
 * season so far" was in fact reading the whole season, including the future it
 * was trying to predict. `month=` is ignored the same way.
 *
 * `statcast_search` does honour the dates, but only serves pitch-level rows and
 * caps a response at 25,000 of them — about a day and a half of MLB — so the
 * window is fetched a day at a time and aggregated here. That is expensive, which
 * is the real reason the leaderboard was used in the first place; it is not a
 * good enough reason to keep using it.
 */
const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
	"(KHTML, like Gecko) Chrome/120.0 Safari/537.36"

export interface WindowLine {
	id: number
	pa: number
	woba: number
	xwoba: number
}

const dayUrl = (day: string, season: number, type: "batter" | "pitcher"): string => {
	const p = new URLSearchParams({
		all: "true", hfGT: "R|", hfSea: `${season}|`, player_type: type,
		game_date_gt: day, game_date_lt: day,
		min_pitches: "0", min_results: "0", min_pas: "0",
		sort_col: "pitches", sort_order: "desc", type: "details", group_by: "name",
		player_event_sort: "api_p_release_speed"
	})
	return `https://baseballsavant.mlb.com/statcast_search/csv?${p}`
}

export const eachDay = function* (start: string, end: string): Generator<string> {
	for (let t = Date.parse(start); t <= Date.parse(end); t += 86400_000)
		yield new Date(t).toISOString().slice(0, 10)
}

/**
 * Aggregates one window into per-player wOBA and xwOBA.
 *
 * `fetchDay` is injected so the backtest can route it through its disk cache — a
 * day of pitches is ~16 MB and windows overlap heavily between weeks.
 */
export const aggregateStatcast = async (
	season: number,
	type: "batter" | "pitcher",
	start: string,
	end: string,
	fetchDay: (url: string) => Promise<string> = async url =>
		(await fetch(url, { headers: { accept: "text/csv", "user-agent": UA } })).text()
): Promise<Map<number, WindowLine>> => {
	const acc = new Map<number, { w: number; x: number; d: number }>()
	for (const day of eachDay(start, end)) {
		let rows: Record<string, string>[]
		try {
			rows = parseCsv(await fetchDay(dayUrl(day, season, type)))
		} catch {
			continue // a missing day degrades the window; it does not invent one
		}
		for (const r of rows) {
			const id = num(r[type === "batter" ? "batter" : "pitcher"])
			const denom = num(r.woba_denom)
			if (id === null || !denom) continue
			const woba = num(r.woba_value) ?? 0
			// xwOBA falls back to the actual outcome on events with no batted ball
			// (walks, strikeouts, hit by pitch) — that is how Savant defines it too
			const est = num(r.estimated_woba_using_speedangle)
			const cur = acc.get(id) ?? { w: 0, x: 0, d: 0 }
			cur.w += woba
			cur.x += est ?? woba
			cur.d += denom
			acc.set(id, cur)
		}
	}
	const out = new Map<number, WindowLine>()
	for (const [id, { w, x, d }] of acc)
		if (d > 0)
			out.set(id, {
				id, pa: d,
				woba: Number((w / d).toFixed(4)),
				xwoba: Number((x / d).toFixed(4))
			})
	return out
}
