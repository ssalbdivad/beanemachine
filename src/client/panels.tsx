import { useEffect, useRef } from "react"
import type { League } from "../schema.ts"
import { deriveTradeDeadline } from "../import.ts"
import { isReserveSlot } from "../engine/bscore.ts"

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
		// isReserveSlot, not a hand-written triple comparison: this one omitted "IL+"
		// and counted an injured seat as a starting one.
		.filter(([slot]) => !isReserveSlot(slot))
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

/* ---------------------------------------------------------------------------
 * Presets, and the one line that keeps them honest.
 *
 * Yahoo cannot be imported from a browser — it sends no CORS headers, measured
 * 2026-09-04 — so for most of this app's users the hosted site had no way in at
 * all: the four platform templates shipped with 0 stats, 0 slots and no team
 * count, which is a "new league" that ranks nothing.
 *
 * A preset fixes that by copying values from a league that WAS read from source,
 * and the whole difference between a stated assumption and a lie is whether the
 * page says so. `resolvePeriod` already sets the pattern: it falls back to a
 * Monday start and prints that it did. So a preset carries
 * `provenance.verified: false`, a `method` that begins with this marker and names
 * the league the numbers came from, and `needs_review` lines naming each value to
 * check — and the marker is what this file matches on, rather than the shape of
 * the data, because a preset and a hand-typed league are both unverified and only
 * one of them is quietly wearing another league's numbers.
 * ------------------------------------------------------------------------- */

/** Contract with scoring.json: every `platform_templates` entry that ships real
 *  values starts its `provenance.method` with this. test/leagues.mjs asserts it
 *  from the data side, so the two cannot drift apart silently. */
export const PRESET_METHOD = "preset:"

export const isPreset = (league: League | null | undefined): boolean =>
	!!league && !league.provenance.verified && league.provenance.method.startsWith(PRESET_METHOD)

/**
 * Rendered above every tab for as long as a league carries preset values.
 *
 * It does not fade like a toast: the numbers underneath stay borrowed until
 * somebody compares them with the real league, so the notice stays until somebody
 * says they have. Editing a value does not clear it and must not — changing one
 * home-run value leaves the other sixteen borrowed. The only thing that ends it is
 * the button below, which records a person's own statement that they checked, as
 * manual entry rather than as a read.
 *
 * Every figure in it is READ from the league rather than written here, so it stays
 * true after an edit. That is the same rule `ExampleNote` follows and for the same
 * reason: a sentence quoting a number the page cannot see is the exact mistake this
 * notice exists to warn about.
 */
export const PresetNote = ({
	league,
	onOpenSetup,
	onChecked
}: {
	league: League
	/** Absent when League setup is already the open tab. */
	onOpenSetup?: () => void
	/** The way this notice ends. Without it the notice is permanent — and a warning
	 *  that can never be satisfied is one people learn to read past, including on
	 *  the league where it is still true. */
	onChecked?: () => void
}) => {
	const stats =
		Object.keys(league.scoring.batting).length + Object.keys(league.scoring.pitching).length
	const seats = Object.values(league.roster.slots).reduce((a, b) => a + b, 0)
	return (
		<div className="preset-note">
			{/* Kept to three lines on purpose: this sits between the visitor and the
			    board they just asked for, and every line of it is a line of ranking
			    pushed below the fold. It says the one thing that cannot be left out —
			    whose numbers these are — with the figures read from the league so they
			    stay true after an edit. */}
			<p>
				<b>These are standard defaults, not read from your league.</b> The board is
				ranking on {stats} scored stats, {seats} roster seats and{" "}
				{league.meta.max_teams ?? "no stated number of"} teams, all copied from a league
				that was read from source. A wrong point value silently reprices every player,
				and a wrong team count moves every bscore.
			</p>
			{/* Folded, and the paragraph above is why it can be: it already names every
			    borrowed value. Measured at 1280x1200 with the four lines open, this
			    notice was 442px tall and the first ranked row sat at y=1557 — the board
			    the visitor had just asked for, entirely below the fold, which is the
			    same defect the management toolbar was moved off the board for. Folded,
			    with the paragraph trimmed to three lines: 163px and y=1278. The same
			    lines are listed in full, unfolded, on Setup's Needs review
			    card. */}
			{league.needs_review.length > 0 && (
				<details>
					<summary>
						{league.needs_review.length} values to check against your league&rsquo;s
						settings page
					</summary>
					<ul className="flags">
						{league.needs_review.map(n => (
							<li key={n}>{n}</li>
						))}
					</ul>
				</details>
			)}
			{onOpenSetup && (
				<button className="primary" onClick={onOpenSetup}>
					Check these in Setup
				</button>
			)}
			{/* The user's own statement, never an inference. Saving an edit is NOT
			    proof of checking — changing one home-run value leaves the other
			    sixteen borrowed — so nothing here clears itself. What this records is
			    that a person compared them, and it records it as manual entry rather
			    than as a read: `verified` stays false, because importing the league is
			    still the only thing that makes it true. */}
			{onChecked && (
				<button onClick={onChecked}>I&rsquo;ve checked these against my league</button>
			)}
		</div>
	)
}

/** The one command a Yahoo user runs, named in exactly one place so the page and
 *  the tool cannot drift — `src/cli.ts` builds the same line for its own usage
 *  message, and test/leagues.mjs asserts the two still agree. The placeholder is
 *  spelled for a reader rather than for a shell. */
/**
 * The one command a visitor could actually run.
 *
 * It was `node --experimental-strip-types src/cli.ts <your league URL>`, and two
 * thirds of that is wrong for the audience this page has: node has stripped types
 * by default since 22.18, and the path only resolves inside a clone of this
 * repository, which nobody arriving at beanemachine.com has. `bin` in package.json
 * is what makes this form real — see `RUN` in src/cli.ts, which prints the local
 * form when it IS running from a clone.
 */
// Re-exported so every consumer keeps importing it from here, and read from
// src/client/command.ts so api.ts can use the same string without importing React.
export { IMPORT_COMMAND } from "./command.ts"
import { IMPORT_COMMAND } from "./command.ts"

/**
 * Three screens. "league" was a fourth and is gone: the League setup editor is now
 * the lower half of Setup, and leaving the value in this union kept a second,
 * unreachable copy of that editor alive in App.tsx — which is exactly how a
 * refactor reintroduces a surface somebody removed on purpose.
 *
 * The ids are the ones the views have always had rather than renamed to match the
 * new labels, because they are also the key `view.ts` stores in this browser: a
 * rename here silently drops every returning reader back on the default screen.
 */
export type View = "board" | "wire" | "trade"

/**
 * The four tabs, in DOM order — which is deliberately not the order a season is
 * run in.
 *
 * A season goes: set the league up, draft it, manage the team, then read the
 * board every week. But the board is the tab someone opens fifty times and the
 * setup is the tab they open once, so the board lands first and stays first.
 * The sequence is stated instead of implied by position: `season` is that order,
 * the setup panel below prints the list in it, and every nav button says what it
 * is for on hover. One list, because two of them drifted: the copy that lived
 * here called the board "The weekly one", but the tab opens on the fortnight —
 * `useBoard.ts` defaults `mode: "board"`, which is the 14-day horizon.
 */
/**
 * Whether this league still takes trades.
 *
 * Yahoo prints "Trade End Date" and the import already harvests it. The app ships a
 * 1,132-line trade evaluator and had never read it, so on 2026-09-08 it was still
 * offering to price deals for a league whose trade window shut on 2026-08-06 — a
 * surface answering a question the reader is not allowed to ask, which is worse
 * than a missing one because it looks live.
 *
 * What is retired is the DEAL, not the tab: the same screen holds the roster reader
 * that everything else depends on, so it stays and loses its dead half. A league
 * that states no deadline keeps everything, because "the settings page did not say"
 * is not "it has passed".
 */
export const tradesClosed = (
	league: League | null,
	today: string
): { closed: boolean; on: string | null } => {
	const raw = ((league?.league_rules as { raw_settings?: Record<string, string> } | undefined)
		?.raw_settings ?? {}) as Record<string, string>
	const on = deriveTradeDeadline(raw).date
	return { closed: !!on && today > on, on }
}

export const VIEWS: { id: View; label: string; purpose: string; season: number }[] = [
	{
		id: "board",
		label: "Today",
		season: 3,
		purpose:
			"Who to start before first pitch, which of your seats scores nothing, and the one move worth making."
	},
	{
		id: "wire",
		label: "Wire",
		season: 4,
		purpose:
			"Everyone you can actually get, ranked in this league's scoring, over the window you pick."
	},
	{
		id: "trade",
		label: "Setup",
		season: 1,
		purpose:
			"Your league's scoring, slots and team count, and the men on your team. Everything the other two screens say is priced in these."
	}
]


/**
 * How a visitor gets from this page to a board ranked in THEIR league.
 *
 * Its own component because it is needed in two places that render for opposite
 * reasons: inside `Setup`, which appears when the active league cannot rank, and
 * on League setup while the demo league is active — which CAN rank, so `Setup`
 * stays hidden and the first-time visitor would otherwise be shown a toolbar and
 * left to infer the rest. That was the shape of the whole problem: every route in
 * existed, none of them was named.
 */
export const WaysIn = ({
	canImport,
	preset,
	league,
	onUsePreset,
	onLoadFile,
	onOpenSetup
}: {
	canImport: boolean
	preset: string | null
	league: League | null
	onUsePreset?: () => void
	onLoadFile?: () => void
	onOpenSetup?: () => void
}) => (
	<>
			{/* ── The routes in, in the order they are worth trying ──────────────
			    This card used to end at "paste your league's URL", which is a
			    route that does not exist for Yahoo: measured 2026-09-04, Yahoo
			    sends no access-control headers on any page the importer reads,
			    so a browser is never handed the response. Yahoo is where most of
			    this app's users are, so the hosted site's only honest answers
			    were "use a stranger's demo league" or "type nine batting values
			    and eight pitching ones by hand". The first two routes below end
			    in a board that ranks with nothing typed at all: the preset is
			    instant and borrowed, the file is exact and costs one command. */}
			<div className="routes">
				<h3>Ways in</h3>
				<dl>
					{preset && onUsePreset && (
						<Fragment2 term="Fastest">
							<b>{preset}</b> — a ready-made scoring table, roster and team count,
							copied from a league that was read from source. Nothing in it came
							from your league, so the page keeps saying so until you check it,
							and every value is editable in Setup.
							<p style={{ margin: "var(--sp-2) 0 0" }}>
								<button className="primary" onClick={onUsePreset}>
									Start from this preset
								</button>
							</p>
						</Fragment2>
					)}
					<Fragment2 term="From its URL">
						{canImport ?
							<>
								Paste your league&rsquo;s URL in the field above and beanemachine
								reads the real values off <b>Yahoo</b> or <b>ESPN</b> — the only
								route that ends with <i>read from source</i> against your own
								league.
							</>
						:	<>
								Paste an <b>ESPN</b> league URL in the field above and beanemachine
								reads the real values off it, here, with no server. A <b>Yahoo</b>{" "}
								league cannot be read by any browser: Yahoo sends no CORS headers,
								so the response never reaches the page.
							</>
						}
					</Fragment2>
					<Fragment2 term="From a file">
						Read the league once on your own machine and carry the file back — this is
						the exact route for a Yahoo league, and the file is plain JSON you can
						read. Clone the repo, then:
						<pre>{IMPORT_COMMAND}</pre>
						One command, three reads: the league&rsquo;s settings, <b>the free agents
						in your league</b>, and your roster with the seat each man is in. The
						middle one is the reason this route exists rather than being a backup
						feature — &ldquo;which starter should I stream this week&rdquo; is a
						question about the players you can <i>add</i>, and Yahoo&rsquo;s
						free-agent page sends no CORS headers, so no browser will ever be handed
						it. Carrying the file is the only way this page gets the real list
						instead of estimating it from rostered shares. Both reads are stamped
						with the time they happened, and the strip at the top of the page says
						how old they are rather than showing them as live.
						<p style={{ margin: "var(--sp-2) 0 0" }}>
							It writes <code>scoring.json</code>, prints what it did and did not read,
							and prints the path last. Drop that file anywhere on this page — or use
							the button below — and all of it loads into this browser. A file taken
							out with <b>Download</b> carries the same things back out.
						</p>
						{onLoadFile && (
							<p style={{ margin: "var(--sp-2) 0 0" }}>
								<button onClick={onLoadFile}>Load a league file…</button>
							</p>
						)}
					</Fragment2>
					<Fragment2 term="By hand">
						{league && onOpenSetup ?
							<>
								Open <b>Setup</b> and type your league&rsquo;s scoring, slots
								and team count in. Nothing is filled in for you and nothing is
								guessed.
							</>
						: league ?
							<>
								The cards below are the whole form — scoring, slots and team count,
								typed in yourself. Nothing is guessed on your behalf.
							</>
						:	<>
								Press <b>New</b> above with <i>a blank league</i> selected and fill it
								in yourself. Nothing is guessed on your behalf.
							</>
						}
					</Fragment2>
				</dl>
			</div>
	</>
)

/**
 * Rendered above whichever tab is open, never instead of it: each tab still
 * says its own piece, and this says the piece none of them can see.
 */
export const Setup = ({
	leagueKey,
	league,
	canImport,
	preset,
	onUsePreset,
	onLoadFile,
	onOpenSetup
}: {
	leagueKey: string | null
	league: League | null
	/** Whether a league can be read from wherever this page is running. True with a
	 *  server behind it; on the static build true for ESPN, which allows a browser to
	 *  read it, and false for Yahoo, which sends no CORS headers. */
	canImport: boolean
	/** How the ready-made league is named in the picker, or null if none ships. Read
	 *  from the template rather than written here, so a preset that is removed from
	 *  scoring.json cannot leave a button behind that offers it. */
	preset: string | null
	onUsePreset?: () => void
	/** Opens the file picker the toolbar owns. Dropping a file on the page does the
	 *  same thing, and both are named because a drop target nobody knows about is
	 *  not a route. */
	onLoadFile?: () => void
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
							<b>{name}</b> is{" "}
							{missing.length === 1 ? "one input" : `${missing.length} inputs`} short of
							ranking anything. Nothing is assumed in their place: a value nobody read
							stays missing and stays listed.
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

				<WaysIn
					canImport={canImport}
					preset={preset}
					onUsePreset={onUsePreset}
					onLoadFile={onLoadFile}
					league={league}
					onOpenSetup={onOpenSetup}
				/>

				{league && onOpenSetup && (
					<p style={{ margin: "var(--sp-3) 0 0" }}>
						<button className="primary" onClick={onOpenSetup}>
							Open Setup
						</button>
					</p>
				)}

				{/* Deliberately not `.legend`: its 110px term column breaks "Today"
				    mid-word, and a tab you are being told to find must be spelled the way
				    the tab is spelled. */}
				<p className="tiny-note" style={{ margin: "var(--sp-4) 0 var(--sp-2)" }}>
					What each tab does once those exist, in the order a season uses them:
				</p>
				<dl>
					{[...VIEWS]
						.sort((a, b) => a.season - b.season)
						.map(v => (
							<Fragment2 key={v.id} term={v.label}>
								{v.purpose}
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
