import { agentHeaders, readableInBrowser } from "../import.ts"
import { parseRoster, type RosterEntry } from "./yahoo-pool.ts"

/**
 * Your team, read off whichever platform your league lives on.
 *
 * Yahoo is scraped because Yahoo has no public API; ESPN publishes documented JSON
 * for a publicly-viewable league, and `src/import.ts` already reads its settings
 * through those same endpoints.
 *
 * Sleeper's reader was DELETED, not disabled. It worked — verified on Sleeper's own
 * documented example league 289646328504385536, 12 rosters and 108 of 108 seats
 * recovered — but it worked on NFL, and Sleeper hosts no baseball league for it to
 * ever run against (the measurement is on `SLEEPER_REFUSAL` in src/import.ts). It
 * cost ~120 lines and an 8.4 MB per-read player-dictionary download to reach a
 * branch that refused on every possible input. `fetchTeamRoster` now answers a
 * `sleeper` platform with that refusal directly, because a league stored before this
 * change can still be sitting in somebody's browser.
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

/**
 * Every reader below runs unchanged in a page as well as in node — the one that a
 * browser is allowed to reach, anyway. `agentHeaders` drops the `user-agent` in a
 * browser so each read stays a simple GET with no CORS preflight (see the measured
 * table on `readableInBrowser` in src/import.ts); `yahoo` keeps sending one because
 * only node ever calls it.
 *
 * Re-exported so the client can ask the same question with one import: whether a
 * roster read needs the server is exactly whether the platform sends CORS headers,
 * which is the fact `src/import.ts` already carries.
 */
export { readableInBrowser }

const yahoo = async (leagueId: string, teamId: string, sport: string): Promise<RosterRead> => {
	const url = `https://${sport}.fantasysports.yahoo.com/b1/${leagueId}/${teamId}`
	// node only: Yahoo sends no CORS headers, so this is never reached from a page.
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
/**
 * The seats a player is eligible for, from ESPN's numeric `eligibleSlots`.
 *
 * Shared by the roster read and the free-agent read so the two cannot disagree
 * about what a man can fill — a pool that thinks he is an outfielder and a roster
 * that thinks he is a shortstop would seat him in one place and price him in
 * another.
 *
 * `played` is the set of seats the league actually uses, where the caller knows it;
 * a league that seats nobody at LF should not be told a player is LF-eligible. The
 * derived seats (2B/SS, 1B/3B, UTIL, IF, bench, IL) are dropped because they are
 * combinations rather than positions, and the generic P is dropped for a pitcher
 * his league already seats as SP or RP.
 */
export const espnPositions = (eligibleSlots: unknown, played = new Set<number>()): string[] => {
	const eligible: number[] = Array.isArray(eligibleSlots) ? (eligibleSlots as number[]) : []
	return eligible
		.filter(id => !ESPN_DERIVED_SLOTS.has(id) && (!played.size || played.has(id)))
		.filter(id => !(id === 13 && played.has(14) && (eligible.includes(14) || eligible.includes(15))))
		.map(id => ESPN_MLB_SLOT[id])
		.filter((x): x is string => !!x)
}

export const ESPN_MLB_SLOT: Record<number, string> = {
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
			{ headers: { ...agentHeaders(UA), accept: "application/json" } }
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
		const positions = espnPositions(pl?.eligibleSlots, played)
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
		// A league imported before Sleeper was cut can still be in a browser's storage,
		// so the platform is still answered — with the finding, not with a reader.
		if (platform === "sleeper")
			return {
				players: [],
				note:
					"Sleeper doesn't run fantasy baseball, so this league is another sport's and " +
					"its roster can't be read into a baseball lineup — a Sleeper player id means " +
					"a different man in every sport. Import your Yahoo or ESPN league instead."
			}
		return {
			players: [],
			note: `Reading a roster isn't supported for ${platform || "this platform"} yet.`
		}
	} catch (e) {
		return { players: [], note: `Couldn't reach ${platform} (${(e as Error).message}).` }
	}
}

/**
 * An ESPN league's own free-agent list, read straight from the browser.
 *
 * Measured 2026-09-04 against public league 81134470 with
 * `Origin: https://beanemachine.com`:
 *
 *   OPTIONS …?view=kona_player_info  ->  access-control-allow-origin: <the origin>
 *                                        access-control-allow-headers: x-fantasy-filter
 *
 * The filter has to travel as a custom header, which forces a preflight, and ESPN
 * answers that preflight naming the header. So the one read Yahoo can never do
 * without a local run — who is actually available in YOUR league — an ESPN user
 * gets on the hosted site with no server at all. That makes ESPN the only platform
 * here that is fully self-service: settings, scoring, period, roster and wire.
 *
 * `filterStatus` FREEAGENT plus WAIVERS because a man on waivers is one you can put
 * a claim on; treating him as taken would hide exactly the players a streamer is
 * looking for in the days after a drop.
 *
 * Sorted by ESPN's own `percentOwned` descending and capped, because the list is
 * every unrostered player in baseball and the ranking only needs the ones anybody
 * would take. The cap is reported in the note rather than applied silently.
 */
export const ESPN_POOL_LIMIT = 300

export const fetchEspnPool = async (
	leagueId: string,
	season: number,
	sport = "flb"
): Promise<{ players: RosterEntry[]; positionsRead: string[]; note: string }> => {
	const url =
		`https://lm-api-reads.fantasy.espn.com/apis/v3/games/${sport}` +
		`/seasons/${season}/segments/0/leagues/${leagueId}?view=kona_player_info`
	const filter = {
		players: {
			filterStatus: { value: ["FREEAGENT", "WAIVERS"] },
			limit: ESPN_POOL_LIMIT,
			sortPercOwned: { sortAsc: false, sortPriority: 1 }
		}
	}
	try {
		const res = await fetch(url, {
			headers: { ...agentHeaders(UA), "x-fantasy-filter": JSON.stringify(filter) }
		})
		if (!res.ok)
			return {
				players: [],
				positionsRead: [],
				note: `ESPN returned HTTP ${res.status} for that league's player list.`
			}
		const data = (await res.json().catch(() => null)) as { players?: any[] } | null
		const rows = Array.isArray(data?.players) ? data!.players : []
		const players: RosterEntry[] = []
		for (const row of rows) {
			const pl = row?.player
			const name = typeof pl?.fullName === "string" ? pl.fullName.trim() : ""
			if (!name) continue
			players.push({
				yahooId: String(pl.id ?? name),
				name,
				// a free agent sits in no seat by definition
				slot: null,
				positions: espnPositions(pl.eligibleSlots),
				team: ESPN_PRO_TEAM[Number(pl.proTeamId)] ?? null
			})
		}
		return {
			players,
			positionsRead: [...new Set(players.flatMap(p => p.positions))].sort(),
			note:
				players.length ?
					`${players.length} free agents and waiver claims read off ESPN, the most ` +
					`widely rostered first${players.length >= ESPN_POOL_LIMIT ? `, capped at ${ESPN_POOL_LIMIT}` : ""}.`
				:	"ESPN served the league but listed no free agents."
		}
	} catch (e) {
		return { players: [], positionsRead: [], note: `Couldn't reach ESPN (${(e as Error).message}).` }
	}
}
