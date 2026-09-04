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
 * ESPN's BASEBALL `lineupSlotId` table. It is NOT the football one — ESPN numbers
 * seats differently in every sport, and the football numbering this file used to
 * carry (20 = BN, 21 = IL) names nothing at all in baseball, so every seat came
 * back null.
 *
 * Derived from the live public league 81134470 (2021, 8 teams, 212 rostered rows).
 * Ids 0-7, 12, 13, 16 and 17 were each observed as a seat a team actually played,
 * with per-team occupancy matching `settings.rosterSettings.lineupSlotCounts`
 * exactly. Ids 8-11, 14, 15 and 19 are never played in that league's shape but
 * appear in `eligibleSlots` on precisely the men who could hold them (9 on the
 * centre fielders, 15 on the relievers, 19 on the infielders), which is what
 * fixes their meaning. 18 and 20-22 were never observed anywhere and are
 * deliberately absent rather than guessed at.
 */
const ESPN_MLB_SLOT: Record<number, string> = {
	0: "C",
	1: "1B",
	2: "2B",
	3: "3B",
	4: "SS",
	5: "OF",
	6: "2B/SS",
	7: "1B/3B",
	8: "LF",
	9: "CF",
	10: "RF",
	11: "DH",
	12: "Util",
	13: "P",
	14: "SP",
	15: "RP",
	16: "BN",
	17: "IL",
	19: "IF"
}

/** ESPN's `proTeamId` table. 0 is a free agent, which is a null club rather than
 *  a team — three men on the 2021 capture read 0 because they hit free agency. */
const ESPN_PRO_TEAM: Record<number, string> = {
	1: "Bal",
	2: "Bos",
	3: "LAA",
	4: "ChW",
	5: "Cle",
	6: "Det",
	7: "KC",
	8: "Mil",
	9: "Min",
	10: "NYY",
	11: "Oak",
	12: "Sea",
	13: "Tex",
	14: "Tor",
	15: "Atl",
	16: "ChC",
	17: "Cin",
	18: "Hou",
	19: "LAD",
	20: "Wsh",
	21: "NYM",
	22: "Phi",
	23: "Pit",
	24: "StL",
	25: "SD",
	26: "SF",
	27: "Col",
	28: "Mia",
	29: "Ari",
	30: "TB"
}

/** Seats every player on earth is eligible for (BN, IL), or that combine two
 *  positions (2B/SS, 1B/3B, Util, IF). Real seats, but not a statement about
 *  where a man can play, so they are not reported as eligibility. */
const ESPN_DERIVED_SLOTS = new Set([6, 7, 12, 16, 17, 19])

/**
 * ESPN's `mRoster` view, taken together with `mSettings` in the ONE request so
 * the league's own seat counts are on hand — eligibility is then reported in the
 * seats that league actually plays rather than in every seat ESPN defines.
 *
 * VERIFIED against the live public league 81134470, season 2021 — the id the
 * `espn-api` wrapper publishes as its own baseball integration-test league, so no
 * stranger's league was probed and no ids were enumerated. 8 teams, 212 rostered
 * rows, every one of them carrying a name, an eligibility list and a club. Team 1
 * reads back 25 players, 25 of 25 seated, 25 of 25 with positions and 22 of 25
 * with a club (the 3 nulls are genuine `proTeamId` 0 free agents).
 *
 * Not verified: what a PRIVATE league answers. Everything reachable here returned
 * 200 or 404, so the 401/403 branch is written from the wrappers' reports, not
 * from an observation. 404 means a wrong league or a season that league never
 * played — not privacy — which is why the season just gone is retried before
 * giving up.
 */
const espn = async (
	leagueId: string,
	teamId: string,
	sport: string,
	season: number
): Promise<RosterRead> => {
	const get = (yr: number) =>
		fetch(
			`https://lm-api-reads.fantasy.espn.com/apis/v3/games/${sport}` +
				`/seasons/${yr}/segments/0/leagues/${leagueId}?view=mRoster&view=mSettings`,
			{ headers: { "user-agent": UA, accept: "application/json" } }
		)
	let res = await get(season)
	// ESPN 404s a season the league never played, and the default season is the
	// current one; the season just gone is the usual fix for a league between years.
	if (res.status === 404) res = await get(season - 1)
	if (!res.ok)
		return {
			players: [],
			note:
				res.status === 401 || res.status === 403 ?
					`ESPN returned HTTP ${res.status}: that league isn't publicly viewable, and ` +
					`reading a private one would need your cookies.`
				: res.status === 404 ?
					`ESPN has no league ${leagueId} in ${season} or ${season - 1}.`
				:	`ESPN returned HTTP ${res.status}.`
		}
	const data = (await res.json().catch(() => null)) as Record<string, any> | null
	const teams: any[] = Array.isArray(data?.teams) ? data!.teams : []
	if (!teams.length) return { players: [], note: "ESPN returned no teams for that league." }
	const team = teams.find(t => String(t?.id) === String(teamId))
	// a wrong team number and a wrong league are different mistakes, so the ids
	// that DO exist are named rather than left for the user to guess at
	if (!team)
		return {
			players: [],
			note: `ESPN has no team ${teamId} in that league (it has ${teams
				.map(t => t?.id)
				.join(", ")}).`
		}
	const counts: Record<string, number> = data?.settings?.rosterSettings?.lineupSlotCounts ?? {}
	const played = new Set(
		Object.entries(counts)
			.filter(([, n]) => Number(n) > 0)
			.map(([id]) => Number(id))
	)
	const entries: any[] = Array.isArray(team?.roster?.entries) ? team.roster.entries : []
	const players: RosterEntry[] = []
	let unnamed = 0
	for (const e of entries) {
		const pl = e?.playerPoolEntry?.player
		const name = typeof pl?.fullName === "string" ? pl.fullName.trim() : ""
		if (!name) {
			unnamed++
			continue
		}
		const eligible: number[] = Array.isArray(pl?.eligibleSlots) ? pl.eligibleSlots : []
		const positions = eligible
			.filter(id => !ESPN_DERIVED_SLOTS.has(id) && (!played.size || played.has(id)))
			// a pitcher his league seats as SP or RP does not also need the generic P
			.filter(
				id => !(id === 13 && played.has(14) && (eligible.includes(14) || eligible.includes(15)))
			)
			.map(id => ESPN_MLB_SLOT[id])
			.filter((s): s is string => !!s)
		const proTeamId = typeof pl?.proTeamId === "number" ? pl.proTeamId : 0
		players.push({
			// an ESPN player id, not a Yahoo one — the field name is Yahoo's because
			// the Yahoo path defined it. The join to the pool runs by NAME, never by this.
			yahooId: String(e?.playerId ?? pl?.id ?? name),
			name,
			slot: ESPN_MLB_SLOT[e?.lineupSlotId as number] ?? null,
			positions,
			team: ESPN_PRO_TEAM[proTeamId] ?? null
		})
	}
	const unseated = players.filter(p => !p.slot).length
	return {
		players,
		note:
			players.length ?
				`Read ${players.length} players off ESPN team ${teamId}` +
				`${unseated ? `, ${unseated} in a seat ESPN didn't name` : ", seats included"}.` +
				(unnamed ? ` ${unnamed} roster rows had no player on them.` : "")
			:	"ESPN served the league but that team's roster was empty."
	}
}

/**
 * Sleeper's player list is 8.4 MB for MLB and 14.7 MB for NFL (measured), and its
 * own docs ask that you "save this information on your own servers" and call it
 * "once per day at most". So it is fetched once per sport per process and held.
 * A failure is NOT cached: a throttled read should be retryable.
 */
const sleeperDicts = new Map<string, Promise<Record<string, any> | null>>()

const sleeperPlayers = (sport: string): Promise<Record<string, any> | null> => {
	const hit = sleeperDicts.get(sport)
	if (hit) return hit
	const pending = (async () => {
		const res = await fetch(`https://api.sleeper.app/v1/players/${sport}`, {
			headers: { "user-agent": UA }
		})
		if (!res.ok) return null
		return (await res.json().catch(() => null)) as Record<string, any> | null
	})()
		.catch(() => null)
		.then(dict => {
			if (!dict) sleeperDicts.delete(sport)
			return dict
		})
	sleeperDicts.set(sport, pending)
	return pending
}

/** Seats Sleeper lists in `roster_positions` that are not on the field. */
const SLEEPER_BENCH = new Set(["BN", "IR", "TAXI"])

/**
 * Sleeper does NOT run fantasy baseball, so this reader is proved on NFL.
 *
 * Verified 2026-09-03: Sleeper's support centre lists football, basketball and
 * soccer; its API docs document one sport value, `nfl`; and `/v1/state/mlb` carries
 * neither `leg` nor `league_season` nor `league_create_season` — the fields every
 * league-hosting sport has — so there is no season in which an MLB league can be
 * created. `/v1/players/mlb` DOES return 6,379 real players, because Sleeper tracks
 * baseball for its news and prop-betting products, which makes this a trap rather
 * than an absence.
 *
 * The trap: Sleeper's player ids are per-sport namespaces that COLLIDE. Id "1352"
 * is Robert Woods in `players/nfl` and Jordan Hicks in `players/mlb`. Reading the
 * NFL league below with the old code's default sport of "mlb" returned twelve
 * plausible, fully-populated baseball players who were not on the team, under a
 * cheerful note. So the sport is now taken from the LEAGUE, never from the caller,
 * and a league that is not the sport we asked for is refused outright.
 *
 * VERIFIED on Sleeper's own documented example league 289646328504385536 (NFL,
 * 2018, 12 teams): 12 rosters, 14-16 players each, 9 starters each, and 108 of 108
 * seats recovered correctly. That is a verification on NFL and NOT a verification
 * on baseball — no baseball league exists on Sleeper to verify against, and the
 * refusal above is the only branch a baseball user can reach.
 *
 * The seats ARE recoverable, contrary to the note this used to carry: `starters`
 * is an ordered list that aligns index-for-index with `roster_positions` minus its
 * bench entries. Where the two lengths disagree the seat is left null rather than
 * guessed at. An empty seat is the string "0" by Sleeper's documented convention —
 * this completed league has none of them, so that guard is written from the docs
 * rather than from an observation.
 *
 * Baseball ceiling, measured on the MLB dictionary: `fantasy_positions` is
 * populated on 32 of 6,379 entries and every one of the 32 is a club, not a player,
 * so eligibility has to come from `position` — which is ONE position per man. It
 * can never match the multi-position line Yahoo prints, and the note says so.
 */
const sleeper = async (leagueId: string, teamId: string, sport: string): Promise<RosterRead> => {
	const headers = { "user-agent": UA }

	// the league first: it names the sport, and it holds the seat chart
	const leagueRes = await fetch(`https://api.sleeper.app/v1/league/${leagueId}`, { headers })
	if (!leagueRes.ok) return { players: [], note: `Sleeper returned HTTP ${leagueRes.status}.` }
	const league = (await leagueRes.json().catch(() => null)) as Record<string, any> | null
	if (!league) return { players: [], note: `Sleeper has no league ${leagueId}.` }
	const leagueSport = typeof league.sport === "string" ? league.sport : ""
	if (!leagueSport)
		return { players: [], note: "Sleeper didn't say what sport that league plays." }
	if (leagueSport !== sport)
		return {
			players: [],
			note:
				`That league plays ${leagueSport.toUpperCase()}, not baseball. Sleeper doesn't run ` +
				`fantasy baseball at all, and a Sleeper player id means a different man in every ` +
				`sport — so reading it would hand you a roster of players you don't have.`
		}

	const res = await fetch(`https://api.sleeper.app/v1/league/${leagueId}/rosters`, { headers })
	if (!res.ok) return { players: [], note: `Sleeper returned HTTP ${res.status}.` }
	const rosters = (await res.json().catch(() => null)) as any[] | null
	if (!Array.isArray(rosters) || !rosters.length)
		return { players: [], note: "Sleeper returned no rosters for that league." }

	// roster_id is the small number Sleeper shows as your team's; owner_id is an
	// 18-digit account id nobody types, accepted as a fallback but NEVER echoed
	// back or stored — it identifies a person.
	const mine =
		rosters.find(r => String(r?.roster_id) === String(teamId)) ??
		rosters.find(r => r?.owner_id != null && String(r.owner_id) === String(teamId))
	if (!mine) return { players: [], note: `Sleeper has no roster ${teamId} in that league.` }
	const label = String(mine.roster_id ?? teamId)

	const ids: string[] = Array.isArray(mine.players) ? mine.players.map(String) : []
	if (!ids.length) return { players: [], note: `That Sleeper roster (${label}) is empty.` }

	const dict = await sleeperPlayers(leagueSport)
	if (!dict) return { players: [], note: "Sleeper's player list could not be read." }

	const seats: string[] = (Array.isArray(league.roster_positions) ? league.roster_positions : [])
		.filter((p: any): p is string => typeof p === "string" && !SLEEPER_BENCH.has(p))
	const starters: string[] = (Array.isArray(mine.starters) ? mine.starters : []).map(String)
	const seatsUsable = seats.length > 0 && seats.length === starters.length
	const seatOf = new Map<string, string>()
	if (seatsUsable)
		starters.forEach((id, i) => {
			if (id && id !== "0") seatOf.set(id, seats[i]!)
		})
	const started = new Set(starters.filter(id => id && id !== "0"))
	const reserve = new Set((Array.isArray(mine.reserve) ? mine.reserve : []).map(String))
	const taxi = new Set((Array.isArray(mine.taxi) ? mine.taxi : []).map(String))

	const players: RosterEntry[] = []
	let unknown = 0
	for (const id of ids) {
		const p = dict[id]
		const name = (
			typeof p?.full_name === "string" && p.full_name.trim() ?
				p.full_name
			:	[p?.first_name, p?.last_name].filter(Boolean).join(" ")
		).trim()
		if (!name) {
			unknown++
			continue
		}
		// baseball carries eligibility in `position`; `fantasy_positions` is populated
		// on 32 of 6,379 MLB entries and every one of them is a club, not a player
		const positions =
			Array.isArray(p.fantasy_positions) && p.fantasy_positions.length ? p.fantasy_positions
			: typeof p.position === "string" && p.position ? [p.position]
			: []
		players.push({
			yahooId: id,
			name,
			slot:
				reserve.has(id) ? "IL"
				: taxi.has(id) ? "NA"
				: (seatOf.get(id) ?? (started.has(id) ? null : "BN")),
			positions,
			team: typeof p.team === "string" ? p.team : null
		})
	}
	if (!players.length)
		return { players: [], note: "Sleeper's player list had none of that roster's ids in it." }

	// a roster that quietly shrank would misprice every lineup under it, so the
	// ids the dictionary could not place are counted rather than dropped in silence
	const missed =
		unknown ? ` ${unknown} of its ${ids.length} ids weren't in Sleeper's player list.` : ""
	return {
		players,
		note:
			seatsUsable ?
				`Read ${players.length} players off Sleeper roster ${label}, seats included.${missed}` +
				` Sleeper lists one position per man, so eligibility is narrower than your league's.`
			:	`Read ${players.length} players off Sleeper roster ${label}. Its ${starters.length} ` +
				`starters didn't line up with the league's ${seats.length} seats, so seats are left ` +
				`unset rather than guessed at.${missed}`
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
