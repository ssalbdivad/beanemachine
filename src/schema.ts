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
