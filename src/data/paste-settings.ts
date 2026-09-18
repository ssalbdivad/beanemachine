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
	/**
	 * STAT CODES THE PAGE LISTED AND THIS COULD NOT PRICE.
	 *
	 * `missing` used to be four whole-category absences — no batting scoring, no pitching
	 * scoring, no roster positions, no team count — and nothing counted ROWS. So a page that
	 * yielded eight of a reader's nine batting stats reported them as a complete batting
	 * table, and the ninth was scored as zero for the rest of the season. A league that pays
	 * 4 for a home run and reads it as absent under-ranks every power hitter on the board,
	 * permanently and quietly, and the reader's only symptom is that the advice feels off.
	 *
	 * A stat read as absent is scored as 0, which is a CLAIM about his league. This is the
	 * list that stops the app making it silently.
	 */
	const unpriced: string[] = []
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
			/*
			   SAME LINE, OR THE NEXT ONE — BUT ONLY IF THE NEXT ONE IS NOT A STAT ITSELF.
			
			   The lookahead is for the genuine flatten: a copy that puts the label on one line
			   and its value on the next. It could not tell that case from a column inserted
			   between label and value, and `asNumber` strips every non-digit from whatever it is
			   handed — so `Home Runs (HR)\tmodified\t4` read `modified` as no number, looked
			   ahead to `Strikeouts (K)\tmodified\t-1`, and PRICED HOME RUNS AT −1. Measured on
			   this project's own settings fixture with one cell inserted: batting came back
			   `{"HR":-1}`, and `missing` came back empty, so the app reported a complete read of
			   a scoring table in which home runs cost a point.
			
			   Every projection, every ranking, every start/sit and every trade verdict is priced
			   off this table. Being wrong here is not a degraded answer, it is an inverted one,
			   and nothing on any screen contradicts it. So the borrow is refused whenever the
			   line below carries a stat code of its own — that line is the next STAT, not this
			   stat's value — and the stat is recorded as one the page listed and this could not
			   price, which is the second half of the fix below.
			*/
			const below = lines[i + 1]
			const belowIsAStat = below !== undefined && STAT_CODE.test(cells(below)[0] ?? "")
			const value = asNumber(parts[1]) ?? (belowIsAStat ? null : asNumber(below))
			if (value !== null) {
				side[code] = value
				if (parts.length < 2) i++
				continue
			}
			/* Listed on the page, inside a stat table, and not priced. Named rather than
			   dropped — see `unpriced` below. */
			if (!unpriced.includes(code)) unpriced.push(code)
		}

		/*
		 * A two-cell row carrying NO STAT CODE AT ALL is where the stat table ended.
		 *
		 * The `!code` is the whole of it, and leaving it out cost the entire pitching
		 * side. Yahoo prints "Innings Pitched (IP)" inside the pitchers' table — a row
		 * that carries a code and is not a scoring line, which is what `NOT_A_STAT` is
		 * for. Without this test that row fell through to the reset, `side` went null on
		 * the FIRST line of the table, and every pitching value after it was read as a
		 * league setting. Measured on a faithful settings page: 9 of 9 batting stats and
		 * 0 of 8 pitching, reported as "no pitching scoring" — which downstream means a
		 * daily card that cannot price anybody on the mound.
		 *
		 * A one-cell line does not reset it either, because that is exactly what a
		 * flattened stat row looks like.
		 */
		if (side && parts.length >= 2 && !code) side = null

		// A settings row: "Max Teams   10". Same map src/import.ts harvests, and the
		// same two signals it uses to find one — a two-column table whose header row
		// reads "Setting". EXACTLY two cells, because everything else on the page with
		// a tab in it is navigation ("Scores  Standings  Players  Draft") and would
		// otherwise land in the league's rules as a setting nobody set.
		// `!side`: a row INSIDE a stat table is a stat or it is skipped, never a league
		// setting. Without this, "Innings Pitched (IP)" — a real row of the pitchers'
		// table that carries a code and scores nothing — was filed under the league's
		// own rules as though the commissioner had set it.
		if (!side && parts.length === 2 && label.toLowerCase() !== "setting") {
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
	if (unpriced.length)
		/* Phrased to fit the two sentences that print this list — "It carried no ___" on the
		   setup sheet and "Not on that page: ___" in the read's own notes. The codes are the
		   page's own, in its own brackets, so he can find the rows this could not read. */
		missing.push(
			`point value${unpriced.length > 1 ? "s" : ""} for ${unpriced.join(", ")}`
		)
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
import { rosterCounts } from "../engine/bscore.ts"


/**
 * WHERE THE TEXT CAME FROM, when it did not come from a person's clipboard.
 *
 * This function is the paste parser and its provenance has always said so: `verified: false`,
 * with the reasoning that a paste is text a person handed over and nothing here can tell a
 * real settings page from an invented one. That is exactly right for a paste, and exactly
 * wrong for the one caller that is not one.
 *
 * The browser reader FETCHED the page, from the reader's own signed-in tab, and has the URL
 * it fetched. It is the same evidence an import has. Left unsaid, the masthead's own trust
 * chip read "not from your league" on a board built from a clean extension read — measured
 * on 2026-09-18, with the sheet directly above it saying "Last read Yahoo H2H-Pts 228947 —
 * 225 free agents". The chip is the app's only trust signal and it was lying in the
 * direction that costs a reader his confidence in the thing he just did.
 *
 * So the caller that can prove where the text came from says so, and every caller that
 * cannot keeps the old sentence by default. The flag is never set from inside this file.
 */
export interface TextSource {
	/** The page this text was read off, which is what makes the claim checkable. */
	url: string
	/** In the reader's words, for `provenance.method`. */
	method: string
}

export const leagueFromPastedSettings = (
	text: string,
	platform: "yahoo" | "espn" | "custom",
	today: string = new Date().toISOString().slice(0, 10),
	from: TextSource | null = null
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
			"Which positions can fill each seat was worked out from the seat names. The " +
				"settings page never says it outright, so check it if a lineup looks wrong."
		)
	/* The same sentence, and only for the reader it is true of. A reader whose browser went
	   and got the page is not "nothing fetched that page", and telling him so on his own
	   league's screen is the app calling its own best evidence hearsay. */
	if (!from)
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
				/* `rosterCounts`, not a fourth hand-written copy of the reserve test. `total`
				   stays `slotOrder.length` rather than the sum of the counts, because here
				   the printed order IS the evidence: a settings page that listed 27 seats
				   listed 27, and disagreeing with it would mean the parse was wrong. */
				counts:
					slotOrder.length ?
						{ ...rosterCounts(slots), total: slotOrder.length }
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
			provenance:
				from ?
					{
						fetched_at: today,
						sources: [from.url],
						method: from.method,
						/* The page was fetched and the URL is in `sources`, which is the whole of
						   what this flag has ever claimed. */
						verified: true
					}
				:	{
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
