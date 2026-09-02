import type { Page } from "playwright-core"
import type { LineupPlan, Move } from "./plan.ts"

/**
 * Actually doing it.
 *
 * Everything else in src/auto/ reasons about a team; this is the only file that
 * changes one. Two rules shape all of it.
 *
 * First, the two capabilities are not equally risky and are never enabled by the
 * same switch. Setting a lineup is fully reversible and cannot lose you a player:
 * the worst case is a bad start, undone in one click. Dropping a player is
 * irreversible within seconds — someone else claims him — so add/drop needs its
 * own flag on top of `--execute`, and lineup-only automation is a first-class
 * mode rather than a degraded one.
 *
 * Second, a click that did not throw is not a click that worked. Every action is
 * verified by re-reading the page afterwards, and an unverified action is
 * reported as unverified, never as success.
 */

/**
 * Every Yahoo selector, in one place.
 *
 * UNVERIFIED against a live authenticated roster page — this repo has no stored
 * session to test with, so these are written from the public page structure and
 * should be treated as the first thing to check when execution fails. That is
 * also why every one of them fails loudly with the selector text rather than
 * quietly matching nothing: a silent no-match here would report "no changes
 * needed" for a team it never actually read.
 */
export const SELECTORS = {
	/** The per-player position dropdown in roster edit mode. */
	positionSelect: "select[name^='pos_']",
	/** Row container, used to pair a select with the player it belongs to. */
	row: "tr[class*='player'], li[class*='player']",
	/** The player's name inside a row. */
	name: ".ysf-player-name a, a[data-ys-playerid]",
	/** Commits the lineup. Yahoo has shipped both a button and an input over time. */
	save: "input[type=submit][value*='Save'], button[type=submit]:has-text('Save')"
} as const

export interface Gates {
	/** Nothing is clicked without this. */
	execute: boolean
	/** Required IN ADDITION to `execute` before any add or drop. */
	allowDrops: boolean
}

export interface Permitted {
	lineup: boolean
	moves: boolean
	/** Why each was withheld, for printing back to the operator. */
	reasons: string[]
}

/**
 * What the flags permit, as a value rather than as scattered `if`s.
 *
 * Pure, so the gate logic is testable without a browser — which matters more here
 * than anywhere else in the codebase, because the failure mode is doing something
 * real to somebody's team.
 */
export const permits = (gates: Gates): Permitted => {
	const reasons: string[] = []
	if (!gates.execute)
		reasons.push("dry run: pass --execute to let Billy actually change the team")
	else if (!gates.allowDrops)
		reasons.push(
			"add/drop withheld: --execute sets lineups only. A drop is irreversible " +
				"within seconds, so it needs --allow-drops as well"
		)
	return { lineup: gates.execute, moves: gates.execute && gates.allowDrops, reasons }
}

export interface ActionResult {
	action: string
	/** True only when a re-read of the page confirmed it. */
	verified: boolean
	detail: string
}

/**
 * Is this swap already applied?
 *
 * Re-running must not double-apply, and the honest test is the world's state, not
 * a record of what we did last time — a run that half-applied and died leaves no
 * such record.
 */
export const alreadyApplied = (
	swap: { start: string; startSlot: string },
	current: { name: string; slot: string }[]
): boolean =>
	current.some(
		r => r.name.toLowerCase() === swap.start.toLowerCase() && r.slot === swap.startSlot
	)

/**
 * Sets the lineup, one seat at a time, then verifies by re-reading.
 *
 * `readBack` is injected rather than imported so the verification path can be
 * tested without a browser, and so a caller can choose how hard it re-reads.
 */
export const applyLineup = async (
	page: Page,
	plan: LineupPlan,
	readBack: () => Promise<{ name: string; slot: string }[]>,
	options: { dryRun: boolean } = { dryRun: true }
): Promise<ActionResult[]> => {
	const results: ActionResult[] = []
	if (!plan.swaps.length) return results

	const before = await readBack()
	const pending = plan.swaps.filter(s => !alreadyApplied(s, before))
	for (const done of plan.swaps.filter(s => alreadyApplied(s, before)))
		results.push({
			action: `start ${done.start} at ${done.startSlot}`,
			verified: true,
			detail: "already in place — re-run applied nothing"
		})
	if (!pending.length) return results

	if (options.dryRun) {
		for (const s of pending)
			results.push({
				action: `start ${s.start} at ${s.startSlot}`,
				verified: false,
				detail: "dry run — nothing was clicked"
			})
		return results
	}

	const selects = await page.$$(SELECTORS.positionSelect)
	if (!selects.length)
		throw new Error(
			`no position dropdowns matched \`${SELECTORS.positionSelect}\` — either the ` +
				`roster is not in edit mode or Yahoo's markup has changed. Nothing was clicked.`
		)

	for (const swap of pending) {
		try {
			const row = page.locator(SELECTORS.row, { hasText: swap.start }).first()
			await row.locator(SELECTORS.positionSelect).selectOption({ label: swap.startSlot })
			results.push({
				action: `start ${swap.start} at ${swap.startSlot}`,
				verified: false,
				detail: "selected, pending save"
			})
		} catch (e) {
			results.push({
				action: `start ${swap.start} at ${swap.startSlot}`,
				verified: false,
				detail: `could not set the dropdown: ${e instanceof Error ? e.message : String(e)}`
			})
		}
	}

	const save = page.locator(SELECTORS.save).first()
	if (!(await save.count()))
		throw new Error(
			`selected the seats but found no save control (\`${SELECTORS.save}\`). The ` +
				`lineup is NOT saved; the page is left as-is so you can finish it by hand.`
		)
	await save.click()
	await page.waitForLoadState("networkidle")

	// the only claim of success this file will make
	const after = await readBack()
	return results.map(r => {
		const swap = pending.find(s => r.action === `start ${s.start} at ${s.startSlot}`)
		if (!swap) return r
		const ok = alreadyApplied(swap, after)
		return {
			...r,
			verified: ok,
			detail: ok ? "confirmed by re-reading the roster" : "saved, but the re-read does NOT show it"
		}
	})
}

/**
 * Add/drop is deliberately not implemented as a click path.
 *
 * The planner produces these and the runner prints them, which is the whole
 * value for a decision a human makes once a week. Automating the irreversible
 * half of that — a drop that another manager can claim within seconds of the
 * page committing — is not something this project does on a selector layer it
 * has never been able to verify against a live page.
 */
export const describeMoves = (moves: Move[]): string[] =>
	moves.map(
		m =>
			`ADD ${m.add} / DROP ${m.drop} (+${m.gain} projected) — execute by hand: ` +
				`this file will not click an irreversible action on unverified selectors`
	)
