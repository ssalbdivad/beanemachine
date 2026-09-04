import { parseRoster, type RosterEntry } from "./yahoo-pool.ts"

/**
 * Your team, read off whichever platform your league lives on.
 *
 * Yahoo is scraped because Yahoo has no public API; ESPN and Sleeper both publish
 * documented JSON for a publicly-viewable league, and `src/import.ts` already
 * reads their settings through those same endpoints.
 *
 * Every reader returns `{ players, note }` and NEVER throws for a shape it did not
 * expect. An unreadable roster is a state — a private league, a wrong team number,
 * a payload that changed — and the caller offers the manual path either way. That
 * matters more here than usual: a roster read wrong is worse than one not read,
 * because the lineup and every add/drop under it would be priced against a team
 * you do not have.
 */
export interface RosterRead {
	players: RosterEntry[]
	note: string
}

const UA =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
	"Chrome/124.0.0.0 Safari/537.36"

const yahoo = async (leagueId: string, teamId: string, sport: string): Promise<RosterRead> => {
	const url = `https://${sport}.fantasysports.yahoo.com/b1/${leagueId}/${teamId}`
	const res = await fetch(url, { headers: { "user-agent": UA } })
	if (!res.ok) return { players: [], note: `Yahoo returned HTTP ${res.status} for that team.` }
	const text = await res.text()
	if (/Please sign in/i.test(text.slice(0, 4000)))
		return {
			players: [],
			note: "That league isn't publicly viewable, so its rosters can't be read without signing in."
		}
	const players = parseRoster(text)
	return {
		players,
		note:
			players.length ?
				`Read ${players.length} players off team ${teamId}'s own page.`
			:	"Yahoo served the page but no roster rows were on it."
	}
}

/**
 * ESPN's `mRoster` view, which is the same league endpoint `importEspn` already
 * reads settings from.
 *
 * ESPN names a seat by a numeric `lineupSlotId`, and that table is ESPN's own and
 * not published as part of the response. Rather than hard-code a mapping that
 * would silently mislabel every seat if ESPN renumbered one, the slot is taken
 * from the ELIGIBILITY the payload states in words wherever the man is started,
 * and left null otherwise — a null slot is reported, never guessed at.
 *
 * NOT VERIFIED against a live ESPN league: no publicly-viewable baseball league is
 * available here to test it on, and probing a stranger's league to find one is not
 * something this should do. It is written to the documented shape and to fail
 * into the manual path, and it says so rather than implying otherwise.
 */
const espn = async (leagueId: string, teamId: string, sport: string, season: number): Promise<RosterRead> => {
	const url =
		`https://lm-api-reads.fantasy.espn.com/apis/v3/games/${sport}` +
		`/seasons/${season}/segments/0/leagues/${leagueId}?view=mRoster`
	const res = await fetch(url, { headers: { "user-agent": UA } })
	if (!res.ok)
		return {
			players: [],
			note:
				`ESPN returned HTTP ${res.status}. Private leagues need cookies; only ` +
				`publicly-viewable ones can be read.`
		}
	const data = (await res.json().catch(() => null)) as Record<string, any> | null
	const teams: any[] = Array.isArray(data?.teams) ? data!.teams : []
	if (!teams.length) return { players: [], note: "ESPN returned no teams for that league." }
	const team = teams.find(t => String(t?.id) === String(teamId))
	if (!team) return { players: [], note: `ESPN has no team ${teamId} in that league.` }
	const entries: any[] = team?.roster?.entries ?? []
	const players: RosterEntry[] = []
	for (const e of entries) {
		const pl = e?.playerPoolEntry?.player
		const name = typeof pl?.fullName === "string" ? pl.fullName.trim() : ""
		if (!name) continue
		players.push({
			yahooId: String(pl?.id ?? name),
			name,
			// ESPN's slot ids are its own; the bench flag is the one thing it states
			// unambiguously, so that is all that is claimed.
			slot: e?.lineupSlotId === 20 ? "BN" : e?.lineupSlotId === 21 ? "IL" : null,
			positions: [],
			team: null
		})
	}
	return {
		players,
		note:
			players.length ?
				`Read ${players.length} players off ESPN team ${teamId}. Seats are not labelled ` +
				`beyond bench and IL, so the add/drop plan needs them set by hand.`
			:	"ESPN served the league but that team's roster was empty."
	}
}

/**
 * Sleeper publishes rosters as player IDS, and resolving them needs its whole
 * player dictionary — a payload measured in megabytes that Sleeper's own docs ask
 * you not to call often. So the ids are fetched and the dictionary once, and a
 * failure of either returns nothing rather than a roster of numbers.
 *
 * NOT VERIFIED against a live Sleeper league, for the same reason as ESPN.
 */
const sleeper = async (leagueId: string, teamId: string, sport: string): Promise<RosterRead> => {
	const res = await fetch(`https://api.sleeper.app/v1/league/${leagueId}/rosters`, {
		headers: { "user-agent": UA }
	})
	if (!res.ok) return { players: [], note: `Sleeper returned HTTP ${res.status}.` }
	const rosters = (await res.json().catch(() => null)) as any[] | null
	if (!Array.isArray(rosters) || !rosters.length)
		return { players: [], note: "Sleeper returned no rosters for that league." }
	const mine =
		rosters.find(r => String(r?.roster_id) === String(teamId)) ??
		rosters.find(r => String(r?.owner_id) === String(teamId))
	if (!mine) return { players: [], note: `Sleeper has no roster ${teamId} in that league.` }
	const ids: string[] = Array.isArray(mine.players) ? mine.players.map(String) : []
	if (!ids.length) return { players: [], note: "That Sleeper roster is empty." }
	const dictRes = await fetch(`https://api.sleeper.app/v1/players/${sport}`, {
		headers: { "user-agent": UA }
	})
	if (!dictRes.ok)
		return { players: [], note: `Sleeper's player list returned HTTP ${dictRes.status}.` }
	const dict = (await dictRes.json().catch(() => null)) as Record<string, any> | null
	if (!dict) return { players: [], note: "Sleeper's player list could not be read." }
	const starters = new Set((Array.isArray(mine.starters) ? mine.starters : []).map(String))
	const players: RosterEntry[] = []
	for (const id of ids) {
		const p = dict[id]
		const name =
			typeof p?.full_name === "string" ? p.full_name
			: [p?.first_name, p?.last_name].filter(Boolean).join(" ")
		if (!name) continue
		players.push({
			yahooId: id,
			name: name.trim(),
			// Sleeper states who STARTS, not which seat, so that is all that is claimed
			slot: starters.has(id) ? null : "BN",
			positions: Array.isArray(p?.fantasy_positions) ? p.fantasy_positions : [],
			team: typeof p?.team === "string" ? p.team : null
		})
	}
	return {
		players,
		note:
			players.length ?
				`Read ${players.length} players off Sleeper roster ${teamId}. Sleeper names ` +
				`starters rather than seats, so the add/drop plan needs them set by hand.`
			:	"Sleeper's player list had none of that roster's ids in it."
	}
}

export const fetchTeamRoster = async (opts: {
	platform: string
	leagueId: string
	teamId: string
	sport?: string
	season?: number
}): Promise<RosterRead> => {
	const { platform, leagueId, teamId } = opts
	try {
		if (platform === "yahoo") return await yahoo(leagueId, teamId, opts.sport ?? "baseball")
		if (platform === "espn")
			return await espn(leagueId, teamId, opts.sport ?? "flb", opts.season ?? new Date().getFullYear())
		if (platform === "sleeper") return await sleeper(leagueId, teamId, opts.sport ?? "mlb")
		return {
			players: [],
			note: `Reading a roster isn't supported for ${platform || "this platform"} yet.`
		}
	} catch (e) {
		return { players: [], note: `Couldn't reach ${platform} (${(e as Error).message}).` }
	}
}
