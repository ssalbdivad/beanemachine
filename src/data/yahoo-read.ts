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
import { leagueIdFrom, sportFrom, teamIdFrom, SPORT, type Grab } from "./extension.ts"
import { leagueFromPastedSettings } from "./paste-settings.ts"
import { rosterFromPaste, type PastedRoster } from "./paste.ts"
import { normalizeName } from "./names.ts"
import { looksLeaked, parsePage, type PoolEntry } from "./yahoo-pool.ts"

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
	/**
	 * WHOSE TEAM PAGE THIS WAS, out of the URL — `/b1/<league>/<team>`.
	 *
	 * Every team in the league has a page of the same shape, and a rival's roster reads
	 * exactly like the reader's own: same table, same slots, same names-in-text. Nothing in
	 * the page can tell them apart, so the id is the only thing that can. Null when no team
	 * page was among the grabs.
	 */
	teamId: string | null
	/** The oldest read in the set, which is what any age the app prints must be measured
	 *  from — a set of pages read over four minutes is as old as its oldest page. */
	at: string | null
	/** What was read and what was not, in the reader's words, for the screen to print. */
	notes: string[]
}

/**
 * WHAT THE CALLER ALREADY KNOWS, so a read onto the wrong league or the wrong team can be
 * refused rather than written.
 *
 * Both are optional and both default to "do not check", which is exactly what the app does
 * today — see the note on each. They are separated from `today` because they are about
 * WHOSE data this is, and getting that wrong is the only failure in this file that leaves
 * something wrong behind instead of leaving nothing.
 */
export interface ExpectedOf {
	/**
	 * The league this read is being written INTO, as `yahoo:<id>`.
	 *
	 * The screen has an active league; the reader's browser has whatever Yahoo tab he left
	 * open. When those differ, every page in the grab set belongs to the open tab's league
	 * and `readLeagueHere` writes it under the screen's key: a rival league's nine men land
	 * in this league's roster store with nothing anywhere saying so.
	 *
	 * PASSED BY `readLeagueHere` (src/client/read-yahoo.ts) AND DELIBERATELY NOT BY THE
	 * ONBOARDING SHEET. On the first route the screen's league is authority, so a tab showing
	 * another one is a mistake and is refused; on the sheet the tab is what the reader is
	 * ADOPTING, and checking it against the screen would refuse the thing he pressed the
	 * button to do. The same mismatch is caught for a sweep by the router, which refuses a tab
	 * whose league is not the one asked for (see `pickTab` in extension/src/background.ts) —
	 * the hole this closes is a `league` press, which names no league at all.
	 */
	leagueKey?: string
	/**
	 * The team id the app already holds for this league, when it holds one.
	 *
	 * With it, "you are looking at somebody else's team" is sayable and the roster is
	 * refused instead of overwriting his own. Without it — which is every caller today, and
	 * every reader on his first read, who has no stored team id to compare against — the
	 * first team page read is taken at its word, because there is nothing to check it
	 * against and refusing every first read would refuse the feature.
	 */
	teamId?: string
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
	today: string = new Date().toISOString().slice(0, 10),
	expect: ExpectedOf = {}
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
		teamId: null,
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
	   get a baseball league whose every player matched nobody, reported as an empty team.

	   The router refuses a football tab before a page is ever read (`pickTab` in
	   extension/src/background.ts), so in the ordinary path this is unreachable. It stays
	   because it is the backstop for every OTHER way a grab can arrive — a browser whose
	   half is older than the router that refuses, and the paste box, which hands this
	   function whatever a reader selected. Two guards on the one failure that reports a
	   whole team as nobody. */
	if (out.sport && out.sport !== SPORT) {
		notes.push(
			`That page is your ${out.sport} league. This only knows baseball, so nothing was read.`
		)
		return out
	}

	/*
	   THE LEAGUE ON THE PAGE IS NOT THE LEAGUE ON THE SCREEN.

	   Refused rather than read, and refused BEFORE anything is parsed, because everything
	   downstream is written under the caller's key rather than under the key found here: a
	   read that goes ahead does not land beside his league, it lands ON it. See `ExpectedOf`
	   for why nothing passes this yet and which half of the hole the router already covers.
	*/
	if (expect.leagueKey && out.leagueKey && expect.leagueKey !== out.leagueKey) {
		notes.push(
			"Those pages are a different league from the one on this screen, so nothing was read."
		)
		return out
	}

	const settings = grabs.find(g => g.kind === "settings")
	if (settings) {
		/*
		   NOT A PASTE, AND THE BOARD SHOULD STOP SAYING IT IS.
		
		   This is the same parser the paste box uses, on text nobody typed: the reader's own
		   browser fetched this page from his signed-in Yahoo tab and the grab carries the URL
		   it fetched. Handed over as an anonymous string, the league came back with
		   `verified: false` and a review line beginning "Nothing fetched that page" — so the
		   masthead's trust chip read "not from your league" on a board built from a clean
		   extension read, while the sheet above it said what league it had just read.
		
		   The method sentence is in the reader's words rather than this project's: what he did
		   was press a button and let his browser read his own league.
		*/
		const { league, read } = leagueFromPastedSettings(settings.text, "yahoo", today, {
			url: settings.url,
			method: `read off your own league page in this browser on ${today}`
		})
		out.league = league
		if (!league)
			notes.push(
				"That settings page carried no scoring table, so the values could not be read from it."
			)
		else if (read.missing.length || read.unpriced.length)
			/* Named rather than counted: a reader told "3 values could not be read" cannot
			   tell which of his league's rules the board is now guessing at. `missing` is the
			   parser's own list and is already written in the reader's terms. */
			notes.push(
				[
					read.missing.length ? `Not on that page: ${read.missing.join(", ")}.` : null,
					/* NOT "not on that page": the row WAS on it. What failed is the reading, and a
					   reader told his home-run row is missing from a page he is looking at will
					   conclude the app cannot read at all — which, about that row, is true, and is
					   what this says instead. */
					read.unpriced.length ?
						`${read.unpriced.join(", ")} could not be read off that page, so ` +
						`${read.unpriced.length === 1 ? "it scores" : "they score"} nothing until you check ` +
						`${read.unpriced.length === 1 ? "that row" : "those rows"}.`
					:	null
				]
					.filter(Boolean)
					.join(" ")
			)
	}

	const team = grabs.find(g => g.kind === "team")
	if (team) out.teamId = teamIdFrom(team.url)
	/*
	   SOMEBODY ELSE'S TEAM.

	   A rival's roster page is the same page with different men on it, and `rosterFromPaste`
	   matches names against the snapshot without any way to notice whose names they are. So
	   a reader who followed a link from the standings to see what he is up against, and then
	   pressed the button, replaced his own team with his opponent's — nine men, no error, no
	   sentence. The URL is the only thing that tells the two pages apart.

	   Refused rather than merged or warned-about, because a roster is the one store in this
	   app that is a statement about WHO HE IS. Everything else can be re-read; a team
	   silently replaced by a rival's is a board that recommends he drop men he does not own.
	*/
	if (team && expect.teamId && out.teamId && expect.teamId !== out.teamId) {
		notes.push(
			"That is somebody else's team page, so your own team was left as it was. Open your team and press it again."
		)
	} else if (team) {
		const read = rosterFromPaste(team.text, snapshot)
		/*
		   A TEAM PAGE IS NOT ONLY A TEAM, and this is where the extension route parts company
		   with the paste.
		
		   A reader pasting SELECTS his roster: whatever else is on the page — the matchup strip
		   naming his opponent's men, a trending-players module, a news blurb about somebody's
		   trade — is not in what he copied. The extension has no selection; it hands over
		   `document.body.innerText`, which is the whole page, and `rosterFromPaste` matches
		   every known name anywhere in it. Nine men in the table plus six more from a sidebar
		   is a fifteen-man roster the reader never had, replacing his real one wholesale, with
		   "15 men, in the seats they are in" as the only thing he is told.
		
		   THE SEAT IS WHAT SEPARATES THEM. Every man on a roster table has a seat printed
		   beside him — C, 1B, BN, IL — and a man named in a news module has nothing. So where
		   the page gave seats to most of the men it named, the seated men ARE the team and the
		   rest are the page around it.
		
		   "Most", not "any", because the fallback has to survive Yahoo restyling the table out
		   of recognition: if seats stop parsing, taking only seated men would store an empty
		   team, which is the failure this whole route exists to avoid. Two thirds is the same
		   line the matchup gap uses for the same kind of judgement. Below it, everything
		   matched is kept — the old behaviour — and the note says the seats could not be read
		   rather than pretending they were.
		*/
		const seatedNames = new Set(read.spots.map(sp => normalizeName(sp.name)))
		const seated = read.players.filter(p => seatedNames.has(normalizeName(p.name)))
		const trustSeats = read.players.length > 0 && seated.length >= Math.ceil(read.players.length * (2 / 3))
		const dropped = trustSeats ? read.players.length - seated.length : 0
		out.roster =
			trustSeats ?
				{
					...read,
					players: seated,
					keys: seated.map(p => `${p.id}:${p.group}`)
				}
			:	read
		if (!out.roster.players.length)
			notes.push("No players were found on that team page, so your team was left as it was.")
		else if (dropped > 0)
			/* Counted rather than named: the men dropped are the page's furniture, and listing
			   six strangers back at a reader as "not on your team" is a paragraph about
			   somebody else's news module. What he needs is that the number he is about to be
			   told is the table and not the page. */
			notes.push(
				`${dropped} other ${dropped === 1 ? "player was" : "players were"} named elsewhere on that page — a matchup strip or a news panel — and ${dropped === 1 ? "is" : "are"} not counted as yours.`
			)
		else if (!trustSeats && read.players.length)
			notes.push(
				"The seats on that page could not be read, so everyone it names is on your team until you say otherwise."
			)
	} else if (grabs.some(g => g.kind !== "players")) {
		/*
		   HE PRESSED IT FROM THE WRONG PAGE, and it used to say nothing at all.

		   The league home, the draft results, the transaction log: every one of them is a
		   page inside his league, so the league id reads fine and the settings and matchup
		   pages are fetched fine — and no team page is among the grabs, so no roster is read
		   and no note is written. `readLeagueHere` then reports what it DID get ("Read your
		   league's own scoring, 27 free agents") and is silent about the team, which reads as
		   a team that was read and had nothing in it.

		   An absence said as an absence, with the one thing he can do about it.
		*/
		notes.push(
			"That page is not your team, so no players were read. Open your own team on Yahoo and press it again."
		)
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

	/*
	   ONLY A SWEEP MAKES A WIRE.

	   `poolIsPartial` in src/client/api.ts calls a pool partial when fewer than two thirds
	   of the positions it ASKED for came back, and the asked-for list is derived below from
	   the URLs of the pages in hand. That is right for a sweep and catastrophic for a single
	   page: a reader standing on the shortstop list who presses "read my league" produces one
	   players grab, one of one is not partial, and a page of shortstops would be promoted to
	   "the exact list of everyone free in your league" — after which the board tells him
	   there is nobody available at any other position, with total confidence.

	   `swept` is set by the sweep and by nothing else. Nothing calls the losing path today —
	   `readLeagueHere` throws away the pool it reads off a league press — so this is a gun
	   being unloaded rather than a bug being fixed, and it is written down here because the
	   next caller will not know.

	   A grab from an older build carries no mark at all. Those are accepted: the only source
	   of a players grab before the mark existed was the sweep.
	*/
	const players = grabs.filter(g => g.kind === "players" && g.html)
	const looseOnly = players.length > 0 && players.every(g => g.swept !== true && !!g.text)
	if (looseOnly)
		notes.push(
			"That page is one position of your league's player list, so the free agents were left as they were."
		)
	if (players.length && !looseOnly) {
		const seen = new Set<string>()
		const rows: PoolEntry[] = []
		const positionsRead: string[] = []
		/*
		   A PAGE THAT CAME BACK IS NOT THE SAME THING AS THE PAGE THAT WAS ASKED FOR.
		
		   A position used to count as read the moment its page carried any rows at all. That
		   is the right test for a page Yahoo refused and the wrong one for a page Yahoo served
		   without honouring `pos=` — and the second is a shape `fetchOwnership` already guards
		   against (`pageKey === prevPage` in src/data/yahoo-pool.ts), because it has happened
		   on the other reader.
		
		   Fed nine grabs whose URLs said `pos=C … pos=RP` and whose HTML was the same 25 rows,
		   this reported 25 players, nine positions read, nothing partial and no note: the
		   board would then tell a reader nobody is free at eight of nine positions, with total
		   confidence, off a ninth of his wire. `poolIsPartial` is written for exactly that
		   failure and cannot see it, because the count it checks was the one being faked.
		
		   Two checks, and both are about the page rather than about the men:
		
		     THE SAME ROWS TWICE. An id set identical to another position's, with at least ten
		     rows in it. The floor matters: in a deep league a position can genuinely have three
		     free agents who are the same three men as another position's, and refusing that
		     would refuse a true answer. Twenty-five identical ids across two positions is not a
		     coincidence, it is an unfiltered page.
		
		     ROWS THAT ARE NOT OF THE POSITION ASKED FOR. Each row carries its own eligibility,
		     so a page asked for SP whose rows mostly do not say SP was not filtered. Util is
		     skipped, because Util accepts everybody by definition, and so is a page whose rows
		     carry no eligibility at all — an absent column is not evidence of anything.
		
		   The men themselves are KEPT either way. They are real free agents whatever page they
		   arrived on, and throwing them away would turn a mislabelled read into an empty one.
		   What is refused is the CLAIM that the position was read.
		*/
		const idsPerPosition = new Map<string, Set<string>>()
		/* The two checks are two different sentences. "Yahoo sent the same list for 1B as for
		   another position" is a statement about two pages and is false of a page that was
		   refused for carrying the wrong men; saying it anyway would send a reader looking for
		   a duplicate that is not there. */
		const duplicated: string[] = []
		const mislabelled: string[] = []
		for (const g of players) {
			const got = parsePage(g.html!)
			const pos = posOf(g.url)
			if (!got.length) continue
			const ids = new Set(got.map(p => p.yahooId))
			let honoured = true
			if (pos) {
				for (const [other, otherIds] of idsPerPosition) {
					if (other === pos) continue
					/*
					   NEARLY THE SAME LIST, not exactly the same list.
					
					   This compared the two id sets for equality, which a single differing row
					   defeats — and a differing row is what an unfiltered page LOOKS like when
					   Yahoo's own ordering has shifted between two requests a quarter-second
					   apart. Nine pages that are 24-of-25 identical are the same failure as nine
					   that are 25-of-25, and only the second was caught.
					
					   The floor is twenty rather than ten. Ten was chosen against a three-man
					   example and is too low for the coincidence it is meant to allow: in a deep
					   league two positions can genuinely share a dozen free agents — a page of
					   catchers who also qualify at first base is an ordinary thing — while twenty
					   of twenty-five shared, at two different positions, is not.
					*/
					const shared = [...otherIds].filter(id => ids.has(id)).length
					const smaller = Math.min(otherIds.size, ids.size)
					if (smaller >= 20 && shared >= smaller * 0.9) {
						honoured = false
						if (!duplicated.includes(pos)) duplicated.push(pos)
					}
				}
				const named = got.filter(p => p.positions.length)
				if (honoured && pos !== "Util" && named.length >= got.length / 2) {
					const ofPos = named.filter(p => p.positions.includes(pos)).length
					if (ofPos < named.length / 2) {
						honoured = false
						if (!mislabelled.includes(pos)) mislabelled.push(pos)
					}
				}
				idsPerPosition.set(pos, ids)
				if (honoured && !positionsRead.includes(pos)) positionsRead.push(pos)
			}
			for (const p of got)
				if (!seen.has(p.yahooId)) {
					seen.add(p.yahooId)
					rows.push(p)
				}
		}
		/* Named, not counted, and phrased as what it means for his list rather than as what the
		   page did: the consequence he can act on is that the list is short at those positions,
		   and that pressing again is the thing to do. */
		if (duplicated.length)
			notes.push(
				`Yahoo sent the same list for ${duplicated.join(", ")} as for another position, so ` +
					`${duplicated.length === 1 ? "it was" : "those were"} not counted as read and the ` +
					`free agents may be short there.`
			)
		if (mislabelled.length)
			notes.push(
				`The ${mislabelled.join(", ")} list came back holding mostly other positions, so ` +
					`${mislabelled.length === 1 ? "it was" : "those were"} not counted as read and the ` +
					`free agents may be short there.`
			)
		/*
		   WHAT WAS ASKED FOR COMES FROM THE SWEEP, NOT FROM WHAT ARRIVED.

		   This used to read the positions off the URLs of the pages in hand, and that made
		   the partial rule blind to the exact failure it exists for. `poolIsPartial` refuses
		   a pool when fewer than two thirds of the ASKED-for positions came back — but a
		   sweep throttled at the fifth position hands over four pages, from which four
		   positions are derived as "asked", and four of four is complete. Only a page that
		   came back EMPTY was ever counted as missing. Measured in test/extension.mjs against
		   a fixture walled at the fifth position: false before, true now.

		   The URLs remain the fallback, for grabs made before the sweep carried its list.
		*/
		/*
		   THE TRIPWIRE, RUN OVER THE WHOLE SWEEP.

		   `parsePage` identifies Yahoo's roster-share cell positively — `<td><div>98%`,
		   a shape the AccuWeather tooltip nested in each row has no equivalent of — so
		   this should never fire. It is here for the day Yahoo's markup moves and the
		   column starts reading as something per-GAME, which is the failure argued at
		   length on `leakedByTeam` and which reorders the whole board rather than
		   degrading one cell.

		   When it fires the percentages go and the pool STAYS: who is free is a separate
		   claim off the same page and is unaffected by what the ownership column did. The
		   absence is then stated in the reader's own note rather than left to look like a
		   league nobody owns anybody in.
		*/
		if (looksLeaked(rows)) {
			for (const r of rows) r.rosteredPct = null
			notes.push("Yahoo's rostered column came back unreadable this time.")
		}
		const asked = players.find(g => g.asked?.length)?.asked
		const requested = players.map(g => posOf(g.url)).filter((p): p is string => !!p)
		out.pool = {
			players: rows,
			positionsRead,
			positionsRequested:
				asked ?? (requested.length ? [...new Set(requested)] : POSITIONS)
		}
		if (!rows.length)
			notes.push("Yahoo's player list came back empty, so the free agents were left as they were.")
	}

	return out
}
