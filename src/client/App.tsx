import { useForm, useStore } from "@tanstack/react-form"
import { type } from "arktype"
import { useCallback, useEffect, useState } from "react"
import type { Config, League } from "../schema.ts"
import { League as LeagueSchema } from "../schema.ts"
import { api, ApiError, downloadConfig, getMode } from "./api.ts"
import { Billy } from "./Billy.tsx"
import { Board } from "./Board.tsx"
import { EligibilityPanel, Fragment2, RosterPanel, StatTable } from "./panels.tsx"
import { useSnapshot } from "./useBoard.ts"
import { useToast } from "./useToast.tsx"

const TEMPLATES = ["custom", "yahoo", "espn", "sleeper"]

export const App = () => {
	const [config, setConfig] = useState<Config | null>(null)
	const [key, setKey] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	// Billy's lenses light for a moment when a save lands
	const [acknowledged, setAcknowledged] = useState(false)
	const [view, setView] = useState<"board" | "league">("board")
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
		staticConfig = next
		setKey(chosen)
	}, [])

	useEffect(() => {
		void run(async () => adopt(await api.config()))
	}, [run, adopt])

	const league = key && config ? config.leagues[key] : undefined

	return (
		<div className={`wrap${busy ? " busy" : ""}${acknowledged ? " saved" : ""}`}>
			<header>
				<div className="mark">
					<Billy />
					<h1>
						beane<b>machine</b>
					</h1>
				</div>
				<p className="tag">League scoring, read from the source — never guessed.</p>
				{config && getMode() === "static" && (
					<p className="tag static-note">
						Static build — edits stay in this browser and Save downloads the file. Run{" "}
						<code>nub run dev</code> locally to import leagues and write scoring.json.
					</p>
				)}
			</header>

			<nav className="views" role="tablist">
				<button
					role="tab"
					aria-selected={view === "board"}
					className={view === "board" ? "on" : ""}
					onClick={() => setView("board")}
				>
					Recommendations
				</button>
				<button
					role="tab"
					aria-selected={view === "league"}
					className={view === "league" ? "on" : ""}
					onClick={() => setView("league")}
				>
					League setup
				</button>
			</nav>

			<Toolbar
				config={config}
				activeKey={key}
				onSelect={k =>
					void run(async () => {
						if (getMode() === "static") return setKey(k)
						adopt((await api.activate(k)).config, k)
					})
				}
				onImport={url =>
					void run(async () => {
						const { key: k, config: next } = await api.import(url)
						adopt(next, k)
						show(`Imported ${next.leagues[k!]?.meta.league_name ?? k}`)
					})
				}
				onCreate={(k, template) =>
					void run(async () => {
						const { key: made, config: next } = await api.create(k, template)
						adopt(next, made)
						show(`Created ${made} — every field is blank until you fill it in`)
					})
				}
				onRemove={k =>
					void run(async () => {
						adopt((await api.remove(k)).config)
						show("Removed")
					})
				}
				onReject={m => show(m, true)}
			/>

			{league && <Chips league={league} />}

			{view === "board" ?
				<div className="grid">
					<Board snapshot={snapshot} league={league ?? null} error={snapshotError} />
				</div>
			: league && key ?
				<LeagueEditor
					key={key}
					leagueKey={key}
					league={league}
					onSaved={next => {
						adopt(next, key)
						acknowledge()
						show("Saved to scoring.json")
					}}
					onDownload={next => {
						adopt(next, key)
						acknowledge()
						downloadConfig(next)
						show("Downloaded scoring.json")
					}}
					onError={m => show(m, true)}
					run={run}
				/>
			:	<div className="grid">
					<section className="card full">
						<p className="empty">
							{config ?
								"No league selected. Paste a league URL above to import one."
							:	"Loading…"}
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
	activeKey,
	onSelect,
	onImport,
	onCreate,
	onRemove,
	onReject
}: {
	config: Config | null
	activeKey: string | null
	onSelect: (key: string) => void
	onImport: (url: string) => void
	onCreate: (key: string, template: string) => void
	onRemove: (key: string) => void
	onReject: (message: string) => void
}) => {
	const [url, setUrl] = useState("")
	const [template, setTemplate] = useState("custom")
	const keys = Object.keys(config?.leagues ?? {})
	return (
		<>
			<div className="bar">
				<label className="ctl">
					<span>League being edited</span>
					<select
						value={activeKey ?? ""}
						disabled={!keys.length}
						aria-label="League being edited"
						onChange={e => onSelect(e.currentTarget.value)}
					>
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
					onClick={() => activeKey && confirm(`Remove ${activeKey} from scoring.json?`) && onRemove(activeKey)}
				>
					Remove
				</button>
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

const Chips = ({ league }: { league: League }) => {
	const { meta, provenance } = league
	return (
		<div className="chips">
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
		</div>
	)
}

let staticConfig: Config | null = null

const LeagueEditor = ({
	leagueKey,
	league,
	onSaved,
	onDownload,
	onError,
	run
}: {
	leagueKey: string
	league: League
	onSaved: (config: Config) => void
	onDownload: (config: Config) => void
	onError: (message: string) => void
	run: (fn: () => Promise<void>) => void
}) => {
	/** The ArkType League schema validates the draft on every change — the exact
	 *  schema the server re-checks and that guards scoring.json on disk. */
	const form = useForm({
		defaultValues: league,
		validators: { onChange: LeagueSchema },
		onSubmit: ({ value }) =>
			run(async () => {
				if (getMode() === "static") {
					// no backend to write to: hand the edited config back as a file
					const merged = { ...staticConfig!, leagues: { ...staticConfig!.leagues, [leagueKey]: value } }
					form.reset(value)
					return onDownload(merged)
				}
				const { config } = await api.save(leagueKey, value)
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
						{getMode() === "static" ? "Download scoring.json" : "Save to scoring.json"}
					</button>
				</div>
			</div>
		</>
	)
}
