import { KEPT_STATS } from "../engine/points.ts"

/**
 * MLB StatsAPI — the observed record. Everything here is a real measurement the
 * league actually produced; nothing is modelled at this layer.
 */
const BASE = "https://statsapi.mlb.com/api/v1"

/* `HittingLine`, an arktype definition of "a stat object is strings and numbers",
   lived here and was DELETED rather than wired up: a repo-wide grep for it
   (`grep -rn HittingLine . --exclude-dir=node_modules --exclude-dir=.git
   --exclude-dir=dist`) returned exactly one line, its own declaration. Nothing
   validated a stat line against it, so it was a claim about the shape of this data
   that no read ever made — and the arktype import it needed was the file's only one. */

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

/**
 * One StatsAPI stat value as a number, or null where it is not one.
 *
 * THIS WAS FOUR FUNCTIONS. statsapi.ts had this one; corpus.ts, season.ts and
 * harness.ts each carried an `asNum` that differed from it in one input class —
 * `Number("")` is 0, so a bare empty string became a zero measurement there rather
 * than a missing one, and a zero is a thing a projection divides by and averages in.
 *
 * The two spellings were collapsed into this, the stricter one, only after measuring
 * that the difference never fired: sampling every 38th file of data/backtest-cache,
 * taking the 309 that are StatsAPI stat responses, and coercing all 7,650,074 stat
 * values both ways gave 0 disagreements (2026-09-12). Had it fired even once, the
 * backtest's copies would have had to stay, because changing a number a stored run
 * was measured with is not a refactor.
 */
export const asNumber = (v: unknown): number | null => {
	if (typeof v === "number") return Number.isFinite(v) ? v : null
	if (typeof v === "string" && v.trim() !== "") {
		const n = Number(v)
		return Number.isFinite(n) ? n : null
	}
	return null
}

/**
 * The byDateRange URL, which four readers used to spell out for themselves.
 *
 * It is a function rather than four template literals because the backtest's disk
 * cache is keyed by the URL STRING: a stray reordered parameter would not be a bug,
 * it would be a 14 GB cache miss and several thousand live requests, and the stored
 * runs under data/results could no longer be re-derived offline at all. One spelling,
 * one key.
 */
export const windowStatsUrl = (
	season: number,
	group: "hitting" | "pitching",
	startDate: string,
	endDate: string
) =>
	`${BASE}/stats?stats=byDateRange&group=${group}&season=${season}&sportId=1` +
	`&playerPool=All&limit=3000&startDate=${startDate}&endDate=${endDate}`

/**
 * StatsAPI splits → `PlayerSeason[]`, the mapping every reader of this API needs.
 *
 * There were five copies of this loop: here, in `fetchSeason`, in src/data/actuals.ts
 * for the browser, and in corpus.ts, season.ts and harness.ts for the backtest. They
 * had already drifted: the three backtest copies keep every stat MLB returns, while
 * the two app copies keep only `KEPT_STATS`, because a snapshot served to a browser
 * pays for each field and a backtest running off local disk does not.
 *
 * That drift is preserved rather than tidied away, as `keepOnly`. Dropping the filter
 * in the app would put 27 unread stats per player back on the wire; ADDING it to the
 * backtest would silently change what the stored runs were measured on, which is the
 * one thing this file must not do.
 */
export const mapPlayerSeasons = (
	splits: any[],
	group: "hitting" | "pitching",
	keepOnly?: ReadonlySet<string>
): PlayerSeason[] =>
	splits
		.map((s: any): PlayerSeason => {
			const stats: StatLine = {}
			for (const [k, v] of Object.entries(s.stat ?? {})) {
				if (keepOnly && !keepOnly.has(k)) continue
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
		})
		.filter((p: PlayerSeason) => typeof p.id === "number")

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
	/* Only the fields something reads — see `KEPT_STATS` in src/engine/points.ts for
	   the measurement. MLB returns 67 per player and this app reads 40; the other 27
	   were 34% of the committed capture, served to every browser and discarded, and
	   shrunk and volume-scaled on the way past. */
	return mapPlayerSeasons(data.stats?.[0]?.splits ?? [], group, KEPT_STATS)
}

/** Stats accumulated strictly inside a date window — used for recent playing time,
 *  which the backtest showed is the single strongest predictor available. */
export const fetchWindowStats = async (
	season: number,
	group: "hitting" | "pitching",
	startDate: string,
	endDate: string
): Promise<PlayerSeason[]> => {
	const data = await json(windowStatsUrl(season, group, startDate, endDate))
	// same filter as the season read above, for the same reason
	return mapPlayerSeasons(data.stats?.[0]?.splits ?? [], group, KEPT_STATS)
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
/**
 * One row per scheduled game, which is the only shape that survives contact with the
 * fact that a scoring period belongs to the LEAGUE and a snapshot serves many.
 *
 * Counting games per team at capture time bakes one window into the data; carrying
 * the games themselves lets any window be counted at read time — the fortnight, the
 * rest of the season, and whatever Monday-to-Sunday period the reader's league
 * happens to run. It also collapses what used to be eight schedule requests into one,
 * and removes the class of bug where the numerator and denominator of a coverage
 * fraction were fetched over different windows.
 */
export interface SlateGame {
	/** The game's own date, as MLB dates it. */
	date: string
	home: number
	away: number
	/** Published probable starters, or null where MLB has not named one yet. Null is
	 *  "not announced", never "nobody is pitching". */
	homeProbable: number | null
	awayProbable: number | null
	/**
	 * True once the game is final, so a played-only count can be taken from the same
	 * rows a forward-looking one is.
	 *
	 * KEPT, having been measured rather than assumed. On the committed capture all 265
	 * rows are `false`, and `windowFrom`'s `playedOnly` path — the only reader — is not
	 * called with `true` anywhere in `src/`, only in test/period.mjs against a fixture.
	 * So today the field feeds nothing the site renders. That argues for deleting it
	 * until you price it: emitting it only where it is true saves 3,710 raw bytes and
	 * **48 gzipped** (zlib level 9, on the exact bytes written, 2026-09-11) — 0.03% of
	 * what a reader's connection pays. It is all zeroes in a row, which is what gzip is
	 * for. Removing it would buy nothing and would cost the one honest answer the slate
	 * can give to "has this game been played", which is not always no: a capture taken
	 * in the evening carries finished games, because the slate starts at the capture
	 * date. Cheap and sometimes true beats tidy.
	 */
	final: boolean
}

export const fetchSlate = async (
	startDate: string,
	endDate: string
): Promise<SlateGame[]> => {
	const data = await json(
		`${BASE}/schedule?sportId=1&gameType=R&startDate=${startDate}&endDate=${endDate}` +
			`&hydrate=probablePitcher`
	)
	const out: SlateGame[] = []
	for (const day of data.dates ?? [])
		for (const game of day.games ?? []) {
			const home = game.teams?.home?.team?.id
			const away = game.teams?.away?.team?.id
			if (typeof home !== "number" || typeof away !== "number") continue
			const probable = (side: "home" | "away") => {
				const id = game.teams?.[side]?.probablePitcher?.id
				return typeof id === "number" ? id : null
			}
			out.push({
				date: day.date ?? game.officialDate ?? startDate,
				home,
				away,
				homeProbable: probable("home"),
				awayProbable: probable("away"),
				final: game.status?.abstractGameState === "Final"
			})
		}
	return out
}
