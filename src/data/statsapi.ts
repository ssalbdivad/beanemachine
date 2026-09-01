import { type } from "arktype"

/**
 * MLB StatsAPI — the observed record. Everything here is a real measurement the
 * league actually produced; nothing is modelled at this layer.
 */
const BASE = "https://statsapi.mlb.com/api/v1"

export const HittingLine = type({
	"[string]": "number | string | undefined"
})

export type StatLine = Record<string, number>

export interface PlayerSeason {
	id: number
	name: string
	team: string | null
	teamId: number | null
	position: string
	group: "hitting" | "pitching"
	stats: StatLine
}

const asNumber = (v: unknown): number | null => {
	if (typeof v === "number") return Number.isFinite(v) ? v : null
	if (typeof v === "string" && v.trim() !== "") {
		const n = Number(v)
		return Number.isFinite(n) ? n : null
	}
	return null
}

const json = async (url: string): Promise<any> => {
	const res = await fetch(url, { headers: { accept: "application/json" } })
	if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
	return res.json()
}

/**
 * Season totals for the ENTIRE player pool (not just qualified hitters) — the
 * qualified leaderboard is ~138 players, the real pool is ~700, and silently
 * ranking only qualifiers would hide exactly the waiver-wire players this app
 * exists to surface.
 */
export const fetchSeason = async (
	season: number,
	group: "hitting" | "pitching"
): Promise<PlayerSeason[]> => {
	const url =
		`${BASE}/stats?stats=season&group=${group}&season=${season}` +
		`&sportId=1&playerPool=All&limit=2000`
	const data = await json(url)
	const splits = data.stats?.[0]?.splits ?? []
	return splits.map((s: any): PlayerSeason => {
		const stats: StatLine = {}
		for (const [k, v] of Object.entries(s.stat ?? {})) {
			const n = asNumber(v)
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
	}).filter((p: PlayerSeason) => typeof p.id === "number")
}

/** Stats accumulated strictly inside a date window — used for recent playing time,
 *  which the backtest showed is the single strongest predictor available. */
export const fetchWindowStats = async (
	season: number,
	group: "hitting" | "pitching",
	startDate: string,
	endDate: string
): Promise<PlayerSeason[]> => {
	const data = await json(
		`${BASE}/stats?stats=byDateRange&group=${group}&season=${season}&sportId=1` +
			`&playerPool=All&limit=3000&startDate=${startDate}&endDate=${endDate}`
	)
	return (data.stats?.[0]?.splits ?? [])
		.map((s: any): PlayerSeason => {
			const stats: StatLine = {}
			for (const [k, v] of Object.entries(s.stat ?? {})) {
				const n = asNumber(v)
				if (n !== null) stats[k] = n
			}
			return {
				id: s.player?.id, name: s.player?.fullName ?? "",
				team: s.team?.name ?? null, teamId: s.team?.id ?? null,
				position: s.position?.abbreviation ?? "", group, stats
			}
		})
		.filter((p: PlayerSeason) => typeof p.id === "number")
}

/** Games each team actually has scheduled in a window — the real denominator for
 *  any "next N days" projection, instead of assuming a uniform slate. */
export const fetchGamesByTeam = async (
	startDate: string,
	endDate: string
): Promise<Map<number, number>> => {
	const data = await json(
		`${BASE}/schedule?sportId=1&startDate=${startDate}&endDate=${endDate}`
	)
	const counts = new Map<number, number>()
	for (const day of data.dates ?? [])
		for (const game of day.games ?? [])
			for (const side of ["home", "away"] as const) {
				const id = game.teams?.[side]?.team?.id
				if (typeof id === "number") counts.set(id, (counts.get(id) ?? 0) + 1)
			}
	return counts
}

/** Injury list status only.
 *
 *  The roster feed reports every non-active status, and most of them are not
 *  injuries: of 709 non-active entries, 513 were Reassigned to Minors, Minor
 *  League Contract, Traded, Released, Claimed or DFA. Showing "Traded" under an
 *  injury flag is simply wrong, so this filters to the D-prefixed IL codes. */
export const fetchInjuries = async (): Promise<Map<number, string>> => {
	const teams = await json(`${BASE}/teams?sportId=1`)
	const ids: number[] = (teams.teams ?? []).map((t: any) => t.id)
	const out = new Map<number, string>()
	const rosters = await Promise.all(
		ids.map(id =>
			json(`${BASE}/teams/${id}/roster?rosterType=fullSeason`).catch(() => null)
		)
	)
	for (const r of rosters)
		for (const entry of r?.roster ?? []) {
			const code: string | undefined = entry.status?.code
			const desc: string | undefined = entry.status?.description
			// D7 / D10 / D15 / D60 are the injured-list codes
			const isInjury = code ? /^D\d+$/.test(code) : false
			if (entry.person?.id && isInjury) out.set(entry.person.id, desc ?? code!)
		}
	return out
}

/** Team games played to date — the denominator for a player's per-team-game
 *  playing-time rate, which drives every horizon projection. */
export const fetchTeamGamesPlayed = async (season: number): Promise<Map<number, number>> => {
	const data = await json(
		`${BASE}/standings?leagueId=103,104&season=${season}&standingsTypes=regularSeason`
	)
	const out = new Map<number, number>()
	for (const record of data.records ?? [])
		for (const t of record.teamRecords ?? []) {
			const id = t.team?.id
			const gp = asNumber(t.gamesPlayed)
			if (typeof id === "number" && gp !== null) out.set(id, gp)
		}
	return out
}
