import { useEffect, useRef } from "react"
import type { League } from "../schema.ts"

type Num = (value: number) => void

/**
 * A stat's point value. Blank or non-numeric restores — `Number("")` is 0, which
 * silently turned a cleared field into a real zero before.
 *
 * The element owns its own text and the number is committed behind it, because
 * the two are not the same thing while someone is still typing. Two ways that
 * went wrong, both of which made a value impossible to *type* — and the manual
 * path is the whole point of this page for a league nobody can import:
 *
 * - keyed on the committed value (`key={value}`), every keystroke committed, the
 *   key changed, React replaced the element and the field lost focus with one
 *   digit in it. Typing "123" left "1".
 * - held as controlled React state, `-` could not survive a keystroke: a number
 *   input reports "" for text it cannot parse yet, React restores a controlled
 *   input whose onChange changed no state, and the minus was wiped before the
 *   digits arrived. Typing "-3" over "8" left "83", so no pitching penalty could
 *   be entered by hand at all.
 *
 * So the DOM keeps the text, and the only thing that ever overwrites it is a
 * value arriving from outside — a Revert, or another league being selected.
 * `fill()` sets a value in one shot, so no test saw either of these.
 */
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
}) => {
	const el = useRef<HTMLInputElement>(null)
	/** The number this field last handed up. It comes straight back as `value`, and
	 *  rewriting the field on that echo would eat the "." halfway through "1.5". */
	const sent = useRef<number | null>(null)
	useEffect(() => {
		if (value === sent.current) return
		sent.current = null
		if (el.current) el.current.value = String(value)
	}, [value])
	return (
		<input
			ref={el}
			className={`${className} ${value > 0 ? "pos" : value < 0 ? "neg" : ""}`}
			type="number"
			step={integer ? 1 : "any"}
			title={label}
			aria-label={label}
			defaultValue={String(value)}
			onChange={e => {
				const node = e.currentTarget
				const raw = node.value
				// `validity.badInput` is the browser distinguishing "there is something
				// here, it just isn't a number yet" from "this is empty". A lone "-" is the
				// first of those: neither a clear nor a mistake, so leave it and wait for
				// the rest of the number.
				if (raw === "" && node.validity.badInput) return
				const n = integer ? Math.round(Number(raw)) : Number(raw)
				if (raw.trim() !== "" && Number.isFinite(n) && (!integer || n >= 0)) {
					sent.current = n
					onCommit(n)
				} else {
					node.value = String(value)
					onReject(`Enter a ${integer ? "whole " : ""}number for ${label}.`)
				}
			}}
			onBlur={e => {
				// a half-typed number that is left half-typed committed nothing, so the
				// field must not go on showing a value no league holds
				if (e.currentTarget.validity.badInput) {
					e.currentTarget.value = String(value)
					return onReject(`Enter a ${integer ? "whole " : ""}number for ${label}.`)
				}
				// and once the typing is over the field shows what was actually stored:
				// "1.5" in a whole-number field is kept as 2, and a field still reading
				// 1.5 would be the page disagreeing with the league about its own value
				if (e.currentTarget.value !== String(value)) e.currentTarget.value = String(value)
			}}
		/>
	)
}

/**
 * How many teams the league drafts with — the one value three tabs refuse to rank
 * without and the only one with nowhere else to live: it is neither a stat nor a
 * slot. Empty is a real state, not an error. Clearing it puts the refusals back,
 * which is correct — an unknown team count must not decay into a default of 10.
 */
export const TeamCountInput = ({
	value,
	onChange,
	onReject
}: {
	value: number | null
	onChange: (next: number | null) => void
	onReject: (message: string) => void
}) => {
	/** Uncontrolled for the reason `ValueInput` above is: the element has to be
	 *  allowed to hold text the number is not finished being. */
	const el = useRef<HTMLInputElement>(null)
	const sent = useRef<number | null | undefined>(undefined)
	/** What was in the field before this edit began, so a rejected entry has
	 *  somewhere to go back to. */
	const before = useRef<number | null>(value)
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
				min="2"
				step="1"
				placeholder="—"
				aria-label="Teams in this league"
				// a count, not a sentence — and it cannot take the `.val` class the other
				// number fields wear, which is what the suites use to find the stat tables
				style={{ width: "6em" }}
				defaultValue={value == null ? "" : String(value)}
				onFocus={() => {
					before.current = value
				}}
				onChange={e => {
					const node = e.currentTarget
					const raw = node.value.trim()
					// "" with badInput set is a keystroke the browser can't parse yet — a
					// stray "-", say. It is not somebody clearing the field, and wiping a
					// stored team count on it would be the silent change this app exists
					// not to make.
					if (raw === "" && node.validity.badInput) return
					// empty is a real answer: it means nobody has said yet, which is what
					// every refusal downstream is written against
					if (raw === "") {
						sent.current = null
						return onChange(null)
					}
					const n = Math.round(Number(raw))
					// "1" is not a league, but it IS the first keystroke of "12", so the
					// minimum is checked when the field is done rather than per keystroke —
					// enforcing it here is what made this field impossible to type into.
					if (Number.isFinite(n) && n >= 1) {
						sent.current = n
						onChange(n)
					} else {
						show(value)
						onReject("Enter a whole number of teams.")
					}
				}}
				onBlur={e => {
					// text the browser never parsed committed nothing, so the field must not
					// be left showing it
					if (e.currentTarget.validity.badInput) {
						show(value)
						return onReject("Enter a whole number of teams.")
					}
					if (value == null || value >= 2) return show(value)
					sent.current = before.current
					show(before.current)
					onChange(before.current)
					onReject("A league has at least two teams — the count is back to what it was.")
				}}
			/>
			<span className="unit">teams</span>
		</span>
	)
}

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
	/** Absent when League setup is already the open tab — a button to where you
	 *  are is furniture. */
	onOpenSetup?: () => void
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
					{league && onOpenSetup ?
						<>
							Or open <b>League setup</b> and enter them by hand.
						</>
					: league ?
						<>Or enter them in the cards below &mdash; they are on this tab.</>
					:	<>
							Or press <b>New</b> above to start one from a blank template and fill it in.
						</>
					}
				</p>

				{league && onOpenSetup && (
					<p style={{ margin: "var(--sp-3) 0 0" }}>
						<button className="primary" onClick={onOpenSetup}>
							Open League setup
						</button>
					</p>
				)}

				{/* Deliberately not `.legend`: its 110px term column breaks "Recommendations"
				    mid-word, and a tab you are being told to find must be spelled the way
				    the tab is spelled. */}
				<p className="tiny-note" style={{ margin: "var(--sp-4) 0 var(--sp-2)" }}>
					What each tab does once those exist, in the order a season uses them:
				</p>
				<dl>
					{TABS.map(([tab, does]) => (
						<Fragment2 key={tab} term={tab}>
							{does}
						</Fragment2>
					))}
				</dl>
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
