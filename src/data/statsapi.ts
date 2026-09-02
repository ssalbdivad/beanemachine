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
export const fetchSchedule = async (
	startDate: string,
	endDate: string,
	/**
	 * Count only games that have actually finished.
	 *
	 * A recent-form window divides plate appearances by team games, and today's
	 * game is scheduled but not yet played — so the denominator counted a game the
	 * numerator could not contain. Measured on a real capture: 14 PA over 3 played
	 * games became 3.5 per game instead of 4.67, a 25% understatement on the
	 * 3-day window, which carries half the recent blend weight.
	 *
	 * A forward-looking horizon wants the opposite: every game on the schedule,
	 * played or not. So this is a parameter rather than a policy.
	 */
	playedOnly = false
): Promise<{ counts: Map<number, number>; opponents: Map<number, number[]> }> => {
	// `gameType=R` on every schedule read here, because a fantasy season is the
	// REGULAR season. Unfiltered, this window returns types R, F, D, L and W, and a
	// rest-of-season horizon running to November therefore picks up the postseason.
	// Today that is invisible: the October games are placeholder-against-placeholder,
	// which is why the reference snapshot carries 52 "teams" for 30 clubs and no real
	// club's count is wrong. It stops being invisible the week clubs clinch, when the
	// placeholders resolve into real matchups and Stash starts crediting good teams
	// with games no league plays. Filtering also keeps the numerator and denominator
	// of the starter-coverage scaling on the same set of games.
	const data = await json(
		`${BASE}/schedule?sportId=1&gameType=R&startDate=${startDate}&endDate=${endDate}`
	)
	const counts = new Map<number, number>()
	const opponents = new Map<number, number[]>()
	const add = (team: number, opp: number) => {
		counts.set(team, (counts.get(team) ?? 0) + 1)
		opponents.set(team, [...(opponents.get(team) ?? []), opp])
	}
	for (const day of data.dates ?? [])
		for (const game of day.games ?? []) {
			const home = game.teams?.home?.team?.id
			const away = game.teams?.away?.team?.id
			if (typeof home !== "number" || typeof away !== "number") continue
			if (playedOnly && game.status?.abstractGameState !== "Final") continue
			add(home, away)
			add(away, home)
		}
	return { counts, opponents }
}

export const fetchGamesByTeam = async (
	startDate: string,
	endDate: string,
	playedOnly = false
): Promise<Map<number, number>> =>
	(await fetchSchedule(startDate, endDate, playedOnly)).counts

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


/**
 * Who is actually scheduled to start, and how many times, over a window.
 *
 * This closes the largest documented hole in the projection. A starter works every
 * fifth day, so projecting him from outs-per-TEAM-game silently averages a
 * two-start week and a one-start week into the same number — and in a points
 * league those two weeks are worth roughly double one another. MLB publishes
 * probable starters about a week ahead and fills every slot, so the count is an
 * observation rather than a guess.
 *
 * It cannot be backtested: probables are announced and then overwritten, and no
 * archive of what was announced at the time exists. That is stated rather than
 * papered over — see model.json.
 */
/** For each team, the opposing starters it is booked against over the window. */
export const fetchOpposingStarters = async (
	startDate: string,
	endDate: string
): Promise<Map<number, number[]>> => {
	const data = await json(
		`${BASE}/schedule?sportId=1&gameType=R&startDate=${startDate}&endDate=${endDate}` +
			`&hydrate=probablePitcher`
	)
	const out = new Map<number, number[]>()
	for (const day of data.dates ?? [])
		for (const game of day.games ?? [])
			for (const [side, other] of [
				["home", "away"],
				["away", "home"]
			] as const) {
				const team = game.teams?.[side]?.team?.id
				const starter = game.teams?.[other]?.probablePitcher?.id
				if (typeof team === "number" && typeof starter === "number")
					out.set(team, [...(out.get(team) ?? []), starter])
			}
	return out
}

/**
 * How much of a team's horizon MLB has actually published probables for.
 *
 * This is the difference between an observation and a fragment of one. MLB fills
 * today and tomorrow and then thins out fast — 46 of 222 slots over a fortnight
 * is typical — so a starter who happens to pitch today carries
 * `projectedStarts = 1` while everyone else is projected off team games at two or
 * three. Read as a complete count that DEMOTED him by roughly 350 places. The
 * count is only usable where it covers the whole window.
 */
export const fetchProbableCoverage = async (
	startDate: string,
	endDate: string
): Promise<Map<number, { published: number; games: number }>> => {
	const data = await json(
		`${BASE}/schedule?sportId=1&gameType=R&startDate=${startDate}&endDate=${endDate}` +
			`&hydrate=probablePitcher`
	)
	const out = new Map<number, { published: number; games: number }>()
	for (const day of data.dates ?? [])
		for (const game of day.games ?? [])
			for (const side of ["home", "away"] as const) {
				const team = game.teams?.[side]?.team?.id
				if (typeof team !== "number") continue
				const cur = out.get(team) ?? { published: 0, games: 0 }
				cur.games++
				if (typeof game.teams?.[side]?.probablePitcher?.id === "number") cur.published++
				out.set(team, cur)
			}
	return out
}

export const fetchProbableStarts = async (
	startDate: string,
	endDate: string
): Promise<Map<number, number>> => {
	const data = await json(
		`${BASE}/schedule?sportId=1&gameType=R&startDate=${startDate}&endDate=${endDate}` +
			`&hydrate=probablePitcher`
	)
	const starts = new Map<number, number>()
	for (const day of data.dates ?? [])
		for (const game of day.games ?? [])
			for (const side of ["home", "away"] as const) {
				const id = game.teams?.[side]?.probablePitcher?.id
				if (typeof id === "number") starts.set(id, (starts.get(id) ?? 0) + 1)
			}
	return starts
}
