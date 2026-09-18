import { useEffect, useRef, useState } from "react"
import type { Snapshot } from "../data/snapshot.ts"
import type { League } from "../schema.ts"
import { leagueFromPastedSettings } from "../data/paste-settings.ts"
import { rosterFromPaste, type PastedRoster } from "../data/paste.ts"
import { lineupStore } from "./lineup.ts"
import { roster } from "./roster.ts"
import { leagueGaps, tab } from "./panels.tsx"
import { typingStore, type Box } from "./typing.ts"
import { Connect, browserOf, takesExtension } from "./Connect.tsx"
import { extensionHere, useExtension } from "./extension.ts"
import { readGrabs } from "../data/yahoo-read.ts"
import { knownTeamId } from "./read-yahoo.ts"
import { pool as poolStore } from "./pool.ts"
import { opponentStore } from "./opponent.ts"
import type { GrabFailure } from "../data/extension.ts"

/**
 * The first thing a stranger sees.
 *
 * What used to be here was a league: `public/scoring.json` shipped one real Yahoo
 * league — somebody's own team, with his scoring and his roster slots — and every
 * first visit was seeded from it. It ranked immediately, which looked like the app
 * working, and every number on the screen was denominated in a stranger's points.
 * The page carried a notice saying so, which is the tell: a product that has to
 * explain that its main screen is not about you is showing the wrong screen.
 *
 * So the seed is gone and this is what a first visit gets instead. It asks for the
 * three inputs the engine cannot proceed without — what each stat is worth, how
 * many roster slots, how many teams — and it asks for them in the order that gets
 * a Yahoo user to a real board fastest, which is by pasting a page rather than by
 * typing seventeen point values in.
 *
 * The order of the routes is not arbitrary and is not a matter of taste:
 *
 *  · PASTE first, on every platform. Yahoo sends no `access-control-allow-origin`
 *    on any page, so no browser will ever be handed one, and — measured 2026-09-09
 *    — a server asking for it is told "Request denied". The reader's own signed-in
 *    browser is the one program in the world that can see that page, and Ctrl-A is
 *    the way out of it. It also works on a PRIVATE league, which is most leagues,
 *    and which nothing else here has ever reached.
 *  · URL second, and only where it is true. ESPN reflects our origin, so the page
 *    reads it directly; with a server behind us Yahoo can be scraped, sometimes.
 *  · The preset is not offered as a button at all any more. It is what the board
 *    behind this sheet is already running, labelled, and typing a team adopts it —
 *    so a reader never chooses it, he only ever reads that he has it.
 *  · By hand last, because it works everywhere and costs the most.
 *
 * Every one of them ends in the same place: a league in this browser, and a board
 * ranked in its points.
 */

/** Four real men, so the box shows the shape of an answer rather than describing it.
 *  Kept as a literal and pinned by test/paste.mjs against the shipped capture: a
 *  placeholder naming somebody who is not in the data would teach the wrong format on
 *  the one screen that has to get the format across. */
const PLACEHOLDER = "C Cal Raleigh\n1B Ben Rice\nOF Aaron Judge\nSP Tarik Skubal"

type Where = "yahoo" | "espn" | "custom"

const WHERE: { id: Where; label: string; note: string }[] = [
	{ id: "yahoo", label: "Yahoo", note: "Head-to-head points, roto or categories" },
	{ id: "espn", label: "ESPN", note: "Can also be read straight from its URL" },
	{ id: "custom", label: "Somewhere else", note: "CBS, Fantrax, Ottoneu, a home league" }
]

/** Where each platform prints the page this asks for. Named per platform because
 *  "your settings page" is the step people get stuck on, and it is called
 *  something different everywhere. */
const SETTINGS_PAGE: Record<Where, React.ReactNode> = {
	yahoo: (
		<>
			your league&rsquo;s <b>Settings</b> page — <b>League</b> → <b>Settings</b>, or
			add <code>/settings</code> to your league&rsquo;s URL
		</>
	),
	espn: (
		<>
			your league&rsquo;s <b>Settings</b> page — <b>LEAGUE</b> → <b>League Settings</b>{" "}
			→ <b>Scoring</b>
		</>
	),
	custom: (
		<>
			whichever page states your league&rsquo;s scoring — usually <b>Settings</b>,{" "}
			<b>Rules</b> or <b>Scoring</b>
		</>
	)
}

export const Onboard = ({
	snapshot,
	leagueKey,
	league,
	canImport,
	openConnect = false,
	onCreateLeague,
	onAdoptPreset,
	onTeamCount,
	onAddSuggested,
	onImportUrl,
	onLoadFile,
	onOpenSetup,
	onDone
}: {
	snapshot: Snapshot | null
	/** The league this browser holds once one exists, so the last step can put a
	 *  team in it and the finish button can say what it is finishing. */
	leagueKey: string | null
	league: League | null
	/** Whether a league can be read from wherever this page is running: true with a
	 *  server behind it, and on the static build true for ESPN alone. */
	canImport: boolean
	/** Another screen asked for the install walkthrough rather than the paste box — see
	 *  `onConnect` in src/client/Trade.tsx, which is the screen a reader with a league is
	 *  standing on and the one place the reader was never offered. */
	openConnect?: boolean
	onCreateLeague: (platform: Where, league: League) => void
	/** Turns the preview the reader is looking at into a real league in this browser,
	 *  and returns its key. Called at the moment he first writes something of his own:
	 *  before that there is nothing to attach it to. */
	onAdoptPreset: () => string | null
	/** Whether this league's lineup can be changed daily. Only the reader knows — no
	 *  platform preset can say, because one platform hosts both kinds. */
	/** Accept one "did you mean" — the reader has read the name and tapped it, which is
	 *  the only way a suggestion is ever allowed to become a roster entry. */
	/** Resolves true only when the man actually landed in a league's roster. The chip
	 *  below must not cross itself off on a failure — see the note at the call site. */
	onAddSuggested: (id: number, group: "hitting" | "pitching", name: string) => Promise<boolean>
	/** How many teams this league has. It is the second and last question, because the
	 *  bar every player is measured against is the (teams x seats)-th best man — so the
	 *  count moves every row on the board. */
	onTeamCount: (teams: number) => void
	onImportUrl: (url: string) => void
	onLoadFile: () => void
	onOpenSetup: () => void
	onDone: () => void
}) => {
	const [where, setWhere] = useState<Where | null>(null)
	/*
	  TWO MODES IN ONE CARD, never both at once.
	
	  The sheet is capped at `min(70vh,620px)` — 590px on a 390px phone — and this file
	  already carries two notes about content that overflowed it: 998px of card with the
	  third question 101px below the fold, and a finish button 646px down a 590px box. A
	  three-step walkthrough is another ~450px, so stacking it above "Who's on your team?"
	  would rebuild the exact defect twice recorded here. It replaces the body instead, and
	  the way back is a line at the foot of it.
	*/
	const ext = useExtension()
	/*
	  A READER WHO ALREADY HAS IT LANDS ON THE BUTTON, not on the box.
	
	  The default sheet asks him to type his team in, which is the right question for every
	  reader who cannot have it read for him — and the wrong one for a reader whose browser
	  is sitting there able to do it in one press. Opening in connect mode is only done when
	  BOTH are true: the reader is there, and there is no team stored yet. With a team
	  already in, the sheet opens where it always did, because he came back to change
	  something rather than to be onboarded again.
	
	  `extensionHere()` rather than the hook's `present`, because this decides the FIRST
	  render: the hook's state arrives a tick later, and a sheet that opens on the box and
	  then jumps to the walkthrough is worse than either.
	*/
	const [connecting, setConnecting] = useState(() => {
		/* `roster.of` THROWS on a damaged store, on purpose — a roster is typed in by hand
		   and must never be silently treated as empty. A throw in this initialiser would
		   blank the whole sheet, so the question it is asked here ("has he got a team yet")
		   degrades to "assume he has", which opens the sheet exactly where it always did. */
		try {
			return extensionHere() && !(leagueKey ? roster.of(leagueKey).length : 0)
		} catch {
			return false
		}
	})
	/* Opened straight onto the walkthrough when another screen asked for it — see `onConnect`
	   in src/client/Trade.tsx. An effect rather than the initialiser above, because this sheet
	   is mounted once and hidden while closed (closing it must not discard what he typed), so
	   a lazy initial value would only ever be read at app start. */
	useEffect(() => {
		if (openConnect) setConnecting(true)
	}, [openConnect])
	const [readFailure, setReadFailure] = useState<GrabFailure | null>(null)
	const [receipt, setReceipt] = useState<{ league: string | null; free: number | null; at: string | null }>({
		league: null,
		free: null,
		at: null
	})
	/*
	  THE TWO BOXES SURVIVE THE SHEET BEING CLOSED, and they did not.
	  
	  This sheet is mounted by App as `{docked && <Dock>}`, and closing it with a league in
	  existence — which there is, from the moment a first visit adopts the borrowed one —
	  takes `docked` false and unmounts everything here. Escape is the gesture a phone
	  keyboard teaches, and it was throwing away eighteen typed lines. The text is kept in
	  the browser as it is typed instead, so it survives Escape, Back, a tab press and a
	  reloaded phone. See src/client/typing.ts for why the draft rather than the component.
	*/
	const draft = (box: Box): ((t: string) => void) => t => typingStore.set(leagueKey, box, t)
	const [pasted, setPasted] = useState(() => typingStore.of(leagueKey, "settings"))
	const [note, setNote] = useState<string | null>(null)
	const [url, setUrl] = useState("")
	const [team, setTeam] = useState(() => typingStore.of(leagueKey, "team"))
	const [teamNote, setTeamNote] = useState<string | null>(null)
	/** How many men this league already holds, read rather than inferred: the copy under the
	 *  box changes on it, and a count the page guesses at is the kind of sentence this app is
	 *  not allowed to write. Forgiving, because a damaged roster store is My league's to
	 *  explain and this box still has to work. */
	const held = (() => {
		try {
			return leagueKey ? roster.of(leagueKey).length : 0
		} catch {
			return 0
		}
	})()
	/** The last read of the team box, kept so the sheet can name every player back and
	 *  quote every line that produced nobody. */
	const [read, setRead] = useState<PastedRoster | null>(null)
	/** Which suggested names this reader has already accepted, so a tapped chip does
	 *  not sit there inviting a second tap that would do nothing. */
	const [added, setAdded] = useState<number[]>([])

	/** Everything the sheet still wants. The lock is the one that decides whether Tonight
	 *  is a list of changes or a plan for the period, so it is what "done" means here. */
	/*
	   WHAT "ANSWERED" MEANT, AND WHAT IT MEANS NOW.
	
	   It was `!!league?.scoring_period?.lineup_lock` — the third question, "can you change
	   your lineup every day?", which was REMOVED from this sheet (see the note where it used
	   to be). Nothing set that field afterwards on the ordinary first visit, so the condition
	   was permanently false and the finish was never pinned: measured at 390x844 immediately
	   after "That's my team", the team-count chips sat at y=850, six pixels under the fold,
	   and "Show me tonight" 172px under that, with nothing scrolling and nothing pinned. A
	   condition that outlives the question it was about is worse than no condition, because it
	   reads as deliberate.
	
	   The last question left is the team count, and it is PRE-FILLED — ten, Yahoo's own
	   default, said on the screen to be a guess. So "answered" is now about the reader rather
	   than about the data: once he has touched it there is nothing left below the button, and
	   pinning it is what the note below argues for.
	*/
	const [teamsAnswered, setTeamsAnswered] = useState(false)
	const answered = teamsAnswered

	/*
	   THE MOMENT A LEAGUE APPEARS, THE REST OF THE SHEET IS BELOW THE FOLD.
	
	   Pressing "That's my team" replaces the question he answered with two things he has not
	   seen: the team count, and the button that ends setup. Measured at 390x844 they land at
	   y=850 and y=1016 against an 844px screen — six pixels and 172 pixels under — and the
	   sheet does not move. The page behind it scrolls normally and the sheet's own scrollbar
	   is a phone's, which is to say invisible, so there is nothing on screen to suggest that
	   anything follows. One wheel gesture reveals both, which is the whole distance between
	   this working and not.
	
	   So the sheet brings them to him, once, on the transition. `block: "nearest"` scrolls the
	   least that will do — a reader on a desktop where both are already visible sees nothing
	   move, which is the correct amount of movement.
	*/
	const rest = useRef<HTMLDivElement | null>(null)
	const had = useRef(false)
	useEffect(() => {
		if (!league) {
			had.current = false
			return
		}
		if (had.current) return
		had.current = true
		/* Not smooth: this is orientation, not decoration, and `prefers-reduced-motion` is a
		   request not to animate rather than a request not to arrive. */
		rest.current?.scrollIntoView({ block: "nearest" })
	}, [league])
	const gaps = league ? leagueGaps(league) : []
	const missing = gaps.filter(g => g.have === null)
	const ready = !!league && missing.length === 0

	/**
	 * Read the settings page out of whatever was pasted.
	 *
	 * A page with no stat table on it is not a settings page, and the honest answer
	 * is to say which page to open rather than to store an empty league that ranks
	 * nothing and looks configured.
	 */
	const readSettings = () => {
		if (!where) return
		const { league: made, read } = leagueFromPastedSettings(pasted, where)
		if (!made) {
			setNote(
				`No scoring table in that. beanemachine looks for the rows that print a stat's ` +
					`own code in brackets — "Home Runs (HR)" and the number beside it. Open ` +
					`the page that lists what each stat is worth, select all of it, and paste ` +
					`again.` +
					(read.slots ? ` (The roster slots WERE in that paste, so it is close.)` : "")
			)
			return
		}
		const stats =
			Object.keys(made.scoring.batting).length + Object.keys(made.scoring.pitching).length
		const seats = Object.values(made.roster.slots).reduce((a, b) => a + b, 0)
		onCreateLeague(where, made)
		setPasted("")
		/* Read into a league, so the draft goes with it: a box that re-offers text the app
		   has already acted on invites the reader to send it twice. */
		typingStore.clear(leagueKey, "settings")
		setNote(
			`Read ${stats} scored stats` +
				(seats ? `, ${seats} roster seats` : "") +
				(made.meta.max_teams ? ` and ${made.meta.max_teams} teams` : "") +
				`. ` +
				/* Two different shortfalls and two different sentences. A missing scoring table is
				   fixed by filling the form in below; a row whose value would not parse is on his
				   settings page and no form here can supply it, so "fill those in below" pointed
				   at a form that had nothing to fill — `leagueGaps` returns no gap for it, and the
				   finish button sat enabled beside the instruction. */
				(read.missing.length ?
					`It carried no ${read.missing.join(" and no ")} — fill those in below and the board can rank.`
				: read.unpriced.length ?
					`${read.unpriced.join(", ")} ${read.unpriced.length === 1 ? "is" : "are"} on that page and ` +
					`the value could not be read, so ${read.unpriced.length === 1 ? "it scores" : "they score"} ` +
					`nothing — worth checking in My league.`
				:	`That is everything the board needs.`)
		)
	}

	/**
	 * THE ONE PRESS.
	 *
	 * Asks the reader's own signed-in Yahoo tab for his team page and his settings page,
	 * turns them into a league and a roster with the parsers the paste box has always used,
	 * and then — only if that worked — sweeps the free agents.
	 *
	 * THE ORDER MATTERS AND THE SECOND HALF IS CONDITIONAL. The first half is two requests
	 * to pages of his own league and is what makes the board his. The sweep is nine, and
	 * asking Yahoo nine times on behalf of a reader whose league we could not even read
	 * would be asking for a throttle to punish a failure. Each half reports separately,
	 * because "your league is in, the free agents are not" is a real state and a common one.
	 */
	const readLeague = async () => {
		if (!snapshot) return
		setReadFailure(null)
		const answer = await ext.ask("league")
		if (!answer.grabs?.length) {
			setReadFailure(answer.failure ?? null)
			return
		}
		/*
		   THE GUARD THE OTHER READ ROUTE HAS, AND THIS ONE DID NOT.
		
		   `readLeagueHere` hands `readGrabs` what the app already knows, so a press made from
		   another manager's roster page — one click from the standings, a page this app parses
		   perfectly — is refused instead of replacing the reader's own team. This route called
		   `readGrabs(grabs, snapshot)` with two arguments, so it was refused by nothing, AND it
		   stored the seats without the team id they came from. The second half is the worse
		   half: `knownTeamId` then answered null for ever after, so the guard on the OTHER route
		   could never arm either. A reader whose first read was this sheet was unguarded on
		   every read he would ever make.
		
		   Only the team is checked here, not the league. On the other route the screen's league
		   is authority and a tab showing a different one is a mistake; on this one the tab IS
		   what he is adopting — that is what the sheet is for — so a league key from the screen
		   would refuse the very thing he pressed the button to do.
		*/
		const reading = readGrabs(answer.grabs, snapshot, undefined, {
			teamId: knownTeamId(leagueKey) ?? undefined
		})
		if (reading.league && reading.leagueKey) {
			/* `onCreateLeague` is what the paste route calls, so an extension read lands in
			   exactly the same place a pasted settings page does, with the same validation
			   and the same provenance rules. The extension is a way of getting the page, not
			   a second way of having a league. */
			onCreateLeague("yahoo", reading.league)
		}
		const key = reading.leagueKey ?? leagueKey ?? onAdoptPreset()
		if (reading.roster?.players.length && key) {
			try {
				roster.set(key, reading.roster.keys)
				if (reading.roster.spots.length)
					lineupStore.set(
						key,
						reading.roster.spots,
						reading.at ?? new Date().toISOString(),
						/* Stored so the NEXT press can be checked against it — see above. Passing
						   three arguments here is what left every reader who onboarded through
						   this sheet permanently unguarded. */
						reading.teamId
					)
			} catch (e) {
				setReadFailure({
					step: "store",
					what: `your team could not be saved in this browser: ${(e as Error).message}`,
					fix: "A private window usually does this, and so does a full phone."
				})
			}
		}
		/* WHO HE IS PLAYING, off the same press. The recap card has been asking him to paste
		   his opponent's roster; when the matchup page came across, it does not have to. */
		if (reading.opponent?.length && key) {
			try {
				opponentStore.set(key, reading.opponent)
			} catch {
				/* An opponent is one paste away and worth nothing if it cost the read that
				   carried it — the league and the team are already saved above. */
			}
		}
		setReceipt({
			/* The league's NAME, or the words "your league" — never the id. A number a reader
			   has never typed and does not recognise is the app naming its own key at him,
			   and the receipt is the one line on this screen he reads twice. */
			league: reading.league?.meta.league_name ?? (reading.leagueId ? "your league" : null),
			free: null,
			at: reading.at
		})
		if (reading.notes.length) setNote(reading.notes.join(" "))

		/* THE FREE AGENTS, second and separately. */
		if (!reading.leagueId || !key) return
		const swept = await ext.ask("pool", { leagueId: reading.leagueId, sport: reading.sport ?? "baseball" })
		if (!swept.grabs?.length) {
			setReadFailure(swept.failure ?? null)
			return
		}
		const got = readGrabs(swept.grabs, snapshot)
		/* WHAT THE SWEEP HAS TO SAY ABOUT ITSELF, which this route dropped exactly as the other
		   one did: a position Yahoo served as another position's list is refused, and the reason
		   was computed here and thrown away while the board downstream said only that the
		   position never came back. */
		if (got.notes.length) setNote(got.notes.join(" "))
		if (got.pool?.players.length) {
			try {
				poolStore.set(key, {
					at: got.at ?? new Date().toISOString(),
					leagueId: reading.leagueId,
					players: got.pool.players.map(p => ({
						yahooId: p.yahooId,
						name: p.name,
						team: p.team,
						positions: p.positions
					})),
					positionsRead: got.pool.positionsRead,
					positionsRequested: got.pool.positionsRequested,
					/* The reader's own account of where this came from, in the words the chip
					   will print. "Carried in a file" and "read off your league in this browser"
					   are different claims about the same list and age it differently. */
					note: "read off your league in this browser"
				})
				setReceipt(r => ({ ...r, free: got.pool!.players.length, at: got.at ?? r.at }))
			} catch (e) {
				setReadFailure({
					step: "store",
					what: `the free agents could not be saved: ${(e as Error).message}`,
					fix: null
				})
			}
		}
		if (swept.failure) setReadFailure(swept.failure)
	}

	/**
	 * The team, and on a first visit this is the ONLY question that has to be answered.
	 *
	 * It used to open `if (!leagueKey || !snapshot) return` — and on a first visit
	 * `leagueKey` is null, because the board a stranger is looking at runs on the
	 * shipped preset as a PREVIEW that is never stored. So the primary button at the
	 * highest-attrition step in the whole product did nothing at all: the reader typed
	 * his team, pressed the button, and the app said nothing and changed nothing.
	 *
	 * Pressing it now makes the preview real first. That is the right moment for it —
	 * a reader who has typed his players has told us he wants this to be his, and the
	 * scoring he is adopting is the scoring he has been looking at for the last
	 * minute, still labelled as borrowed on the board behind the sheet.
	 */
	const readTeam = () => {
		if (!snapshot) return
		const got = rosterFromPaste(team, snapshot)
		setRead(got)
		setAdded([])
		if (!got.players.length) return setTeamNote(got.note)
		const key = leagueKey ?? onAdoptPreset()
		if (!key)
			return setTeamNote(
				"Something went wrong saving your team. Nothing was lost — try again."
			)
		try {
			roster.set(key, got.keys)
			if (got.spots.length)
				lineupStore.set(key, got.spots, new Date().toISOString())
			setTeam("")
			/* BOTH KEYS, because this gesture can be the thing that creates the league: when
			   `leagueKey` was null the draft was stored under the empty key and `key` is the
			   one the preset just adopted. Clearing only the new one would leave the text to
			   be re-offered on the next visit. */
			typingStore.clear(key, "team")
			if (leagueKey !== key) typingStore.clear(leagueKey, "team")
			// Cleared on success: the answer block below names every player back, which is
			// the confirmation, and `note` here would repeat it in smaller type.
			setTeamNote(null)
		} catch (e) {
			setTeamNote(
				`Your team could not be saved in this browser: ${(e as Error).message} ` +
					`A private window usually does this, and so does a full phone.`
			)
		}
	}

	/* `step()` drew a numbered `<li class="onboard-step">` for a three-step sheet and
	 * nothing has called it since the sheet became one question. Its CSS went with the
	 * layout; this was the last of it. */
	return (
		<div className="grid">
			<section className="card full onboard">
				{/*
				  TWO WRAPPERS, and they exist for ONE viewport: a phone held sideways.
				  
				  Measured at 844x390 with the sheet open: the box is 288px tall holding 557px of
				  content, so the team-count question sat 19px below the visible bottom while the
				  finish button sat above it — a reader's natural gesture is the big button he can
				  see, so the question he answered was the one he never saw. Portrait is fine (590
				  holding 676, everything reachable), and the content is not the problem: 844px of
				  WIDTH is.
				  
				  So in a short, wide viewport these two become columns — the typing on the left,
				  the one remaining question and the way out on the right — and everywhere else
				  they are two plain blocks in a column, which is what they were. See
				  `.onboard-cols` in src/client/app.css.
				*/}
				<div className="onboard-main">
				{connecting ?
					<Connect
						ext={ext}
						leagueName={receipt.league}
						freeAgents={receipt.free}
						readAt={receipt.at}
						failure={readFailure}
						onRead={() => void readLeague()}
						onBack={() => setConnecting(false)}
					/>
				:	<>
				{/*
				  THE OTHER DOOR, offered above the question rather than instead of it.
				
				  A reader in a browser that takes the reader can have his league read to him in
				  one press; a reader on a phone cannot, and must not be shown a control he
				  cannot use or a sentence about what his device lacks. So the offer line is
				  shown where it is true, and where it is not, the sheet is exactly what it has
				  always been — because typing a team in is not a consolation prize, it is the
				  route that works on every device, in a private window, and on a private league.
				*/}
				{takesExtension(browserOf()) && (
					<p className="onboard-offer">
						{/*
						  IT SAYS YAHOO BEFORE HE PRESSES IT, AND IT DID NOT.
						
						  This read "Let it read my league for me" until he had already installed the
						  add-on, and the word Yahoo first appeared in step 3 of the walkthrough —
						  272px below the line he pressed. An ESPN reader could therefore install an
						  add-on called "beanemachine — read my Yahoo league" before anything on this
						  screen told him it is Yahoo only, which costs him an install and this
						  project a store review it can never make good on. The offer names what it
						  reads, in both states.
						*/}
						<button type="button" className="as-link" onClick={() => setConnecting(true)}>
							{ext.present ? "Let it read my Yahoo league" : "Let it read my Yahoo league for me"}
						</button>
					</p>
				)}
				{/*
				  ONE question, and it is about baseball.
				  
				  This card used to open with "Where do you play?" — a question asked for the
				  app's benefit, not the reader's — followed by an instruction to select a
				  whole web page with Ctrl+A, which no phone browser can do. On the device
				  this app is opened on, the only advertised route in was impossible.
				  
				  What is possible on a phone, and has been all along without the app ever
				  saying so, is typing names. `playersInText` matches known players in
				  arbitrary text, so a list a reader thumbs in works exactly as well as a
				  pasted page. So that is the front door, and everything about platforms and
				  scoring tables moves behind "My league scores differently" — true for some
				  readers, and never the first thing anybody is asked.
				*/}
				<h2>Who&rsquo;s on your team?</h2>
				{/* THE PASTE WAS ALREADY THE FRONT DOOR AND THE SCREEN DID NOT SAY SO.
				
				    This read "First and last name, one to a line. Put the position first if you
				    know it." — which a reader on a phone correctly hears as "type your 27 names
				    in by hand", and closes the sheet. `rosterFromPaste` has always matched names
				    inside arbitrary text: a walk pasted a real tab-delimited Yahoo roster copy,
				    game times and eleven stat columns per line, and got every name back with no
				    errors. The capability was there, advertised nowhere, and the instruction
				    pointed at the slowest route to it.
				
				    The roster LIST rather than the whole page, deliberately: pasting a whole team
				    page pulls in the news and trending modules, which is how two men nobody owns
				    ended up on a test roster. */}
				<p className="sub">Paste your roster page, or type the names one to a line.</p>
				<textarea
					data-ctl="onboard-team"
					value={team}
					onChange={e => {
						setTeam(e.currentTarget.value)
						draft("team")(e.currentTarget.value)
					}}
					placeholder={PLACEHOLDER}
					rows={5}
					aria-label="The players on your team"
				/>
				{/* Said where the typing happens, not in a policy nobody opens. It is the
				    question a stranger actually has before he gives an app a list of
				    anything, and it is answered in one sentence because the answer is
				    simple: there is no server to send it to. */}
				<p className="onboard-privacy">
					Nothing leaves this phone. There is no account &mdash; your team is saved in
					this browser and nowhere else.
				</p>
				{/*
				  THE BOX REPLACES, AND THE LINE UNDER IT PROMISED IT ADDED.
				  
				  "You can add the rest later" is true of the app and false of this box: a second
				  paste REPLACES the stored team. Measured — thirteen names, then two more in a
				  cleared box, leaves two men on the roster and the first thirteen gone. Nothing
				  lies about it (the panel below honestly says "Got them. 2 players") and nothing
				  warns either, and the box emptying itself on success is what makes the second
				  paste look like an append.
				  
				  So once a team is stored, the button and the line state the rule the code already
				  follows, and name the route that really does add one man — `roster.add`, which is
				  what the Add control on My league's own-team search calls. The first-visit copy
				  is untouched: "start with your starters" is the right invitation when there is
				  nothing to lose yet, and it is also what makes the Tonight card's seat count a
				  short list, which that card now says out loud.
				*/}
				<p className="onboard-go">
					<button
						type="button"
						className="primary"
						onClick={readTeam}
						disabled={!team.trim()}
					>
						{held > 0 ? "Replace my team" : "That’s my team"}
					</button>
					<span className="sub">
						{held > 0 ?
							`Pasting here replaces all ${held} of them. Adding one man is on ${tab("trade")}.`
						:	"Only got a few? Start with your starters. You can add the rest later."}
					</span>
				</p>

				{/*
				  The answer, in the same sheet, before he goes anywhere.
				  
				  Names ticked back as the app spells them, so he can check four of them in
				  four seconds — a count cannot be checked. And every line that produced
				  nobody, quoted verbatim: a silent drop is the one failure a reader never
				  notices, and two mistyped names would otherwise be missing from every
				  recommendation for the rest of the season with nothing on screen about it.
				*/}
				{/* A line whose suggestion the reader has accepted is no longer missing, and
				    saying "Nothing in them is counted anywhere" about it would be false the
				    moment he taps. */}
				{read && (() => {
					const accepted = read.suggestions.filter(g => added.includes(g.id))
					const acceptedLines = new Set(accepted.map(g => g.line))
					const stillMissed = read.unmatched.filter(l => !acceptedLines.has(l))
					return (
					<div className="onboard-answer">
						{/* ONE READOUT OF THE TEAM, not two. Accepting a suggestion used to leave
						    this line saying "Got them. 1 player: Vladimir Guerrero Jr." with
						    "Added: Cal Raleigh" printed separately below it — two counts of the
						    same roster on one screen, the first of them stale the moment he taps. */}
						{(read.players.length > 0 || accepted.length > 0) && (
							<p className="onboard-got">
								<b>
									Got them. {read.players.length + accepted.length}{" "}
									{read.players.length + accepted.length === 1 ? "player" : "players"}:
								</b>{" "}
								{[...read.players.map(p => p.name), ...accepted.map(g => g.name)].join(", ")}
							</p>
						)}
						{stillMissed.length > 0 && (
							<p className="onboard-missed">
								I couldn&rsquo;t find a player in{" "}
								{stillMissed.length === 1 ? "this line" : "these lines"}:{" "}
								{stillMissed.slice(0, 6).map(l => `\u00ab${l}\u00bb`).join(", ")}
								{stillMissed.length > 6 && ` and ${stillMissed.length - 6} more`}.
								Nothing in them is counted anywhere.
							</p>
						)}
						{/*
						  THE SUGGESTION, AS A TAP.
						  
						  `rosterFromPaste` measures the one man each failed line is a single typo
						  from — 99.1% right and 0.0% wrong on real typos across the whole capture,
						  and it refuses rather than guessing on anything that says too little (see
						  `nearestName`). The note already ASKS "Did you mean Aaron Judge?", and the
						  only way to answer was to retype the line on a phone keyboard, which is
						  where people quit. This is the answer: one tap per name.
						  
						  It stays an explicit tap and it prints the name it is about to add, full
						  size, because the parser must never correct anybody silently — a reader who
						  accepts a plausible name without reading it ends up owning a roster he did
						  not assemble, which is worse than the typo.
						*/}
						{read.suggestions.filter(g => !added.includes(g.id)).length > 0 && (
							<p className="onboard-missed onboard-meant">
								<span>Did you mean</span>{" "}
								{read.suggestions
									.filter(g => !added.includes(g.id))
									.map(g => (
										<button
											key={`${g.id}:${g.group}`}
											type="button"
											className="chip-btn"
											/* Crossed off only if it LANDED. This called `setAdded`
											   unconditionally, and the one path that reaches these chips
											   with no league is the path where `readTeam` returned before
											   adopting one — so every chip a visitor tapped disappeared,
											   the sheet said "Got them", and storage held nothing. */
											onClick={() => {
												void onAddSuggested(g.id, g.group, g.name).then(ok => {
													if (!ok) return
													setAdded(a => [...a, g.id])
													/*
													  THE LINE LEAVES THE BOX WITH HIM.
													  
													  It used to stay, and the consequence was measured: tap
													  every chip, then press the button again, and the whole
													  six-line rejection comes back over a roster that is now
													  correct — because the text is re-parsed and those lines
													  still do not match. The false claim was one tap away
													  rather than on screen, and it cleared only on reload.
													  
													  Removed by exact line rather than by index, because the
													  reader may have edited the box between the read and the
													  tap, and an index would then delete somebody else's line.
													*/
													setTeam(t =>
														t
															.split(/\r?\n/)
															.filter(l => l.trim() !== g.line.trim())
															.join("\n")
													)
												})
											}}
										>
											{g.name}
										</button>
									))}
							</p>
						)}

						{read.ambiguous.length > 0 && (
							<p className="onboard-missed">
								Two different players share {read.ambiguous.join(" and ")}, so neither was
								added. Add a position in front of the one you own.
							</p>
						)}
						{/*
						  THE THING THAT WENT WRONG, on the step with the highest attrition in the
						  product.
						  
						  `teamNote` was written in four places — the parser's own note, "Something
						  went wrong saving your team", and twice the message off a `roster.set`
						  throw, which is what a full storage quota or a private window produces —
						  and read in none. A storage failure here was completely silent: the reader
						  pressed the button, saw his players named back, and had nothing saved.
						*/}
						{/*
						  AND THE GUARD MADE IT UNREACHABLE, which is the same bug one layer out.
						
						  `!read.players.length` was the condition, and every path that sets a storage
						  message runs only AFTER `if (!got.players.length) return setTeamNote(got.note)`
						  — so a note about a failed save exists exactly when this guard is false. The
						  block written to stop a silent storage failure could not render on a storage
						  failure. Measured: the sheet named all fourteen men back, with nothing saved
						  and nothing said.
						
						  The condition is the note itself now. On a clean read there IS no note —
						  `setTeamNote(null)` on success, because the list of names below is the
						  confirmation — so nothing appears where nothing went wrong.
						*/}
						{teamNote && <p className="onboard-missed">{teamNote}</p>}
					</div>
					)
				})()}
				{/* And the same note when there is no `read` to hang it on — a throw before the
				    parser returned anything. */}
				{teamNote && !read && <p className="onboard-missed">{teamNote}</p>}
				</>
				}
				</div>

				<div className="onboard-rest" ref={rest}>
				{/*
				  The second question, and the only other one. It changes who counts as a
				  good pickup more than anything else does: the bar every player is measured
				  against is the (teams x seats)-th best man, so the number of teams moves
				  every row on the board. Ten is preselected because it is Yahoo's own
				  default for baseball and is what the shipped values came from — a guess,
				  and said to be one.
				*/}
				{league && (
					<div className="onboard-teams">
						<h3>How many teams are in your league?</h3>
						<div className="chips">
							{[8, 10, 12, 14, 16].map(n => (
								<button
									key={n}
									type="button"
									className={`chip-btn${league.meta.max_teams === n ? " on" : ""}`}
									aria-pressed={league.meta.max_teams === n}
									onClick={() => {
										setTeamsAnswered(true)
										onTeamCount(n)
									}}
								>
									{n}
								</button>
							))}
						</div>
						<p className="sub">
							It changes who counts as a good pickup more than anything else does.
						</p>
					</div>
				)}

				{/*
				  THE THIRD QUESTION IS GONE, and the argument that put it here is why.
				  
				  It asked "Can you change your lineup every day?" and the case for it was real
				  at the time: `Decide`'s Today section rendered only where
				  `scoring_period.lineup_lock === "daily"`, and the shipped preset carries no
				  scoring period at all — so a reader who pressed through without answering got
				  a scoring-period plan and no tonight in it, on a screen the bar outside had
				  promised would tell him who to start tonight.
				  
				  That gate changed. Today now renders unless the league is KNOWN to lock for the
				  period, and `assumedDaily` prints the assumption on the heading it qualifies —
				  "if your league lets you change the lineup every day — most do, and My league
				  takes the answer". So the absence is stated where it matters instead of being
				  asked for up front, which is this project's own rule, and the question is one
				  select away on My league rather than one tap away here.
				  
				  And it cost more than a tap. Measured at 390x844 with the sheet open: the box
				  is 590px tall holding 998px of content, this question sat at y874 — 101px below
				  the visible bottom — and the finish button at y1113. A reader's natural gesture
				  is to press the big button he can see, which means the question most readers
				  answered was the one they never saw, and the two they did see were pushed
				  further down by the one they did not.
				*/}

				{/*
				  Everything about platforms, scoring tables and pasted pages lives here, off
				  the required path. It is true for the reader who wants it and it is the
				  wrong first question for everybody.
				*/}
				<details className="onboard-alts">
					<summary>My league scores differently</summary>
					<p className="sub">
						The numbers you are looking at come from one real Yahoo league&rsquo;s settings
						page, copied &mdash; they are not Yahoo&rsquo;s defaults and they are not yours.
						If your league
						pays differently, every ranking shifts &mdash; here is how to tell it.
					</p>
					<div className="chips onboard-where">
						{WHERE.map(w => (
							<button
								key={w.id}
								type="button"
								className={`chip-btn${where === w.id ? " on" : ""}`}
								title={w.note}
								onClick={() => {
									setWhere(w.id)
									setNote(null)
								}}
							>
								{w.label}
							</button>
						))}
					</div>
					{where && (
						<>
							{/* The one sentence about Yahoo a reader needs, said once. It is a
							    fact about Yahoo and not a thing to make his problem. */}
							{/* THE SENTENCE BRANCHES NOW, because the claim in it stopped being true of
							    every reader on the day the browser reader shipped. It is still true of
							    a WEB PAGE — Yahoo sends no header that would let one read a league, and
							    it never will — and it is false of a reader whose own browser is doing
							    the reading from inside his own signed-in tab. Saying the old sentence
							    to him would be claiming an absence the app has filled. */}

							{where === "espn" && (
								/*
								  AN ESPN READER'S BEST ROUTE WAS HIS FOURTH CLICK AND OFF SCREEN.
								
								  ESPN publishes a public league's settings to any web page that asks —
								  `readableInBrowser` is true for ESPN alone, because lm-api-reads sends
								  the CORS header Yahoo never will — so for him the whole setup is one
								  address, with nothing to copy and nothing to install. The address box
								  sat BELOW a paste box and a three-step Ctrl+A instruction he does not
								  need: measured at 390x844 on the published build, 36px under the fold.
								
								  So it comes first for him, and the paste stays underneath as the route
								  for a private league — which is a real case and the reason the paste is
								  not simply hidden here.
								*/
								<div className="onboard-first">
									<p className="sub">
										ESPN hands a public league straight over. Paste your league&rsquo;s
										address and there is nothing to copy and nothing to install.
									</p>
									<p className="onboard-url">
										<input
											type="text"
											value={url}
											placeholder="https://fantasy.espn.com/baseball/league?leagueId=…"
											onChange={e => setUrl(e.currentTarget.value)}
											aria-label="Your ESPN league's web address"
										/>
										<button type="button" className="primary" onClick={() => onImportUrl(url)} disabled={!url.trim()}>
											Read my league
										</button>
									</p>
									<p className="sub">
										A private league answers nobody, this app included &mdash; for that one,
										copy the page below.
									</p>
								</div>
							)}
							<ol className="paste-how">
								<li>
									<b>On a computer</b>, open {SETTINGS_PAGE[where]}.
								</li>
								<li>
									Hold <kbd>Ctrl</kbd> and press <kbd>A</kbd> &mdash; the whole page turns
									blue &mdash; then <kbd>Ctrl</kbd> and <kbd>C</kbd> to copy it.
								</li>
								<li>Paste it below.</li>
							</ol>
							<textarea
								data-ctl="paste-settings"
								value={pasted}
								onChange={e => {
									setPasted(e.currentTarget.value)
									draft("settings")(e.currentTarget.value)
								}}
								placeholder={"Max Teams\t10\nRoster Positions\tC, 1B, 2B, 3B, SS, OF, …"}
								rows={4}
								aria-label="Paste your league's settings page here"
							/>
							<p style={{ margin: "var(--sp-2) 0 0" }}>
								<button
									type="button"
									onClick={readSettings}
									disabled={!pasted.trim()}
								>
									Read that
								</button>
							</p>
							{note && <p className="sub paste-note">{note}</p>}
							{/* The same box again for a reader who came here some other way — a saved
							    league whose platform is already known, or a platform that turns out to be
							    importable. Not rendered twice for an ESPN reader, who has it above. */}
							{where !== "espn" && canImport && (
								<p className="onboard-url">
									<input
										type="text"
										value={url}
										placeholder="https://…"
										onChange={e => setUrl(e.currentTarget.value)}
										aria-label="Your league's web address"
									/>
									<button type="button" onClick={() => onImportUrl(url)} disabled={!url.trim()}>
										Read it from that address
									</button>
								</p>
							)}
						</>
					)}
					{/*
					  The two routes that do not care where you play, outside the platform gate.
					  
					  These used to sit inside `{where && …}`, so both were unreachable until the
					  reader had named a platform — and neither of them asks. Typing the values in
					  is the same form whoever you play with, and a saved league already HAS its
					  platform in it. That gate mattered most for the file, because it is the only
					  load door a browser with no league has: `WireChip` in App.tsx returns null
					  unless the active league is a Yahoo one, and the management toolbar is gated
					  on the dock being absent, so with nothing stored this sheet and an invisible
					  drag-and-drop were the whole of it — and the reader it is for had to claim
					  his league scores differently, then pick a platform, to find it.
					  
					  It stays behind this <details>, which is shut on a first visit: measured on
					  the published build at 390x844 and 360x640, "Load a file I saved" is not in
					  the document at all until the reader opens this drawer. A stranger with no
					  file is never shown it, which is the thing that would be worth removing.
					*/}
					<p style={{ margin: "var(--sp-3) 0 0" }}>
						<button type="button" onClick={onOpenSetup}>
							Or type the values in myself
						</button>{" "}
						<button type="button" onClick={onLoadFile}>
							Load a file I saved
						</button>
					</p>
				</details>

				{/*
				  The finish, pinned to the foot of the sheet rather than printed under it.
				  
				  Measured on the published build before this, a stranger's walk at 390x844:
				  the sheet's own scroll box was 590px tall with 713px of content in it, and
				  "Show me tonight" — the button that ends setup — sat 646px down, 56px below
				  a fold the reader had no way to know was there, because the page behind the
				  sheet goes on scrolling normally and the sheet's scrollbar is a phone's, which
				  is to say invisible. At 360x640 it was 685px down in a 447px box, 238px under.
				  The one question had been answered and the way forward was off screen.
				  
				  `onboard-foot` is only added when there IS a button: with no league this
				  paragraph is a sentence saying what the board behind the sheet is running, and
				  pinning an explanation would spend the scarcest 75px in the product on
				  something nobody has to act on — and would push "That’s my team" under it on a
				  360px phone, which is the same bug one step earlier.
				*/}
				{/*
				  STICKY ONLY WHEN THERE IS NOTHING LEFT BELOW IT.

				  Pinned from the moment a league exists, this sat ON TOP of the two chip
				  questions that come after it in the document — measured on the published
				  build at 390x844: the button at y=701, "How many teams" at 757, "Can you
				  change your lineup every day?" at 894, fifty pixels past the bottom of the
				  screen. The natural gesture is to press the big button you can see, and it
				  skipped the question the whole Tonight screen turns on.

				  A finish action that hides the remaining work is worse than one that scrolls
				  away, so it only pins once the work is done. Until then it sits in the flow
				  and the reader reaches the questions on his way to it. (Tonight no longer
				  DEPENDS on the answer either — see the note on `today` in Decide.tsx — but a
				  question the reader never sees is still a question he cannot answer.)
				*/}
				<p className={`onboard-done${league && answered ? " onboard-foot" : ""}`}>
					{league ?
						<button type="button" className={ready ? "primary" : ""} onClick={onDone}>
							{read && read.players.length ? "Show me tonight" : "Show me the board"}
						</button>
					:	<span className="sub">
							The board behind this is already running, on one real league&rsquo;s values,
							with no team
							behind it. Answering the question above makes it yours.
						</span>
					}
					{league && missing.length > 0 && (
						<span className="sub">
							{missing.map(g => g.label).join(" and ")} still missing &mdash; the board
							cannot rank without{" "}
							{missing.length === 1 ? "it" : "them"}.{" "}
							<button type="button" className="linkish" onClick={onOpenSetup}>
								Fill in
							</button>
						</span>
					)}
				</p>
				</div>
			</section>
		</div>
	)
}
