import type { League } from "./schema.ts"
import { cellText, documentText, parseNumber, parseTables } from "./html.ts"
import { ESPN_MLB_SLOT } from "./data/rosters.ts"
import {
	espnInningsMinimum,
	espnMatchupDays,
	openingDayOf,
	espnLock,
	espnMoveLimit,
	espnPointsFormat,
	espnSeason,
	espnTradeDeadline
} from "./data/espn.ts"
import { IL_SLOTS, rosterCounts } from "./engine/bscore.ts"

/**
 * Reads a league's real settings from a pasted URL.
 *
 * Invariant: nothing is invented. Every value written comes from the league's
 * own pages or API. Whatever the source doesn't state stays `null` and is named
 * in `needs_review`, so a missing setting can never pass for a real one.
 */

const USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
	"(KHTML, like Gecko) Chrome/120.0 Safari/537.36"

/** True inside a page, false under node. `window` alone is not enough — a bare
 *  `globalThis.window` shim would pass — so the document is checked too. */
export const IN_BROWSER =
	typeof globalThis.window !== "undefined" && typeof globalThis.document !== "undefined"

/**
 * `user-agent` on a cross-origin fetch, but only where sending one means anything.
 *
 * A page IS allowed to set it (it stopped being a forbidden header name), and ESPN
 * answers a preflight for it — measured 2026-09-04, replying
 * `access-control-allow-headers: … user-agent`. But setting it makes the request
 * non-simple, so every read costs an extra OPTIONS round trip and depends on a
 * second response staying the way it is. The plain GET is what was measured working
 * and what ships; node, which has no browser UA of its own, keeps sending one.
 */
export const agentHeaders = (ua: string): Record<string, string> =>
	IN_BROWSER ? {} : { "user-agent": ua }

/** Thrown for conditions the user can act on; surfaced verbatim in the UI. */
export class ImportError extends Error {}

/**
 * Why a Sleeper league URL is refused outright rather than imported.
 *
 * Sleeper does not run fantasy baseball, verified four independent ways and
 * re-measured 2026-09-04:
 *
 *   1. Sleeper's support centre lists the sports its leagues play; baseball is absent.
 *   2. Its API docs document one sport value, `nfl`.
 *   3. `/v1/state/mlb` answers `{week, season, season_type, previous_season,
 *      season_start_date, display_week, season_has_scores}` and NOTHING else, while
 *      `/v1/state/nfl` and `/v1/state/nba` both add `leg`, `league_season` and
 *      `league_create_season`. There is no season in which a Sleeper MLB league can
 *      be created, because Sleeper never names one.
 *   4. `/v1/players/mlb` DOES return 6,379 real players — Sleeper tracks baseball for
 *      news and props — but `fantasy_positions` is populated on 32 of them and every
 *      one of those 32 is a club, not a player. It is a betting payload.
 *
 * The import used to succeed anyway. Measured 2026-09-04 on Sleeper's OWN documented
 * example league (289646328504385536), `importSleeper` returned a league with
 * sport `nfl`, 0 batting stats, 0 pitching stats and roster slots
 * {QB:1, RB:2, WR:2, TE:1, FLEX:2, DEF:1, BN:6} — and the app then made it ACTIVE.
 * All four inputs this engine needs to rank anything (scoring.batting,
 * scoring.pitching, roster.slots, meta.max_teams) were absent or football, and there
 * is no repair: you cannot hand-enter baseball scoring onto a QB/RB/WR seat chart.
 * A league you can neither use nor fix is a dead end, so the URL is refused at the
 * one moment the user can still do something else.
 */
const SLEEPER_REFUSAL =
	"Sleeper doesn't run fantasy baseball — it hosts football, basketball and soccer " +
	"leagues only, and there is no season in which an MLB league can be created there " +
	"(`/v1/state/mlb` names none). So a Sleeper league URL can only ever be another " +
	"sport's league, whose scoring and roster slots this baseball engine cannot use. " +
	"If your baseball league is on Yahoo or ESPN, paste that URL instead."

const YAHOO_SPORTS = {
	baseball: "mlb",
	football: "nfl",
	basketball: "nba",
	hockey: "nhl"
} as const

const ESPN_GAMES = {
	baseball: "flb",
	football: "ffl",
	basketball: "fba",
	hockey: "fhl"
} as const

export type Target =
	| {
			platform: "yahoo"
			sport: string
			yahooGame: keyof typeof YAHOO_SPORTS
			leagueId: string
			teamId: string | null
	  }
	| {
			platform: "espn"
			sport: string
			leagueId: string
			teamId: string | null
			season: number | null
	  }

export const detect = (url: string): Target => {
	const u = url.trim()

	const yahoo = u.match(
		/(baseball|football|basketball|hockey)\.fantasysports\.yahoo\.com\/\w+\/(\d+)(?:\/(\d+))?/
	)
	if (yahoo) {
		const game = yahoo[1] as keyof typeof YAHOO_SPORTS
		return {
			platform: "yahoo",
			sport: YAHOO_SPORTS[game],
			yahooGame: game,
			leagueId: yahoo[2]!,
			teamId: yahoo[3] ?? null
		}
	}

	const espn = u.match(/fantasy\.espn\.com\/(baseball|football|basketball|hockey)\b/)
	if (espn) {
		const leagueId = u.match(/leagueId=(\d+)/)?.[1]
		if (!leagueId) throw new ImportError("That ESPN URL has no `leagueId=` in it.")
		const season = u.match(/seasonId=(\d+)/)?.[1]
		return {
			platform: "espn",
			sport: ESPN_GAMES[espn[1] as keyof typeof ESPN_GAMES],
			leagueId,
			teamId: u.match(/teamId=(\d+)/)?.[1] ?? null,
			season: season ? Number(season) : null
		}
	}

	// Sleeper URLs are still MATCHED, so the refusal below can name the reason
	// instead of falling through to "unrecognized" — a Sleeper user who pastes a
	// real league URL has made no mistake, and telling him the URL is unrecognized
	// would be a lie about his URL rather than a fact about baseball.
	if (/sleeper\.(?:app|com)\/leagues?\/\d+/.test(u)) throw new ImportError(SLEEPER_REFUSAL)

	throw new ImportError(
		"Unrecognized league URL. Supported: Yahoo (*.fantasysports.yahoo.com) and " +
			"ESPN (fantasy.espn.com, needs ?leagueId=)."
	)
}

/**
 * Which platforms a browser can read for itself, and which one genuinely needs a
 * server in front of it. Measured 2026-09-04, each with `Origin:
 * https://beanemachine.com` on the exact endpoints below:
 *
 *   ESPN     lm-api-reads.fantasy.espn.com  → `access-control-allow-origin:
 *            https://beanemachine.com` (it reflects the origin back), on both the
 *            mSettings read here and the mRoster read in data/rosters.ts.
 *   Yahoo    *.fantasysports.yahoo.com      → NO access-control headers at all
 *
 * So ESPN imports with nothing behind the page, and Yahoo — HTML scraped off pages
 * that send no CORS headers — is the one that cannot. That is not something client
 * code can fix: without an `access-control-allow-origin` the browser will not hand
 * the response body to the script, whatever it contains.
 *
 * Sleeper was the third row of this table and answered `access-control-allow-origin:
 * *`, which is still true and no longer relevant: a browser being ALLOWED to read a
 * platform means nothing when that platform hosts no baseball league to read. See
 * `SLEEPER_REFUSAL`. CORS was never the reason Sleeper failed, which is exactly why
 * it kept passing a CORS test while shipping a dead end.
 */
export const readableInBrowser = (platform: string): boolean => platform === "espn"

/** `readableInBrowser` for a pasted URL, without the throw: an unrecognized URL is
 *  not browser-readable either, and whoever asked gets to decide what that means. */
export const importableInBrowser = (url: string): boolean => {
	try {
		return readableInBrowser(detect(url).platform)
	} catch {
		return false
	}
}

const fetchText = async (url: string): Promise<string> => {
	const res = await fetch(url, { headers: agentHeaders(USER_AGENT) })
	if (!res.ok) throw new ImportError(`${url} returned HTTP ${res.status}.`)
	return res.text()
}

const today = (): string => new Date().toISOString().slice(0, 10)

/** Yahoo labels every scored stat with its short code: "Home Runs (HR)". */
const STAT_CODE = /\(([A-Za-z0-9/]+)\)\s*$/

/**
 * Which eligibility positions may fill each roster slot, derived from the slot
 * names the league published.
 *
 * Yahoo expresses slot compatibility as the COLUMNS of its position-eligibility
 * grid rather than as prose, so the only honest reconstruction is to mirror the
 * slot names it printed: a `C` seat takes catchers, `Util` takes whichever batter
 * positions this league actually rosters, `P` takes whichever arms it rosters,
 * bench takes anyone and an IL seat takes only the injured.
 *
 * Exported because a league now arrives by two routes — fetched HTML and a
 * settings page the reader pasted — and a slot rule that differed between them
 * would mean the same league seats a different lineup depending on how it got
 * here. Returns null when the league listed no slots, which is the caller's cue
 * that there is nothing to derive from rather than that everything is ineligible.
 */
export const deriveSlotAccepts = (
	slots: Record<string, number>
): Record<string, string[] | "any" | "injured_only"> | null => {
	if (!Object.keys(slots).length) return null
	const batterPositions = ["C", "1B", "2B", "3B", "SS", "OF"].filter(p => p in slots)
	const accepts: Record<string, string[] | "any" | "injured_only"> = Object.fromEntries(
		batterPositions.map(p => [p, [p]])
	)
	for (const p of ["SP", "RP"]) if (p in slots) accepts[p] = [p]
	if ("Util" in slots) accepts["Util"] = batterPositions
	if ("P" in slots) {
		const arms = ["SP", "RP"].filter(p => p in slots)
		accepts["P"] = arms.length ? arms : ["SP", "RP"]
	}
	if ("BN" in slots) accepts["BN"] = "any"
	for (const il of IL_SLOTS) if (il in slots) accepts[il] = "injured_only"
	/*
	   A SEAT THAT NAMES THE TWO POSITIONS IT TAKES.
	
	   Yahoo prints none of these, so this function never needed them. ESPN does: its lineup
	   slot table carries `2B/SS` and `1B/3B`, and the map in src/data/rosters.ts names them
	   exactly that way because that is what they are. Left out, an ESPN league's middle-infield
	   seat accepted NOBODY — and a seat nobody can fill is a seat the replacement bar prices as
	   if the league did not have it, which moves every row on the board.
	
	   Read off the name rather than from a table of known compounds, because the name is the
	   evidence: a slot called `2B/SS` takes second basemen and shortstops whoever published it,
	   and a compound this has never seen still reads correctly. Only positions this league
	   actually rosters are kept, the same rule `Util` follows one line up.
	*/
	for (const name of Object.keys(slots)) {
		if (name in accepts || !name.includes("/")) continue
		const parts = name
			.split("/")
			.map(x => x.trim())
			.filter(x => batterPositions.includes(x) || ["SP", "RP"].includes(x))
		if (parts.length > 1) accepts[name] = parts
	}
	return accepts
}

/** The lock is a weekday when lineups are set for the whole period, e.g. "Monday". */
const WEEKDAY_NAMES: readonly string[] = [
	"sunday",
	"monday",
	"tuesday",
	"wednesday",
	"thursday",
	"friday",
	"saturday"
]

/** Schema spelling: lowercase three-letter, Sunday first. */
const WEEKDAY_CODES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const

/** Yahoo dates the END of the playoff period ("ends Sunday, Sep 27"). A period that
 *  ends on a Sunday and runs seven inclusive days opens on the Monday before, so the
 *  start is the day after the stated end. */
const dayAfter = (name: string): (typeof WEEKDAY_CODES)[number] =>
	WEEKDAY_CODES[(WEEKDAY_NAMES.indexOf(name.toLowerCase()) + 1) % 7]!

export interface DerivedPeriod {
	period: NonNullable<League["scoring_period"]>
	needsReview: string[]
}

/**
 * ESPN's numeric scoring stat ids, mapped to this engine's stat codes.
 *
 * ESPN publishes `{ statId, points, isReverseItem, leagueRanking, leagueTotal,
 * pointsOverrides }` and NO NAMES anywhere in the payload — the whole `scoringItems` array
 * contains no string values at all, re-measured 2026-09-18 — so
 * an imported ESPN league landed its whole scoring table in `scoring.unmapped` and
 * the board refused it: "this league has no scoring yet", with no way forward. The
 * import worked and the product did not.
 *
 * This map is DERIVED, not copied from a table. Method: take the 212 roster rows of
 * public league 81134470 for 2021, each carrying its season stat split keyed by
 * these same ids; fetch the real 2021 season from MLB StatsAPI, which this repo
 * already reads; join by `normalizeName`; and for every id find the MLB stat it
 * agrees with player by player.
 *
 *   HITTING (133 players matched)      PITCHING (76 matched)
 *     8  total bases        83%          34  outs recorded    97%
 *     10 walks              96%          37  hits allowed     89%
 *     20 runs               96%          39  walks allowed    99%
 *     21 RBI                95%          45  earned runs      89%
 *     23 stolen bases       99%          48  strikeouts       97%
 *     27 strikeouts         94%          53  wins            100%
 *                                        54  losses           99%
 *                                        57  saves            94%
 *
 * The shortfall from 100% is players ESPN's season split covers differently from
 * MLB's totals — traded men, and rows counting only time on a fantasy roster — and
 * no id had a competing candidate at any rate.
 *
 * Two independent confirmations, because a mapping this load-bearing should not
 * rest on one method. Total bases satisfies its own identity in the payload:
 * Mookie Betts reads 226, and 67 singles + 2x29 + 3x3 + 4x23 = 226, with
 * 226/466 = .485 matching the slugging id beside it. And every SIGN in the league's
 * own scoring table comes out right: hits allowed, walks allowed, earned runs,
 * losses and batter strikeouts are all negative, while total bases, walks, runs,
 * RBI, steals, wins, saves, strikeouts and outs are all positive. A wrong mapping
 * would have paid a hitter for striking out.
 *
 * Ids outside this set stay in `scoring.unmapped` and are named in `needs_review`.
 * Guessing at a stat is how a board silently reprices every player in a league.
 */
const ESPN_STAT: Record<number, { side: "batting" | "pitching"; code: string }> = {
	8: { side: "batting", code: "TB" },
	10: { side: "batting", code: "BB" },
	20: { side: "batting", code: "R" },
	21: { side: "batting", code: "RBI" },
	23: { side: "batting", code: "SB" },
	27: { side: "batting", code: "K" },
	34: { side: "pitching", code: "OUT" },
	37: { side: "pitching", code: "H" },
	39: { side: "pitching", code: "BB" },
	45: { side: "pitching", code: "ER" },
	48: { side: "pitching", code: "K" },
	53: { side: "pitching", code: "W" },
	54: { side: "pitching", code: "L" },
	57: { side: "pitching", code: "SV" }
}

/**
 * Splits ESPN's numeric scoring table into what `ESPN_STAT` can name and what it
 * cannot. Exported so a suite can pin the mapping without a network call.
 *
 * A stat carrying a points OVERRIDE is left unmapped on purpose: an override is a
 * per-slot or per-position exception this engine has no way to express, and
 * flattening it to its base value would price that stat wrong everywhere the
 * exception applies. Silently wrong beats loudly absent nowhere in this project.
 */
export const mapEspnScoring = (
	scoringItems: Record<string, unknown>[]
): { batting: Record<string, number>; pitching: Record<string, number>; unmapped: Record<string, unknown>[] } => {
	const batting: Record<string, number> = {}
	const pitching: Record<string, number> = {}
	const unmapped: Record<string, unknown>[] = []
	for (const item of scoringItems) {
		const id = Number(item.statId)
		const points = Number(item.points)
		const known = ESPN_STAT[id]
		const overridden =
			item.pointsOverrides !== undefined &&
			item.pointsOverrides !== null &&
			Object.keys(item.pointsOverrides as object).length > 0
		if (known && Number.isFinite(points) && !overridden) {
			;(known.side === "batting" ? batting : pitching)[known.code] = points
			continue
		}
		unmapped.push({
			espn_stat_id: item.statId,
			points: item.points,
			points_overrides: item.pointsOverrides
		})
	}
	return { batting, pitching, unmapped }
}

/**
 * Reads the scoring period out of ESPN's own `scheduleSettings`.
 *
 * ESPN states this properly, unlike Yahoo, which implies it in two places. The note
 * that used to sit in `needs_review` — "ESPN may state it under
 * settings.scheduleSettings, but no fixture or test here has ever seen that shape" —
 * was true when it was written and stopped being true when a real public league was
 * captured. This is derived from that capture, not from a table.
 *
 * The shape, from league 81134470 season 2021:
 *
 *   matchupPeriodCount: 21
 *   matchupPeriodLength: 1
 *   matchupPeriods: { "1":[1], "2":[2], … "22":[22,23], "23":[24,25] }
 *
 * The unit those arrays count in is the thing to establish, and the payload settles
 * it without an external table. `scoringPeriodId` at the top level reads **187**,
 * which is a day index — so if `matchupPeriods` counted days, this league's whole
 * season would be 25 days. It counts WEEKS: 21 regular matchups of one week each,
 * then two playoff rounds of two, which is 25 weeks against a regular season of
 * about 26. A unit is a week, and a matchup is `matchupPeriodLength` of them.
 *
 * What is NOT derived, and so is not claimed:
 * - The start day. Nothing in the payload names one, so `starts_on` stays null and
 *   `resolvePeriod` applies its own Monday fallback, which announces itself in
 *   `basis` — a stated assumption rather than a quiet one.
 * - The lineup lock. ESPN baseball is daily-lineup in practice, but no field here
 *   says so, so `lineup_lock` stays null and the board treats the rest of the
 *   current period as actionable.
 */
export const deriveEspnPeriod = (
	settings: Record<string, any>,
	/** ESPN's own `status` block, from `view=mStatus`. Optional because a caller with only a
	 *  settings payload — every test of this before the window was derivable, and any stored
	 *  league re-read from `raw_settings` — still gets what it always got. */
	status?: Record<string, any> | null,
	/** `schedule[]` from `view=mMatchupScore`, which is where ESPN states which days each
	 *  matchup covers. Without it there is no window to read and the league's stated length is
	 *  used with its Monday assumption declared. */
	schedule?: unknown,
	/** The season's first regular-season game day, ISO, which is ESPN's scoring period 1.
	 *  Null where it could not be read; the derivation is then skipped rather than guessed. */
	openingDay?: string | null
): DerivedPeriod => {
	const needsReview: string[] = []
	const sched = settings?.scheduleSettings
	/*
	   THE LOCK IS READ BEFORE THE PERIOD, AND SEPARATELY FROM IT.
	
	   `settings.rosterSettings.lineupLocktimeType` — see `espnLock` in src/data/espn.ts, where
	   the mapping and its measurement are written down. It is up here rather than beside the
	   period below because the two facts live in different blocks of ESPN's settings and fail
	   independently: a league whose `scheduleSettings` this cannot read still states its lock
	   perfectly well, and returning null for it because the OTHER half was unreadable is a fact
	   thrown away for no reason.
	*/
	const { lock, stated: lockType } = espnLock(settings)
	if (lock === null)
		needsReview.push(
			lockType === null ?
				"ESPN's settings carried no lineup lock, so the rest of the current period is " +
					"treated as still actionable."
			:	`ESPN stated a lineup lock this does not recognise (${lockType}), so it is left ` +
				`unknown rather than guessed at.`
		)
	const empty: NonNullable<League["scoring_period"]> = {
		kind: null, days: null, starts_on: null, anchor: null, lineup_lock: lock, source: null
	}
	if (!sched || typeof sched !== "object") {
		needsReview.push(
			"ESPN sent nothing about this league's schedule, so how long a scoring period " +
				"runs is unknown and the board ranks a rolling seven days instead."
		)
		return { period: empty, needsReview }
	}

	const length = typeof sched.matchupPeriodLength === "number" ? sched.matchupPeriodLength : null
	const periods = sched.matchupPeriods
	const units =
		periods && typeof periods === "object" ?
			Math.max(0, ...Object.values(periods).flat().filter((n): n is number => typeof n === "number"))
		:	0

	// The unit test: a season's worth of WEEKS is a couple of dozen; a season's worth
	// of days is a couple of hundred. Anything else is a shape this has not seen, and
	// guessing at it is how a board ends up ranking the wrong seven days.
	if (length === null || units < 10 || units > 40) {
		needsReview.push(
			`ESPN described this league's schedule in a shape this has not seen before ` +
				`(matchups of ${String(length)}, ${units} of them in the season), so how long a ` +
				`scoring period runs is unknown and the board ranks a rolling seven days instead.`
		)
		return { period: empty, needsReview }
	}

	/* What ESPN says the season holds, where it says it. `matchupPeriodCount` is the league's
	   own count of matchups; `units` above is the largest id in its period map, which includes
	   the playoff rounds and is a unit test rather than a count. */
	const stated =
		typeof sched.matchupPeriodCount === "number" && sched.matchupPeriodCount > 0 ?
			sched.matchupPeriodCount
		:	null
	const days = length * 7
	/*
	   THE WINDOW HIS LEAGUE IS ACTUALLY PLAYING, where ESPN gives enough to work it out.
	
	   Everything below this point describes the league in the abstract — a matchup is seven
	   days, the start weekday is unknown, assume Monday. `espnMatchupDays` answers the
	   question a reader's screen actually asks: which DAYS is the matchup in front of him,
	   which is the window his men's points and his opponent's are summed over.
	
	   It needs the `status` block and the season's opening day, so a caller without them gets
	   exactly what this returned before. With them, the anchor is a real date this league is
	   known to have started a period on, and the length is the CURRENT matchup's — which is
	   how a two-week playoff round stops being reported as one week.
	*/
	const window = espnMatchupDays(status, schedule, openingDay ?? null)
	if (window) {
		const WEEKDAY = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const
		return {
			period: {
				kind: "matchup",
				days: window.days,
				starts_on: WEEKDAY[new Date(`${window.start}T00:00:00Z`).getUTCDay()]!,
				anchor: window.start,
				lineup_lock: lock,
				source:
					`ESPN's own schedule for your league: matchup ${window.matchup} runs ` +
					`${window.start} to ${window.end}, which is ${window.days} days.`
			},
			needsReview: [
				...needsReview,
				/* THE WINDOW IS THE ONE THAT WAS CURRENT WHEN IT WAS READ. The length is not
				   constant across an ESPN season — the playoff rounds are double — so a league
				   imported in August and looked at in October is tiling the wrong length. Said
				   rather than silently drifting, because the drift is invisible on screen. */
				...(window.days !== days ?
					[
						`This matchup runs ${window.days} days rather than your league's usual ` +
							`${days}. Read your league again when the round changes and the window ` +
							`will follow it.`
					]
				:	[])
			]
		}
	}
	needsReview.push(
		"ESPN states how long a period runs but not which weekday it starts on, so the board " +
			"assumes Monday and says so wherever it prints the week."
	)
	/*
	   AND THE PLAYOFF MATCHUPS ARE LONGER, which this stores one number for.
	
	   `scoring_period.days` is one length for the whole season, and ESPN states two:
	   `matchupPeriodLength` for the regular season and `playoffMatchupPeriodLength` for the
	   rounds at the end, which on the template is 2 — a fortnight. In September that is not a
	   detail: a reader in a two-week playoff round is shown a one-week window, so every figure
	   computed over it — what his men have scored, what his opponent's have, how many days are
	   left — is half of the matchup he is actually playing.
	
	   Working out WHICH matchup today falls in needs the calendar, and ESPN publishes the
	   scoring-period-to-date mapping on a different endpoint this import does not fetch. So the
	   number stays the regular-season one, which is right for about nine tenths of the season,
	   and the reader is told the one thing he can act on: that his playoff weeks are longer than
	   the window this is using.
	*/
	const playoff =
		typeof sched.playoffMatchupPeriodLength === "number" ? sched.playoffMatchupPeriodLength : null
	if (playoff !== null && playoff > length)
		needsReview.push(
			`Your league's playoff matchups run ${playoff * 7} days rather than ${days}. This uses ` +
				`the regular-season length all season, so during the playoffs the week it shows you ` +
				`is the first half of the matchup you are playing.`
		)
	return {
		period: {
			kind: "matchup",
			days,
			starts_on: null,
			anchor: null,
			lineup_lock: lock,
			/* PRINTED, under "Read from:" on My league — so it is written in a reader's words
			   and not in ESPN's field names, which he can see nowhere. The arithmetic is the
			   same one the code does, stated so he can check it against his own league page:
			   the units are WEEKS, settled by the payload itself, since the day counter in the
			   same response reads in the hundreds while these run to about 25. */
			/*
			   AND THE COUNT IS THE LEAGUE'S OWN, not the highest number in its schedule.
			
			   `units` is the largest value in `matchupPeriods`, which is what settles the UNIT
			   (weeks, not days) and is not the number of matchups: it counts the playoff rounds
			   too, so a league ESPN says plays 21 matchups was told it plays 25. The sentence is
			   printed under "Read from:" on My league, where a reader can compare it with his own
			   league page and find it wrong.
			*/
			source:
				`ESPN's own schedule for your league: each matchup runs ${length} ` +
				`week${length === 1 ? "" : "s"}, and there are ${stated ?? units} of them in the ` +
				`season, so a scoring period is ${days} days.`
		},
		needsReview
	}
}

/**
 * Reads the scoring period out of the verbatim settings map `importYahoo` harvests.
 *
 * Yahoo states the period nowhere and implies it in two places, so this reads both and
 * says which is which. "Weekly Deadline" is the LINEUP LOCK — when a day's starters
 * stop being editable — and not the period; the shipped league proves the two are
 * independent, since its deadline is "Daily - Today" while its matchups still run a
 * Monday-to-Sunday week. The period itself is evidenced only by "Playoffs", which
 * names Yahoo's numbered weeks and the weekday the last one ends on.
 *
 * Every value here is free text Yahoo can restyle at any time, so an unrecognized one
 * nulls its field and quotes itself into `needs_review` instead of being guessed at,
 * the rule `numericSetting` already follows for a non-numeric number.
 *
 * Exported so the shipped league's own `league_rules.raw_settings` can be run through
 * it in a test without a network call: those are the strings Yahoo actually printed,
 * and a fixture written here would only prove the fixture matches the parser.
 */
export const deriveScoringPeriod = (settings: Record<string, string>): DerivedPeriod => {
	const needsReview: string[] = []
	// Each entry names what it established as well as quoting itself, so a value that
	// turns out wrong can be traced to the line that produced it.
	const source: string[] = []
	let lockSource: string | null = null

	const deadline = settings["Weekly Deadline"]
	let lineupLock: "daily" | "period" | null = null
	if (deadline === undefined) {
		needsReview.push(
			'No "Weekly Deadline" row on the settings page, so lineup_lock is null: the ' +
				"board will treat the rest of the current period as still actionable."
		)
	} else if (/^daily\b/i.test(deadline)) {
		lineupLock = "daily"
		lockSource = `Weekly Deadline "${deadline}" is the lineup lock, not the period`
	} else if (WEEKDAY_NAMES.includes(deadline.trim().toLowerCase())) {
		// A weekday deadline is Yahoo's weekly lock: the lineup is set once for the
		// period, so the period a decision can still act on is the next one.
		lineupLock = "period"
		lockSource = `Weekly Deadline "${deadline}" locks the lineup for the whole period`
	} else {
		needsReview.push(
			`"Weekly Deadline" is "${deadline}", which is neither "Daily…" nor a weekday; ` +
				"lineup_lock is null."
		)
	}

	// A weekly grid alone does not make a matchup period: Yahoo runs numbered weeks
	// for acquisition limits in season-long leagues too, and scoring one of those over
	// a Monday-to-Sunday window would be a window nothing measured.
	const scoringType = settings["Scoring Type"]
	const headToHead = scoringType !== undefined && /head-to-head/i.test(scoringType)
	const playoffs = settings["Playoffs"]
	const weeks = playoffs !== undefined && /\bWeek\s*\d+/i.test(playoffs)
	const ends = playoffs?.match(
		/\bends\s+(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\b/i
	)

	let kind: "matchup" | "daily" | "none" | null = null
	let days: number | null = null
	let startsOn: (typeof WEEKDAY_CODES)[number] | null = null

	if (headToHead && weeks) {
		kind = "matchup"
		// The periods Yahoo names are "Week"s, which is also the only evidence for
		// their length; a seven-day week is what that word claims and nothing else on
		// the page states a number of days.
		days = 7
		if (ends) startsOn = dayAfter(ends[1]!)
		source.push(
			`Scoring Type "${scoringType}" with Playoffs "${playoffs}" names numbered ` +
				(startsOn ?
					`weeks ending ${ends![1]}, so a period opens the day after, on ${startsOn}`
				:	"weeks of seven days, with no weekday one ends on")
		)
		if (!startsOn)
			needsReview.push(
				`"Playoffs" is "${playoffs}": it names numbered weeks but no weekday one ` +
					"ends on, so starts_on is null and the board will assume a Monday start."
			)
	} else if (!headToHead) {
		needsReview.push(
			`Scoring Type is ${scoringType === undefined ? "absent" : `"${scoringType}"`}, ` +
				"which does not state head-to-head play, so no matchup period was derived; " +
				"scoring_period.kind is null and the board will rank a rolling window."
		)
	} else {
		needsReview.push(
			`"Playoffs" is ${playoffs === undefined ? "absent" : `"${playoffs}"`}, which ` +
				"names no numbered week, so no scoring period was derived; " +
				"scoring_period.kind is null and the board will rank a rolling window."
		)
	}

	return {
		period: {
			kind,
			days,
			starts_on: startsOn,
			// Yahoo's periods fall on a fixed weekday, so there is nothing to pin.
			anchor: null,
			lineup_lock: lineupLock,
			source:
				source.length || lockSource ?
					`league settings: ${[...source, ...(lockSource ? [lockSource] : [])].join("; ")}`
				:	null
		},
		needsReview
	}
}

const importYahoo = async (t: Extract<Target, { platform: "yahoo" }>): Promise<League> => {
	const base = `https://${t.yahooGame}.fantasysports.yahoo.com/b1/${t.leagueId}`
	const settingsUrl = `${base}/settings`
	const eligibilityUrl = `${base}/positioneligibility`
	const needsReview: string[] = []

	const settingsHtml = await fetchText(settingsUrl)
	if (!/Scoring\s*(&amp;|&)\s*Settings/i.test(settingsHtml)) {
		throw new ImportError(
			"Couldn't read that league's settings page. Only publicly-viewable Yahoo " +
				"leagues can be read without signing in."
		)
	}

	const batting: Record<string, number> = {}
	const pitching: Record<string, number> = {}
	const unmapped: { side: string; label: string; value: string }[] = []
	const settings: Record<string, string> = {}

	for (const rows of parseTables(settingsHtml)) {
		const header = (rows[0] ?? []).join(" ").toLowerCase()
		const side =
			header.includes("batters stat category") ? batting
			: header.includes("pitchers stat category") ? pitching
			: null

		if (side) {
			for (const row of rows.slice(1)) {
				const [label, raw] = row
				if (!label || raw === undefined) continue
				const code = STAT_CODE.exec(label)?.[1]
				const value = parseNumber(raw)
				if (code && value !== null) side[code] = value
				else if (label.trim())
					unmapped.push({
						side: side === batting ? "batting" : "pitching",
						label,
						value: raw
					})
			}
		} else if (rows[0]?.[0]?.trim().toLowerCase() === "setting") {
			for (const row of rows.slice(1)) {
				const [label, value] = row
				if (label && value !== undefined)
					settings[label.trim().replace(/:$/, "")] = value.trim()
			}
		}
	}

	if (!Object.keys(batting).length && !Object.keys(pitching).length) {
		throw new ImportError(
			"No points-scoring table on that league's settings page — it may be a " +
				"roto or categories league rather than head-to-head points."
		)
	}

	const rawRoster = settings["Roster Positions"] ?? ""
	const slotOrder = rawRoster
		.split(",")
		.map(s => s.trim())
		.filter(Boolean)
	const slots: Record<string, number> = {}
	for (const slot of slotOrder) slots[slot] = (slots[slot] ?? 0) + 1

	const slotAccepts = t.sport === "mlb" ? deriveSlotAccepts(slots) : null
	if (slotAccepts) {
		needsReview.push(
			// A needs_review line is read by the reader, on My league, next to his own
			// scoring. It has to say what he should check, in his words — not name a
			// field in a JSON schema.
			"Which positions can fill each seat was worked out from the seat names and " +
				"Yahoo's eligibility grid. Yahoo never says it outright, so check it if a " +
				"lineup looks wrong."
		)
	}

	let eligibility: League["eligibility"] = null
	try {
		const text = documentText(await fetchText(eligibilityUrl))
		const batters = text.match(
			/Batters need either (\d+) Games Started or (\d+) Games Played/
		)
		const pitchers = text.match(
			/Pitchers need (\d+) Starts to gain SP eligibility,\s*(\d+) Relief Appearances/
		)
		const header = text.match(/No Appearances Yet\s+((?:[A-Za-z0-9+]+\s+){2,14}?)Player\b/)
		if (batters || pitchers) {
			if (!header)
				needsReview.push(
					"Couldn't parse the eligibility grid header; tracked_positions is null."
				)
			eligibility = {
				source: eligibilityUrl,
				tracked_positions: header ? header[1]!.trim().split(/\s+/) : null,
				batters:
					batters ?
						{
							rule: "or",
							games_started_at_position: Number(batters[1]),
							games_played_at_position: Number(batters[2])
						}
					:	null,
				pitchers:
					pitchers ?
						{
							SP: { starts: Number(pitchers[1]) },
							RP: { relief_appearances: Number(pitchers[2]) }
						}
					:	null,
				grid_legend: {
					P: "games to play until eligible",
					S: "games to start until eligible",
					E: "currently eligible",
					"-": "no appearances yet"
				}
			}
		} else {
			needsReview.push(
				"Eligibility thresholds weren't found on the position-eligibility page."
			)
		}
	} catch (e) {
		needsReview.push(
			`Position-eligibility page unreadable (${(e as Error).message}); eligibility is null.`
		)
	}

	let teamName: string | null = null
	if (t.teamId) {
		try {
			const title = cellText(
				(await fetchText(`${base}/${t.teamId}`)).match(
					/<title>([\s\S]*?)<\/title>/i
				)?.[1] ?? ""
			)
			// "<league name> - <team name> | Fantasy Baseball | Yahoo! Sports"
			const afterLeague = title.split(" - ").slice(1).join(" - ")
			teamName = afterLeague.split(" | ")[0]?.trim() || null
			if (!teamName) needsReview.push("Couldn't parse the team name from the team page.")
		} catch (e) {
			needsReview.push(
				`Team page unreadable (${(e as Error).message}); team_name is null.`
			)
		}
	}

	const numericSetting = (label: string): number | null => {
		const raw = settings[label]
		if (raw === undefined) return null
		const n = parseNumber(raw)
		if (n === null)
			needsReview.push(`"${label}" is "${raw}", not a number; stored as null.`)
		return n
	}


	const { period, needsReview: periodReview } = deriveScoringPeriod(settings)
	needsReview.push(...periodReview)

	const scoring: League["scoring"] = { unit: "points", batting, pitching }
	if (unmapped.length) {
		scoring.unmapped = unmapped
		needsReview.push(
			`${unmapped.length} scoring row(s) had no (CODE) in the label; kept verbatim under scoring.unmapped.`
		)
	}

	return {
		meta: {
			platform: "yahoo",
			sport: t.sport,
			league_id: t.leagueId,
			league_name: settings["League Name"] ?? null,
			league_url: base,
			team_id: t.teamId,
			team_name: teamName,
			season: null,
			scoring_type: settings["Scoring Type"] ?? null,
			max_teams: numericSetting("Max Teams"),
			publicly_viewable: settings["Make League Publicly Viewable"] === "Yes"
		},
		scoring,
		roster: {
			raw: rawRoster || null,
			slots,
			slot_order: slotOrder.length ? slotOrder : null,
			/* `rosterCounts`, the same call the pasted route and the editor make. `total`
			   stays the printed order's length: a settings page that listed 27 seats listed
			   27, and disagreeing with it would mean the parse was wrong rather than the
			   page. */
			counts: slotOrder.length ? { ...rosterCounts(slots), total: slotOrder.length } : null,
			slot_accepts: slotAccepts
		},
		eligibility,
		scoring_period: period,
		// Verbatim label/value pairs exactly as the settings page prints them.
		league_rules: { raw_settings: settings },
		provenance: {
			fetched_at: today(),
			sources: [settingsUrl, eligibilityUrl, ...(t.teamId ? [`${base}/${t.teamId}`] : [])],
			method: "raw HTML fetch + table parse",
			verified: true
		},
		needs_review: needsReview
	}
}

const importEspn = async (t: Extract<Target, { platform: "espn" }>): Promise<League> => {
	/* ASKED, NOT ASSUMED. `new Date().getFullYear()` agrees with ESPN from April to December
	   and disagrees for exactly the months somebody sets a league up in — see `espnSeason`. */
	const asked = t.season ? null : await espnSeason(fetch, agentHeaders(USER_AGENT))
	const season = t.season ?? asked!.season
	/* TWO VIEWS, ONE REQUEST. `mTeam` costs nothing beside `mSettings` and carries the
	   league's teams — which is where this league's own NAME for the reader's team lives, and
	   the join that answers "which of these is mine". Yahoo pays a whole extra page fetch for
	   the same fact. */
	const url =
		`https://lm-api-reads.fantasy.espn.com/apis/v3/games/${t.sport}` +
		`/seasons/${season}/segments/0/leagues/${t.leagueId}?view=mSettings&view=mTeam&view=mStatus&view=mMatchupScore`

	/*
	   THE SEASON JUST GONE, AND THEN THE RIGHT SENTENCE FOR EACH WAY THIS FAILS.
	
	   This threw one sentence at every non-200: "Private leagues need cookies; only
	   publicly-viewable leagues can be imported." For a 404 that is a lie with a dead end in
	   it — a PUBLIC league returns 404 for a season it never played, which is the single most
	   likely failure a reader hits between seasons, and he was told his league was private and
	   left there. The roster reader in src/data/rosters.ts has branched these correctly for
	   months, including the retry; the importer never learned it.
	*/
	const get = (yr: number) =>
		fetch(url.replace(/seasons\/\d+/, `seasons/${yr}`), { headers: agentHeaders(USER_AGENT) })
	let res = await get(season)
	/*
	   AND THE YEAR THIS ACTUALLY READ, which is not always the year it asked for.
	
	   The retry exists because a public league 404s for a season it never played, and between
	   seasons that is the ordinary case. What was recorded afterwards was the year it PLANNED
	   to read: an import that fell back to 2021 came back stamped 2026, with a `sources` URL
	   that 404s, and `meta.season` is what every later read is made with — the free-agent pool,
	   the actuals, the roster. So the league said one year and every request about it asked for
	   another, and nothing on any screen mentioned it.
	*/
	let read = season
	if (res.status === 404) {
		res = await get(season - 1)
		if (res.ok) read = season - 1
	}
	if (!res.ok) {
		throw new ImportError(
			res.status === 401 || res.status === 403 ?
				`ESPN returned HTTP ${res.status} for league ${t.leagueId}: that league is not ` +
					`publicly viewable, and reading a private one would need your ESPN cookies.`
			: res.status === 404 ?
				`ESPN has no league ${t.leagueId} in ${season} or ${season - 1}. Check the id in ` +
					`your league's own URL — it is the number after leagueId=.`
			:	`ESPN returned HTTP ${res.status} for league ${t.leagueId}.`
		)
	}
	const data = (await res.json()) as Record<string, any>
	const settings = data.settings ?? {}
	const scoringSettings = settings.scoringSettings ?? {}
	/*
	   A CATEGORIES LEAGUE IS NOT A POINTS LEAGUE, AND THIS USED TO IMPORT ONE AS THE OTHER.
	
	   ESPN's category leagues carry a `scoringItems` array exactly like a points league's,
	   with `points: 1.0` in every entry — meaning "this category counts", not "a home run is
	   worth one point". Six of the eleven default ids are ones this app's stat map can name,
	   so six of them landed in the scoring table as 1.0 apiece and the import reported a
	   league whose scoring had been read. Everything downstream is a number of points computed
	   from that table: a board built on it ranks a single against a home run as equals.
	
	   The Yahoo path has refused this since the beginning — a settings page with no points
	   table throws, naming roto and categories as the likely reason. See `espnPointsFormat`.
	*/
	const format = espnPointsFormat(settings)
	if (!format.ok) throw new ImportError(format.why!)
	const lineupSlotCounts: Record<string, number> = settings.rosterSettings?.lineupSlotCounts ?? {}

	// ESPN identifies stats and lineup slots by numeric id. We keep them raw
	// rather than guessing what each id means — a mislabeled stat would silently
	// corrupt every lineup decision downstream.
	const { batting: espnBatting, pitching: espnPitching, unmapped: items } =
		mapEspnScoring((scoringSettings.scoringItems ?? []) as Record<string, unknown>[])
	const mappedCount = Object.keys(espnBatting).length + Object.keys(espnPitching).length

	/**
	 * ESPN names a seat by a numeric `lineupSlotId`, so `roster.slots` read
	 * `{"0":1,"1":1,"5":5,…}` — a shape no replacement level can be computed from,
	 * which is the other half of why an imported ESPN league could not rank.
	 *
	 * `ESPN_MLB_SLOT` in src/data/rosters.ts already carries the baseball table, and
	 * it was DERIVED rather than copied: every slot's usage count matches
	 * `settings.rosterSettings.lineupSlotCounts` exactly and every occupant's
	 * `defaultPositionId` agrees with the position the id claims. It is reused here
	 * rather than restated, so the roster reader and the importer cannot drift.
	 *
	 * An id the table does not name keeps its number and is reported, because a seat
	 * invented here would seat players in a slot the league does not have.
	 */
	const namedSlots: Record<string, number> = {}
	const unnamedSlots: string[] = []
	for (const [id, n] of Object.entries(lineupSlotCounts)) {
		if (Number(n) <= 0) continue
		const name = ESPN_MLB_SLOT[Number(id)]
		if (name) namedSlots[name] = (namedSlots[name] ?? 0) + Number(n)
		else {
			namedSlots[id] = Number(n)
			unnamedSlots.push(id)
		}
	}
	const slots = namedSlots
	/* One entry per seat, ascending by ESPN's slot id — `Object.entries` on a parsed object
	   already iterates integer keys in ascending numeric order, so this is ESPN's own order
	   rather than the order the bytes happened to arrive in. */
	const slotOrder: string[] = []
	for (const [id, n] of Object.entries(lineupSlotCounts)
		.map(([id, n]) => [Number(id), Number(n)] as const)
		.sort((a, b) => a[0] - b[0])) {
		if (n <= 0) continue
		const name = ESPN_MLB_SLOT[id] ?? String(id)
		for (let k = 0; k < n; k++) slotOrder.push(name)
	}

	/* The season's opening day, which is ESPN's scoring period 1 — see `openingDayOf`. One
	   small request to the schedule this app already reads, and null when it cannot be had,
	   which makes the period fall back to what it was before rather than to a calendar nobody
	   checked. */
	const openingDay = await openingDayOf(read)
	const { period: espnPeriod, needsReview: periodReview } = deriveEspnPeriod(
		settings,
		data.status,
		data.schedule,
		openingDay
	)
	/* A points league does not carry an innings floor and ESPN's nearest field is a
	   category-format qualification total in OUTS — see `espnInningsMinimum`, which converts
	   and names it rather than returning it as a weekly floor. Almost always silent here;
	   reported when it is not, because a number this app declined to use is a thing the
	   reader is entitled to know about. */
	const inningsNote = espnInningsMinimum(settings).note

	return {
		meta: {
			platform: "espn",
			sport: t.sport,
			league_id: t.leagueId,
			league_name: settings.name ?? null,
			league_url: `https://fantasy.espn.com/baseball/league?leagueId=${t.leagueId}`,
			team_id: t.teamId,
			/* HIS LEAGUE'S OWN NAME FOR HIS TEAM, off the `mTeam` view that now rides along with
			   the settings request. It was null because nothing asked; Yahoo pays a whole extra
			   page fetch for the same fact. Null still, when the URL carried no team number or
			   when ESPN's list does not contain it — a team name guessed at is a stranger's. */
			team_name:
				(t.teamId &&
					(data.teams as any[] | undefined)?.find(x => String(x?.id) === String(t.teamId))
						?.name) ||
				null,
			/* The year READ, not the year asked for — see the retry above. */
			season: read,
			scoring_type: scoringSettings.scoringType ?? null,
			/* ESPN states this about itself, and the app has a field for it that only the Yahoo
			   side ever set. It is the difference between "we could not read your league" and
			   "your league is private", which is the whole of what a reader can act on. */
			...(typeof settings.isPublic === "boolean" ? { publicly_viewable: settings.isPublic } : {}),
			max_teams: settings.size ?? null
		},
		scoring_period: espnPeriod,
		scoring: {
			unit: "points",
			batting: espnBatting,
			pitching: espnPitching,
			...(items.length ? { unmapped: items } : {})
		},
		roster: {
			raw: null,
			slots,
			/*
			   THE SEATS, IN THE ORDER ESPN LISTS THEM, AND THE COUNTS THAT FOLLOW FROM THEM.
			
			   Both were null, and both were derivable from the payload already in hand with no
			   second request. `slot_order` is one entry per seat in ascending lineup-slot-id
			   order, which is ESPN's own canonical order — C, 1B, 2B, 3B, SS, OF… — rather than
			   a printed order this has ever seen on a page, and the difference is worth naming:
			   Yahoo's comes off the settings page as the reader sees it, this one comes off the
			   ids. What the two have in common is the only thing anything downstream reads it
			   for, which is how many seats there are and what may sit in them.
			
			   A seat ESPN names only by a number keeps its number here too, and is reported
			   below — the same rule the slot map itself follows.
			*/
			slot_order: slotOrder.length ? slotOrder : null,
			counts: slotOrder.length ? { ...rosterCounts(slots), total: slotOrder.length } : null,
			/*
			   WHICH MEN MAY SIT WHERE, from the seat names ESPN already published.
			
			   Null here meant "there is nothing to derive from", and that was false:
			   `deriveSlotAccepts` takes slot NAMES, and `ESPN_MLB_SLOT` has been turning ESPN's
			   numeric ids into exactly those names for months. The board's replacement bar is
			   computed per seat, so a league with no seat rules is a league in which every man is
			   priced against the wrong bar. It is the same function the Yahoo side uses, so the
			   two routes cannot disagree about what a Util seat takes.
			*/
			slot_accepts: deriveSlotAccepts(slots)
		},
		/* ESPN states each man's own eligibility in `gamesPlayedByPosition`, on a player read
		   this import does not make. Null is the truth, and the board falls back to each man's
		   primary position exactly as it does for any league that states none. */
		eligibility: null,
		league_rules: { raw_settings: settings },
		provenance: {
			fetched_at: today(),
			sources: [url.replace(/seasons\/\d+/, `seasons/${read}`)],
			method: "ESPN v3 mSettings API",
			verified: false
		},
		needs_review: [
			...(read !== season ?
				[
					`ESPN has no ${season} season for this league, so its ${read} season was read ` +
						`instead. Everything below is that year's.`
				]
			:	[]),
			...(inningsNote ? [inningsNote] : []),
			...(t.teamId ? []
			:	[
					"The URL didn't carry `teamId=`, so which of these teams is yours is not " +
						"known and team_id is null. Reading your roster asks for the number rather " +
						"than assuming one."
				]),
			...periodReview,
			`${mappedCount} of ${mappedCount + items.length} scoring stats were read off ` +
				`ESPN's numeric stat ids, using a map derived by joining a public league's own ` +
				`season splits to MLB StatsAPI. Check the point values against your league's ` +
				`settings page before trusting a ranking built on them.`,
			...(items.length ?
				[
					/* `needs_review` renders on My league, so these three lines are read by
					   somebody who has never seen this repo. They named `scoring.unmapped`,
					   `roster.slots` and "endpoint" — a schema field, a second schema field and a
					   word about the software. The facts are unchanged; what goes is the
					   vocabulary, and with it the implication that the reader can go and look at
					   something called `scoring.unmapped`. */
					`${items.length} scoring stat(s) your league pays for are ones ESPN names only ` +
						`by a number, or that pay differently by position, which this app cannot ` +
						`express. They are kept exactly as they arrived and score nothing \u2014 ` +
						`nothing about them is guessed at. Enter those by hand below if they matter.`
				]
			:	[]),
			...(unnamedSlots.length ?
				[
					`Your league has ${unnamedSlots.length} roster seat(s) ESPN names only by a ` +
						`number (${unnamedSlots.join(", ")}), so this app does not know which ` +
						`positions they take. They are kept, and nobody is priced against them \u2014 ` +
						`name them below and they start counting.`
				]
			:	[]),
			"ESPN does not publish what it takes to qualify at a position, so nothing here " +
				"assumes it. Where a man plays comes from the player data instead."
		]
	}
}

export const importLeague = async (url: string): Promise<{ key: string; league: League }> => {
	const target = detect(url)
	const league =
		target.platform === "yahoo" ? await importYahoo(target) : await importEspn(target)
	return { key: `${target.platform}:${target.leagueId}`, league }
}

/**
 * How many players the league lets a team add in one scoring period.
 *
 * Yahoo prints this on the settings page as "Max Acquisitions per Week", and
 * `importYahoo` already harvests every row of that page verbatim, so for a Yahoo
 * league the number has been sitting in `league_rules.raw_settings` all along
 * while the board asked the reader to type it. Derived here rather than stored as
 * a new field so it applies to leagues captured before this existed, including
 * the shipped one.
 *
 * What this is NOT is how many moves he has LEFT. The cap is a league rule and is
 * printed; the count he has spent this week is on his team page, which none of
 * these readers open. So this seeds the control and he adjusts it — a better
 * starting point than zero, and still his number.
 *
 * "No maximum" is a real and common answer, and it returns null rather than some
 * large stand-in: unlimited is not 26. Only the per-WEEK row is read. A league can
 * cap the season and not the week, and reading a season cap as a weekly budget
 * would tell a reader in April he may make 40 moves before Sunday.
 */
export const deriveMoveLimit = (
	settings: Record<string, string>
): { perPeriod: number | null; source: string | null } => {
	const row = settings["Max Acquisitions per Week"]
	if (row === undefined) return { perPeriod: null, source: null }
	const n = Number(row.trim())
	if (!Number.isInteger(n) || n < 0) {
		// "No maximum", or anything else Yahoo decides to print
		return { perPeriod: null, source: `Max Acquisitions per Week "${row}"` }
	}
	return { perPeriod: n, source: `Max Acquisitions per Week "${row}"` }
}

/**
 * The innings a league requires of a team in one scoring period, where it sets one.
 *
 * Yahoo prints this as "Min innings pitched per team per week" and it is the reason
 * a lot of streaming happens at all: fall short and the pitching side of the matchup
 * is forfeited or zeroed depending on the league. It is a per-period league rule, so
 * it belongs next to the per-period move budget, read the same way from the settings
 * rows the import already harvested.
 *
 * Only the number is read. How many innings his staff has already thrown this week
 * is on his team page, which no reader here opens, so nothing here says how far
 * short he is — see `deriveMoveLimit` for the same boundary.
 */
export const deriveInningsMinimum = (
	settings: Record<string, string>
): { perPeriod: number | null; source: string | null } => {
	const row = settings["Min innings pitched per team per week"]
	if (row === undefined) return { perPeriod: null, source: null }
	const n = Number(row.trim())
	const quoted = `Min innings pitched per team per week "${row}"`
	// a league that sets no floor prints "No minimum", and 0 is that same answer
	if (!Number.isFinite(n) || n <= 0) return { perPeriod: null, source: quoted }
	return { perPeriod: n, source: quoted }
}

/**
 * THE TWO PER-PERIOD RULES A PLAN CAN BREAK, read off one league in one call.
 *
 * `deriveMoveLimit` and `deriveInningsMinimum` both take the settings rows rather than
 * the league, because that is the shape a fetch and a paste both produce. Every caller
 * therefore has to reach through `league_rules.raw_settings` and cast it, and there were
 * three such reaches before this existed — Board.tsx, Decide.tsx, and the planner had
 * none at all and used its own defaults.
 *
 * WHY THIS IS SUDDENLY WORTH HAVING. Until the browser reader landed, these two rows
 * were real only for the handful of leagues somebody had fetched or pasted; a typical
 * reader had no settings page in the app at all, so a planner reading them would have
 * read nothing. A reader now hands over his settings page in the same press that brings
 * his roster, so for every reader who connects, both numbers are his league's own. On
 * league 228947 they are "Max Acquisitions per Week: 6" and "Min innings pitched per
 * team per week: 20".
 *
 * Both stay null where the page did not say, and null means UNLIMITED for the cap and NO
 * FLOOR for the innings — not zero, and not some large stand-in. A planner handed null
 * must fall back to its own measured default rather than to a number nobody stated;
 * `movesAllowed` in src/auto/plan.ts is where that is decided and where the argument is.
 *
 * `sources` quotes the rows the numbers came from, in the settings page's own words, so
 * a screen can say where a limit came from instead of asserting it.
 */
export const leagueLimits = (
	league: Pick<League, "league_rules"> & {
		/* Optional so a caller with nothing but a settings map — which is every test of this
		   and was every caller before ESPN — still gets the Yahoo reading it always got. */
		meta?: { platform?: string | null } | null
		scoring_period?: { days?: number | null } | null
	}
): {
	movesPerPeriod: number | null
	inningsPerPeriod: number | null
	sources: string[]
	/** Caveats a screen must print BESIDE a number, rather than instead of it — a per-day cap
	 *  summed into a weekly budget is the case this exists for. Empty on the Yahoo side, where
	 *  the page states the rule in the unit the app uses. */
	notes: string[]
} => {
	const rules = (league.league_rules as { raw_settings?: unknown } | undefined)?.raw_settings
	/*
	   AN ESPN LEAGUE STATES BOTH OF THESE AND WAS ANSWERING NEITHER.
	
	   This reached into `raw_settings` and looked up Yahoo's printed row labels — "Max
	   Acquisitions per Week", "Min innings pitched per team per week". An ESPN league's
	   `raw_settings` is ESPN's own nested JSON, so both lookups missed, both numbers came back
	   null, and null means UNLIMITED to the planner: every ESPN reader was planned against the
	   app's generic default while the screen beside it promised his league's own rule. Same
	   shape as the trade deadline, one field over — see `leagueTradeDeadline`.
	*/
	if (league.meta?.platform === "espn" && rules && typeof rules === "object") {
		const settings = rules as Record<string, any>
		const moves = espnMoveLimit(settings, league.scoring_period?.days ?? null)
		const innings = espnInningsMinimum(settings)
		return {
			movesPerPeriod: moves.perPeriod,
			inningsPerPeriod: innings.perPeriod,
			sources: [moves.source, innings.source].filter((s): s is string => s !== null),
			/* The MOVE caveat only. It qualifies a number the planner acts on — six a week that
			   are one a day cannot all be made on Saturday — so it has to travel with the number.
			   `espnInningsMinimum`'s note is about a field a points league does not carry, and it
			   is reported once at import time in `needs_review` rather than on every plan. */
			notes: [moves.note].filter((n): n is string => n !== null)
		}
	}
	const raw = (rules ?? {}) as Record<string, string>
	const moves = deriveMoveLimit(raw)
	const innings = deriveInningsMinimum(raw)
	return {
		movesPerPeriod: moves.perPeriod,
		inningsPerPeriod: innings.perPeriod,
		sources: [moves.source, innings.source].filter((s): s is string => s !== null),
		notes: []
	}
}

/**
 * The date after which this league takes no more trades.
 *
 * Yahoo prints it as "Trade End Date" and the import already harvests the row. The
 * app ships a 1,132-line trade evaluator and has never read it, so on 2026-09-08 it
 * was still offering to price deals for a league whose trade window shut on
 * 2026-08-06 — a whole surface answering a question the reader is no longer allowed
 * to ask.
 *
 * Returned as an ISO date so a caller can compare it to today without re-parsing
 * prose. Yahoo writes it as "August 6, 2026", which `Date.parse` handles; anything
 * it does not parse to a real date returns null and quotes itself, because a
 * deadline guessed wrong either hides a working feature or leaves a dead one up.
 */
export const deriveTradeDeadline = (
	settings: Record<string, string>
): { date: string | null; source: string | null } => {
	const row = settings["Trade End Date"]
	if (row === undefined) return { date: null, source: null }
	const quoted = `Trade End Date "${row}"`
	const t = Date.parse(row.trim())
	if (!Number.isFinite(t)) return { date: null, source: quoted }
	return { date: new Date(t).toISOString().slice(0, 10), source: quoted }
}

/**
 * THE SAME DEADLINE, FOR WHATEVER PLATFORM THE LEAGUE CAME FROM.
 *
 * `deriveTradeDeadline` above reads Yahoo's settings ROW — a label and a printed date, which
 * is the shape a Yahoo fetch and a Yahoo paste both produce. An ESPN league's `raw_settings`
 * is not that shape at all: it is ESPN's own nested JSON, where the deadline is an epoch in
 * milliseconds under `tradeSettings.deadlineDate`. Handed to the row reader it looks up a key
 * that is not there and answers "no deadline stated", which is how an ESPN league whose window
 * shut in August was still being offered trades in September — the exact bug the Yahoo reader
 * was written to fix, reappearing one platform over.
 *
 * Dispatching on `meta.platform` rather than sniffing the shape, because the two shapes are
 * distinguishable today and might not be tomorrow, and a league already knows who it is.
 */
export const leagueTradeDeadline = (
	league:
		| (Pick<League, "league_rules"> & { meta?: { platform?: string | null } | null })
		| null
		| undefined
): { date: string | null; source: string | null; at?: number | null } => {
	const raw = (league?.league_rules as { raw_settings?: unknown } | undefined)?.raw_settings
	if (!raw || typeof raw !== "object") return { date: null, source: null, at: null }
	if (league?.meta?.platform === "espn") return espnTradeDeadline(raw as Record<string, any>)
	/* Yahoo prints a DATE and no hour, so there is no instant to carry and none is invented:
	   a league that stated a day is closed at the end of that day, which is what
	   `tradeWindow` does with it. */
	return deriveTradeDeadline(raw as Record<string, string>)
}

/**
 * WHETHER THIS LEAGUE STILL TAKES TRADES, right now.
 *
 * Lives here rather than on the screen that asks, because it is a fact about the league's
 * rules and because a rule in a .tsx file cannot be tested by the node suites — which is how
 * the hour below went unasserted in the first place.
 *
 * A DEADLINE IS A MOMENT AND A DATE IS A DAY. ESPN states an instant, usually noon Eastern;
 * comparing days alone kept the trade screens up for the rest of that day, offering to price
 * deals the league had already stopped taking. Where a league stated only a day — which is
 * every Yahoo league, because Yahoo prints "August 6, 2026" and no hour — it is open for the
 * whole of that day, which is the most that can be claimed from what it said.
 */
export const tradeWindow = (
	league:
		| (Pick<League, "league_rules"> & { meta?: { platform?: string | null } | null })
		| null
		| undefined,
	today: string,
	now: number = Date.now()
): { closed: boolean; on: string | null } => {
	const stated = leagueTradeDeadline(league)
	if (stated.at) return { closed: now > stated.at, on: stated.date }
	return { closed: !!stated.date && today > stated.date, on: stated.date }
}
