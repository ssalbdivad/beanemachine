import { useForm, useStore } from "@tanstack/react-form"
import { type } from "arktype"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { Snapshot } from "../data/snapshot.ts"
import { resolvePeriod } from "../engine/period.ts"
import type { Config, League, ScoringPeriod } from "../schema.ts"
import { League as LeagueSchema } from "../schema.ts"
import { api, ApiError, detectMode, getMode } from "./api.ts"
import { Billy } from "./Billy.tsx"
import { Board } from "./Board.tsx"
import { Draft } from "./Draft.tsx"
import { Trade } from "./Trade.tsx"
import { leagues } from "./leagues.ts"
import {
	BoardPrimer,
	EligibilityPanel,
	EXAMPLE_LEAGUE_KEY,
	ExampleNote,
	Fragment2,
	freshness,
	IMPORT_COMMAND,
	isPreset,
	leagueReady,
	PresetNote,
	RosterPanel,
	Setup,
	StatTable,
	TeamCountInput,
	type View,
	VIEWS,
	WaysIn
} from "./panels.tsx"
import { useSnapshot } from "./useBoard.ts"
import { useToast } from "./useToast.tsx"

/**
 * What "Start a league from" offers, read from `platform_templates` rather than
 * listed here.
 *
 * It used to be the literal list `["custom", "yahoo", "espn", "sleeper"]`, which
 * was wrong in two directions at once. Sleeper runs no fantasy baseball — src/import.ts
 * refuses a Sleeper URL and cites the check, `/v1/state/mlb` naming no season — so a
 * baseball app was offering a Sleeper league type;
 * and all four templates shipped with 0 stats, 0 slots and no team count, so every
 * option created a league that could rank nothing. scoring.json now ships the two
 * that are true (a Yahoo Head-to-Head Points preset, and a blank one), and this
 * list follows it: removing a template from the data removes it from the picker,
 * with no second list to remember.
 */
interface TemplateOption {
	key: string
	label: string
	/** Whether it arrives with values, which decides where you land after New. */
	filled: boolean
}

const templateOptions = (config: Config | null): TemplateOption[] =>
	Object.entries(config?.platform_templates ?? {}).map(([key, raw]) => {
		const tpl = raw as League | undefined
		const platform = tpl?.meta?.platform ?? key
		const stats =
			Object.keys(tpl?.scoring?.batting ?? {}).length +
			Object.keys(tpl?.scoring?.pitching ?? {}).length
		const name = platform === "custom" ? "" : `${platform[0]!.toUpperCase()}${platform.slice(1)} `
		return {
			key,
			filled: stats > 0,
			// The label states what you get, from the template's own fields: a scoring
			// type it names, or the fact that it names nothing at all.
			label:
				stats > 0 ?
					`a ${name}${tpl?.meta?.scoring_type ?? ""} league (standard values)`.replace(/\s+/g, " ")
				:	`a blank ${name}league (nothing filled in)`
		}
	})

/** What is known about the leagues in this browser. Three states, because an
 *  unreadable store and an empty one call for opposite advice. */
type StoreState = "reading" | "read" | "unreadable"

/** The league picker is one control doing four jobs, so it says which one. */
const LEAGUE_LABEL: Record<View, string> = {
	board: "Scoring these picks against",
	league: "League being edited",
	trade: "Team being managed",
	draft: "Drafting in"
}

export const App = () => {
	const [config, setConfig] = useState<Config | null>(null)
	const [key, setKey] = useState<string | null>(null)
	const [loadError, setLoadError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	// Billy's lenses light for a moment when a save lands
	const [acknowledged, setAcknowledged] = useState(false)
	const [view, setView] = useState<View>("board")
	/** True while a file is over the window. A drop target nobody can see is a
	 *  feature nobody uses, so the page says it will take the file. */
	const [dragging, setDragging] = useState(false)
	/** Set by the toolbar so the Setup card can open the same picker: one file
	 *  input, three ways to reach it. Stable, so the toolbar's effect that hands it
	 *  up does not re-run on every render. */
	const openPicker = useRef<(() => void) | null>(null)
	const registerPicker = useCallback((open: () => void) => {
		openPicker.current = open
	}, [])
	const { snapshot, error: snapshotError } = useSnapshot()
	const { toast, show } = useToast()
	const acknowledge = useCallback(() => {
		setAcknowledged(true)
		setTimeout(() => setAcknowledged(false), 900)
	}, [])

	const run = useCallback(
		async (fn: () => Promise<void>) => {
			setBusy(true)
			try {
				await fn()
			} catch (e) {
				show(e instanceof ApiError ? e.message : String(e), true)
			} finally {
				setBusy(false)
			}
		},
		[show]
	)

	const adopt = useCallback((next: Config, preferred?: string) => {
		const keys = Object.keys(next.leagues)
		const chosen =
			preferred && keys.includes(preferred) ? preferred
			: next.active_league && keys.includes(next.active_league) ? next.active_league
			: keys[0] ?? null
		setConfig(next)
		setKey(chosen)
		setLoadError(null)
	}, [])

	useEffect(() => {
		void run(async () => {
			try {
				const [, stored] = await Promise.all([detectMode(), leagues.load()])
				adopt(stored)
			} catch (e) {
				// a toast fades, and with no config the page would sit on "Loading…" forever
				setLoadError(e instanceof ApiError ? e.message : String(e))
				throw e
			}
		})
	}, [run, adopt])

	/**
	 * Loading a league file, from wherever it arrived.
	 *
	 * One function, because there are now three doors onto it — the toolbar button,
	 * the Setup card, and dropping the file on the page — and three copies of a
	 * confirm-then-replace would be three chances for one of them to skip the
	 * confirm. The file replaces the store outright (see leagues.replace), so what
	 * is about to go is named before it goes.
	 */
	const loadFile = useCallback(
		(file: File) => {
			if (!/\.json$/i.test(file.name) && file.type !== "application/json")
				return show(`${file.name} isn't a .json league file.`, true)
			const existing = Object.keys(config?.leagues ?? {}).length
			if (
				existing &&
				!confirm(
					`Replace the ${existing} league${existing === 1 ? "" : "s"} in this browser with ${file.name}?`
				)
			)
				return
			void run(async () => {
				const loaded = leagues.replace(await file.text())
				adopt(loaded.config)
				// what actually arrived, counted from the file rather than assumed: a
				// file with no roster in it must not be reported as having brought one
				const carried = [
					`${loaded.leagues} league${loaded.leagues === 1 ? "" : "s"}`,
					loaded.rosters ? `${loaded.rosters} roster${loaded.rosters === 1 ? "" : "s"}` : null,
					loaded.lineups ? `${loaded.lineups} lineup${loaded.lineups === 1 ? "" : "s"}` : null
				].filter(Boolean)
				show(`Loaded ${carried.join(", ")} from ${file.name}`)
			})
		},
		[config, run, adopt, show]
	)

	/**
	 * Starting a league from a template.
	 *
	 * Two things changed here and both were in the way of a first-time visitor. The
	 * key used to come from a `prompt()`, a modal asking for a string that is only
	 * ever seen again in this dropdown — so it is derived now (leagues.suggestKey).
	 * And every template used to be blank, so this always landed on League setup
	 * with a form to fill in; a preset arrives ready to rank, so it lands on the
	 * board, which is the thing the visitor came for. `leagueReady` decides which,
	 * from the created league itself rather than from the template's name.
	 */
	const create = useCallback(
		(template: string) =>
			run(async () => {
				if (!config) return
				const k = leagues.suggestKey(config, template)
				const next = leagues.create(k, template)
				adopt(next, k)
				const made = next.leagues[k]!
				if (leagueReady(made)) {
					setView("board")
					// named by the platform the league itself carries, not by the template
					// key, which is an internal string nobody chose
					show(
						`Ranking on the ${made.meta.platform[0]!.toUpperCase()}${made.meta.platform.slice(1)} ` +
							`preset — check its values in League setup`
					)
				} else {
					setView("league")
					show(`Created ${k} — every field is blank until you fill it in`)
				}
			}),
		[config, run, adopt, show]
	)

	/**
	 * Drag a league file anywhere onto the page.
	 *
	 * The file route is the answer for a Yahoo user — the platform no browser can
	 * read — and it was a button in a toolbar that only appears on one tab, labelled
	 * as though it were a restore-from-backup. Listening on the window means the
	 * file lands wherever it is dropped, including on the board a visitor is
	 * looking at when they realise it is not their league.
	 *
	 * `dragover` must be prevented for a drop to fire at all, and the counter-free
	 * approach (dragleave anywhere clears it) is deliberate: dragleave fires for
	 * every child element the pointer crosses, so a boolean set on dragover and
	 * cleared only when the pointer actually leaves the window keeps the overlay
	 * from flickering.
	 */
	useEffect(() => {
		const over = (e: DragEvent) => {
			if (!e.dataTransfer?.types.includes("Files")) return
			e.preventDefault()
			setDragging(true)
		}
		const leave = (e: DragEvent) => {
			if (e.relatedTarget === null) setDragging(false)
		}
		const drop = (e: DragEvent) => {
			if (!e.dataTransfer?.files.length) return
			e.preventDefault()
			setDragging(false)
			loadFile(e.dataTransfer.files[0]!)
		}
		window.addEventListener("dragover", over)
		window.addEventListener("dragleave", leave)
		window.addEventListener("drop", drop)
		return () => {
			window.removeEventListener("dragover", over)
			window.removeEventListener("dragleave", leave)
			window.removeEventListener("drop", drop)
		}
	}, [loadFile])

	const league = key && config ? config.leagues[key] : undefined
	// Nothing is known until the store has been read, and "no leagues", "not looked
	// yet" and "the store is unreadable" are three different screens. One value
	// decides which, so no two controls can disagree about it.
	const store: StoreState = loadError ? "unreadable" : config ? "read" : "reading"
	const loading = store === "reading"
	// The board, the draft and a trade are all priced in the same three inputs.
	// Until they exist, the guided panel is what the page leads with.
	const ready = leagueReady(league)
	/** What scoring.json offers to start from, and which of those is ready-made.
	 *  Both read from the data: a preset that stops shipping stops being offered. */
	const templates = useMemo(() => templateOptions(config), [config])
	const preset = templates.find(t => t.filled) ?? null
	/**
	 * League MANAGEMENT — create, remove, import, download, load a file — is chrome
	 * for a thing you do once, and it was sitting above the recommendations on every
	 * view. Measured in the browser: it pushed the first ranked row to y=1187, so on
	 * a 1200px screen the board this page exists to show was entirely below the fold.
	 *
	 * It shows where it belongs: on League setup, or when there is no league at all
	 * and importing one is the only thing left to do. Elsewhere all that survives is
	 * the switcher, and only when there is more than one league to switch between.
	 */
	const manage =
		view === "league" ||
		// nothing to work with yet: importing or creating one is the only move left
		(store === "read" && !Object.keys(config?.leagues ?? {}).length) ||
		// and the unreadable-store card below points at Load file as the way out
		store === "unreadable"

	return (
		<div className={`wrap${busy ? " busy" : ""}${acknowledged ? " saved" : ""}`}>
			{/* Styled inline rather than in app.css: it is one element that exists only
			    while a file is in the air, and it has to sit above everything the page
			    has painted. `pointer-events: none` matters — the window's own drop
			    handler is what takes the file, and an overlay that swallowed the event
			    would make the page look like it accepted a file it never received. */}
			{dragging && (
				<div
					className="dropzone"
					style={{
						position: "fixed",
						inset: 0,
						zIndex: 50,
						display: "grid",
						placeItems: "center",
						pointerEvents: "none",
						background: "color-mix(in srgb, var(--bg) 82%, transparent)",
						outline: "3px dashed var(--accent)",
						outlineOffset: "-14px",
						font: "600 18px/1.5 inherit",
						textAlign: "center",
						padding: "var(--sp-4)"
					}}
				>
					<span>
						Drop a league file to load it
						<br />
						<span style={{ font: "400 14px/1.6 inherit", opacity: 0.75 }}>
							the <code>scoring.json</code> that <code>{IMPORT_COMMAND.split(" <")[0]}</code>{" "}
							writes, or one you downloaded here
						</span>
					</span>
				</div>
			)}
			<header>
				<div className="mark">
					<Billy />
					<h1>
						beane<b>machine</b>
					</h1>
				</div>
				<p className="tag tagline">How can you not be robotic about baseball?</p>
				{/* The hosted build's first impression used to be four lines of instructions
				    for running a dev server — read by everyone, relevant to the few who are
				    about to import. The reassurance a visitor needs is one line; the caveat
				    belongs where importing is attempted, and it is on that form already. */}
				{/* It also said "importing one by URL needs the local server", flatly, which
				    is false for two platforms out of three: ESPN reflects our origin in
				    `access-control-allow-origin` and Sleeper sends `*`, so a browser reads
				    both directly. Only Yahoo has no CORS headers at all, and Yahoo is a
				    scrape rather than an API. That blanket sentence was the single thing
				    standing between a visitor and using this on their own league. */}
				{/* Sleeper used to be named here as a way in. It runs no fantasy baseball —
				    src/import.ts refuses a Sleeper URL and quotes the check — so pointing a
				    baseball user at it was a dead end dressed up as an option. What replaces it is the route
				    a Yahoo user can actually finish: a preset now, or a file they carry
				    over, both of which end in a board that ranks. */}
				{config && getMode() === "static" && (
					<p className="tag static-note">
						Your leagues are saved in this browser. Paste an <b>ESPN</b> league URL and
						it imports right here. <b>Yahoo</b> sends no CORS headers, so no browser can
						read it: start from the Yahoo preset, or read your league once locally and
						drop the file it writes anywhere on this page.
					</p>
				)}
			</header>

			<nav className="views" role="tablist" aria-label="Sections">
				{VIEWS.map(v => (
					<button
						key={v.id}
						role="tab"
						title={v.purpose}
						aria-selected={view === v.id}
						aria-current={view === v.id ? "page" : undefined}
						className={view === v.id ? "on" : ""}
						// the .on class carries the tab's state; the accent is the same "this one
						// is live" signal .modes and .chip-btn already use for a selected control
						style={view === v.id ? { color: "var(--accent)", borderColor: "var(--accent)" } : undefined}
						onClick={() => setView(v.id)}
					>
						{v.label}
					</button>
				))}
				<a
					className="views-link"
					href="https://github.com/ssalbdivad/beanemachine/blob/main/docs/GUIDE.md"
					target="_blank"
					rel="noreferrer"
					title="How to read the board, and how it was validated"
				>
					How to read this →
				</a>
			</nav>

			<Toolbar
				config={config}
				store={store}
				view={view}
				manage={manage}
				activeKey={key}
				templates={templates}
				onSelect={k => void run(async () => adopt(leagues.activate(k), k))}
				onImport={url =>
					void run(async () => {
						// reading the league needs a server; storing what it read never does
						const { key: k, league } = await api.import(url)
						adopt(leagues.save(k, league), k)
						show(`Imported ${league.meta.league_name ?? k}`)
					})
				}
				onCreate={template => void create(template)}
				onRemove={k =>
					void run(async () => {
						adopt(leagues.remove(k))
						show("Removed")
					})
				}
				onDownload={() => {
					if (!config) return
					const file = leagues.download(config)
					const carried = [
						`${Object.keys(file.leagues).length} league${Object.keys(file.leagues).length === 1 ? "" : "s"}`,
						file.rosters ? `${Object.keys(file.rosters).length} roster` : null,
						file.lineups ? `${Object.keys(file.lineups).length} lineup` : null
					].filter(Boolean)
					show(`Downloaded scoring.json — ${carried.join(", ")}. Drop it on this page anywhere to load it back.`)
				}}
				onLoadFile={loadFile}
				onPicker={registerPicker}
				onReject={m => show(m, true)}
			/>

			<Status
				league={league ?? null}
				store={store}
				detail={view === "league"}
				snapshot={snapshot}
				snapshotError={snapshotError}
			/>

			{/* A store that can't be read is not an empty store, and every tab's own
			    "configure a league first" would quietly claim it is. */}
			{loadError && (
				<div className="grid">
					<section className="card full">
						<h2>Your leagues couldn&rsquo;t be read</h2>
						<ul className="flags">
							<li>{loadError}</li>
						</ul>
						<p className="sub" style={{ margin: "var(--sp-3) 0 0" }}>
							Nothing was overwritten and nothing was guessed at. <b>Load file</b> above
							replaces what is in this browser with a <code>scoring.json</code> you keep.
						</p>
					</section>
				</div>
			)}

			{!loadError && !loading && !ready && (
				<Setup
					leagueKey={key}
					league={league ?? null}
					canImport={getMode() !== "static"}
					preset={preset?.label ?? null}
					onUsePreset={preset ? () => void create(preset.key) : undefined}
					onLoadFile={() => openPicker.current?.()}
					onOpenSetup={view === "league" ? undefined : () => setView("league")}
				/>
			)}

			{/* On every tab, not just the board: the demo is not a property of one
			    screen, and League setup is where the note is most useful. It goes
			    away by itself the moment a different league is the active one. */}
			{league && key === EXAMPLE_LEAGUE_KEY && (
				<ExampleNote
					league={league}
					onOpenSetup={view === "league" ? undefined : () => setView("league")}
				/>
			)}

			{/* A preset ranks immediately, which is the point of it and also the risk:
			    a board that works looks like a board that is right. This says whose
			    numbers it is working from, on every tab, until they are checked. */}
			{league && isPreset(league) && key && (
				<PresetNote
					league={league}
					onOpenSetup={view === "league" ? undefined : () => setView("league")}
					onChecked={() =>
						void run(async () => {
							if (
								!confirm(
									`Confirm that these values match ${league.meta.league_name ?? key}'s own ` +
										`settings page? Nothing was read from your league, so this records ` +
										`that you checked them by hand — it does not make them verified.`
								)
							)
								return
							const on = new Date().toISOString().slice(0, 10)
							const platform = league.meta.platform
							// The preset marker goes, so the notice ends; `verified` does not,
							// because nothing was read off the league and only an import can
							// change that. What replaces the preset's "check this" list is one
							// line saying where the values came from and who vouched for them.
							adopt(
								leagues.save(key, {
									...league,
									provenance: {
										...league.provenance,
										method: `manual entry: started from the ${platform} preset, then checked by hand against the league's own settings page on ${on}`
									},
									needs_review: [
										`These values were started from the ${platform} preset and confirmed by hand on ${on}. Nothing was read from this league's own pages, so it stays unverified — importing the league is the only route that changes that.`
									]
								}),
								key
							)
							show("Recorded as checked by hand — the values are yours now")
						})
					}
				/>
			)}

			{/* The demo league CAN rank, so the Setup card above stays hidden for a
			    first-time visitor — which left the routes to their own league named
			    nowhere at all: the toolbar has a New button, a Download button and a
			    URL field, and nothing that says which of them is for a Yahoo user.
			    This is the same list, on the tab they are sent to. */}
			{!loadError && !loading && ready && view === "league" && key === EXAMPLE_LEAGUE_KEY && (
				<div className="grid">
					<section className="card full">
						<h2>Use your own league</h2>
						<p className="sub">
							Everything below is {league?.meta.team_name ?? "somebody else's team"}&rsquo;s.
							Any of these replaces it.
						</p>
						<WaysIn
							canImport={getMode() !== "static"}
							preset={preset?.label ?? null}
							league={league ?? null}
							onUsePreset={preset ? () => void create(preset.key) : undefined}
							onLoadFile={() => openPicker.current?.()}
						/>
					</section>
				</div>
			)}

			{view === "board" ?
				<>
					{/* Above the grid, not in it: `.grid` is two columns and this is one
					    line of orientation, not a card. Only once there is something to
					    orient — with the league unset the Setup panel above is the
					    message, and a definition of bscore is not what is missing. */}
					{ready && <BoardPrimer />}
					<div className="grid">
						<Board snapshot={snapshot} league={league ?? null} error={snapshotError} />
					</div>
				</>
			: view === "draft" ?
				<div className="grid">
					<Draft
						snapshot={snapshot}
						league={league ?? null}
						leagueKey={key}
						error={snapshotError}
					/>
				</div>
			: view === "trade" ?
				<div className="grid">
					<Trade
						snapshot={snapshot}
						league={league ?? null}
						leagueKey={key}
						error={snapshotError}
					/>
				</div>
			: league && key ?
				<LeagueEditor
					key={key}
					leagueKey={key}
					league={league}
					snapshot={snapshot}
					onSaved={next => {
						adopt(next, key)
						acknowledge()
						show("Saved to this browser")
					}}
					onError={m => show(m, true)}
					run={run}
				/>
			:	<div className="grid">
					<section className="card full">
						<h2>League setup</h2>
						<p className="empty">
							{loading ?
								"Reading the leagues stored in this browser…"
							: loadError ?
								"There is nothing to edit until the store above is replaced."
							:	"No league to edit yet — import one from its URL, or press New, and its scoring, slots and team count appear here."}
						</p>
					</section>
				</div>
			}

			<Colophon />

			{toast && <div className={`toast on${toast.bad ? " bad" : ""}`} role="status">{toast.message}</div>}
		</div>
	)
}

/**
 * What the app is willing to claim, and where the working is.
 *
 * The advanced reader has the opposite problem to the beginner: the measured
 * results exist, in detail, and the app pointed at exactly one of them — a
 * single "How to read this" link in the nav, to the guide. METHODOLOGY.md is
 * where the backtest, the negative results and the caveats live and nothing on
 * screen mentioned it at all.
 *
 * The three caveats here are the ones that change how a number on this page
 * should be read, so they belong on the page and not only in a doc:
 *
 * - Ranking, docs/METHODOLOGY.md §6.5: mean Spearman rho 0.6759 vs a naive
 *   0.5743 for hitting (+17.7%, 48 of 50 folds) and 0.5318 vs 0.4697 for
 *   pitching (+13.2%, 49 of 50), 14-day horizon, 2016-2026.
 * - The human comparison, §9: 63/111 weeks is 63W-47L with ties excluded,
 *   z 1.53, one-sided p 0.064 — short of the 5% bar this project applies to
 *   its other results, and quoting the win count without the p-value is the
 *   asymmetry METHODOLOGY calls out by name. Beating an inactive manager
 *   (98/111) and a streak-chaser (74/111) is the part that is established.
 * - Probables, §3.5: "This cannot be backtested, and the weight was not set by
 *   a measurement." Nothing archives what was announced when.
 *
 * Market edge gets its own line because it is a control on the board a reader
 * can select today, and the board's own warning does not cover it: Board.tsx
 * warns only when `edgeCoverage < 0.35`, and about coverage, not about the
 * leaked values. docs/GUIDE.md documents the per-game weather percentage that
 * reached the committed capture's "% Ros" sweep, 225 players across four games
 * reading 51%.
 */
const Colophon = () => (
	<footer className="colophon">
		<p className="links">
			<a
				href="https://github.com/ssalbdivad/beanemachine/blob/main/docs/GUIDE.md"
				target="_blank"
				rel="noreferrer"
			>
				How to read the board
			</a>
			<a
				href="https://github.com/ssalbdivad/beanemachine/blob/main/docs/METHODOLOGY.md"
				target="_blank"
				rel="noreferrer"
			>
				Methodology &amp; measured results
			</a>
			<a href="https://github.com/ssalbdivad/beanemachine" target="_blank" rel="noreferrer">
				Source
			</a>
		</p>
		<dl>
			<Fragment2 term="what is measured">
				Scored against a naive &ldquo;he keeps doing what he has been doing&rdquo;
				baseline over 2016&ndash;2026 at a 14-day horizon, this ordering won 48 of 50
				hitting folds (mean Spearman &rho; 0.676 against 0.574) and 49 of 50 pitching
				folds (0.532 against 0.470). The consistency is the result, not the size:
				&rho; 0.68 leaves a great deal of disagreement between the projected order and
				the real one, and a bscore of 55 is not a forecast that you gain 55 points.
			</Fragment2>
			<Fragment2 term="what is not">
				Playing five seasons out, the model beats an inactive manager 98 weeks of 111
				and a streak-chaser 74, both clearly. Against a manager who blends season and
				recent form it is 63 of 111 &mdash; 63W&ndash;47L, z 1.53, one-sided p 0.064.
				That is suggestive and does not clear the 5% bar the rest of these results
				are held to.
			</Fragment2>
			<Fragment2 term="what cannot be checked">
				Where MLB has published a probable starter the board projects a pitcher from
				his own scheduled starts. Probables are announced and then overwritten and
				nothing archives them, so that step cannot be backtested at all, and its
				weight was set by judgment rather than by a measurement.
			</Fragment2>
			<Fragment2 term="what is known broken">
				<b>Market edge</b> is selectable and unreliable, so it is not the default.
				The sweep that reads Yahoo&rsquo;s &ldquo;% Ros&rdquo; caught a per-game
				weather figure in the committed capture, and being per-game it is shared by
				everyone in both clubs &mdash; 225 players across four games read 51%. bscore
				is the honest column, and <b>Free agents only</b> is the control that answers
				what edge was there to answer.
			</Fragment2>
		</dl>
	</footer>
)

const Toolbar = ({
	config,
	store,
	view,
	manage,
	activeKey,
	templates,
	onSelect,
	onImport,
	onCreate,
	onRemove,
	onDownload,
	onLoadFile,
	onPicker,
	onReject
}: {
	config: Config | null
	store: StoreState
	view: View
	/** Whether the create/remove/import/file controls are on screen at all. */
	manage: boolean
	activeKey: string | null
	/** Read from scoring.json, so the picker cannot offer a template the data
	 *  does not ship. */
	templates: TemplateOption[]
	onSelect: (key: string) => void
	onImport: (url: string) => void
	onCreate: (template: string) => void
	onRemove: (key: string) => void
	onDownload: () => void
	onLoadFile: (file: File) => void
	/** Hands the file input's opener up, so the Setup card can offer the same
	 *  route without a second `<input type=file>` to keep in step. */
	onPicker: (open: () => void) => void
	onReject: (message: string) => void
}) => {
	const [url, setUrl] = useState("")
	/**
	 * The ready-made one leads: it is the only option that ends in a ranked board
	 * without further typing, and it was not offered at all before.
	 *
	 * Null until somebody actually picks, rather than seeded with a default. The
	 * first render happens while the store is still being read, so `templates` is
	 * empty then — a `useState` initialiser would have frozen the fallback in, and
	 * did: it left "a blank league" selected on every load, which is the option that
	 * ranks nothing.
	 */
	const [chosen, setChosen] = useState<string | null>(null)
	const template = chosen ?? templates.find(t => t.filled)?.key ?? "custom"
	const picker = useRef<HTMLInputElement>(null)
	useEffect(() => {
		onPicker(() => picker.current?.click())
	}, [onPicker])
	const keys = Object.keys(config?.leagues ?? {})
	// the same control means different things per view, so it says which
	const label = LEAGUE_LABEL[view]
	// One league is the normal case, and a select with one option is a control that
	// cannot do anything — the chips below already name the league it would name.
	if (!manage && keys.length < 2) return null
	const selector = (
				<label className="ctl">
					<span>{label}</span>
					<select
						value={activeKey ?? ""}
						disabled={!keys.length}
						aria-label={label}
						onChange={e => onSelect(e.currentTarget.value)}
					>
						{/* an empty disabled box reads as broken; this says which of the three
						    reasons it is empty for */}
						{!keys.length && (
							<option value="">
								{store === "reading" ? "Reading this browser…"
								: store === "unreadable" ? "Couldn't be read"
								: "No leagues in this browser"}
							</option>
						)}
						{keys.map(k => (
							<option key={k} value={k}>
								{config!.leagues[k]!.meta.league_name ?? k}
								{config!.leagues[k]!.meta.team_name ? ` · ${config!.leagues[k]!.meta.team_name}` : ""}
							</option>
						))}
					</select>
				</label>
	)
	// Nothing to manage from here — just say which league the page is denominated in.
	if (!manage) return <div className="bar">{selector}</div>
	return (
		<>
			<div className="bar">
				{selector}
				<label className="ctl">
					<span>Start a league from</span>
					<select
						id="tpl"
						value={template}
						aria-label="Start a league from"
						onChange={e => setChosen(e.currentTarget.value)}
					>
						{templates.map(t => (
							<option key={t.key} value={t.key}>
								{t.label}
							</option>
						))}
					</select>
				</label>
				<button
					title={
						templates.find(t => t.key === template)?.filled ?
							"Start from standard values you then check against your own league — nothing here was read from it"
						:	"Start an empty league you fill in yourself — no values are invented"
					}
					onClick={() => onCreate(template)}
				>
					New
				</button>
				<button
					className="ghost"
					disabled={!activeKey}
					title="Remove this league"
					onClick={() => activeKey && confirm(`Remove ${activeKey} from this browser?`) && onRemove(activeKey)}
				>
					Remove
				</button>
				<button
					disabled={!keys.length}
					title="Take every league in this browser out as one scoring.json — plus your roster and the seats it was read in — and load it into any other browser"
					onClick={onDownload}
				>
					Download
				</button>
				<button
					title="Replace the leagues in this browser with a scoring.json file — the one the local importer writes, or one downloaded here. Dropping it anywhere on the page does the same."
					onClick={() => picker.current?.click()}
				>
					Load file
				</button>
				<input
					ref={picker}
					type="file"
					accept="application/json,.json"
					hidden
					aria-label="Load a scoring.json file"
					onChange={e => {
						const chosen = e.currentTarget.files?.[0]
						// picking the same file twice has to fire again, so clear it either way
						e.currentTarget.value = ""
						// The confirm moved to the one loader in App: a dropped file and a
						// picked one have to warn identically, and two copies of that check
						// is one copy too many to keep in step.
						if (chosen) onLoadFile(chosen)
					}}
				/>
			</div>
			<form
				className="bar"
				onSubmit={e => {
					e.preventDefault()
					if (!url.trim()) return onReject("Paste a league URL first.")
					onImport(url.trim())
					setUrl("")
				}}
			>
				<label className="ctl grow">
					<span>Import a league from its URL</span>
					<input
						type="text"
						value={url}
						onChange={e => setUrl(e.currentTarget.value)}
						placeholder="Paste a Yahoo or ESPN league URL…"
						aria-label="Import a league from its URL"
					/>
				</label>
				<button className="primary" type="submit">
					Import
				</button>
			</form>
		</>
	)
}

/**
 * The masthead strip: which league everything below is denominated in, where its
 * values came from, and how old the observed data is. All three degrade to a
 * stated absence rather than to nothing at all — an empty strip would read as a
 * page that had not finished loading.
 */
const Status = ({
	league,
	store,
	detail,
	snapshot,
	snapshotError
}: {
	league: League | null
	store: StoreState
	/** Provenance — platform, scoring type, whether it was read or typed, when —
	 *  is what you check while setting a league up and never again. It rides along
	 *  on the setup view; on the board it is four chips of noise above the ranking. */
	detail: boolean
	snapshot: Snapshot | null
	snapshotError: string | null
}) => {
	const age = freshness(snapshot?.capturedAt, Date.now())
	const data =
		snapshotError ? { className: "chip warn", value: "unavailable" }
		: !snapshot ? { className: "chip", value: "loading…" }
		: { className: `chip${age.stale ? " warn" : ""}`, value: age.label }
	return (
		<div className="chips">
			{league ?
				<Chips league={league} detail={detail} />
			: store === "reading" ?
				<span className="chip">reading this browser&rsquo;s leagues…</span>
			: store === "unreadable" ?
				<span className="chip warn">leagues unreadable</span>
			:	<span className="chip warn">no league yet</span>}
			<span className={data.className} title="Age of the MLB and Statcast capture the ranking is computed from">
				player data <b>{data.value}</b>
			</span>
		</div>
	)
}

const Chips = ({ league, detail }: { league: League; detail: boolean }) => {
	const { meta, provenance } = league
	return (
		<>
			{[detail ? meta.platform : null, meta.team_name].filter(Boolean).map(v => (
				<span className="chip" key={String(v)}>
					<b>{String(v)}</b>
				</span>
			))}
			{meta.max_teams != null && (
				<span className="chip">
					<b>{meta.max_teams}</b> teams
				</span>
			)}
			{detail && meta.scoring_type && <span className="chip">{meta.scoring_type}</span>}
			{/* "unverified" means the values were typed rather than read off the platform,
			    and that changes how much to trust every number below — so it shows
			    everywhere. Its opposite is the uninteresting case and rides with the
			    rest of the provenance. */}
			{(detail || !provenance.verified) && (
				<span className={`chip ${provenance.verified ? "ok" : "warn"}`}>
					{provenance.verified ? "read from source" : "unverified"}
				</span>
			)}
			{detail && provenance.fetched_at && <span className="chip">fetched {provenance.fetched_at}</span>}
		</>
	)
}

/** The scoring period as the league states it, with every field present. */
type Period = NonNullable<ScoringPeriod>

/** Every field null: a league that has said nothing about its period. Written only
 *  when an edit actually lands. Opening the editor must not turn an unstated period
 *  into a stored one — null means "not known", and a control that defaults itself on
 *  mount would turn the reader's silence into the league's answer. */
const NO_PERIOD: Period = {
	kind: null,
	days: null,
	starts_on: null,
	anchor: null,
	lineup_lock: null,
	source: null
}

/** Lowercase three-letter, as `resolvePeriod` matches them against `Date.getUTCDay`. */
const WEEKDAYS = [
	["mon", "Monday"],
	["tue", "Tuesday"],
	["wed", "Wednesday"],
	["thu", "Thursday"],
	["fri", "Friday"],
	["sat", "Saturday"],
	["sun", "Sunday"]
] as const

/**
 * How long a matchup period runs.
 *
 * Uncontrolled for the reason `ValueInput` and `TeamCountInput` in panels.tsx are:
 * the element has to be allowed to hold text the number is not finished being, and a
 * field React rewrites on every keystroke cannot be typed into. Empty is a real
 * answer — it is the league not having said, which is the state the panel above
 * prints the board's assumption for.
 */
const PeriodDaysInput = ({
	value,
	onChange,
	onReject
}: {
	value: number | null
	onChange: (next: number | null) => void
	onReject: (message: string) => void
}) => {
	const el = useRef<HTMLInputElement>(null)
	/** The number this field last handed up. It comes straight back as `value`, and
	 *  rewriting the field on that echo would eat a digit mid-number. */
	const sent = useRef<number | null | undefined>(undefined)
	const show = (to: number | null) => {
		if (el.current) el.current.value = to == null ? "" : String(to)
	}
	useEffect(() => {
		if (value === sent.current) return
		sent.current = undefined
		show(value)
	}, [value])
	return (
		<span className="field">
			<input
				ref={el}
				type="number"
				min="1"
				step="1"
				placeholder="—"
				aria-label="Days in a scoring period"
				defaultValue={value == null ? "" : String(value)}
				onChange={e => {
					const node = e.currentTarget
					const raw = node.value.trim()
					// "" with badInput set is a keystroke the browser cannot parse yet — a
					// stray "-", say. It is not somebody clearing the field.
					if (raw === "" && node.validity.badInput) return
					// empty is a real answer: it means nobody has said how long the period
					// is, and the panel says what the board reads in place of it
					if (raw === "") {
						sent.current = null
						return onChange(null)
					}
					const n = Math.round(Number(raw))
					// unlike the team count, no valid length is a prefix of another one that
					// this rejects — "1" is itself a period — so the minimum holds per
					// keystroke rather than waiting for blur
					if (Number.isFinite(n) && n >= 1) {
						sent.current = n
						onChange(n)
					} else {
						show(value)
						onReject("Enter a whole number of days.")
					}
				}}
				onBlur={e => {
					// text the browser never parsed committed nothing, so the field must not
					// be left showing it
					if (e.currentTarget.validity.badInput) {
						show(value)
						return onReject("Enter a whole number of days.")
					}
					// and once the typing is over the field shows what was actually stored,
					// so "007" does not sit there as a length no league holds
					show(value)
				}}
			/>
			<span className="unit">days</span>
		</span>
	)
}

/**
 * The league's own week, for a league whose period could not be read off its
 * platform.
 *
 * Everything here is nullable and the key itself is optional, so the panel's job is
 * as much to print what the board does with a null as to collect a value. It prints
 * `resolvePeriod`'s own `basis` sentence rather than a second copy of that reasoning,
 * because a second copy is a thing that can drift: the board's footer and this panel
 * would then disagree about the same league on the same day.
 */
const ScoringPeriodPanel = ({
	draft,
	saved,
	snapshot,
	onChange,
	onReject
}: {
	draft: League
	saved: ScoringPeriod | undefined
	snapshot: Snapshot | null
	onChange: (next: ScoringPeriod) => void
	onReject: (message: string) => void
}) => {
	const stated = draft.scoring_period ?? null
	/** The end of the captured slate, exactly as `useBoard` derives it, so the window
	 *  printed here is the window the board ranks over. Null with no snapshot: there
	 *  is then nothing to clip a window to, and dates are left unstated rather than
	 *  guessed. */
	const slateEnd = useMemo(
		() =>
			snapshot ?
				(snapshot.slate ?? []).reduce((a, g) => (g.date > a ? g.date : a), snapshot.horizon.end)
			:	null,
		[snapshot]
	)
	const resolved = useMemo(() => {
		const today = new Date().toISOString().slice(0, 10)
		// `resolvePeriod` takes a slate end only to clip the window to what was
		// captured. With no snapshot there is nothing to clip to, so it is handed
		// `today` and only `basis` — which period.ts derives from the league alone,
		// never from the slate — is printed.
		return resolvePeriod(draft, today, slateEnd ?? today)
	}, [draft, slateEnd])

	/** An edit starts from whatever the league already said, with null — not a
	 *  default — everywhere it said nothing, so changing one field cannot invent the
	 *  other five. */
	const patch = (fields: Partial<Period>) => {
		const next = { ...NO_PERIOD, ...(stated ?? {}), ...fields }
		// Knowing nothing again is a state the league has to be able to return to:
		// clearing a mistaken entry must leave silence rather than an object claiming
		// six unknowns. `source` counts as something known, because it is the quote a
		// wrong value would be traced back through.
		const says = Object.values(next).some(v => v !== null)
		onChange(says ? next : null)
	}

	/** Which of these fields the board actually reads, given the period chosen. It is
	 *  stated rather than shown by disabling anything, because a fact the league does
	 *  hold is worth recording whether or not today's window is ranked on it. */
	const reads =
		stated?.kind === "matchup" ?
			"The length, the start day, the lock and the anchor are all read — the anchor in place of the start day, wherever one is set."
		: stated?.kind === "daily" ?
			"A daily league's window is today, so nothing else here is read."
		: stated?.kind === "none" ?
			"A league with no periods is ranked over a rolling week, so nothing else here is read."
		:	"Until the period is stated the board takes a rolling week and reads nothing else here."

	/** What the board fills each null in with. Every line names a fallback that is in
	 *  period.ts and would otherwise move a ranking without saying so. `basis` names
	 *  the Monday and seven-day fallbacks itself; the unstated lineup lock leaves no
	 *  trace there, because an unlocked period reads the same as a stated one. */
	const assumptions: string[] = []
	if ((stated?.kind ?? null) === null)
		assumptions.push(
			"This league has not said how its scoring period runs, so that window is an assumption rather than its own."
		)
	else if (stated?.kind === "matchup" && stated.starts_on === null && stated.anchor === null)
		assumptions.push("Neither a start day nor an anchor is stated, so the board falls back to a Monday start.")
	if (stated?.kind === "matchup" && stated.days === null)
		assumptions.push("No length is stated, so the board reads the period as seven days long.")
	if (stated?.kind === "matchup" && stated.lineup_lock === null)
		assumptions.push(
			"No lineup lock is stated, so the board treats the rest of the current period as still yours to act on."
		)

	const edited = JSON.stringify(stated) !== JSON.stringify(saved ?? null)

	return (
		<>
			<p className="sub">
				Which days a matchup is scored over, and whether the lineup can still be changed
				inside it — two facts that do not follow from each other. The period decides
				where the streaming window ends; the lock decides which period you can still
				act on. Ranked as a rolling seven days instead, on a Wednesday against the
				shipped league, the board counted 7.4 games a club when 4.7 remained in the
				matchup.
			</p>

			<div className="period">
				<label className="ctl">
					<span>Period</span>
					<select
						value={stated?.kind ?? ""}
						aria-label="How this league's scoring period runs"
						onChange={e => patch({ kind: (e.currentTarget.value || null) as Period["kind"] })}
					>
						<option value="">not stated</option>
						<option value="matchup">a matchup over days</option>
						<option value="daily">one day at a time</option>
						<option value="none">no periods at all</option>
					</select>
				</label>
				<label className="ctl">
					<span>Length</span>
					<PeriodDaysInput
						value={stated?.days ?? null}
						onReject={onReject}
						onChange={days => patch({ days })}
					/>
				</label>
				<label className="ctl">
					<span>Starts on</span>
					<select
						value={stated?.starts_on ?? ""}
						aria-label="Weekday the scoring period opens on"
						onChange={e =>
							patch({ starts_on: (e.currentTarget.value || null) as Period["starts_on"] })
						}
					>
						<option value="">not stated</option>
						{WEEKDAYS.map(([value, label]) => (
							<option key={value} value={value}>
								{label}
							</option>
						))}
					</select>
				</label>
				<label className="ctl">
					<span>Lineups lock</span>
					<select
						value={stated?.lineup_lock ?? ""}
						aria-label="When this league locks the lineup"
						onChange={e =>
							patch({ lineup_lock: (e.currentTarget.value || null) as Period["lineup_lock"] })
						}
					>
						<option value="">not stated</option>
						<option value="daily">every day</option>
						<option value="period">for the whole period</option>
					</select>
				</label>
			</div>

			<p className="sub period-reads">{reads}</p>

			<p className="sub">
				The board ranks the streaming week over {resolved.basis}.
				{slateEnd !== null &&
					` Right now that window is ${resolved.start} → ${resolved.end}${
						resolved.clipped ? ", cut short by the end of the captured slate" : ""
					}.`}
			</p>

			{assumptions.length > 0 && (
				<ul className="flags">
					{assumptions.map(a => (
						<li key={a}>{a}</li>
					))}
				</ul>
			)}

			<details>
				<summary>Anchor the period to a date</summary>
				<p className="sub">
					For a league whose grid does not fall on a fixed weekday. Any date known to be
					the first day of some period: the board steps forward from it in strides of the
					length above, so an anchor without a length is stepped in sevens. It replaces
					the start day rather than adjusting it — with an anchor set, the weekday above
					is not read at all.
				</p>
				<div className="period">
					<label className="ctl">
						<span>First day of a period</span>
						<input
							type="date"
							value={stated?.anchor ?? ""}
							aria-label="A date known to be the first day of a scoring period"
							onChange={e => patch({ anchor: e.currentTarget.value || null })}
						/>
					</label>
				</div>
			</details>

			{stated?.source && (
				<p className="sub period-source">
					Read from: {stated.source}
					{edited &&
						" — that is where the stored values came from, not what is in the boxes now."}
				</p>
			)}
		</>
	)
}

const LeagueEditor = ({
	leagueKey,
	league,
	snapshot,
	onSaved,
	onError,
	run
}: {
	leagueKey: string
	league: League
	snapshot: Snapshot | null
	onSaved: (config: Config) => void
	onError: (message: string) => void
	run: (fn: () => Promise<void>) => void
}) => {
	/** The ArkType League schema validates the draft on every change — the same
	 *  schema that guards what reaches storage. */
	const form = useForm({
		defaultValues: league,
		validators: { onChange: LeagueSchema },
		onSubmit: ({ value }) =>
			run(async () => {
				const config = leagues.save(leagueKey, value)
				form.reset(value)
				onSaved(config)
			})
	})

	// form.state is a snapshot — useStore subscribes this component to changes.
	const draft = useStore(form.store, s => s.values)
	// TanStack's isDirty tracks fields mounted via <form.Field>; this editor drives
	// nested objects through setFieldValue, so compare against the loaded league.
	const dirty = JSON.stringify(draft) !== JSON.stringify(league)
	// the validator returns either ArkErrors or the parsed League, so narrow on ArkErrors
	const invalid = useStore(form.store, s =>
		s.errorMap.onChange instanceof type.errors ? s.errorMap.onChange : null
	)

	const raw = (draft.league_rules as { raw_settings?: Record<string, unknown> } | undefined)?.raw_settings

	return (
		<>
			{/* Its own grid, above the scoring one: the team count and the scoring
			    period are the two league-wide facts a ranking turns on that are
			    neither a stat nor a slot, and neither had a field on this page. The
			    board, the draft and the trade page all told you to "open League
			    setup and set the team count" against a page that had no field for
			    it; the streaming week is ranked over whatever period the league
			    states, and a league whose period could not be read off its platform
			    had no way to state one. Kept out of the grid below because that
			    grid's first two cards are batting and pitching, which is what the
			    suites read them as. */}
			<div className="grid">
				<section className="card full">
					<h2>This league</h2>
					<p className="sub">
						Replacement level is teams × slots — what a player is worth is what he beats
						the next man up by, and the team count is what decides who that is. The board,
						the draft and every trade verdict wait on it.
					</p>
					<TeamCountInput
						value={draft.meta.max_teams}
						onReject={onError}
						onChange={max_teams => form.setFieldValue("meta", { ...draft.meta, max_teams })}
					/>
					{draft.meta.max_teams == null && (
						<p className="empty" style={{ marginTop: "var(--sp-2)" }}>
							Not set. Nothing is assumed in its place, so nothing is ranked.
						</p>
					)}
				</section>

				<section className="card full">
					<h2>Scoring period</h2>
					<ScoringPeriodPanel
						draft={draft}
						saved={league.scoring_period}
						snapshot={snapshot}
						onReject={onError}
						onChange={p => form.setFieldValue("scoring_period", p)}
					/>
				</section>
			</div>

			<div className="grid">
				<section className="card">
					<h2>Batting</h2>
					<p className="sub">Points per stat, as scored by this league.</p>
					<StatTable
						table={draft.scoring.batting}
						side="batting"
						onReject={onError}
						onChange={batting => form.setFieldValue("scoring", { ...draft.scoring, batting })}
					/>
				</section>

				<section className="card">
					<h2>Pitching</h2>
					<p className="sub">Negative values are penalties.</p>
					<StatTable
						table={draft.scoring.pitching}
						side="pitching"
						onReject={onError}
						onChange={pitching => form.setFieldValue("scoring", { ...draft.scoring, pitching })}
					/>
				</section>

				<section className="card full">
					<h2>Roster slots</h2>
					<p className="sub">{draft.roster.raw ?? "Slot counts for this league."}</p>
					<RosterPanel roster={draft.roster} onReject={onError} onChange={r => form.setFieldValue("roster", r)} />
				</section>

				<section className="card">
					<h2>Position eligibility</h2>
					{draft.eligibility?.source && <p className="sub">{draft.eligibility.source}</p>}
					<EligibilityPanel
						eligibility={draft.eligibility}
						onReject={onError}
						onChange={e => form.setFieldValue("eligibility", e)}
					/>
				</section>

				<section className="card">
					<h2>Needs review</h2>
					<p className="sub">Anything the source didn't state is left null and listed here.</p>
					{draft.needs_review.length ?
						<ul className="flags">
							{draft.needs_review.map(f => (
								<li key={f}>{f}</li>
							))}
						</ul>
					:	<p className="empty">Nothing outstanding — every value came from the league.</p>}
				</section>

				{raw && Object.keys(raw).length > 0 && (
					<section className="card full">
						<h2>League rules</h2>
						<p className="sub">Verbatim from the league's settings page.</p>
						<details>
							<summary>{Object.keys(raw).length} settings</summary>
							<dl>
								{Object.entries(raw).map(([k, v]) => (
									<Fragment2 key={k} term={k}>
										{String(v)}
									</Fragment2>
								))}
							</dl>
						</details>
					</section>
				)}

				{draft.scoring.unmapped != null && (
					<section className="card full">
						<h2>Unmapped scoring</h2>
						<p className="sub">Kept raw rather than guessed at.</p>
						<pre>{JSON.stringify(draft.scoring.unmapped, null, 2)}</pre>
					</section>
				)}
			</div>

			<div className={dirty ? "savebar on" : "savebar"}>
				<div className="inner">
					<span className="msg">
						{invalid ? `Invalid: ${invalid.summary}` : "Unsaved changes"}
					</span>
					<button onClick={() => form.reset()}>Revert</button>
					<button className="primary" disabled={!!invalid} onClick={() => void form.handleSubmit()}>
						Save
					</button>
				</div>
			</div>
		</>
	)
}
