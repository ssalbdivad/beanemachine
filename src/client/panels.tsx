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
