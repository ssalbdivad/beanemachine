/**
 * WHAT THE EXTENSION HANDED OVER, TURNED INTO A LEAGUE.
 *
 * The extension reads pages and knows nothing about baseball. This is where the reading
 * becomes a league, a team and a list of free agents — and it does it with the parsers the
 * paste box has always used, on text that arrives the same way a paste does.
 *
 * That is the point of the split. `rosterFromPaste` refuses to understand Yahoo's table:
 * it searches the text for names it already knows, out of a snapshot that holds every
 * player in baseball, and ignores everything else. A redesign, an advert, a different
 * platform — all free. The one page that cannot be read that way is the player table,
 * because a free agent has to be matched to a man by ID rather than by name, and
 * `parsePage` reads those IDs out of the HTML.
 *
 * NOTHING HERE TRUSTS ANYTHING. Every field arrives from a page written by somebody else
 * and forwarded by an extension, so it goes through the same validation a pasted page
 * goes through, which is to say the parsers assume they are being handed a stranger's
 * HTML, because they always have been.
 */
import type { League } from "../schema.ts"
import type { PlayerSeason } from "./statsapi.ts"
import { leagueIdFrom, sportFrom, type Grab } from "./extension.ts"
import { leagueFromPastedSettings } from "./paste-settings.ts"
import { rosterFromPaste, type PastedRoster } from "./paste.ts"
import { parsePage, type PoolEntry } from "./yahoo-pool.ts"

export interface YahooReading {
	/** `yahoo:<id>`, the key this app has always stored a Yahoo league under, so a read
	 *  lands ON the reader's league rather than beside it. */
	leagueKey: string | null
	leagueId: string | null
	sport: string | null
	/** The scoring table, slots and team count, when a settings page was among the grabs. */
	league: League | null
	/** The team, with seats, when a roster page was. */
	roster: PastedRoster | null
	/** Free agents, when a sweep was. */
	pool: { players: PoolEntry[]; positionsRead: string[]; positionsRequested: string[] } | null
	/**
	 * The men on the OTHER side of this week's matchup, as `id:group` keys.
	 *
	 * Names only, and only the ones that are not the reader's own. The matchup page shows
	 * both teams, so his own roster is what separates them — which also means this is empty
	 * until his roster is known, and that is the honest answer rather than a guess at which
	 * half of the page belongs to whom.
	 *
	 * NO SCORE. The page prints one, and it is deliberately not read: nobody working on
	 * this has seen the real page, and a regular expression written against a page nobody
	 * has seen is a number the app would print with total confidence and no idea whether it
	 * was the score, the projection, or last week's.
	 */
	opponent: string[] | null
	/** The oldest read in the set, which is what any age the app prints must be measured
	 *  from — a set of pages read over four minutes is as old as its oldest page. */
	at: string | null
	/** What was read and what was not, in the reader's words, for the screen to print. */
	notes: string[]
}

const POSITIONS = ["C", "1B", "2B", "3B", "SS", "OF", "Util", "SP", "RP"]

/** The position a players-page URL was asking for, so a sweep can say which positions it
 *  actually got back rather than counting pages. */
const posOf = (url: string): string | null => {
	try {
		return new URL(url).searchParams.get("pos")
	} catch {
		return null
	}
}

export const readGrabs = (
	grabs: Grab[],
	snapshot: { players: PlayerSeason[]; eligibility?: Record<string, string[]> },
	today: string = new Date().toISOString().slice(0, 10)
): YahooReading => {
	const notes: string[] = []
	const out: YahooReading = {
		leagueKey: null,
		leagueId: null,
		sport: null,
		league: null,
		roster: null,
		pool: null,
		opponent: null,
		at: null,
		notes
	}
	if (!grabs.length) return out

	for (const g of grabs) {
		const id = leagueIdFrom(g.url)
		if (id && !out.leagueId) {
			out.leagueId = id
			out.leagueKey = `yahoo:${id}`
		}
		const sport = sportFrom(g.url)
		if (sport && !out.sport) out.sport = sport
		if (!out.at || g.at < out.at) out.at = g.at
	}

	/* A FOOTBALL LEAGUE IS NOT A SMALL BASEBALL LEAGUE. The same extension sees every
	   fantasy sport Yahoo runs, and a reader who has his football team open would otherwise
	   get a baseball league whose every player matched nobody, reported as an empty team. */
	if (out.sport && out.sport !== "baseball") {
		notes.push(
			`That page is your ${out.sport} league. This only knows baseball, so nothing was read.`
		)
		return out
	}

	const settings = grabs.find(g => g.kind === "settings")
	if (settings) {
		const { league, read } = leagueFromPastedSettings(settings.text, "yahoo", today)
		out.league = league
		if (!league)
			notes.push(
				"That settings page carried no scoring table, so the values could not be read from it."
			)
		else if (read.missing.length)
			/* Named rather than counted: a reader told "3 values could not be read" cannot
			   tell which of his league's rules the board is now guessing at. `missing` is the
			   parser's own list and is already written in the reader's terms. */
			notes.push(`Not on that page: ${read.missing.join(", ")}.`)
	}

	const team = grabs.find(g => g.kind === "team")
	if (team) {
		out.roster = rosterFromPaste(team.text, snapshot)
		if (!out.roster.players.length)
			notes.push("No players were found on that team page, so your team was left as it was.")
	}

	const matchup = grabs.find(g => g.kind === "matchup")
	if (matchup) {
		const both = rosterFromPaste(matchup.text, snapshot)
		/* HIS MEN ARE THE ONES THAT ARE NOT YOURS. The page carries both rosters and does
		   not label which is which in any way a name-matcher can see, so the reader's own
		   team is the only thing that separates them. Without a roster read in the same
		   breath there is nothing to subtract, and the honest answer is none — not "all of
		   them", which would put his own team on both sides of his own matchup. */
		const mine = new Set(out.roster?.keys ?? [])
		const his = both.keys.filter(k => !mine.has(k))
		out.opponent = mine.size ? his : []
		if (!mine.size)
			notes.push(
				"Your opponent could not be told apart from you on that page until your own team is read."
			)
	}

	const players = grabs.filter(g => g.kind === "players" && g.html)
	if (players.length) {
		const seen = new Set<string>()
		const rows: PoolEntry[] = []
		const positionsRead: string[] = []
		for (const g of players) {
			const got = parsePage(g.html!)
			const pos = posOf(g.url)
			if (!got.length) continue
			if (pos && !positionsRead.includes(pos)) positionsRead.push(pos)
			for (const p of got)
				if (!seen.has(p.yahooId)) {
					seen.add(p.yahooId)
					rows.push(p)
				}
		}
		const requested = players.map(g => posOf(g.url)).filter((p): p is string => !!p)
		out.pool = {
			players: rows,
			positionsRead,
			positionsRequested: requested.length ? [...new Set(requested)] : POSITIONS
		}
		if (!rows.length)
			notes.push("Yahoo's player list came back empty, so the free agents were left as they were.")
	}

	return out
}
