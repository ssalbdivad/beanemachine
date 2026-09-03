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
	const re = /data-ys-playerid="(\d+)"[^>]*title="([^"]+)"([\s\S]{0,9000}?)(?=data-ys-playerid="\d+"[^>]*title=|$)/g
	let m: RegExpExecArray | null
	while ((m = re.exec(htmlText))) {
		const [, yahooId, rawName, block] = m
		if (!yahooId || seen.has(yahooId)) continue
		seen.add(yahooId)
		// somewhere in the row: "MIN - 1B" or "SD - SP,RP"
		const meta = /\b([A-Z]{2,3})\s*-\s*([A-Z0-9,]+)/.exec(cellText(block ?? ""))
		/**
		 * Yahoo nests a weather-forecast table inside each OUTDOOR game's tooltip, so
		 * ending the row at the next `<tr>` cut the block off before the "% Ros"
		 * cell — and only dome games survived. Reading to the next player instead
		 * fixes the truncation but swallows the forecast, whose humidity is also
		 * written as a percentage and appears FIRST. Strip the forecast's own
		 * percentages before looking for ownership; a hitter's roster share and the
		 * relative humidity in Anaheim are not interchangeable.
		 */
		const cleaned = (block ?? "").replace(
			/(?:Humidity|Precipitation|Chance of (?:Rain|Precipitation))\s*:?\s*<?[^>]*>?\s*\d{1,3}\s*%/gi,
			" "
		)
		const pct = /(\d{1,3})%/.exec(cleaned)
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

/**
 * Which "% Ros" values are the weather rather than a roster share.
 *
 * Yahoo nests a forecast table inside each OUTDOOR game's tooltip, and `parsePage`
 * reads the first percentage left in a player's row block after stripping the
 * forecast lines it knows the labels of. It did not know all of them. So a
 * per-GAME number reached the field, and because it is per-game every player in
 * both clubs of that matchup carries it: on the capture committed as
 * data/snapshot.json, all 30 Yankees and all 28 Angels read 47%, Dodgers and
 * Cardinals 54%, Orioles and Rockies 20%, and 225 players across four games 51%.
 * Those are the day's matchups. 20 of 30 clubs sat on one value, most of them at
 * 93-100% of the club.
 *
 * This is not a cosmetic column. Market edge — for a long time the board's DEFAULT
 * ranking — is a player's bscore minus the median bscore at his ownership decile,
 * so a wrong percentage does not degrade one cell, it reorders the whole board by
 * a number drawn from the precipitation forecast.
 *
 * Rather than guess at Yahoo's markup a second time, the read is checked against
 * something that must be true of the real quantity: roster share VARIES within a
 * club. A star and his club's fifth starter are not owned in the same fraction of
 * leagues, to the percent. When most of a club agrees exactly, the number being
 * read belongs to the game and not to the player, and the honest thing is to have
 * no ownership for those players — this project's whole rule is that absent is
 * reported as absent rather than filled in.
 *
 * It flags a VALUE per club, not the club: the genuine singleton reads inside a
 * poisoned club (Soto 99, Machado 97, Lindor 96) are real and survive.
 */
export const leakedByTeam = (
	rows: readonly { team: string | null; rosteredPct?: number | null }[]
): Map<string, number> => {
	const byTeam = new Map<string, number[]>()
	for (const r of rows) {
		if (!r.team || r.rosteredPct === null || r.rosteredPct === undefined) continue
		const list = byTeam.get(r.team)
		if (list) list.push(r.rosteredPct)
		else byTeam.set(r.team, [r.rosteredPct])
	}
	const leaked = new Map<string, number>()
	for (const [team, vals] of byTeam) {
		// Two players agreeing is a coincidence. A club Yahoo listed only a handful
		// of players from cannot distinguish a leak from a small sample, so it is
		// left alone rather than blanked on a guess.
		if (vals.length < 10) continue
		const counts = new Map<number, number>()
		for (const v of vals) counts.set(v, (counts.get(v) ?? 0) + 1)
		let best = 0
		let bestVal = 0
		for (const [v, n] of counts)
			if (n > best) {
				best = n
				bestVal = v
			}
		if (best / vals.length > 0.5) leaked.set(team, bestVal)
	}
	return leaked
}

/**
 * Normalised for joining to MLB names: accents, punctuation and suffixes vary.
 *
 * The punctuation class held two straight apostrophes for a while — they read as
 * one straight and one curly — so U+2019 survived normalisation here while the
 * browser's copy stripped it. Every read keyed on this function fails open when
 * that happens: snapshot.ts joins eligibility and ownership by name, and
 * auto/plan.ts decides who is addable by name, and a key that never matches drops
 * the player with no error. MLB spells him Ke'Bryan Hayes with U+0027; if a Yahoo
 * page ever spells him with U+2019 the two must still collapse to the same key.
 * The escape is written out so the difference is visible in a diff.
 *
 * src/client/useBoard.ts carries a second copy for the browser bundle. It always
 * had the U+2019 escape; this one is now the same function.
 */
export const normalizeName = (n: string): string =>
	n
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[.'\u2019]/g, "")
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
): Promise<{
	byName: Map<string, number>
	/**
	 * Multi-position eligibility, as YOUR platform actually prints it.
	 *
	 * This is the largest known accuracy gap in the ranking. StatsAPI reports one
	 * primary position, so a catcher who also qualifies at first base was scored
	 * only as a catcher — which understates him, because he can fill two slots and
	 * the scarcer one sets his value. Yahoo prints the real eligibility next to
	 * every name ("MIN - 1B,3B"), and the same sweep that reads ownership already
	 * has it in hand. It is an observation, not an inference.
	 */
	eligibility: Map<string, string[]>
	read: number
	note: string
}> => {
	const { pages = 8, sport = "baseball" } = options
	const eligibility = new Map<string, string[]>()
	const seen = new Set<string>()
	// Held whole rather than folded into a map page by page, because whether a
	// percentage is this player's roster share or his game's forecast can only be
	// decided against his club-mates — see `leakedByTeam`.
	const priced: PoolEntry[] = []
	let read = 0
	for (const pos of POSITIONS)
		for (let page = 1; page <= pages; page++) {
			const url =
				`https://${sport}.fantasysports.yahoo.com/b1/${leagueId}/players` +
				`?status=ALL&pos=${encodeURIComponent(pos)}&sort=AR&sdir=1&count=${page * 25}`
			/**
			 * One retry with a long pause before giving up on a page.
			 *
			 * How much of the priced universe comes back depends on who is asking: a
			 * local run reads ~845 players, the CI runner that builds the published
			 * snapshot gets throttled to ~229. Bailing on the first non-200 turned a
			 * slow page into a permanently missing position. The board no longer
			 * depends on this succeeding, but more of it arriving is strictly better.
			 */
			let text: string | null = null
			for (let attempt = 0; attempt < 2 && text === null; attempt++) {
				if (attempt) await new Promise(r => setTimeout(r, 2000))
				try {
					const res = await fetch(url, { headers: { "user-agent": UA } })
					if (res.ok) text = await res.text()
				} catch {
					/* retried once, then treated as unread rather than as empty */
				}
			}
			try {
				if (text === null) break
				if (/Please sign in/i.test(documentText(text).slice(0, 400))) break
				const rows = parsePage(text)
				if (!rows.length) break
				let fresh = 0
				for (const r of rows) {
					if (seen.has(r.yahooId)) continue
					seen.add(r.yahooId)
					fresh++
					read++
					const key = normalizeName(r.name)
					if (r.rosteredPct !== null) priced.push(r)
					// a single position from this source is no better than what StatsAPI
					// already gives, so only a genuine multi-position line is recorded
					if (r.positions.length > 1) eligibility.set(key, r.positions)
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
	// The forecast check, applied to the whole sweep at once. A percentage most of a
	// club shares to the point is the game's number, not the player's, and dropping
	// it leaves that player with no ownership — which every consumer already handles,
	// because Yahoo omits plenty of players outright.
	const leaked = leakedByTeam(priced)
	const byName = new Map<string, number>()
	let discarded = 0
	for (const r of priced) {
		if (r.team && leaked.get(r.team) === r.rosteredPct) {
			discarded++
			continue
		}
		byName.set(normalizeName(r.name), r.rosteredPct!)
	}
	return {
		byName,
		eligibility,
		read,
		note:
			`Yahoo "% Ros" for ${byName.size} of ${read} players read, swept ${pages} pages ` +
			`per position, of whom ${eligibility.size} print more than one eligible ` +
			`position. Players Yahoo did not list have no ownership figure — they are ` +
			`reported as unknown rather than as unowned.` +
			(discarded ?
				` ${discarded} more were discarded: ${leaked.size} club${leaked.size === 1 ? "" : "s"} ` +
				`came back with most of the roster on one percentage, which is the game's ` +
				`weather line rather than anybody's roster share.`
			:	"")
	}
}
