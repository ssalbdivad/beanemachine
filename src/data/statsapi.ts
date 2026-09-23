import { KEPT_STATS } from "../engine/points.ts"
/* One predicate for "MLB called this one off", owned by the file that had to learn what
 * MLB actually writes there. See `readSlateRows` for why the capture needs it too. */
import { isCalledOff } from "./today.ts"

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
/**
 * DID THIS GAME ACTUALLY GET PLAYED.
 *
 * MLB reports a POSTPONED game as `abstractGameState: "Final"`. Not "Postponed", not
 * "Cancelled" — Final, with `codedGameState: "D"`, and the real answer hidden one field
 * over in `detailedState`. Every count in this repo tested the abstract field, so every
 * rained-out game was counted as played.
 *
 * Measured across the whole backtest cache on 2026-09-19: 5,788 cached schedule
 * responses, 1,798,000 game rows, of which 36,343 are Postponed and 56 Cancelled and
 * every one of them was being counted. That is 2.02% of the games this project has ever
 * divided by.
 *
 * It is a DENOMINATOR, which is what makes 2% matter. A recent-form rate is plate
 * appearances over team games, and `model.json` gives the three-day window half the
 * recent blend weight — so one rainout inside a three-day window inflates that
 * denominator by a third to a half and understates the man's per-game volume by the
 * same. The docblock on `fetchSchedule` below already measured exactly this failure for
 * a different cause (a game scheduled but not yet played, 25% understatement) and fixed
 * that one; this is the same error arriving through a status field nobody read.
 *
 * A POSITIVE LIST, never a blocklist. "Final" and "Completed Early" are the two states
 * in which men actually batted — Completed Early is a game called after it became
 * official, and those plate appearances are real and are in the stat lines. Anything
 * else, including a state this has never seen, is not counted, because a denominator
 * that grows on an unrecognised string is the bug this function exists to end.
 */
export const wasPlayed = (game: {
	status?: { detailedState?: string } | null
}): boolean =>
	game.status?.detailedState === "Final" || game.status?.detailedState === "Completed Early"

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
	 *
	 * And the rule for "finished" is `wasPlayed` — see the note above it. This line used
	 * to test `abstractGameState`, which MLB sets to "Final" on a POSTPONED game, so the
	 * 25% understatement measured below was being fixed for the scheduled-but-not-played
	 * case and reintroduced for every rainout.
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
			/* `wasPlayed`, not `abstractGameState === "Final"`, which a postponed game also
			   says. See the note on that predicate: 2.02% of every game row in this
			   project's cache is a game nobody played. */
			if (playedOnly && !wasPlayed(game)) continue
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

/** The `schedule?hydrate=probablePitcher` payload, narrowed to what is read, on the
 *  same discipline as `RawGame` in src/data/today.ts: anything MLB adds is ignored
 *  rather than typed. Written down at all because `json` returns `any`, and a status
 *  field read through `any` is how this file came to test two different ones. */
interface ScheduleSide {
	team?: { id?: number }
	probablePitcher?: { id?: number }
}
interface ScheduleResponse {
	dates?: {
		date?: string
		games?: {
			officialDate?: string
			status?: { detailedState?: string; abstractGameState?: string }
			teams?: { home?: ScheduleSide; away?: ScheduleSide }
		}[]
	}[]
}

/**
 * The parse, separate from the fetch, so a status rule can be asserted against a
 * captured response instead of against the weather — the split src/data/today.ts makes
 * for `readSlate` and for the same reason. Both producers of `SlateGame` now read the
 * same two fields the same way, which is the property that was broken (see below).
 */
export const readSlateRows = (data: ScheduleResponse, startDate: string): SlateGame[] => {
	const out: SlateGame[] = []
	for (const day of data.dates ?? [])
		for (const game of day.games ?? []) {
			const home = game.teams?.home?.team?.id
			const away = game.teams?.away?.team?.id
			if (typeof home !== "number" || typeof away !== "number") continue
			/*
			   A GAME NOBODY WILL PLAY IS NOT A GAME ON THE SLATE.

			   A postponed game kept its original date here and the makeup appears on its own,
			   so any window spanning both credited the club with a game that was never played
			   — the 2.02% denominator inflation `wasPlayed` above measures (36,343 postponed
			   rows and 56 cancelled, of 1,798,000 in this project's cache), arriving through
			   the forward-looking path instead of the played-only one. `isCalledOff` rather
			   than a second regex, because src/data/today.ts already owns that vocabulary and
			   already had to learn that "Suspended: Rain" and "Cancelled" are the same news as
			   "Postponed" while "Delayed" is not. Importing it here is what keeps the capture
			   and the live read saying the same thing about the same game; today.ts's import
			   back is type-only, so there is no cycle at runtime.
			*/
			if (isCalledOff(game.status?.detailedState ?? "")) continue
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
				/*
				   `wasPlayed`, not `abstractGameState === "Final"`.

				   This is the exact mistake that predicate was written to end, twelve lines
				   below the docblock that ends it: MLB reports a POSTPONED game as
				   `abstractGameState: "Final"`. `fetchSchedule` was converted and this was
				   not, so the two functions in this file disagreed about what "final" means —
				   and so did the two producers of `SlateGame`, since `asSlateGames` in
				   src/data/today.ts reads `detailedState` and additionally drops called-off
				   games. `windowFrom(..., playedOnly)` cannot tell which producer made its
				   rows.

				   Latent rather than live when fixed: all 265 rows of the committed capture
				   are `false` and nothing in src/ passes `playedOnly: true`. That is the
				   argument FOR doing it now — it is a one-line change while nothing depends
				   on it, and the field's own docblock above keeps it precisely for the case
				   where it starts being wrong, "a capture taken in the evening".
				*/
				final: wasPlayed(game)
			})
		}
	return out
}

export const fetchSlate = async (
	startDate: string,
	endDate: string
): Promise<SlateGame[]> =>
	readSlateRows(
		await json(
			`${BASE}/schedule?sportId=1&gameType=R&startDate=${startDate}&endDate=${endDate}` +
				`&hydrate=probablePitcher`
		),
		startDate
	)
