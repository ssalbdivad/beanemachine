import { useState } from "react"
import type { Snapshot } from "../data/snapshot.ts"
import type { Config, League } from "../schema.ts"
import { leagueFromPastedSettings } from "../data/paste-settings.ts"
import { rosterFromPaste } from "../data/paste.ts"
import { lineupStore } from "./lineup.ts"
import { roster } from "./roster.ts"
import { IMPORT_COMMAND, leagueGaps } from "./panels.tsx"

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
 *  · The preset third, because it is borrowed values wearing a warning label.
 *  · By hand last, because it works everywhere and costs the most.
 *
 * Every one of them ends in the same place: a league in this browser, and a board
 * ranked in its points.
 */

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
	config,
	snapshot,
	leagueKey,
	league,
	canImport,
	preset,
	onCreateLeague,
	onUsePreset,
	onImportUrl,
	onLoadFile,
	onOpenSetup,
	onDone
}: {
	config: Config | null
	snapshot: Snapshot | null
	/** The league this browser holds once one exists, so the last step can put a
	 *  team in it and the finish button can say what it is finishing. */
	leagueKey: string | null
	league: League | null
	/** Whether a league can be read from wherever this page is running: true with a
	 *  server behind it, and on the static build true for ESPN alone. */
	canImport: boolean
	preset: { key: string; label: string } | null
	onCreateLeague: (platform: Where, league: League) => void
	onUsePreset: () => void
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

	/** The team, from the same gesture. Optional, and the difference between "here
	 *  is the wire ranked" and "here is what to do with your team tonight". */
	const readTeam = () => {
		if (!leagueKey || !snapshot) return
		const read = rosterFromPaste(team, snapshot)
		if (!read.players.length) return setTeamNote(read.note)
		try {
			roster.set(leagueKey, read.keys)
			if (read.spots.length)
				lineupStore.set(leagueKey, read.spots, new Date().toISOString())
			setTeam("")
			setTeamNote(read.note)
		} catch (e) {
			setTeamNote((e as Error).message)
		}
	}

	const step = (n: number, title: string, done: boolean, body: React.ReactNode) => (
		<li className={`onboard-step${done ? " done" : ""}`}>
			<b className="onboard-n">{done ? "✓" : n}</b>
			<div className="onboard-body">
				<h3>{title}</h3>
				{body}
			</div>
		</li>
	)

	return (
		<div className="grid">
			<section className="card full onboard">
				<h2>Set up your league</h2>
				<p className="sub">
					A player is only worth what <i>your</i> league pays for what he does. Nothing
					here can rank anybody until it knows three things: what each stat is worth,
					how many roster slots you fill, and how many teams you are up against. This
					takes a couple of minutes, once — and it all stays in this browser.
				</p>

				<ol className="onboard-steps">
					{step(
						1,
						"Where do you play?",
						!!where,
						<div className="chips">
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
					)}

					{/*
					  The route that ends in a ranked board in three taps, said out loud.
					  
					  It already existed and it was folded inside a disclosure called "Other
					  ways in", 1,536px down a screen whose only visible path is one a phone
					  cannot walk: selecting a whole settings page with Ctrl-A is a desktop
					  gesture, and this app is opened on a phone. So the first-time visitor
					  who could not paste had no visible way to see the thing work at all.
					  
					  It is offered as what it is — borrowed values, replaceable in a tap —
					  and the notice above the board goes on saying so until somebody checks
					  them. Only before a league exists: once one does, this is a second
					  league nobody asked for.
					*/}
					{preset && !league && (
						<p className="onboard-shortcut">
							<button type="button" className="chip-btn" onClick={onUsePreset}>
								Show me a board first
							</button>
							<span className="sub">
								Starts from <b>{preset.label}</b> — standard values, nothing read from
								your league, and the page keeps saying so until you check them. Setting
								your own up replaces it.
							</span>
						</p>
					)}

					{where &&
						step(
							2,
							ready ? "Its settings are in" : "Get its settings in",
							ready,
							<>
								{/* The route that cannot be revoked, first, on every platform. */}
								<ol className="paste-how">
									<li>Open {SETTINGS_PAGE[where]}.</li>
									<li>
										Select the whole page: <kbd>Ctrl</kbd>+<kbd>A</kbd> (<kbd>⌘</kbd>+
										<kbd>A</kbd> on a Mac), then <kbd>Ctrl</kbd>+<kbd>C</kbd> to copy.
									</li>
									<li>
										Click in the box below, paste, and press <b>Read that</b>.
									</li>
								</ol>
								<p className="sub">
									Adverts, menus and columns you don&rsquo;t care about do no harm —
									only the scoring rows, the roster positions and the team count are
									read. It works on a <b>private</b> league, which is the case no
									amount of scraping has ever reached.
								</p>
								<textarea
									data-ctl="paste-settings"
									value={pasted}
									onChange={e => setPasted(e.currentTarget.value)}
									placeholder={
										"Max Teams\t10\nRoster Positions\tC, 1B, 2B, 3B, SS, OF, OF, OF, Util, …\n" +
										"Batters Stat Category\tValue\nHome Runs (HR)\t10.4\n…"
									}
									rows={5}
									aria-label="Paste your league's settings page here"
								/>
								<p style={{ margin: "var(--sp-2) 0 0" }}>
									<button
										type="button"
										className="primary"
										onClick={readSettings}
										disabled={!pasted.trim()}
									>
										Read that
									</button>
								</p>
								{note && <p className="sub paste-note">{note}</p>}

								{/* Everything below is a fallback, and folded, because offering four
								    equal routes to somebody who has done none of them is how a setup
								    screen becomes a menu. */}
								<details className="onboard-alts">
									<summary>Other ways in</summary>
									<dl>
										{(where === "espn" || canImport) && (
											<>
												<dt>From its URL</dt>
												<dd>
													{where === "espn" ?
														<>
															ESPN lets this page read it directly, with no server
															anywhere. Paste your league&rsquo;s URL:
														</>
													: canImport ?
														<>
															There is a server behind this page, so it can try to
															read the league itself. Paste your league&rsquo;s URL:
														</>
													:	null}
													<span className="onboard-url">
														<input
															type="text"
															value={url}
															placeholder="https://…"
															onChange={e => setUrl(e.currentTarget.value)}
															aria-label="Your league's URL"
														/>
														<button
															type="button"
															onClick={() => onImportUrl(url)}
															disabled={!url.trim()}
														>
															Read it
														</button>
													</span>
												</dd>
											</>
										)}
										{where === "yahoo" && !canImport && (
											<>
												<dt>From its URL</dt>
												<dd>
													Not available for Yahoo from a browser, and saying so is the
													point: Yahoo sends no CORS headers, so the response never
													reaches this page however the URL is written. Pasting the page
													is the route that works — including on a private league.
												</dd>
											</>
										)}
										{preset && (
											<>
												<dt>Start from a preset</dt>
												<dd>
													<b>{preset.label}</b> — a ready-made scoring table copied from
													a league that was read from source. Nothing in it came from
													your league, so the page keeps saying so until you check it.
													<p style={{ margin: "var(--sp-2) 0 0" }}>
														<button type="button" onClick={onUsePreset}>
															Use the preset
														</button>
													</p>
												</dd>
											</>
										)}
										<dt>From a file</dt>
										<dd>
											Read the league once on your own machine and carry the file back.
											It brings the free-agent list and your roster with it, which a
											paste of the settings page alone does not:
											<pre>{IMPORT_COMMAND}</pre>
											Drop the <code>scoring.json</code> it writes anywhere on this page.
											<p style={{ margin: "var(--sp-2) 0 0" }}>
												<button type="button" onClick={onLoadFile}>
													Load a league file…
												</button>
											</p>
										</dd>
										<dt>By hand</dt>
										<dd>
											Type the scoring, the slots and the team count in yourself. Nothing
											is guessed on your behalf.
											<p style={{ margin: "var(--sp-2) 0 0" }}>
												<button type="button" onClick={onOpenSetup}>
													Open League setup
												</button>
											</p>
										</dd>
									</dl>
								</details>
							</>
						)}

					{/* Named, not hidden: a league that is half-read is the case this whole
					    screen exists to make visible, and the board must not open until the
					    reader has seen what is still missing. */}
					{league &&
						missing.length > 0 &&
						step(
							3,
							`${missing.length === 1 ? "One input" : `${missing.length} inputs`} still missing`,
							false,
							<>
								<ul className="flags">
									{missing.map(g => (
										<li key={g.label}>
											<b>{g.label}</b> — {g.why} {g.blocks}
										</li>
									))}
								</ul>
								<p style={{ margin: "var(--sp-3) 0 0" }}>
									<button type="button" className="primary" onClick={onOpenSetup}>
										Fill these in on League setup
									</button>
								</p>
							</>
						)}

					{ready &&
						step(
							3,
							"Add your players",
							false,
							<>
								<p className="sub" style={{ margin: "0 0 var(--sp-3)" }}>
									Optional, and it is what turns a ranked list into an answer: with your
									team in, Recommendations says which of <i>your</i> men to drop for
									which free agent, and the daily lineup names the seats to change.
								</p>
								<ol className="paste-how">
									<li>
										Open your team — <b>My Team</b> on Yahoo and ESPN, <b>Roster</b>{" "}
										elsewhere.
									</li>
									<li>
										<kbd>Ctrl</kbd>+<kbd>A</kbd>, <kbd>Ctrl</kbd>+<kbd>C</kbd>, then
										paste below.
									</li>
								</ol>
								<textarea
									data-ctl="paste-onboard-roster"
									value={team}
									onChange={e => setTeam(e.currentTarget.value)}
									placeholder={"C\tBen Rice NYY - C,1B\n1B\tJonathan Aranda TB - 1B\n…"}
									rows={4}
									aria-label="Paste your roster page here"
								/>
								<p style={{ margin: "var(--sp-2) 0 0" }}>
									<button
										type="button"
										className="chip-btn"
										onClick={readTeam}
										disabled={!team.trim()}
									>
										Read that
									</button>
								</p>
								{teamNote && <p className="sub paste-note">{teamNote}</p>}
							</>
						)}
				</ol>

				{/* The way out, always available. A setup screen you cannot leave is a wall,
				    and somebody who wants to look around before committing should be able
				    to — there is simply nothing to rank until a league exists, and the
				    button says which of those two states they are in. */}
				<p className="onboard-done">
					{league ?
						<button type="button" className={ready ? "primary" : ""} onClick={onDone}>
							{ready ?
								`Show me the board for ${league.meta.league_name ?? leagueKey}`
							:	"Take me to the board anyway"}
						</button>
					:	<span className="sub">
							There is nothing to show until one of these is done — every number on
							the board is denominated in a league&rsquo;s own points, so there is no
							board without a league.
						</span>
					}
				</p>
			</section>
		</div>
	)
}
