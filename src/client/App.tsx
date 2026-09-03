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
	EligibilityPanel,
	Fragment2,
	freshness,
	leagueReady,
	RosterPanel,
	Setup,
	StatTable,
	TeamCountInput,
	type View,
	VIEWS
} from "./panels.tsx"
import { useSnapshot } from "./useBoard.ts"
import { useToast } from "./useToast.tsx"

const TEMPLATES = ["custom", "yahoo", "espn", "sleeper"]

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
			<header>
				<div className="mark">
					<Billy />
					<h1>
						beane<b>machine</b>
					</h1>
				</div>
				<p className="tag tagline">How can you not be robotic about baseball?</p>
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
				manage={manage}
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

			{toast && <div className={`toast on${toast.bad ? " bad" : ""}`} role="status">{toast.message}</div>}
		</div>
	)
}

const Toolbar = ({
	config,
	store,
	view,
	manage,
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
	/** Whether the create/remove/import/file controls are on screen at all. */
	manage: boolean
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
