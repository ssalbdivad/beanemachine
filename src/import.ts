import type { League } from "./schema.ts"
import { cellText, documentText, parseNumber, parseTables } from "./html.ts"

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

const IL_SLOTS = ["IL", "NA", "IL+"]

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

	// Yahoo expresses slot compatibility as the columns of its eligibility grid
	// rather than as prose, so we mirror the slot names it actually published.
	let slotAccepts: Record<string, string[] | "any" | "injured_only"> | null = null
	if (t.sport === "mlb" && slotOrder.length) {
		const batterPositions = ["C", "1B", "2B", "3B", "SS", "OF"].filter(p => p in slots)
		slotAccepts = Object.fromEntries(batterPositions.map(p => [p, [p]]))
		for (const p of ["SP", "RP"]) if (p in slots) slotAccepts[p] = [p]
		if ("Util" in slots) slotAccepts["Util"] = batterPositions
		if ("P" in slots) {
			const arms = ["SP", "RP"].filter(p => p in slots)
			slotAccepts["P"] = arms.length ? arms : ["SP", "RP"]
		}
		if ("BN" in slots) slotAccepts["BN"] = "any"
		for (const il of IL_SLOTS) if (il in slots) slotAccepts[il] = "injured_only"
		needsReview.push(
			"slot_accepts is derived from the roster slot names plus the columns of " +
				"Yahoo's position-eligibility grid; Yahoo does not state it as prose."
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

	const active = Object.entries(slots)
		.filter(([slot]) => slot !== "BN" && !IL_SLOTS.includes(slot))
		.reduce((sum, [, n]) => sum + n, 0)

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
			counts: slotOrder.length ?
				{
					active,
					bench: slots["BN"] ?? 0,
					injured_list: IL_SLOTS.reduce((sum, il) => sum + (slots[il] ?? 0), 0),
					total: slotOrder.length
				}
			:	null,
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
	const season = t.season ?? new Date().getFullYear()
	const url =
		`https://lm-api-reads.fantasy.espn.com/apis/v3/games/${t.sport}` +
		`/seasons/${season}/segments/0/leagues/${t.leagueId}?view=mSettings`

	const res = await fetch(url, { headers: agentHeaders(USER_AGENT) })
	if (!res.ok) {
		throw new ImportError(
			`ESPN returned HTTP ${res.status} for league ${t.leagueId}. Private leagues ` +
				"need cookies; only publicly-viewable leagues can be imported."
		)
	}
	const data = (await res.json()) as Record<string, any>
	const settings = data.settings ?? {}
	const scoringSettings = settings.scoringSettings ?? {}
	const lineupSlotCounts: Record<string, number> = settings.rosterSettings?.lineupSlotCounts ?? {}

	// ESPN identifies stats and lineup slots by numeric id. We keep them raw
	// rather than guessing what each id means — a mislabeled stat would silently
	// corrupt every lineup decision downstream.
	const items = (scoringSettings.scoringItems ?? []).map((item: Record<string, unknown>) => ({
		espn_stat_id: item.statId,
		points: item.points,
		points_overrides: item.pointsOverrides
	}))

	const slots = Object.fromEntries(
		Object.entries(lineupSlotCounts).filter(([, n]) => Number(n) > 0)
	) as Record<string, number>

	return {
		meta: {
			platform: "espn",
			sport: t.sport,
			league_id: t.leagueId,
			league_name: settings.name ?? null,
			league_url: `https://fantasy.espn.com/baseball/league?leagueId=${t.leagueId}`,
			team_id: t.teamId,
			team_name: null,
			season,
			scoring_type: scoringSettings.scoringType ?? null,
			max_teams: settings.size ?? null
		},
		scoring: { unit: "points", batting: {}, pitching: {}, unmapped: items },
		roster: {
			raw: null,
			slots,
			slot_order: null,
			counts: null,
			slot_accepts: null
		},
		eligibility: null,
		league_rules: { raw_settings: settings },
		provenance: {
			fetched_at: today(),
			sources: [url],
			method: "ESPN v3 mSettings API",
			verified: false
		},
		needs_review: [
			...(t.teamId ? []
			:	[
					"The URL didn't carry `teamId=`, so which of these teams is yours is not " +
						"known and team_id is null. Reading your roster asks for the number rather " +
						"than assuming one."
				]),
			"The scoring period was not read. ESPN may state it under " +
				"settings.scheduleSettings, but no fixture or test here has ever seen that " +
				"shape, so scoring_period is null and the board ranks a rolling window.",
			"ESPN stat ids and lineup-slot ids are numeric and kept raw under " +
				"scoring.unmapped and roster.slots. Map them to canonical stat keys before " +
				"optimizing — they are deliberately not guessed.",
			"This endpoint doesn't expose position-eligibility rules; eligibility is null."
		]
	}
}

export const importLeague = async (url: string): Promise<{ key: string; league: League }> => {
	const target = detect(url)
	const league =
		target.platform === "yahoo" ? await importYahoo(target) : await importEspn(target)
	return { key: `${target.platform}:${target.leagueId}`, league }
}
