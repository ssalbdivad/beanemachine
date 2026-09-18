import { type } from "arktype"

/**
 * Runtime contract for scoring.json.
 *
 * The whole point of this file is that a league config is only ever as good as
 * its provenance: a value that was never read from a real league must stay
 * `null` and be named in `needs_review`, never quietly defaulted. The schema
 * therefore makes "absent" representable everywhere rather than optional-away.
 */

export const StatTable = type({ "[string]": "number" })

export const Scoring = type({
	unit: "'points'",
	batting: StatTable,
	pitching: StatTable,
	/** Platform values we could not confidently map onto a canonical stat key. */
	"unmapped?": "unknown",
	"notes?": "string[]"
})

/** Which player-eligibility positions may fill a roster slot. */
export const SlotAccepts = type("string[] | 'any' | 'injured_only'")

export const RosterCounts = type({
	active: "number",
	bench: "number",
	injured_list: "number",
	total: "number"
})

export const Roster = type({
	raw: "string | null",
	slots: { "[string]": "number" },
	slot_order: "string[] | null",
	counts: RosterCounts.or("null"),
	slot_accepts: type({ "[string]": SlotAccepts }).or("null")
})

export const Eligibility = type({
	source: "string",
	tracked_positions: "string[] | null",
	batters: type({
		rule: "'or' | 'and'",
		games_started_at_position: "number",
		games_played_at_position: "number"
	}).or("null"),
	/** e.g. `{ SP: { starts: 3 }, RP: { relief_appearances: 5 } }` */
	pitchers: type({ "[string]": { "[string]": "number" } }).or("null"),
	"grid_legend?": { "[string]": "string" }
}).or("null")

/**
 * How the league carves the season into the periods a matchup is scored over.
 *
 * Two independent facts, not one. The PERIOD decides where a streaming window ends;
 * the LOCK decides which period you can still act on. The shipped league is proof
 * they do not follow from each other: it runs Monday-to-Sunday matchups AND lets you
 * change your lineup every day.
 *
 * Optional, and every inner field nullable, for two load-bearing reasons found by
 * reading the callers: `test/leagues.mjs` and `src/client/leagues.ts` both validate
 * the platform TEMPLATES against this same `League` schema, so a required key would
 * make "new league" throw; and `src/client/leagues.ts` re-validates every stored
 * config on read, so a required key would brick the browser store of anyone who has
 * saved a league. Null means "not known", never "no period" — `kind: "none"` is how
 * a league says it genuinely has no week.
 */
export const ScoringPeriod = type({
	/** `matchup` is a multi-day period; `daily` scores each day on its own; `none` is
	 *  roto or season-long points, where a rolling window is the honest answer. */
	kind: "'matchup' | 'daily' | 'none' | null",
	/** Length of a matchup period in days. Null when unknown. */
	days: "number | null",
	/** Weekday the period opens on, lowercase three-letter. Null when unknown. */
	starts_on: "'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun' | null",
	/** An ISO date known to be the first day of some period, for leagues whose grid
	 *  does not fall on a fixed weekday. Null for the ordinary weekday case. */
	anchor: "string | null",
	/** `daily` means lineups can be changed every day, so the remainder of the
	 *  current period is actionable. `period` means the lineup is locked for the
	 *  period, so the next one is what a streaming decision is really about. */
	lineup_lock: "'daily' | 'period' | null",
	/**
	 * WHICH DAY'S LINEUP IS STILL OPEN, where a daily league said.
	 *
	 * `lineup_lock` says how OFTEN a lineup can be changed. This says which day the change
	 * he makes right now applies to. Yahoo prints it in the same row — "Daily - Today" —
	 * and the parser tested `/^daily\b/i` and threw the qualifier away, so a league whose
	 * daily deadline is the NEXT day's lineup got tonight's card: advice for a lineup that
	 * locked yesterday, printed with no hedge.
	 *
	 * Null is NOT "today". It means the page did not say, or said something this has never
	 * seen, and the card then plans tonight and says which night it is planning.
	 *
	 * Optional so every league already stored reads unchanged — `leagues.ts` re-validates
	 * each one on read, and a required key would discard them all.
	 */
	"locks?": "'today' | 'tomorrow' | null",
	/**
	 * THE LAST DAY THIS LEAGUE SCORES, as an ISO date, where its own page says so.
	 *
	 * Yahoo prints it inside the Playoffs row — "6 teams - Week 24, 25 and 26 (ends Sunday,
	 * Sep 27)" — and the app read that row only for the weekday, to work out which day a
	 * period opens on. So every screen that ranks "the rest of the season" ranked past the
	 * end of the reader's own season: on 2026-09-18 his league stops scoring in nine days and
	 * the Stash board was holding men for October.
	 *
	 * Optional and nullable, so a league stored before this reads exactly as it did.
	 */
	"ends_on?": "string | null",
	/**
	 * WHICH OF ITS OWN NUMBERED WEEKS THIS IS, where that is checkable.
	 *
	 * Yahoo numbers weeks and names which of them are the playoffs, so the last listed week
	 * plus the end date fix the whole grid by subtraction. Claimed ONLY where walking back
	 * from the stated end lands exactly on the resolved period's first day — inside the
	 * listed playoff weeks, that is one or two subtractions from a printed anchor; everywhere
	 * else it is null and no screen says a word.
	 */
	"week?": type({ number: "number | null", of: "number | null" }).or("null"),
	/** Where this came from, quoted, so a wrong value can be traced to its source
	 *  rather than argued about. */
	source: "string | null"
}).or("null")

export const Meta = type({
	platform: "'yahoo' | 'espn' | 'sleeper' | 'custom'",
	sport: "string | null",
	league_id: "string | null",
	league_name: "string | null",
	league_url: "string | null",
	team_id: "string | null",
	team_name: "string | null",
	season: "number | string | null",
	scoring_type: "string | null",
	max_teams: "number | null",
	"publicly_viewable?": "boolean"
})

export const Provenance = type({
	fetched_at: "string | null",
	sources: "string[]",
	method: "string",
	/** True only when every stored value was read from the league's own pages. */
	verified: "boolean"
})

export const League = type({
	meta: Meta,
	scoring: Scoring,
	roster: Roster,
	eligibility: Eligibility,
	"scoring_period?": ScoringPeriod,
	"league_rules?": "object",
	provenance: Provenance,
	needs_review: "string[]"
})

export const Config = type({
	schema_version: "string",
	description: "string",
	active_league: "string | null",
	stat_keys: {
		description: "string",
		batting: "string[]",
		pitching: "string[]"
	},
	leagues: { "[string]": League },
	platform_templates: { "[string]": "unknown" }
})

export type Config = typeof Config.infer
export type League = typeof League.infer
export type Meta = typeof Meta.infer
export type ScoringPeriod = typeof ScoringPeriod.infer
