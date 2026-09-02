import type { BrowserContext } from "playwright-core"

/** Reads YOUR team as the site actually renders it, rather than guessing. */
export interface RosterSpot {
	slot: string
	name: string
	positions: string[]
	team: string | null
	/** Yahoo's own status text, e.g. "IL", "DTD", "" */
	status: string
}

export const readRoster = async (
	context: BrowserContext,
	leagueId: string,
	teamId: string,
	sport = "baseball"
): Promise<RosterSpot[]> => {
	const page = await context.newPage()
	await page.goto(`https://${sport}.fantasysports.yahoo.com/b1/${leagueId}/${teamId}`, {
		waitUntil: "domcontentloaded"
	})
	await page.waitForSelector("table", { timeout: 20_000 })
	const rows = await page.$$eval("tbody tr", trs =>
		trs
			.map(tr => {
				const cells = [...tr.querySelectorAll("td")]
				const slot = cells[0]?.textContent?.trim() ?? ""
				const nameEl = tr.querySelector("[data-ys-playerid] .ysf-player-name a, .ysf-player-name a, a[href*='/players/']")
				const name = nameEl?.textContent?.trim() ?? ""
				const meta = tr.querySelector(".ysf-player-name span")?.textContent?.trim() ?? ""
				const m = /([A-Z]{2,3})\s*-\s*([A-Z0-9,]+)/.exec(meta)
				const status = tr.querySelector(".F-injury, .ysf-player-status")?.textContent?.trim() ?? ""
				return {
					slot,
					name,
					positions: (m?.[2] ?? "").split(",").filter(Boolean),
					team: m?.[1] ?? null,
					status
				}
			})
			.filter(r => r.name)
	)
	await page.close()
	return rows
}
