import type { BrowserContext } from "playwright-core"
import { unread, type Read } from "./session.ts"

/** Reads YOUR team as the site actually renders it, rather than guessing. */
export interface RosterSpot {
	slot: string
	name: string
	/**
	 * Eligibility as YOUR league prints it, next to the player's name.
	 *
	 * This is the one place the league's real multi-position eligibility is
	 * readable — the projection elsewhere has to derive slots from a single
	 * StatsAPI position — so it is the source the lineup planner uses. Empty
	 * means the cell could not be read, which is reported, never filled in.
	 */
	positions: string[]
	team: string | null
	/** Yahoo's own status text, e.g. "IL", "DTD", "" */
	status: string
}

export interface RosterRead {
	spots: RosterSpot[]
	/** Rows that parsed, but with something missing. Named, never dropped silently. */
	warnings: string[]
	url: string
}

/** The row selectors, named so a failure can quote the one that found nothing. */
const NAME_SELECTOR =
	"[data-ys-playerid] .ysf-player-name a, .ysf-player-name a, a[href*='/players/']"
const META_SELECTOR = ".ysf-player-name span"
const STATUS_SELECTOR = ".F-injury, .ysf-player-status"

/** Yahoo throttles by serving a wall rather than an error status, so the words are
 *  the only signal. */
const THROTTLED = /too many requests|unusual traffic|rate limit|temporarily blocked/i
const SIGN_IN = /login\.yahoo\.com|\/account\/challenge|guce\.yahoo\.com/

/**
 * Reads the roster page.
 *
 * Every way this can fail against a live site is named: no page, a throttle, a
 * sign-in wall, no table, a table whose rows no longer carry player links, and a
 * row missing a field. The caller gets either spots or a `ReadFailure` saying
 * which of those happened — an empty roster is never manufactured out of a failed
 * read, because the plan built on one would say "stand pat" with total confidence.
 */
export const readRoster = async (
	context: BrowserContext,
	leagueId: string,
	teamId: string,
	sport = "baseball"
): Promise<Read<RosterRead>> => {
	const url = `https://${sport}.fantasysports.yahoo.com/b1/${leagueId}/${teamId}`
	let page
	try {
		page = await context.newPage()
	} catch (e) {
		return unread("browser", "could not open a page in the logged-in browser", null, String(e))
	}
	try {
		let status: number | null = null
		try {
			const res = await page.goto(url, { waitUntil: "domcontentloaded" })
			status = res?.status() ?? null
		} catch (e) {
			return unread("roster-page", `could not load ${url}`, "check the connection and try again", String(e))
		}
		if (status === 429 || status === 503)
			return unread(
				"rate-limit",
				`Yahoo answered ${status} for ${url}, so the roster was never sent`,
				"wait a few minutes and run again"
			)
		if (status !== null && status >= 400)
			return unread(
				"roster-page",
				`Yahoo answered ${status} for ${url}`,
				`check that league ${leagueId} team ${teamId} is your team`
			)
		if (SIGN_IN.test(page.url()))
			return unread(
				"session",
				`Yahoo redirected the roster page to ${page.url()} — the saved cookies are no longer accepted`,
				"run --login again"
			)

		try {
			await page.waitForSelector("table", { timeout: 20_000 })
		} catch {
			const text = (await page.textContent("body").catch(() => null)) ?? ""
			if (THROTTLED.test(text))
				return unread(
					"rate-limit",
					`${url} answered with a throttling notice instead of the roster`,
					"wait a few minutes and run again"
				)
			return unread(
				"roster-table",
				`no <table> appeared on ${url} within 20s`,
				"run with --headed to see what the page is actually showing",
				text.slice(0, 200).replace(/\s+/g, " ").trim()
			)
		}

		const seen = await page.$$eval(
			"tbody tr",
			(trs, sel) =>
				trs.map(tr => {
					const cells = [...tr.querySelectorAll("td")]
					const nameEl = tr.querySelector(sel.name)
					const meta = tr.querySelector(sel.meta)?.textContent?.trim() ?? ""
					const m = /([A-Z]{2,3})\s*-\s*([A-Z0-9,]+)/.exec(meta)
					return {
						slot: cells[0]?.textContent?.trim() ?? "",
						name: nameEl?.textContent?.trim() ?? "",
						positions: (m?.[2] ?? "").split(",").map(p => p.trim()).filter(Boolean),
						team: m?.[1] ?? null,
						status: tr.querySelector(sel.status)?.textContent?.trim() ?? "",
						hasLink: nameEl !== null,
						cells: cells.length
					}
				}),
			{ name: NAME_SELECTOR, meta: META_SELECTOR, status: STATUS_SELECTOR }
		)

		if (!seen.length)
			return unread(
				"roster-table",
				`${url} rendered a table but no rows under any <tbody>`,
				"run with --headed to see the page Yahoo is serving"
			)
		const named = seen.filter(r => r.name)
		if (!named.length)
			return unread(
				"roster-rows",
				`${seen.length} roster rows rendered but none exposed a player name — ` +
					`the selector \`${NAME_SELECTOR}\` matches nothing, so Yahoo's markup has changed`,
				"update NAME_SELECTOR in src/auto/roster.ts against the live page"
			)

		const warnings: string[] = []
		for (const r of named) {
			if (!r.slot) warnings.push(`${r.name}: the slot cell is empty, so his current slot is unknown`)
			if (!r.positions.length)
				warnings.push(
					`${r.name}: Yahoo printed no position eligibility (selector \`${META_SELECTOR}\`), ` +
						`so no slot can be proven legal for him`
				)
		}
		return {
			ok: true,
			value: {
				spots: named.map(({ slot, name, positions, team, status }) => ({
					slot,
					name,
					positions,
					team,
					status
				})),
				warnings,
				url
			}
		}
	} finally {
		await page.close().catch(() => {})
	}
}
