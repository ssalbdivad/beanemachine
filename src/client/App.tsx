import { useForm, useStore } from "@tanstack/react-form"
import { type } from "arktype"
import { useCallback, useEffect, useRef, useState } from "react"
import type { Snapshot } from "../data/snapshot.ts"
import type { Config, League } from "../schema.ts"
import { League as LeagueSchema } from "../schema.ts"
import { api, ApiError, detectMode, getMode } from "./api.ts"
import { Billy } from "./Billy.tsx"
import { Board } from "./Board.tsx"
import { Draft } from "./Draft.tsx"
import { Trade } from "./Trade.tsx"
import { leagues } from "./leagues.ts"
import {
	EligibilityPanel,
	Fragment2,
	freshness,
	leagueReady,
	RosterPanel,
	Setup,
	StatTable,
	TeamCountInput
} from "./panels.tsx"
import { useSnapshot } from "./useBoard.ts"
import { useToast } from "./useToast.tsx"

const TEMPLATES = ["custom", "yahoo", "espn", "sleeper"]

type View = "board" | "league" | "trade" | "draft"

/** What is known about the leagues in this browser. Three states, because an
 *  unreadable store and an empty one call for opposite advice. */
type StoreState = "reading" | "read" | "unreadable"

/**
 * The four tabs, in DOM order — which is deliberately not the order a season is
 * run in.
 *
 * A season goes: set the league up, draft it, manage the team, then read the
 * board every week. But the board is the tab someone opens fifty times and the
 * setup is the tab they open once, so the board lands first and stays first.
 * The sequence is stated instead of implied by position: the setup panel lists
 * the tabs in season order, and every button says what it is for on hover.
 */
const VIEWS: { id: View; label: string; purpose: string }[] = [
	{
		id: "board",
		label: "Recommendations",
		purpose:
			"The wire ranked in this league's scoring, over the next week, the standing fortnight, or the rest of the season. The tab you come back to."
	},
	{
		id: "league",
		label: "League setup",
		purpose:
			"Scoring, roster slots and team count — read off the platform or entered by hand. Everything the other tabs say is priced in these."
	},
	{
		id: "trade",
		label: "My team & trades",
		purpose: "Your roster and starting lineup in points, and what a proposed deal does to it."
	},
	{
		id: "draft",
		label: "Draft",
		purpose: "Who to take next, what he gains over the next man up, and where each position's cliff is."
	}
]

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

	const league = key && config ? config.leagues[key] : undefined
	// Nothing is known until the store has been read, and "no leagues", "not looked
	// yet" and "the store is unreadable" are three different screens. One value
	// decides which, so no two controls can disagree about it.
	const store: StoreState = loadError ? "unreadable" : config ? "read" : "reading"
	const loading = store === "reading"
	// The board, the draft and a trade are all priced in the same three inputs.
	// Until they exist, the guided panel is what the page leads with.
	const ready = leagueReady(league)

	return (
		<div className={`wrap${busy ? " busy" : ""}${acknowledged ? " saved" : ""}`}>
			<header>
				<div className="mark">
					<Billy />
					<h1>
						beane<b>machine</b>
					</h1>
				</div>
				<p className="tag tagline">How can you not be robotic about baseball?</p>
				<p className="tag">Optimized picks, ranked in your league&rsquo;s own scoring.</p>
				{config && getMode() === "static" && (
					<p className="tag static-note">
						Static build — your leagues are stored in this browser, so editing and saving
						work here. Importing one from its URL needs the local server (
						<code>node src/server.ts</code> alongside <code>npx vite</code>), since browsers
						can&rsquo;t read Yahoo or ESPN directly.
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
				activeKey={key}
				onSelect={k => void run(async () => adopt(leagues.activate(k), k))}
				onImport={url =>
					void run(async () => {
						// reading the league needs a server; storing what it read never does
						const { key: k, league } = await api.import(url)
						adopt(leagues.save(k, league), k)
						show(`Imported ${league.meta.league_name ?? k}`)
					})
				}
				onCreate={(k, template) =>
					void run(async () => {
						adopt(leagues.create(k, template), k)
						// the new league is blank on purpose, and the setup panel below now says
						// exactly which values that leaves missing
						setView("league")
						show(`Created ${k} — every field is blank until you fill it in`)
					})
				}
				onRemove={k =>
					void run(async () => {
						adopt(leagues.remove(k))
						show("Removed")
					})
				}
				onDownload={() => config && leagues.download(config)}
				onLoadFile={file =>
					void run(async () => {
						const next = leagues.replace(await file.text())
						adopt(next)
						show(`Loaded ${Object.keys(next.leagues).length} leagues from ${file.name}`)
					})
				}
				onReject={m => show(m, true)}
			/>

			<Status
				league={league ?? null}
				store={store}
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
					onOpenSetup={view === "league" ? undefined : () => setView("league")}
				/>
			)}

			{view === "board" ?
				<div className="grid">
					<Board snapshot={snapshot} league={league ?? null} error={snapshotError} />
				</div>
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

			{toast && <div className={`toast on${toast.bad ? " bad" : ""}`} role="status">{toast.message}</div>}
		</div>
	)
}

const Toolbar = ({
	config,
	store,
	view,
	activeKey,
	onSelect,
	onImport,
	onCreate,
	onRemove,
	onDownload,
	onLoadFile,
	onReject
}: {
	config: Config | null
	store: StoreState
	view: View
	activeKey: string | null
	onSelect: (key: string) => void
	onImport: (url: string) => void
	onCreate: (key: string, template: string) => void
	onRemove: (key: string) => void
	onDownload: () => void
	onLoadFile: (file: File) => void
	onReject: (message: string) => void
}) => {
	const [url, setUrl] = useState("")
	const [template, setTemplate] = useState("custom")
	const picker = useRef<HTMLInputElement>(null)
	const keys = Object.keys(config?.leagues ?? {})
	// the same control means different things per view, so it says which
	const label = LEAGUE_LABEL[view]
	return (
		<>
			<div className="bar">
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
				<label className="ctl">
					<span>Start a league from</span>
					<select
						id="tpl"
						value={template}
						aria-label="Start a league from"
						onChange={e => setTemplate(e.currentTarget.value)}
					>
						{TEMPLATES.map(t => (
							<option key={t} value={t}>
								{t === "custom" ? "a blank template" : `a ${t} template`}
							</option>
						))}
					</select>
				</label>
				<button
					title="Start an empty league you fill in yourself — no values are invented"
					onClick={() => {
						const k = prompt(`Key for the new ${template} league (e.g. "${template}:12345"):`, `${template}:`)
						if (k?.trim()) onCreate(k.trim(), template)
					}}
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
					title="Download every league in this browser as a scoring.json"
					onClick={onDownload}
				>
					Download
				</button>
				<button
					title="Replace the leagues in this browser with a scoring.json file"
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
						if (!chosen) return
						// the file replaces the store outright, so say what is about to go
						if (
							keys.length &&
							!confirm(
								`Replace the ${keys.length} league${keys.length === 1 ? "" : "s"} in this browser with ${chosen.name}?`
							)
						)
							return
						onLoadFile(chosen)
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
						placeholder="Paste a Yahoo, ESPN, or Sleeper league URL…"
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
	snapshot,
	snapshotError
}: {
	league: League | null
	store: StoreState
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
				<Chips league={league} />
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

const Chips = ({ league }: { league: League }) => {
	const { meta, provenance } = league
	return (
		<>
			{[meta.platform, meta.team_name].filter(Boolean).map(v => (
				<span className="chip" key={String(v)}>
					<b>{String(v)}</b>
				</span>
			))}
			{meta.max_teams != null && (
				<span className="chip">
					<b>{meta.max_teams}</b> teams
				</span>
			)}
			{meta.scoring_type && <span className="chip">{meta.scoring_type}</span>}
			<span className={`chip ${provenance.verified ? "ok" : "warn"}`}>
				{provenance.verified ? "read from source" : "unverified"}
			</span>
			{provenance.fetched_at && <span className="chip">fetched {provenance.fetched_at}</span>}
		</>
	)
}

const LeagueEditor = ({
	leagueKey,
	league,
	onSaved,
	onError,
	run
}: {
	leagueKey: string
	league: League
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
			{/* Its own grid, above the scoring one: the team count is the only league
			    value that is neither a stat nor a slot, and until this card existed
			    the board, the draft and the trade page all told you to "open League
			    setup and set the team count" against a page that had no field for it.
			    Kept out of the grid below because that grid's first two cards are
			    batting and pitching, which is what the suites read them as. */}
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
