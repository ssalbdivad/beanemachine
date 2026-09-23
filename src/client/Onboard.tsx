import { useEffect, useRef, useState } from "react"
import type { Snapshot } from "../data/snapshot.ts"
import type { League } from "../schema.ts"
import { rosterFromPaste, type PastedRoster } from "../data/paste.ts"
import { lineupStore } from "./lineup.ts"
import { roster } from "./roster.ts"
import { isPreset, leagueGaps } from "./panels.tsx"
import { typingStore } from "./typing.ts"
import { Connect, browserOf, readsHere } from "./Connect.tsx"
import { useExtension } from "./extension.ts"
import { readGrabs } from "../data/yahoo-read.ts"
import { knownTeamId, refreshPool } from "./read-yahoo.ts"
import { pool as poolStore } from "./pool.ts"
import { opponentStore } from "./opponent.ts"
import type { GrabFailure } from "../data/extension.ts"

/**
 * The first thing a stranger sees: a wizard, one question per screen, platform first.
 *
 * WHAT THIS WAS, measured 2026-09-22 on the published build at 390x844 by a stranger with
 * no league. The sheet opened on "Who's on your team?" — asking for the TEAM before it knew
 * the PLATFORM — and then offered three routes at once: a "Read my Yahoo league for me"
 * button that assumed Yahoo, a box to paste a roster page into, and the same box to type
 * names into. Under that a privacy paragraph, "Only got a few? Start with your starters",
 * and a fold titled "My league scores differently", which is where the platform question
 * actually lived — under a paragraph explaining the app ("The board behind this runs on one
 * real league's values..."). Inside the fold: Yahoo/ESPN/Somewhere else chips, a
 * Ctrl+A/Ctrl+C settings-page routine, "Or type the values in myself", and "Load a file I
 * saved". First screen: 79 words, 4 controls, 583px. With the fold open and Yahoo chosen:
 * 137 words, 11 controls, 1,051px in a sheet capped at 590. The Yahoo reader walkthrough on
 * its own: 216 words, 1,246px. The owner's word for it was "the epitome of bloat and
 * confusion", and every number above agrees with him.
 *
 * WHAT IT IS NOW. Five screens, and the reader sees two or three of them:
 *
 *  · "where" — Yahoo, ESPN, Somewhere else. Three buttons and nothing else, except a
 *    small link to load a saved file, which stays because it is the ONLY door a saved
 *    league has back into a browser that holds nothing (App's toolbar is hidden while
 *    this sheet is up).
 *  · "yahoo" — the browser reader, which is the one route that gets a Yahoo league in
 *    without typing. Only where the reader can actually be installed (`readsHere`):
 *    anywhere else Yahoo goes straight to "team", and nothing says why, because a
 *    sentence about what a reader's phone lacks is an explanation, not an instruction.
 *  · "espn" — one address box. ESPN publishes a public league's settings to any page
 *    that asks, so the whole setup is a link.
 *  · "team" — type the players. Every platform ends here if its own route fails, and
 *    "Somewhere else" starts here, because it is the route that works everywhere.
 *  · "teams" — how many teams, and only when the league does not already say (`asksTeams`).
 *    It was drawn under the team box once the team was read, and that screen then held
 *    four things at once: "Replace my team", the "Did you mean" chips, the count chips and
 *    the finish. The chips that correct the TEAM stay with the team; the count is its own
 *    screen, reached by "Next", and the finish is on it.
 *
 * ONE PATH PER PLATFORM, and the alternatives were deleted rather than folded. The
 * settings-page paste was the richest route (it reads scoring, slots and team count off a
 * page) and it was also a Ctrl+A instruction no phone can follow, sitting beside a reader
 * that reads the same page in one press. Its PARSER stays — src/data/paste-settings.ts is
 * what the browser reader hands Yahoo's settings page to, via `readGrabs` — only the box
 * that exposed it here is gone. A league whose scoring the preset does not match has NO
 * door from this sheet: the "missing" line under the finish links to My league only when
 * `leagueGaps` finds a value with no answer, and a preset has an answer for every one — it
 * is borrowed, not blank. A reader who adopted the preset (typing his team does) and scores
 * differently changes the values on My league, reached from the app's own navigation once
 * the sheet is closed. (This comment used to claim the "missing" line was that door.)
 *
 * EVERY SCREEN BUT THE FIRST HAS A WAY BACK to the first, at the top, because the answer
 * to "where" is the one a reader most often gets wrong (a Yahoo reader on a phone, an
 * ESPN reader with a private league) and the cost of that mistake must be one tap.
 *
 * UI TEXT INSTRUCTS AND NOTHING ELSE. Every string on these screens is an imperative or a
 * label, under a dozen words. The arguments for each choice live here, in comments, where
 * the next person to change the screen will read them and the reader never has to.
 */

/** Four real men, so the box shows the shape of an answer rather than describing it.
 *  Kept as a literal and pinned by test/paste.mjs against the shipped capture: a
 *  placeholder naming somebody who is not in the data would teach the wrong format on
 *  the one screen that has to get the format across. */
const PLACEHOLDER = "C Cal Raleigh\n1B Ben Rice\nOF Aaron Judge\nSP Tarik Skubal"

/** When the stored free-agent list says it was read, or null when there is no list.
 *  Read back off the store rather than remembered from the sweep, so the receipt cannot
 *  outlive the thing it describes; forgiving, because a damaged pool store is the
 *  free-agent chip's to explain and the receipt still has a league to name. */
const poolAt = (leagueKey: string): string | null => {
	try {
		return poolStore.of(leagueKey)?.at ?? null
	} catch {
		return null
	}
}

/** The platform a league was created for. Part of `onCreateLeague`'s signature, which
 *  App.tsx implements, so it keeps its three members even though only "yahoo" is passed
 *  from this file now (the settings paste that passed the other two is gone). */
type Where = "yahoo" | "espn" | "custom"

/** The screens, in the order a reader can meet them. "where" is always first on a fresh
 *  sheet; "Somewhere else" has no screen of its own because its route IS "team". */
type Step = "where" | "yahoo" | "espn" | "team" | "teams"

export const Onboard = ({
	snapshot,
	snapshotError,
	leagueKey,
	league,
	openConnect = false,
	onCreateLeague,
	onAdoptPreset,
	onTeamCount,
	onAddSuggested,
	onImportUrl,
	onOpenSetup,
	onDone
}: {
	snapshot: Snapshot | null
	/** The league this browser holds once one exists, so the last step can put a
	 *  team in it and the finish button can say what it is finishing. */
	leagueKey: string | null
	league: League | null
	/** Why the player list could not be loaded, when it could not.
	 *
	 *  THIS SLOT USED TO BE `canImport`, a boolean the wizard stopped reading when the
	 *  generic "read it from that address" box went, and which the comment here kept alive
	 *  on the grounds that App.tsx passes it. A prop nothing reads is not an interface, it
	 *  is a line App.tsx has to keep true about a component that does not care — so it is
	 *  replaced rather than removed, by the one fact the sheet was missing. See `readTeam`
	 *  and `readLeague`: both open `if (!snapshot) return`, and a button that returns in
	 *  silence is the exact defect this file's own docstring says it fixed once already. */
	snapshotError: string | null
	/** Another screen asked for the Yahoo reader rather than the first question — see
	 *  `onConnect` in src/client/Trade.tsx, which is the screen a reader with a league is
	 *  standing on and the one place the reader was never offered. */
	openConnect?: boolean
	onCreateLeague: (platform: Where, league: League) => void
	/** Turns the preview the reader is looking at into a real league in this browser,
	 *  and returns its key. Called at the moment he first writes something of his own:
	 *  before that there is nothing to attach it to. */
	onAdoptPreset: () => string | null
	/** Accept one "did you mean" — the reader has read the name and tapped it, which is
	 *  the only way a suggestion is ever allowed to become a roster entry.
	 *  Resolves true only when the man actually landed in a league's roster. The chip
	 *  below must not cross itself off on a failure — see the note at the call site. */
	onAddSuggested: (id: number, group: "hitting" | "pitching", name: string) => Promise<boolean>
	/** How many teams this league has. The bar every player is measured against is the
	 *  (teams x seats)-th best man, so the count moves every row on the board. */
	onTeamCount: (teams: number) => void
	onImportUrl: (url: string) => void
	onLoadFile: () => void
	onOpenSetup: () => void
	onDone: () => void
}) => {
	const ext = useExtension()
	/** Whether this browser can run the Yahoo reader AND has somewhere to get it from. A
	 *  Yahoo reader for whom this is false is sent straight to typing his team. */
	const reads = readsHere(browserOf())
	/** Where the reader is. The Yahoo answer resolves to "team" wherever the reader cannot
	 *  be installed, so no screen is ever drawn that only says it cannot help. */
	/* A sheet with a half-typed team in it is not a fresh sheet: the draft is kept in the
	   browser precisely so that Escape, Back and a reload do not cost him the typing (see
	   src/client/typing.ts), and reopening onto "Where's your league?" would hide the box
	   that holds it one screen away. So a draft reopens on the team step; everything else
	   opens on the platform question. */
	const [step, setStep] = useState<Step>(() =>
		typingStore.of(leagueKey, "team").trim() ? "team" : "where"
	)
	const yahoo = (): Step => (reads ? "yahoo" : "team")
	/* Opened straight onto the reader when another screen asked for it — see `onConnect`
	   in src/client/Trade.tsx. An effect rather than the initialiser, because this sheet is
	   mounted once and hidden while closed (closing it must not discard what he typed), so a
	   lazy initial value would only ever be read at app start. */
	useEffect(() => {
		if (openConnect) setStep(yahoo())
	}, [openConnect])
	const [readFailure, setReadFailure] = useState<GrabFailure | null>(null)
	const [receipt, setReceipt] = useState<{ league: string | null; free: number | null; at: string | null }>({
		league: null,
		free: null,
		at: null
	})
	/*
	  THE BOX SURVIVES THE SHEET BEING CLOSED.

	  This sheet is mounted by App as `{docked && <Dock>}`, and closing it with a league in
	  existence takes `docked` false and unmounts everything here. Escape is the gesture a
	  phone keyboard teaches, and it was throwing away eighteen typed lines. The text is kept
	  in the browser as it is typed instead, so it survives Escape, Back, a tab press and a
	  reloaded phone. See src/client/typing.ts for why the draft rather than the component.
	*/
	const [note, setNote] = useState<string | null>(null)
	const [url, setUrl] = useState("")
	const [team, setTeam] = useState(() => typingStore.of(leagueKey, "team"))
	const [teamNote, setTeamNote] = useState<string | null>(null)
	/** How many men this league already holds, read rather than inferred: the button under
	 *  the box changes on it. Forgiving, because a damaged roster store is My league's to
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

	/*
	   WHAT "ANSWERED" MEANS.

	   The last question on the sheet is the team count, and it is PRE-FILLED — ten, Yahoo's
	   own default. So "answered" is about the reader rather than about the data: once he has
	   touched it there is nothing left below the finish, and pinning it is what the note on
	   `.onboard-foot` argues for. (It used to be `!!league?.scoring_period?.lineup_lock`, the
	   answer to a question this sheet stopped asking, which left the finish permanently
	   unpinned — measured at 390x844, the chips six pixels under the fold and "Show me
	   tonight" 172px under that.)
	*/
	const [teamsAnswered, setTeamsAnswered] = useState(false)

	/*
	   THE QUESTION HIS OWN LEAGUE PAGE ANSWERS.

	   Yahoo prints "Max Teams" on the settings page and every press of the reader fetches
	   that page, so a reader with the add-on installed is being asked for a number that is
	   two requests away. Where the press is available it is offered INSTEAD of the chips,
	   and where it is not — no add-on, or a press already made that came back without the
	   row — the chips are exactly what they were. `readTried` is the whole fallback: one
	   press, then the chips.
	*/
	const [readTried, setReadTried] = useState(false)
	/** The step "teams" was reached from, so its Back returns there — the team box, or the
	 *  Yahoo reader whose read came back without the count. */
	const [teamsFrom, setTeamsFrom] = useState<Step>("team")
	/** Set only by the team-count question's "read it off my Yahoo league" offer — see `back`. */
	const [cameFromTeams, setCameFromTeams] = useState(false)
	/*
	   A PRIVATE ESPN LEAGUE, SAID ON THE ESPN SCREEN AS AN INSTRUCTION.

	   `onImportUrl` returns nothing, and the failure it produces is App's `run` putting the
	   ImportError's text in the toast: "ESPN returned HTTP 401 for league X: that league is
	   not publicly viewable, and reading a private one would need your ESPN cookies." (from
	   src/import.ts). That sentence explains; the screen the reader is standing on should
	   instruct, and the instruction is the link already on it. Neither App's interface nor
	   import.ts is this file's to change, so the sheet reads what reaches the page: App's
	   always-mounted live region (`role="status"`), watched only between a press and the
	   next edit of the address. 401 and 403 are the two statuses import.ts words as "not
	   publicly viewable", and the match is on that phrase or on those statuses together
	   with "ESPN", so a toast about something else cannot trip it.
	*/
	const [espnAsked, setEspnAsked] = useState(false)
	const [espnPrivate, setEspnPrivate] = useState(false)
	useEffect(() => {
		if (!espnAsked) return
		const region = document.querySelector('[role="status"]')
		if (!region) return
		const check = () => {
			const said = region.textContent ?? ""
			if (/not publicly viewable|ESPN returned HTTP 40[13]\b/i.test(said)) setEspnPrivate(true)
		}
		/* No check on arming: a bad toast lives 6.5s, so a press on a NEW address inside that
		   window read the old league's refusal and called the new one private before its read
		   had answered. Only a change to the region, made after the press, is this press's. */
		const watch = new MutationObserver(check)
		watch.observe(region, { childList: true, characterData: true, subtree: true })
		return () => watch.disconnect()
	}, [espnAsked])
	const asksTeams = !!league && (league.meta.max_teams === null || isPreset(league))
	const offerPress = asksTeams && ext.present && !readTried

	const answered = !asksTeams || teamsAnswered

	/*
	   THE MOMENT A LEAGUE APPEARS, THE REST OF THE SHEET IS BELOW THE FOLD.

	   Pressing "That's my team" replaces the question he answered with two things he has not
	   seen: the team count, and the button that ends setup. Measured at 390x844 they landed at
	   y=850 and y=1016 against an 844px screen and the sheet did not move; a phone draws no
	   scrollbar, so nothing said anything followed. So the sheet brings them to him, once, on
	   the transition. `block: "nearest"` scrolls the least that will do.
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
		rest.current?.scrollIntoView({ block: "nearest" })
	}, [league])
	const gaps = league ? leagueGaps(league) : []
	const missing = gaps.filter(g => g.have === null)
	const ready = !!league && missing.length === 0

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
	 *
	 * THE SECOND HALF IS `refreshPool`; THE FIRST HALF CANNOT BE `readLeagueHere` YET, and the
	 * two reasons are worth writing down because the duplication reads like laziness and is
	 * not. `readLeagueHere` takes a `leagueKey: string` and passes it into `readGrabs` as what
	 * the read is expected to be ABOUT, so a tab showing a different league is refused. That
	 * is exactly right on My league, where the screen's league is the authority — and it is
	 * exactly wrong here, where the tab IS what the reader is adopting and no key exists yet
	 * on a first visit (the board behind this sheet is a preview). Sharing the first half
	 * needs `readLeagueHere` to take something like `adopt: true`, which means editing
	 * src/client/read-yahoo.ts.
	 */
	const readLeague = async () => {
		/* SAME SILENT RETURN AS `readTeam`, and the same repair — see the note there. The
		   press that pulls a whole Yahoo league across needs the player list to match the
		   names it reads against, so it opened `if (!snapshot) return` and, on a read that
		   failed, did nothing forever with a fully drawn screen in front of the reader. The
		   button is disabled while the list is on its way (`waiting`, below), so this branch
		   is the error case alone: say it where the read's other failures are said. */
		if (snapshotError)
			return setNote(
				`The player list couldn’t be loaded, so your league can’t be matched to it yet: ${snapshotError}`
			)
		if (!snapshot) return
		setReadFailure(null)
		/* Before the await, not after: a press that throws has still been made, and the
		   question must not go on offering a route the reader has already taken. */
		setReadTried(true)
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
			/* `onCreateLeague` is the one door a league comes in by, so an extension read
			   lands with the same validation and provenance rules as every other route. The
			   extension is a way of getting the page, not a second way of having a league. */
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
					fix: null
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

		/*
		   THE FREE AGENTS, SECOND AND SEPARATELY — and by the SAME function the chip calls.

		   This was forty-eight lines that re-implemented `refreshPool` from src/client/read-yahoo.ts:
		   the same `ext.ask("pool")`, the same `readGrabs`, and a `poolStore.set` call copied
		   field for field down to the `note` string the chip prints. The file it was copied
		   from opens with "READING A LEAGUE, IN ONE PLACE, because two places would drift",
		   and the two had already drifted in two measurable ways:

		    · A sweep that came back with NOBODY in it set no failure here and returned. The
		      reader pressed the button, the receipt kept saying whatever the league read had
		      said, and nothing on the screen mentioned the nine requests that had just come
		      back empty. `refreshPool` answers that case with "that came back with nobody in
		      it" and "Open your league's players page on Yahoo and try again."
		    · A refused `poolStore.set` — a private window, a full phone — reported `fix: null`
		      here against `refreshPool`'s "A private window usually does this, and so does a
		      full phone." `Connect` renders `failure.fix`, so the reader with the one cause he
		      could actually act on was the one reader told nothing.

		   Both are now whatever the shared function says, because there is one of them.

		   NINE REQUESTS ONLY ON A READ THAT WORKED. Asking Yahoo nine times on behalf of a
		   reader whose own league page we could not even parse is asking for a throttle to
		   punish a failure, so the sweep is refused where there is no league id and no key to
		   file it under.
		*/
		if (!reading.leagueId || !key) return
		const swept = await refreshPool(ext, snapshot, key, reading.leagueId, reading.sport ?? "baseball")
		if (swept.notes.length) setNote(swept.notes.join(" "))
		if (swept.added !== null)
			/* The instant off the STORE rather than off the read, so the receipt cannot outlive
			   the list it is about — the same rule the dock bar's summary follows. */
			setReceipt(r => ({ ...r, free: swept.added, at: poolAt(key) ?? r.at }))
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
	/**
	 * WHAT A PRESS DOES BEFORE THE PLAYER LIST HAS ARRIVED, which until now was nothing.
	 *
	 * `public/snapshot.json` is a megabyte, and both primary buttons in this wizard open
	 * `if (!snapshot) return`. On a phone on a slow connection that is a multi-second window
	 * in which the sheet is fully drawn and typeable; on a read that FAILED it never ends,
	 * and the sheet renders identically to one that is ready. The reader types his team,
	 * presses the button, and the app says nothing and changes nothing — which is word for
	 * word the defect this file's docstring below says was fixed, on the `leagueKey` half of
	 * the same condition. The `snapshot` half survived it.
	 *
	 * Both buttons carry it now: disabled while the list is on its way, with the label saying
	 * so, and a note rather than a silent return when it will never arrive.
	 */
	const waiting = !snapshot && !snapshotError
	const readTeam = () => {
		if (snapshotError)
			return setTeamNote(
				`The player list couldn’t be loaded, so your team can’t be matched to it yet: ${snapshotError}`
			)
		if (!snapshot) return
		const got = rosterFromPaste(team, snapshot)
		setRead(got)
		setAdded([])
		if (!got.players.length) return setTeamNote(got.note)
		const key = leagueKey ?? onAdoptPreset()
		if (!key) return setTeamNote("Your team could not be saved. Try again.")
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
				`Your team could not be saved in this browser: ${(e as Error).message}`
			)
		}
	}

	/*
	  "LOAD A FILE I SAVED" DID NOTHING ON A FIRST VISIT, and still would through the prop.

	  `onLoadFile` is `() => openPicker.current?.()` in App.tsx, and `openPicker` is filled in
	  by the management toolbar's own `<input type=file>` — which is not mounted while this
	  sheet is up on a browser with no league. Measured on the published build 2026-09-22:
	  pressing the link raised no file chooser at all (Playwright's `filechooser` wait timed
	  out), so the one door a saved league has back into an empty browser was a dead link.

	  The prop's signature is `() => void` and App.tsx is not this file's to change, so the
	  sheet carries its own picker and hands the chosen file to App's loader by the one other
	  route App already has: its window-level `drop` handler, which calls the same `loadFile`
	  (same confirm, same `leagues.replace`, same toast) that the toolbar's picker does. A
	  synthetic drop is a strange shape for a button press and is written down here so nobody
	  mistakes it for an accident; the clean fix is for App to pass `loadFile` itself (it has
	  `(file: File) => void` already, used by the Setup card), and then this becomes
	  `onLoadFile(file)` and the dispatch goes. `onLoadFile` stays in the prop interface.
	*/
	const picker = useRef<HTMLInputElement | null>(null)
	const handOver = (file: File) => {
		const dt = new DataTransfer()
		dt.items.add(file)
		window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }))
	}

	/** The one way off every screen but the first. At the TOP, because on a phone the foot
	 *  of the sheet is under the keyboard. Every step backs to "where" except "teams",
	 *  which backs to the step that sent the reader to it. */
	const backTo = (to: Step) => (
		<p className="onboard-back">
			<button type="button" className="as-link" onClick={() => setStep(to)}>
				&larr; Back
			</button>
		</p>
	)
	/**
	 * BACK GOES WHERE HE CAME FROM, and on the yahoo step that is not always "where".
	 *
	 * The three platform steps share one Back and it went to the first question. That is
	 * right when the reader arrived by answering it, and wrong on the one route that reaches
	 * the yahoo step from somewhere else: the last question, "How many teams are in your
	 * league?", offers "Read the team count off my Yahoo league" and sets `step` to yahoo.
	 * Back from there dropped him at "Where's your league?" — two screens behind the question
	 * he was answering, with the answer he had already given behind him.
	 *
	 * `teamsFrom` already records the step the count question was reached from, for its own
	 * Back. This is the same idea one level up, set by that offer alone, so every other route
	 * into the yahoo step still backs to the first question.
	 */
	const back = backTo(cameFromTeams ? "teams" : "where")
	/** The one alternative a platform route offers, and it exists because a read can fail:
	 *  a private ESPN league, a Yahoo reader that will not install. Same words on both. */
	const typeInstead = (
		<p className="connect-back">
			<button type="button" className="as-link" onClick={() => setStep("team")}>
				Type your players instead
			</button>
		</p>
	)

	return (
		<div className="grid">
			<section className="card full onboard" data-step={step}>
				{/*
				  TWO WRAPPERS, and they exist for ONE viewport: a phone held sideways.

				  Measured at 844x390 with the sheet open: the box was 288px tall holding 557px of
				  content, so the team-count question sat 19px below the visible bottom while the
				  finish button sat above it. In a short, wide viewport these two become columns —
				  the step on the left, the remaining question and the way out on the right — and
				  everywhere else they are two plain blocks in a column. See `.onboard` in the
				  landscape rule of src/client/app.css.
				*/}
				<div className="onboard-main">
				{step === "where" && (
					<>
						<h2>Where&rsquo;s your league?</h2>
						{/* Three answers, stacked and full width, because they are the whole screen
						    and a thumb should not have to aim. `.onboard-where` is the hook the
						    suites click by label. */}
						{/* Answering this question clears `cameFromTeams`: it is set by the team-count
						    screen's Yahoo shortcut so that Back from the yahoo step returns to the
						    count, and a reader who has walked back out to this question is no longer
						    on that errand. Left set, a later yahoo → Back would have sent him
						    FORWARD to a question he had not reached yet. */}
						<div className="onboard-where">
							<button
								type="button"
								onClick={() => {
									setCameFromTeams(false)
									setStep(yahoo())
								}}
							>
								Yahoo
							</button>
							<button
								type="button"
								onClick={() => {
									setCameFromTeams(false)
									setStep("espn")
								}}
							>
								ESPN
							</button>
							<button
								type="button"
								onClick={() => {
									setCameFromTeams(false)
									setStep("team")
								}}
							>
								Somewhere else
							</button>
						</div>
						{/* Small and last: it is for the reader who already has a file, and he
						    knows he is looking for it. The only door a saved league has back in —
						    App hides its toolbar while this sheet is up. */}
						<p className="onboard-file">
							<button type="button" className="as-link" onClick={() => picker.current?.click()}>
								Load a file I saved
							</button>
							<input
								ref={picker}
								type="file"
								accept="application/json,.json"
								hidden
								aria-label="Load a league file you saved"
								onChange={e => {
									const chosen = e.currentTarget.files?.[0]
									/* Cleared either way, so picking the same file twice fires again. */
									e.currentTarget.value = ""
									if (chosen) handOver(chosen)
								}}
							/>
						</p>
					</>
				)}

				{step === "yahoo" && (
					<>
						{back}
						<Connect
							ext={ext}
							leagueName={receipt.league}
							freeAgents={receipt.free}
							readAt={receipt.at}
							failure={readFailure}
							onRead={() => void readLeague()}
							/* The list this read matches names against is a megabyte, so on a phone
							   there is a window where this sheet is drawn and the press does nothing.
							   Connect says so on the button rather than looking ready. */
							waiting={waiting}
							onBack={() => setStep("team")}
						/>
						{/* What the read itself said — a stat whose value would not parse, a sweep
						    that came back empty. Written by `readLeague`, and it had nowhere to show
						    once the settings-paste box it used to share went. */}
						{note && <p className="sub paste-note">{note}</p>}
					</>
				)}

				{step === "espn" && (
					/*
					  ONE ADDRESS, because for ESPN that is the whole setup. ESPN publishes a public
					  league's settings to any web page that asks — lm-api-reads sends the CORS
					  header Yahoo never will — so there is nothing to copy and nothing to install.
					  A private league refuses, App's `run` says so in the toast, and the link
					  under the box is the way on.
					*/
					<>
						{back}
						<h2>Paste your ESPN team link</h2>
						{/*
						  HIS TEAM'S PAGE, NOT HIS LEAGUE'S, and the difference is the whole setup.

						  This asked for the league page and showed `…/baseball/league?leagueId=…`
						  as the example. `detect` in src/import.ts reads the team out of the query
						  string — `teamId: u.match(/teamId=(\d+)/)?.[1] ?? null` — and a league URL
						  never carries one, so the import came back with `team_id: null` and
						  src/import.ts's own note fires: "The URL didn't carry `teamId=`, so which
						  of these teams is yours is not known."

						  The chain that produced, walked through the code: the wizard's finish
						  appears the moment a league exists, so the ESPN reader is told he is done
						  with nought players; Tonight then says "Add the players you own"; that
						  lands him on My league; and the pull button there is
						  `disabled={pulling || !readTeamId}` under the caption "Enter your team
						  number above." The last instruction a finished wizard gave him is to go
						  and find his own numeric id.

						  The team page always carries it, and it is what his address bar actually
						  shows while he is looking at his team — so asking for that one costs the
						  reader nothing and is the difference between a setup that finishes and
						  one that hands him a number to hunt for.

						  STILL OUTSTANDING, deliberately: with `teamId` in hand the roster could be
						  read in the same press, the way the Yahoo route does (`readLeague` writes
						  roster and lineupStore together). That needs `onImportUrl` to report what
						  it imported, which it does not — it returns void — so it is a change to
						  App's interface rather than to this screen, and it is not this commit.
						*/}
						<p className="sub">Open your team on ESPN and copy the address.</p>
						<p className="onboard-url">
							<input
								type="text"
								value={url}
								placeholder="https://fantasy.espn.com/baseball/team?leagueId=…&teamId=…"
								onChange={e => {
									setUrl(e.currentTarget.value)
									/* A new address is a new question; the old answer about the
									   old one must not sit under it. */
									setEspnAsked(false)
									setEspnPrivate(false)
								}}
								aria-label="Your ESPN team's web address"
							/>
							<button
								type="button"
								className="primary"
								onClick={() => {
									/* Not cleared here: an edit already cleared it, and a second
									   press on the same private address leaves the toast's text
									   unchanged, so nothing would set it again. */
									setEspnAsked(true)
									onImportUrl(url)
								}}
								disabled={!url.trim()}
							>
								Read my league
							</button>
						</p>
						{/* After a private league's refusal the link becomes the second half of the
						    instruction, on one line, so the screen still has exactly one way on. */}
						{espnPrivate ?
							<p className="connect-back onboard-private">
								That league is private.{" "}
								<button type="button" className="as-link" onClick={() => setStep("team")}>
									Type your players instead
								</button>
							</p>
						:	typeInstead}
					</>
				)}

				{step === "team" && (
					<>
						{back}
						<h2>Who&rsquo;s on your team?</h2>
						{/* "one per line" is the instruction; `rosterFromPaste` also matches names
						    inside a pasted roster page (game times, stat columns and all), so a
						    reader who pastes instead of typing is not wrong, just not told. */}
						<p className="sub">Type your players, one per line.</p>
						<textarea
							data-ctl="onboard-team"
							value={team}
							onChange={e => {
								setTeam(e.currentTarget.value)
								typingStore.set(leagueKey, "team", e.currentTarget.value)
							}}
							placeholder={PLACEHOLDER}
							rows={5}
							aria-label="The players on your team"
						/>
						{/*
						  THE BOX REPLACES, and once a team is stored the button says so.

						  A second paste REPLACES the stored team — measured: thirteen names, then two
						  more in a cleared box, leaves two men — and the box emptying on success is
						  what makes the second paste look like an append. So with a team stored the
						  button's own label states the rule. The line beside it ("Replaces all 3.
						  Add one on My league.") was cut: the first half repeated the label and the
						  second explained where another feature lives.

						  `.onboard-go button` must match exactly ONE element on the sheet: the suites
						  click it to submit the team, and twice a second button under the same class
						  sent them to the wrong screen.
						*/}
						<p className="onboard-go">
							<button
								type="button"
								className="primary"
								onClick={readTeam}
								disabled={!team.trim() || waiting}
							>
								{waiting ?
									"Loading players…"
								: held > 0 ?
									"Replace my team"
								:	"That’s my team"}
							</button>
						</p>
						{/* The one line left of the privacy paragraph ("Nothing leaves this phone. There
						    is no account — your team is saved in this browser and nowhere else."). What
						    survives is the fact a reader acts on — the team is KEPT, here, so a cleared
						    browser or another phone will not have it — said as a fact, not an argument. */}
						<p className="onboard-saved">Saved in this browser.</p>
				{/*
				  The answer, in the same sheet, before he goes anywhere.
				  
				  Names ticked back as the app spells them, so he can check four of them in
				  four seconds — a count cannot be checked. And every line that produced
				  nobody, quoted verbatim: a silent drop is the one failure a reader never
				  notices, and two mistyped names would otherwise be missing from every
				  recommendation for the rest of the season with nothing on screen about it.
				*/}
				{/* A line whose suggestion the reader has accepted is no longer missing, and
				    quoting it back as unfound would be false the moment he taps. The quote
				    ends in an instruction; it used to end "Nothing in them is counted
				    anywhere.", which explained the app instead of saying what to do. */}
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
								Check the spelling and try again.
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
								Two players share {read.ambiguous.join(" and ")}. Add a position in
								front of yours.
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
				)}
				{/*
				  THE TEAM COUNT, ITS OWN STEP, ASKED ONLY WHEN HIS LEAGUE HAS NOT ALREADY SAID.

				  Yahoo prints "Max Teams" on the settings page and ESPN states `size`, so a league
				  that arrived by a read already carries the number. A PRESET is the case that must
				  still ask: its ten is borrowed from somebody else's league. Ten is preselected
				  because it is Yahoo's own default.

				  Two screens can produce a league the count is missing from — typing a team (which
				  adopts the preset) and the Yahoo reader once a read has come back without the row
				  — and on those two the way on is "Next", to this step, instead of the finish. It
				  used to be drawn under them, which put a second question on a screen that was
				  still answering the first. The ESPN read always carries `size`.
				*/}
				{step === "teams" && league && asksTeams && (
					<div className="onboard-teams">
						{backTo(teamsFrom)}
						<h2>How many teams are in your league?</h2>
						{offerPress && (
							/* Its own class, because a class naming a control belongs to one
							   control and the suites address this one by it. */
							<p className="onboard-offer onboard-teams-read">
								<button
									type="button"
									className="as-link"
									onClick={() => {
										setCameFromTeams(true)
										setStep("yahoo")
									}}
								>
									Read the team count off my Yahoo league
								</button>
							</p>
						)}
						{/* ALWAYS, NOT INSTEAD — see the note on `offerPress`. These chips are the
						    answer every reader can give whatever platform he is on; the line above is
						    a shortcut for one of them. Drawn as the alternative to that line, they
						    left a non-Yahoo reader on the last screen of the wizard with nothing on
						    it he could press. */}
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
					</div>
				)}
				</div>

				<div className="onboard-rest" ref={rest}>
				{/*
				  "NEXT" INSTEAD OF THE FINISH, on the two screens that lead to the count.

				  On the team box only once a team has been read (before that the one action is
				  the submit), and on the reader only once a press has been made. Its own class
				  rather than `.onboard-done`, which the suites press to END setup.
				*/}
				{league && asksTeams && !teamsAnswered &&
				((step === "team" && !!read?.players.length) || (step === "yahoo" && readTried)) ? (
					<p className="onboard-next">
						<button
							type="button"
							className="primary"
							onClick={() => {
								setTeamsFrom(step)
								setStep("teams")
							}}
						>
							Next
						</button>
					</p>
				) : (
				/*
				  THE FINISH, pinned to the foot of the sheet once there is nothing left below it.

				  Measured on the published build before pinning, at 390x844: the sheet's scroll
				  box was 590px tall with 713px in it and "Show me tonight" sat 56px below a fold
				  nobody could see. Pinned from the moment a league exists, though, it sat ON TOP
				  of the team-count chips — a finish that hides the remaining work is worse than
				  one that scrolls away — so it pins only once that question is answered.

				  With no league there is no finish, and nothing in its place. This paragraph used
				  to say "The board behind this runs on one real league's values. Answering the
				  question above makes it yours." — the app explaining itself, on a screen whose
				  only job is to ask. It is not rendered at all now.
				*/
				league && (
					<p className={`onboard-done${answered ? " onboard-foot" : ""}`}>
						<button type="button" className={ready ? "primary" : ""} onClick={onDone}>
							{/*
						  ONE LABEL, BECAUSE THERE IS ONE DESTINATION AND NO SCREEN CALLED A BOARD.

						  This branched on `read && read.players.length` between "Show me tonight" and
						  "Show me the board". Both press `onDone`, which goes to `view: "board"` —
						  the tab labelled **Tonight**. The screen this app actually calls a board is
						  `wire`, labelled Pickups. So one of the two labels named a screen that does
						  not exist and neither named a different one.

						  The branch was also backwards about who deserved which. `read` is set only
						  by `readTeam`, the typed-textarea route, so a reader who pressed one button
						  and pulled his whole Yahoo league across — roster, seats, opponent — was
						  told "Show me the board", and the reader who typed four names got the
						  specific one. It was measuring which code path ran, not what he has.
						*/}
						Show me tonight
						</button>
						{missing.length > 0 && (
							<span className="sub">
								{missing.map(g => g.label).join(" and ")} missing.{" "}
								<button type="button" className="linkish" onClick={onOpenSetup}>
									Fill in
								</button>
							</span>
						)}
					</p>
				))}
				</div>
			</section>
		</div>
	)
}
