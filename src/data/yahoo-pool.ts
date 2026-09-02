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
	/** Yahoo's "% Ros" — the share of leagues the player is rostered in. This is the
	 *  market's opinion, and it is the only number here that is not about baseball.
	 *  Null when the cell was absent; never assumed to be zero, because "nobody owns
	 *  him" and "we could not read it" are opposite claims. */
	rosteredPct: number | null
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
	// The row must run to the NEXT table row, not to the next `data-ys-playerid`:
	// each row carries that attribute twice (the name link and the player-note
	// link), so stopping at the second one cuts the block off ~50 characters in,
	// before any of the stat cells — which is how the ownership column silently
	// read as absent for every player.
	const re = /data-ys-playerid="(\d+)"[^>]*title="([^"]+)"([\s\S]{0,6000}?)(?=<tr|$)/g
	let m: RegExpExecArray | null
	while ((m = re.exec(htmlText))) {
		const [, yahooId, rawName, block] = m
		if (!yahooId || seen.has(yahooId)) continue
		seen.add(yahooId)
		// somewhere in the row: "MIN - 1B" or "SD - SP,RP"
		const meta = /\b([A-Z]{2,3})\s*-\s*([A-Z0-9,]+)/.exec(cellText(block ?? ""))
		const pct = /(\d{1,3})%/.exec(block ?? "")
		out.push({
			yahooId,
			name: cellText(rawName ?? ""),
			team: meta?.[1] ?? null,
			positions: (meta?.[2] ?? "").split(",").map((x: string) => x.trim()).filter(Boolean),
			rosteredPct: pct?.[1] ? Number(pct[1]) : null
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

	// Sequential with a small gap. Nine simultaneous requests get throttled, which
	// silently collapsed the pool from 177 players to 25.
	const pages: { pos: string; rows: PoolEntry[] }[] = []
	for (const pos of POSITIONS) {
		pages.push(await (async () => {
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
		})())
		await new Promise(r => setTimeout(r, 120))
	}
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

/**
 * How many leagues each player is rostered in — the market's price.
 *
 * Yahoo caps an anonymous reader at 24 rows per request and ignores the `b=`
 * offset, but `count=` shifts the window: count=50 returns rows 25-48, count=75
 * the next two dozen, and so on. Sweeping it per position is how the whole
 * priced universe becomes readable without an account.
 *
 * `status=ALL` rather than `status=A`, because the point is to compare our number
 * against the field's opinion of EVERY player, not only the unrostered ones.
 */
export const fetchOwnership = async (
	leagueId: string,
	options: { pages?: number; sport?: string } = {}
): Promise<{ byName: Map<string, number>; read: number; note: string }> => {
	const { pages = 8, sport = "baseball" } = options
	const byName = new Map<string, number>()
	const seen = new Set<string>()
	let read = 0
	for (const pos of POSITIONS)
		for (let page = 1; page <= pages; page++) {
			const url =
				`https://${sport}.fantasysports.yahoo.com/b1/${leagueId}/players` +
				`?status=ALL&pos=${encodeURIComponent(pos)}&sort=AR&sdir=1&count=${page * 25}`
			try {
				const res = await fetch(url, { headers: { "user-agent": UA } })
				if (!res.ok) break
				const text = await res.text()
				if (/Please sign in/i.test(documentText(text).slice(0, 400))) break
				const rows = parsePage(text)
				if (!rows.length) break
				let fresh = 0
				for (const r of rows) {
					if (seen.has(r.yahooId)) continue
					seen.add(r.yahooId)
					fresh++
					read++
					if (r.rosteredPct !== null) byName.set(normalizeName(r.name), r.rosteredPct)
				}
				// the window stopped moving — Yahoo has run out of rows for this position
				if (fresh === 0) break
			} catch {
				break
			}
			// sequential with a gap: parallel requests get throttled and silently
			// collapse the pool, which has happened here before
			await new Promise(r => setTimeout(r, 120))
		}
	return {
		byName,
		read,
		note:
			`Yahoo "% Ros" for ${byName.size} of ${read} players read, swept ${pages} pages ` +
			`per position. Players Yahoo did not list have no ownership figure — they are ` +
			`reported as unknown rather than as unowned.`
	}
}
