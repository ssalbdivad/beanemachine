import { useState } from "react"
import type { Snapshot } from "../data/snapshot.ts"
import type { League } from "../schema.ts"
import { leagueFromPastedSettings } from "../data/paste-settings.ts"
import { rosterFromPaste, type PastedRoster } from "../data/paste.ts"
import { lineupStore } from "./lineup.ts"
import { roster } from "./roster.ts"
import { leagueGaps } from "./panels.tsx"

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
	onCreateLeague,
	onAdoptPreset,
	onTeamCount,
	onLineupLock,
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
	onCreateLeague: (platform: Where, league: League) => void
	/** Turns the preview the reader is looking at into a real league in this browser,
	 *  and returns its key. Called at the moment he first writes something of his own:
	 *  before that there is nothing to attach it to. */
	onAdoptPreset: () => string | null
	/** Whether this league's lineup can be changed daily. Only the reader knows — no
	 *  platform preset can say, because one platform hosts both kinds. */
	onLineupLock: (lock: "daily" | "period") => void
	/** Accept one "did you mean" — the reader has read the name and tapped it, which is
	 *  the only way a suggestion is ever allowed to become a roster entry. */
	onAddSuggested: (id: number, group: "hitting" | "pitching", name: string) => void
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
	const [pasted, setPasted] = useState("")
	const [note, setNote] = useState<string | null>(null)
	const [url, setUrl] = useState("")
	const [team, setTeam] = useState("")
	const [teamNote, setTeamNote] = useState<string | null>(null)
	/** The last read of the team box, kept so the sheet can name every player back and
	 *  quote every line that produced nobody. */
	const [read, setRead] = useState<PastedRoster | null>(null)
	/** Which suggested names this reader has already accepted, so a tapped chip does
	 *  not sit there inviting a second tap that would do nothing. */
	const [added, setAdded] = useState<number[]>([])

	/** Everything the sheet still wants. The lock is the one that decides whether Tonight
	 *  is a list of changes or a plan for the period, so it is what "done" means here. */
	const answered = !!league?.scoring_period?.lineup_lock
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
		setNote(
			`Read ${stats} scored stats` +
				(seats ? `, ${seats} roster seats` : "") +
				(made.meta.max_teams ? ` and ${made.meta.max_teams} teams` : "") +
				`. ` +
				(read.missing.length ?
					`It carried no ${read.missing.join(" and no ")} — fill those in below and the board can rank.`
				:	`That is everything the board needs.`)
		)
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
				<p className="sub">
					First and last name, one to a line. Put the position first if you know it.
				</p>
				<textarea
					data-ctl="onboard-team"
					value={team}
					onChange={e => setTeam(e.currentTarget.value)}
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
				<p className="onboard-go">
					<button
						type="button"
						className="primary"
						onClick={readTeam}
						disabled={!team.trim()}
					>
						That&rsquo;s my team
					</button>
					<span className="sub">
						Only got a few? Start with your starters. You can add the rest later.
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
											onClick={() => {
												onAddSuggested(g.id, g.group, g.name)
												setAdded(a => [...a, g.id])
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
						{teamNote && !read.players.length && (
							<p className="onboard-missed">{teamNote}</p>
						)}
					</div>
					)
				})()}
				{/* And the same note when there is no `read` to hang it on — a throw before the
				    parser returned anything. */}
				{teamNote && !read && <p className="onboard-missed">{teamNote}</p>}

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
									onClick={() => onTeamCount(n)}
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
				  THE THIRD QUESTION, AND IT IS THE ONE THE BAR OUTSIDE PROMISES.

				  The dock says "Tell it who's on your team and it will tell you who to start
				  tonight", and the button below says "Show me tonight" — and on the route a
				  first visit actually takes, neither was true. `Decide`'s Today section
				  renders only where `scoring_period.lineup_lock === "daily"`, and the shipped
				  preset carries no `scoring_period` at all (verified: undefined), so the card
				  came up with a scoring-period plan and no tonight in it. Repro on the
				  published build with a fresh profile: paste 18 men, press through, and the
				  Today section is simply absent.

				  There is no honest way to read this off a preset, because it is not a fact
				  about a platform — Yahoo hosts both kinds. It is a fact only the reader has,
				  it takes one tap, and it is the difference between an app that answers
				  "who do I start tonight" and one that cannot. So it is asked, in the words
				  somebody who has never read a rules page would use, and what he answers is
				  stored with `source` saying he is the one who said it.
				*/}
				{league && (
					<div className="onboard-teams">
						<h3>Can you change your lineup every day?</h3>
						<div className="chips">
							{([
								["daily", "Yes, every day"],
								["period", "No, it locks for the week"]
							] as const).map(([lock, label]) => (
								<button
									key={lock}
									type="button"
									className={`chip-btn${league.scoring_period?.lineup_lock === lock ? " on" : ""}`}
									aria-pressed={league.scoring_period?.lineup_lock === lock}
									onClick={() => onLineupLock(lock)}
								>
									{label}
								</button>
							))}
						</div>
						<p className="sub">
							Most Yahoo and ESPN points leagues let you change it every day. If yours
							does, tonight&rsquo;s lineup is a decision you get to make.
						</p>
					</div>
				)}

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
							{where === "yahoo" && (
								<p className="sub">
									Yahoo won&rsquo;t let any website read your league &mdash; not this one,
									not anyone. Copying your own page works, private leagues included.
								</p>
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
								onChange={e => setPasted(e.currentTarget.value)}
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
							{(where === "espn" || canImport) && (
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
			</section>
		</div>
	)
}
