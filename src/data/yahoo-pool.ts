import { cellText, documentText } from "../html.ts"

/**
 * Who is actually available in YOUR league.
 *
 * A ranking of all of MLB is only half a recommendation — the players at the top
 * are rostered. Yahoo's player list for a publicly-viewable league is readable
 * without OAuth, so for those leagues the board can be narrowed to players you
 * could actually add. Private leagues need OAuth and are not supported.
 */
const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
	"(KHTML, like Gecko) Chrome/120.0 Safari/537.36"

export interface PoolEntry {
	yahooId: string
	name: string
	team: string | null
	positions: string[]
}

/**
 * Yahoo returns 25 rows and ignores the `b=` offset for anonymous readers — every
 * offset serves page one. But `pos=` is honoured, so the pool is assembled by
 * asking for each roster slot in turn and taking the union. That also guarantees
 * coverage at every position rather than just the global top 25.
 */
const POSITIONS = ["C", "1B", "2B", "3B", "SS", "OF", "Util", "SP", "RP"]

const parsePage = (htmlText: string): PoolEntry[] => {
	const out: PoolEntry[] = []
	const seen = new Set<string>()
	const re = /data-ys-playerid="(\d+)"[^>]*title="([^"]+)"([\s\S]{0,700}?)(?=data-ys-playerid=|$)/g
	let m: RegExpExecArray | null
	while ((m = re.exec(htmlText))) {
		const [, yahooId, rawName, block] = m
		if (!yahooId || seen.has(yahooId)) continue
		seen.add(yahooId)
		// somewhere in the row: "MIN - 1B" or "SD - SP,RP"
		const meta = /\b([A-Z]{2,3})\s*-\s*([A-Z0-9,]+)/.exec(cellText(block ?? ""))
		out.push({
			yahooId,
			name: cellText(rawName ?? ""),
			team: meta?.[1] ?? null,
			positions: (meta?.[2] ?? "").split(",").map((x: string) => x.trim()).filter(Boolean)
		})
	}
	return out
}

/**
 * Pages through the free-agent list. Yahoo orders it by its own rank, so the cap
 * covers everyone realistically addable; the caller is told how many were read so
 * a truncation is never silent.
 */
export const fetchAvailable = async (
	leagueId: string,
	sport = "baseball"
): Promise<{ players: PoolEntry[]; positionsRead: string[]; note: string }> => {
	const players: PoolEntry[] = []
	const seen = new Set<string>()
	const positionsRead: string[] = []

	const pages = await Promise.all(
		POSITIONS.map(async pos => {
			const url =
				`https://${sport}.fantasysports.yahoo.com/b1/${leagueId}/players` +
				`?status=A&pos=${encodeURIComponent(pos)}&sort=AR&sdir=1&count=25`
			try {
				const res = await fetch(url, { headers: { "user-agent": UA } })
				if (!res.ok) return { pos, rows: [] as PoolEntry[] }
				const text = await res.text()
				if (/Please sign in/i.test(documentText(text).slice(0, 400)))
					return { pos, rows: [] as PoolEntry[] }
				return { pos, rows: parsePage(text) }
			} catch {
				return { pos, rows: [] as PoolEntry[] }
			}
		})
	)
	for (const { pos, rows } of pages) {
		if (!rows.length) continue
		positionsRead.push(pos)
		for (const p of rows)
			if (!seen.has(p.yahooId)) {
				seen.add(p.yahooId)
				players.push(p)
			}
	}
	return {
		players,
		positionsRead,
		note:
			`Top 25 free agents per position (${positionsRead.join(", ")}). Yahoo ignores ` +
			`the paging offset for anonymous readers, so this is the addable pool by ` +
			`position rather than every unrostered player.`
	}
}

/** Normalised for joining to MLB names: accents, punctuation and suffixes vary. */
export const normalizeName = (n: string): string =>
	n
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[.'']/g, "")
		.replace(/\s+(jr|sr|ii|iii|iv)\.?$/i, "")
		.replace(/\s+/g, " ")
		.trim()
