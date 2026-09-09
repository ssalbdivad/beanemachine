/**
 * A whole league, out of a pasted settings page.
 *
 * The four things this app needs before it can rank anything are batting scoring,
 * pitching scoring, roster slots and a team count. On Yahoo all four are printed on
 * one page — `.../b1/<league>/settings` — and none of them can be fetched: Yahoo
 * sends no CORS headers to a browser and, measured 2026-09-09, answers a server with
 * "Request denied". So the page is readable by exactly one program in the world, the
 * reader's own signed-in browser, and the way to get it out of there is Ctrl-A.
 *
 * `src/import.ts` already reads this page when it can reach it, and the shape it
 * relies on survives a copy: Yahoo prints the stat tables under headers reading
 * "Batters Stat Category" and "Pitchers Stat Category", each row a label carrying a
 * `(CODE)` and a number. This file is that same convention applied to text rather
 * than to HTML, so the two cannot disagree about what a league is.
 *
 * Two shapes of paste are handled because both really happen. Copying a table
 * usually keeps a row on one line with tabs between cells; sometimes it flattens to
 * one CELL per line. A label with a code and no number on its line therefore looks
 * ahead to the next line for one.
 *
 * Nothing is invented. A page that carries no stat table yields no scoring and says
 * so in `missing`, and the caller offers a template rather than filling it in.
 */

/** Yahoo writes the stat's own code in parentheses: "Home Runs (HR)". That code is
 *  what the engine scores by, and it is why this is parseable at all. */
const STAT_CODE = /\(([A-Za-z0-9/+-]{1,6})\)/

/** Rows that carry a code but are not a scoring line. */
const NOT_A_STAT = new Set(["IP", "GS", "G"])

export interface PastedLeague {
	batting: Record<string, number>
	pitching: Record<string, number>
	/** Seat counts, e.g. `{ C: 1, OF: 3, BN: 5 }`. Null where the page did not list
	 *  its roster positions. */
	slots: Record<string, number> | null
	/** The same seats in the order Yahoo printed them, which is the order a lineup
	 *  is set in and is not recoverable from the counts. */
	slotOrder: string[] | null
	maxTeams: number | null
	/** Every `Label: value` row, verbatim — the same map `src/import.ts` harvests,
	 *  so `deriveScoringPeriod`, `deriveMoveLimit` and `deriveInningsMinimum` all
	 *  work on a pasted page exactly as they do on a fetched one. */
	settings: Record<string, string>
	/** What this page did not carry, named so the caller can ask for it rather than
	 *  guess. */
	missing: string[]
}

const cells = (line: string): string[] =>
	line
		.split(/\t+|\s{2,}/)
		.map(c => c.trim())
		.filter(Boolean)

const asNumber = (s: string | undefined): number | null => {
	if (s === undefined) return null
	// Yahoo writes negatives as "-1" and some tables use a minus sign
	const n = Number(s.replace(/[−–—]/g, "-").replace(/[^0-9.+-]/g, ""))
	return Number.isFinite(n) && /\d/.test(s) ? n : null
}

export const leagueFromSettingsText = (text: string): PastedLeague => {
	const lines = text
		.split(/\r?\n/)
		.map(l => l.trim())
		.filter(Boolean)

	const batting: Record<string, number> = {}
	const pitching: Record<string, number> = {}
	const settings: Record<string, string> = {}
	let side: Record<string, number> | null = null

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!
		const low = line.toLowerCase()

		// The headers Yahoo prints above each stat table. They survive a copy, and
		// they are the only thing that says which side of the ball a row belongs to —
		// "K" is a strikeout for a batter and for a pitcher, and they score
		// differently and usually with opposite signs.
		if (low.includes("batters stat category")) {
			side = batting
			continue
		}
		if (low.includes("pitchers stat category")) {
			side = pitching
			continue
		}

		const parts = cells(line)
		const label = parts[0] ?? ""
		const code = STAT_CODE.exec(label)?.[1]?.toUpperCase()

		if (side && code && !NOT_A_STAT.has(code)) {
			// same line, or the next one when the copy flattened the table
			const value = asNumber(parts[1]) ?? asNumber(lines[i + 1])
			if (value !== null) {
				side[code] = value
				if (parts.length < 2) i++
				continue
			}
		}

		// A two-cell row carrying no stat code is where the stat table ended. Without
		// this, `side` stayed set for the rest of the document and any later row that
		// happened to carry a short parenthesised code would have been scored as a
		// pitching stat. A one-cell line does NOT reset it, because that is exactly
		// what a flattened stat row looks like.
		if (side && parts.length >= 2) side = null

		// A settings row: "Max Teams   10". Same map src/import.ts harvests, and the
		// same two signals it uses to find one — a two-column table whose header row
		// reads "Setting". EXACTLY two cells, because everything else on the page with
		// a tab in it is navigation ("Scores  Standings  Players  Draft") and would
		// otherwise land in the league's rules as a setting nobody set.
		if (parts.length === 2 && label.toLowerCase() !== "setting") {
			const key = label.replace(/:$/, "")
			if (key && !(key in settings)) settings[key] = parts[1]!
		}
	}

	const maxTeams = asNumber(settings["Max Teams"])
	const positions = settings["Roster Positions"]
	let slots: Record<string, number> | null = null
	let slotOrder: string[] | null = null
	if (positions) {
		const order = positions
			.split(",")
			.map(s => s.trim())
			.filter(Boolean)
		if (order.length) {
			slotOrder = order
			slots = {}
			for (const s of order) slots[s] = (slots[s] ?? 0) + 1
		}
	}

	const missing: string[] = []
	if (!Object.keys(batting).length) missing.push("batting scoring")
	if (!Object.keys(pitching).length) missing.push("pitching scoring")
	if (!slots) missing.push("roster positions")
	if (maxTeams === null) missing.push("team count")

	return { batting, pitching, slots, slotOrder, maxTeams, settings, missing }
}

/**
 * The same page, as a league this app can rank with.
 *
 * `leagueFromSettingsText` above only reads; this assembles, and it deliberately
 * shares the derivations with `src/import.ts` rather than re-deriving them —
 * `deriveScoringPeriod` for the matchup grid and lineup lock, `deriveSlotAccepts`
 * for which men may fill which seat. A league that arrived by paste and the same
 * league fetched over HTTP must seat the same lineup, and the only way to be sure
 * of that is for one function to decide it.
 *
 * `verified` is false, and that is not pedantry. Importing a league means this app
 * fetched the page and can point at the URL it read; a paste is text a person
 * handed over, and nothing here can tell a real settings page from an invented
 * one. The values are almost certainly right — they came off the reader's own
 * screen — but the app cannot attest to it, so it says so once in `needs_review`
 * instead of wearing a badge it did not earn.
 */
import type { League } from "../schema.ts"
import { deriveScoringPeriod, deriveSlotAccepts } from "../import.ts"

const IL_SLOTS = ["IL", "NA", "IL+"]

export const leagueFromPastedSettings = (
	text: string,
	platform: "yahoo" | "espn" | "custom",
	today: string = new Date().toISOString().slice(0, 10)
): { league: League | null; read: PastedLeague } => {
	const read = leagueFromSettingsText(text)
	// Scoring is the one thing nothing else can stand in for: without it every
	// projection is zero. Slots and team count have a form to fill in; a page with
	// no stat table is not a settings page, and saying so beats storing an empty
	// league that silently ranks nothing.
	if (!Object.keys(read.batting).length && !Object.keys(read.pitching).length)
		return { league: null, read }

	const slots = read.slots ?? {}
	const slotOrder = read.slotOrder ?? []
	const { period, needsReview } = deriveScoringPeriod(read.settings)
	const slotAccepts = deriveSlotAccepts(slots)
	if (slotAccepts)
		needsReview.push(
			"slot_accepts is derived from the roster slot names, not stated as prose on " +
				"the settings page."
		)
	needsReview.push(
		`These values were read off a settings page you pasted on ${today}. Nothing ` +
			`fetched that page, so beanemachine can't vouch for it — check anything that ` +
			`looks wrong in League setup.`
	)
	for (const gap of read.missing) needsReview.push(`The paste carried no ${gap}.`)

	/**
	 * Yahoo prints the league's own id on this very page, as "League ID#".
	 *
	 * It matters more than it looks. The free-agent list — carried in a file, or
	 * pasted on My team — is stored against the league id, and `Board.tsx` looks it
	 * up by that id; a league with none can never be shown its own wire, only the
	 * ownership estimate. So the first pasted leagues had scoring, slots and teams
	 * and were quietly incapable of the one thing the paste route exists for.
	 */
	const leagueId =
		read.settings["League ID#"] ?? read.settings["League ID"] ?? read.settings["League Id"] ?? null

	const active = Object.entries(slots)
		.filter(([slot]) => slot !== "BN" && !IL_SLOTS.includes(slot))
		.reduce((sum, [, n]) => sum + n, 0)

	return {
		league: {
			meta: {
				platform,
				sport: "mlb",
				league_id: leagueId,
				league_name: read.settings["League Name"] ?? null,
				league_url: null,
				team_id: null,
				team_name: null,
				season: null,
				scoring_type: read.settings["Scoring Type"] ?? null,
				max_teams: read.maxTeams
			},
			scoring: { unit: "points", batting: read.batting, pitching: read.pitching },
			roster: {
				raw: read.settings["Roster Positions"] ?? null,
				slots,
				slot_order: slotOrder.length ? slotOrder : null,
				counts:
					slotOrder.length ?
						{
							active,
							bench: slots["BN"] ?? 0,
							injured_list: IL_SLOTS.reduce((sum, il) => sum + (slots[il] ?? 0), 0),
							total: slotOrder.length
						}
					:	null,
				slot_accepts: slotAccepts
			},
			// The eligibility thresholds live on a different Yahoo page, so a settings
			// paste genuinely does not carry them. Null is the truth; the board falls
			// back to each man's primary position, as it does for any league that
			// states none.
			eligibility: null,
			scoring_period: period,
			league_rules: { raw_settings: read.settings },
			provenance: {
				fetched_at: today,
				sources: [],
				method: `paste: the league's own settings page, pasted on ${today}`,
				verified: false
			},
			needs_review: needsReview
		},
		read
	}
}
