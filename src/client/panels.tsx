import type { League } from "../schema.ts"

type Num = (value: number) => void

/** A stat's point value. Blank or non-numeric restores — `Number("")` is 0, which
 *  silently turned a cleared field into a real zero before. */
export const ValueInput = ({
	value,
	label,
	onCommit,
	onReject,
	className = "val",
	integer = false
}: {
	value: number
	label: string
	onCommit: Num
	onReject: (message: string) => void
	className?: string
	integer?: boolean
}) => (
	<input
		className={`${className} ${value > 0 ? "pos" : value < 0 ? "neg" : ""}`}
		type="number"
		step={integer ? 1 : "any"}
		title={label}
		aria-label={label}
		defaultValue={String(value)}
		key={value}
		onChange={e => {
			const raw = e.currentTarget.value
			const n = integer ? Math.round(Number(raw)) : Number(raw)
			if (raw.trim() !== "" && Number.isFinite(n) && (!integer || n >= 0)) onCommit(n)
			else {
				e.currentTarget.value = String(value)
				onReject(`Enter a ${integer ? "whole " : ""}number for ${label}.`)
			}
		}}
	/>
)

export const StatTable = ({
	table,
	side,
	onChange,
	onReject
}: {
	table: Record<string, number>
	side: string
	onChange: (next: Record<string, number>) => void
	onReject: (message: string) => void
}) => {
	const keys = Object.keys(table)
	return (
		<div className="rows">
			{!keys.length && <p className="empty">No {side} stats scored.</p>}
			{keys.map(code => (
				<div className="row" key={code}>
					<span className="code">{code}</span>
					<span className="name" />
					<ValueInput
						value={table[code]!}
						label={`${code} point value`}
						onCommit={n => onChange({ ...table, [code]: n })}
						onReject={onReject}
					/>
					<button
						className="ghost"
						title={`Remove ${code}`}
						onClick={() => {
							const { [code]: _, ...rest } = table
							onChange(rest)
						}}
					>
						×
					</button>
				</div>
			))}
			<AddStat table={table} onChange={onChange} onReject={onReject} />
		</div>
	)
}

const AddStat = ({
	table,
	onChange,
	onReject
}: {
	table: Record<string, number>
	onChange: (next: Record<string, number>) => void
	onReject: (message: string) => void
}) => {
	const add = (form: HTMLFormElement) => {
		const data = new FormData(form)
		const code = String(data.get("code") ?? "").trim().toUpperCase()
		const raw = String(data.get("points") ?? "").trim()
		const points = Number(raw)
		if (!code) return onReject("Enter a stat code.")
		if (raw === "" || !Number.isFinite(points)) return onReject("Enter a point value.")
		if (code in table) return onReject(`${code} is already scored.`)
		onChange({ ...table, [code]: points })
		form.reset()
	}
	return (
		<form
			className="add"
			onSubmit={e => {
				e.preventDefault()
				add(e.currentTarget)
			}}
		>
			<input className="k" name="code" placeholder="CODE" aria-label="Stat code" />
			<input name="points" type="number" step="any" placeholder="points" aria-label="Points" />
			<button type="submit">Add</button>
		</form>
	)
}

const IL_SLOTS = ["IL", "NA", "IL+"]

export const recount = (slots: Record<string, number>): League["roster"]["counts"] => {
	const sum = (ks: string[]) => ks.reduce((a, k) => a + (slots[k] ?? 0), 0)
	const all = Object.keys(slots)
	return {
		active: sum(all.filter(k => k !== "BN" && !IL_SLOTS.includes(k))),
		bench: slots.BN ?? 0,
		injured_list: sum(IL_SLOTS),
		total: sum(all)
	}
}

export const RosterPanel = ({
	roster,
	onChange,
	onReject
}: {
	roster: League["roster"]
	onChange: (next: League["roster"]) => void
	onReject: (message: string) => void
}) => {
	const order = roster.slot_order ?? Object.keys(roster.slots)
	const seen = new Set<string>()
	const setSlots = (slots: Record<string, number>, slot_order = roster.slot_order) =>
		onChange({ ...roster, slots, slot_order, counts: recount(slots) })

	const addSlot = (form: HTMLFormElement) => {
		const data = new FormData(form)
		const name = String(data.get("slot") ?? "").trim().toUpperCase()
		const n = Math.round(Number(data.get("count")))
		if (!name) return onReject("Enter a slot name.")
		if (!Number.isFinite(n) || n < 1) return onReject("Enter how many of that slot.")
		if (roster.slots[name]) return onReject(`${name} already exists.`)
		setSlots({ ...roster.slots, [name]: n }, [...(roster.slot_order ?? Object.keys(roster.slots)), name])
		form.reset()
	}

	return (
		<>
			<div className="slots">
				{order.map(slot => {
					if (seen.has(slot)) return null
					seen.add(slot)
					return (
						<div className="slot" key={slot}>
							<span className="code">{slot}</span>
							<ValueInput
								className=""
								integer
								value={roster.slots[slot] ?? 0}
								label={`${slot} slot count`}
								onReject={onReject}
								onCommit={n => {
									if (n === 0) {
										const { [slot]: _, ...rest } = roster.slots
										setSlots(rest, (roster.slot_order ?? []).filter(s => s !== slot))
									} else setSlots({ ...roster.slots, [slot]: n })
								}}
							/>
						</div>
					)
				})}
				<form
					className="add slotadd"
					onSubmit={e => {
						e.preventDefault()
						addSlot(e.currentTarget)
					}}
				>
					<input className="k" name="slot" placeholder="SLOT" aria-label="New roster slot" />
					<input name="count" type="number" min="1" step="1" placeholder="#" aria-label="Slot count" />
					<button type="submit">Add slot</button>
				</form>
			</div>
			{roster.counts && (
				<div className="totals">
					{(
						[
							["active", roster.counts.active],
							["bench", roster.counts.bench],
							["IL", roster.counts.injured_list],
							["total", roster.counts.total]
						] as const
					).map(([label, value]) => (
						<div className="tot" key={label}>
							<b>{value}</b>
							<span>{label}</span>
						</div>
					))}
				</div>
			)}
			{roster.slot_accepts && (
				<details>
					<summary>Which positions fill each slot</summary>
					<dl>
						{Object.entries(roster.slot_accepts).map(([slot, accepts]) => (
							<Fragment2 key={slot} term={slot}>
								<code>
									{Array.isArray(accepts) ? accepts.join(", ") : accepts.replace("_", " ")}
								</code>
							</Fragment2>
						))}
					</dl>
				</details>
			)}
		</>
	)
}

/** dt/dd pair — a fragment can't carry the key, so this names the pattern. */
export const Fragment2 = ({ term, children }: { term: string; children: React.ReactNode }) => (
	<>
		<dt>{term}</dt>
		<dd>{children}</dd>
	</>
)

export const EligibilityPanel = ({
	eligibility,
	onChange,
	onReject
}: {
	eligibility: League["eligibility"]
	onChange: (next: League["eligibility"]) => void
	onReject: (message: string) => void
}) => {
	if (!eligibility)
		return <p className="empty">This platform doesn't publish eligibility rules — nothing assumed.</p>
	const { batters, pitchers, tracked_positions } = eligibility
	return (
		<dl>
			{batters && (
				<Fragment2 term="Batters">
					<span className="field">
						<ValueInput
							integer
							value={batters.games_started_at_position}
							label="games started"
							onReject={onReject}
							onCommit={n =>
								onChange({ ...eligibility, batters: { ...batters, games_started_at_position: n } })
							}
						/>
						<span className="unit">games started</span>
					</span>
					<span className="unit"> {batters.rule} </span>
					<span className="field">
						<ValueInput
							integer
							value={batters.games_played_at_position}
							label="games played"
							onReject={onReject}
							onCommit={n =>
								onChange({ ...eligibility, batters: { ...batters, games_played_at_position: n } })
							}
						/>
						<span className="unit">games played</span>
					</span>
				</Fragment2>
			)}
			{Object.entries(pitchers ?? {}).map(([pos, rules]) => (
				<Fragment2 key={pos} term={pos}>
					{Object.entries(rules).map(([rule, n]) => (
						<span className="field" key={rule}>
							<ValueInput
								integer
								value={n}
								label={rule.replace(/_/g, " ")}
								onReject={onReject}
								onCommit={v =>
									onChange({
										...eligibility,
										pitchers: { ...pitchers, [pos]: { ...rules, [rule]: v } }
									})
								}
							/>
							<span className="unit">{rule.replace(/_/g, " ")}</span>
						</span>
					))}
				</Fragment2>
			))}
			{tracked_positions?.length ? (
				<Fragment2 term="Tracked">
					<code>{tracked_positions.join(", ")}</code>
				</Fragment2>
			) : null}
		</dl>
	)
}

/* ---------------------------------------------------------------------------
 * First run.
 *
 * Every platform_template in scoring.json ships empty — no scoring, no slots, no
 * team count — because none of those can be known before a real league is read.
 * So a visitor who creates one lands on a league that honestly cannot rank
 * anything, and three tabs each refuse for their own reason. The refusals are
 * right; on their own they are also a dead end, and they tell a partial truth:
 * the board stops at the first missing input it hits and never mentions the
 * other two.
 *
 * This is the one place that states the whole gap at once — what is missing,
 * where each value comes from, and what it unblocks. Nothing here fills a value
 * in: a number nobody read stays missing and stays listed.
 * ------------------------------------------------------------------------- */

export interface Gap {
	/** Named the way League setup names it, so the fix is findable. */
	label: string
	/** What was actually read, or null while it is missing. Never a default. */
	have: string | null
	/** Why it cannot be guessed at. */
	why: string
	/** What stays unavailable until it exists. */
	blocks: string
}

/** The three inputs every priced answer in the app is denominated in. */
export const leagueGaps = (league: League): Gap[] => {
	// A stat that exists at 0 is scored at zero — the same as unscored, as far as
	// a projection is concerned — so the count is of non-zero values only.
	const scored = [
		...Object.values(league.scoring.batting),
		...Object.values(league.scoring.pitching)
	].filter(v => v !== 0).length
	const slots = Object.entries(league.roster.slots).filter(([, n]) => n > 0)
	const starters = slots
		.filter(([slot]) => slot !== "BN" && slot !== "IL" && slot !== "NA")
		.reduce((a, [, n]) => a + n, 0)
	return [
		{
			label: "What each stat is worth",
			have: scored ? `${scored} stats scored` : null,
			why: "Points per stat, as your league scores them.",
			blocks:
				"A bscore is denominated in your league's own points, so every projection comes out at exactly zero — the board, each draft pick and every trade verdict."
		},
		{
			label: "How many teams",
			have: league.meta.max_teams == null ? null : `${league.meta.max_teams} teams`,
			why: "The number of teams in the league, as it drafts.",
			blocks:
				"Replacement level is teams × slots: a player is worth what he beats the next man up by, and how deep the wire runs decides who that is. Nothing is ranked without it."
		},
		{
			label: "Roster slots",
			have: slots.length ? `${slots.length} slots, ${starters} starting` : null,
			why: "How many of each position you start, plus bench and IL.",
			blocks:
				"Positional scarcity, what the draft says you still need, and the lineup a trade is judged against."
		}
	]
}

export const leagueReady = (league: League | null | undefined): boolean =>
	!!league && leagueGaps(league).every(g => g.have !== null)

/** What each tab is for, in the order a season actually runs. The nav can't be
 *  reordered to match — the board is the tab people come back to, so it stays
 *  first — so the sequence is said here instead of implied by position. */
const TABS: [string, string][] = [
	[
		"League setup",
		"Scoring, roster slots and team count. Read off the platform, or typed in — every other tab prices what it ranks in these."
	],
	["Draft", "Who to take next, what it gains over the next man up, and where the cliff at each position is."],
	["My team & trades", "Your starting lineup in points, and what a proposed deal does to it."],
	["Recommendations", "The wire ranked in your scoring, over a week, a fortnight or the rest of the season. The weekly one."]
]

/**
 * Rendered above whichever tab is open, never instead of it: each tab still
 * says its own piece, and this says the piece none of them can see.
 */
export const Setup = ({
	leagueKey,
	league,
	canImport,
	onOpenSetup
}: {
	leagueKey: string | null
	league: League | null
	/** False in the static build, where reading a league needs the local server. */
	canImport: boolean
	onOpenSetup: () => void
}) => {
	const gaps = league ? leagueGaps(league) : []
	const missing = gaps.filter(g => g.have === null)
	const have = gaps.filter(g => g.have !== null)
	const name = league?.meta.league_name ?? leagueKey
	return (
		<div className="grid">
			<section className="card full">
				<h2>{league ? "Finish setting this league up" : "Start with a league"}</h2>
				<p className="sub">
					{!league ?
						<>
							There is no league in this browser yet, and nothing in beanemachine means
							anything without one — a player&rsquo;s value is his value <i>in your
							league&rsquo;s scoring</i>.
						</>
					:	<>
							<b>{name}</b> was created from a blank template, so{" "}
							{missing.length === 1 ? "one input is" : `${missing.length} inputs are`} still
							missing. Nothing is assumed in their place: a value nobody read stays missing
							and stays listed.
						</>
					}
				</p>

				{missing.length > 0 && (
					<ul className="flags">
						{missing.map(g => (
							<li key={g.label}>
								<b>{g.label}</b> — {g.why} {g.blocks}
							</li>
						))}
					</ul>
				)}

				{have.length > 0 && (
					<div className="chips" style={{ marginTop: "var(--sp-3)" }}>
						{have.map(g => (
							<span className="chip ok" key={g.label}>
								{g.label}: <b>{g.have}</b>
							</span>
						))}
					</div>
				)}

				<p className="sub" style={{ margin: "var(--sp-4) 0 0" }}>
					{canImport ?
						<>
							<b>Paste your league&rsquo;s URL</b> in the field above and beanemachine reads
							the real values off Yahoo, ESPN or Sleeper &mdash; that is the only route that
							ends with <i>read from source</i> against them.{" "}
						</>
					:	<>
							<b>Importing needs the local server</b>, and this is the static build, so the
							values have to be typed in here. They are stored in this browser either way.{" "}
						</>
					}
					{league ?
						<>
							Or open <b>League setup</b> and enter them by hand.
						</>
					:	<>
							Or press <b>New</b> above to start one from a blank template and fill it in.
						</>
					}
				</p>

				{league && (
					<p style={{ margin: "var(--sp-3) 0 0" }}>
						<button className="primary" onClick={onOpenSetup}>
							Open League setup
						</button>
					</p>
				)}

				<div className="legend">
					<p className="tiny-note">What each tab does once those exist, in the order a season uses them:</p>
					<dl>
						{TABS.map(([tab, does]) => (
							<Fragment2 key={tab} term={tab}>
								{does}
							</Fragment2>
						))}
					</dl>
				</div>
			</section>
		</div>
	)
}

/**
 * How old the observed-data capture is. A projection built on last week's numbers
 * is wrong in a way nothing else on the page would reveal, so the age is stated in
 * the masthead as well as on the board — same 36-hour line as `Board.tsx`, because
 * two different answers to "is this stale" would be worse than one repeated one.
 */
export const freshness = (
	capturedAt: string | undefined,
	now: number
): { label: string; stale: boolean } => {
	const hours = capturedAt == null ? NaN : (now - Date.parse(capturedAt)) / 3_600_000
	if (!Number.isFinite(hours)) return { label: "age unknown", stale: true }
	if (hours < 1) return { label: "just now", stale: false }
	if (hours < 36) return { label: `${Math.round(hours)}h ago`, stale: false }
	return { label: `${Math.round(hours / 24)}d ago`, stale: true }
}
