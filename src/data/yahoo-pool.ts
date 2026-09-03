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
 * Yahoo serves 25 rows per request and ignores the `b=` offset for anonymous
 * readers, but `count=` IS honoured and is an offset, not a page size: count=0
 * returns rows 0-24, count=25 rows 25-49, count=50 rows 50-74, measured disjoint
 * on 2026-09-03 against league 228947 pos=SP. `pos=` is honoured too, so the pool
 * is assembled by asking for each roster slot in turn and taking the union, which
 * guarantees coverage at every position rather than just the global top 25.
 */
const POSITIONS = ["C", "1B", "2B", "3B", "SS", "OF", "Util", "SP", "RP"]

/**
 * The URL for one page of Yahoo's player table.
 *
 * `count` is an OFFSET, not a page size, so page 0 must ask for count=0. Both
 * readers went through `count = page * 25` with page counted from ONE, which meant
 * neither ever requested offset 0 and the top 25 at every position were invisible.
 * Built here so test/ownership.mjs can assert that without the network.
 */
export const pageUrl = (
	leagueId: string,
	sport: string,
	pos: string,
	page: number,
	status: "A" | "ALL"
): string =>
	`https://${sport}.fantasysports.yahoo.com/b1/${leagueId}/players` +
	`?status=${status}&pos=${encodeURIComponent(pos)}&sort=AR&sdir=1&count=${page * 25}`

/**
 * The rows of one page, in Yahoo's order.
 */
export const parsePage = (htmlText: string): PoolEntry[] => {
	const out: PoolEntry[] = []
	const seen = new Set<string>()
	// The row must run to the NEXT table row, not to the next `data-ys-playerid`:
	// each row carries that attribute twice (the name link and the player-note
	// link), so stopping at the second one cuts the block off ~50 characters in,
	// before any of the stat cells — which is how the ownership column silently
	// read as absent for every player. Only the name link carries `title=`, which
	// is what makes it a usable row boundary.
	//
	// Split rather than match: as a single regex the block was `[\s\S]{0,9000}?`
	// followed by a lookahead for the next row OR end-of-input, and the LAST row of
	// every page has ~90KB of page footer after it, so neither alternative was
	// reachable within 9000 characters and the match failed. Every page returned 25
	// rows and parsed as 24 — one player in 25 dropped on the floor, 72 across a
	// nine-position eight-page sweep.
	const head = /^data-ys-playerid="(\d+)"[^>]*title="([^"]+)"/
	for (const part of htmlText.split(/(?=data-ys-playerid="\d+"[^>]*title=")/)) {
		const m = head.exec(part)
		if (!m) continue
		const [matched, yahooId, rawName] = m
		// capped at the same 9000 characters, so a row still cannot read the next
		// player's cells even if the boundary marker ever stops appearing
		const block = part.slice(matched.length, matched.length + 9000)
		if (!yahooId || seen.has(yahooId)) continue
		seen.add(yahooId)
		// somewhere in the row: "MIN - 1B" or "SD - SP,RP"
		const meta = /\b([A-Z]{2,3})\s*-\s*([A-Z0-9,]+)/.exec(cellText(block))
		/**
		 * "% Ros" is read from the CELL, not from the text.
		 *
		 * Yahoo nests an AccuWeather table inside each outdoor game's tooltip, and the
		 * row block therefore carries percentages that are the weather. Taking the
		 * first percentage in the text and stripping the forecast lines by label
		 * failed twice: it missed "There is a 51% chance of precipitation", which is a
		 * sentence with the number BEFORE the label, so Misiorowski read 51 (his
		 * game's rain chance) instead of 98, Yamamoto 63 instead of 99 and Ohtani 63
		 * instead of 96. A blocklist of forecast phrasings is the wrong shape.
		 *
		 * The two are structurally distinct and always have been. Yahoo's stat cells
		 * wrap their value in a div — `<td class="Ta-end Nowrap Bdrend"><div>98%</div>`
		 * — while every cell of the forecast table is a bare `<td>76%</td>`. Matching
		 * the div form identifies ownership positively instead of ruling weather out,
		 * and on the 2026-09-03 sweep it priced 25 of 25 rows on every page where the
		 * text scan produced a third of the board's percentages from the forecast.
		 */
		const pct = /<td[^>]*>\s*<div[^>]*>\s*(?:<span[^>]*>\s*)?(\d{1,3})%/.exec(block)
		out.push({
			yahooId,
			// Yahoo lists a two-way player twice, as "Shohei Ohtani (Batter)" and
			// "Shohei Ohtani (Pitcher)". MLB has one id for the man, so the qualifier
			// is dropped here; `fetchOwnership` keeps the higher of the two prices.
			name: cellText(rawName ?? "").replace(/\s*\((?:Batter|Pitcher)\)\s*$/, ""),
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
			// page 0, i.e. count=0. This read count=25, which is an OFFSET, so it
			// served rows 25-49: the top 25 free agents at every position were
			// missing from the addable pool entirely.
			const url = pageUrl(leagueId, sport, pos, 0, "A")
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
			`Top 25 free agents per position (${positionsRead.join(", ")}). Yahoo serves ` +
			`25 rows to an anonymous reader, so this is the addable pool by position ` +
			`rather than every unrostered player.`
	}
}

/**
 * Which "% Ros" values are the weather rather than a roster share.
 *
 * Yahoo nests a forecast table inside each OUTDOOR game's tooltip. `parsePage` used
 * to read the first percentage left in a player's row block after stripping the
 * forecast lines whose labels it knew, and it did not know all of them. So a
 * per-GAME number reached the field, and because it is per-game every player in
 * both clubs of that matchup carries it: on the capture committed as
 * data/snapshot.json, all 30 Yankees and all 28 Angels read 47%, Dodgers and
 * Cardinals 54%, Orioles and Rockies 20%, and 225 players across four games 51%.
 * Those are the day's matchups. 20 of 30 clubs sat on one value, most of them at
 * 93-100% of the club.
 *
 * `parsePage` now reads the `<td><div>` stat cell instead, which the forecast table
 * has no equivalent of, and on the 2026-09-03 sweep this check discarded 0 of 1118
 * reads against 451 of 1120 under the text scan. It is kept as the tripwire, not
 * the cure: it is what would catch the next time Yahoo's markup moves under us.
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
		// Zero is exempt. It is the modal HONEST roster share — the bottom of Yahoo's
		// list is full of players nobody owns — so on the 2026-09-03 sweep this rule
		// flagged NYM (24 of 41 at 0%), LAA (23 of 38) and SF (26 of 41) and would have
		// blanked 73 real prices. A weather leak is a nonzero per-game number: the four
		// captured in data/snapshot.json are 47, 54, 20 and 51.
		if (bestVal !== 0 && best / vals.length > 0.5) leaked.set(team, bestVal)
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
 * Yahoo serves 25 rows to an anonymous reader and ignores the `b=` offset, but
 * `count=` shifts the window and is itself an offset: count=0 rows 0-24, count=25
 * rows 25-49, disjoint. Sweeping it per position is how the whole priced universe
 * becomes readable without an account.
 *
 * The sweep used to start at `count = page * 25` with page counted from 1, so
 * offset 0 was never requested and the top 25 at every position — the most-owned
 * players on the board — had no ownership at all. That is why `uscore` was blank
 * for 74 of the top 120 rendered rows while Judge and Soto, who sit deeper in
 * Yahoo's own rank order, did have prices.
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
	for (const pos of POSITIONS) {
		// The ids the previous offset returned, so "Yahoo has run out of rows" can be
		// told apart from "these players were already read at another position".
		let prevPage: string | null = null
		for (let page = 0; page < pages; page++) {
			const url = pageUrl(leagueId, sport, pos, page, "ALL")
			/**
			 * One retry with a long pause before giving up on a page.
			 *
			 * How much of the priced universe comes back depends on who is asking: a
			 * local run reads 1118 players on the 8-page default (2026-09-03), the CI
			 * runner that builds the published snapshot gets throttled to a few
			 * hundred. Bailing on the first non-200 turned a
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
				// End-of-list is a property of the WINDOW, not of what we happen to have
				// read elsewhere. The rule here was "no new player on this page means
				// stop", and Util's leaders are all already known from C/1B/OF, so it
				// ended the Util sweep two pages in (measured 2026-09-03). It cost
				// nothing that day — total rows read was 1118 either way, because every
				// Util row also appears under a specific position — but a player who
				// qualifies at Util ALONE is reachable no other way. Yahoo signals the
				// real end by running short then empty (pos=C returned 17 rows at
				// offset 175 and 0 at 200), which `!rows.length` above catches; this
				// compares ids so a repeated page would end it too.
				const pageKey = rows.map(r => r.yahooId).join(",")
				if (pageKey === prevPage) break
				prevPage = pageKey
				for (const r of rows) {
					if (seen.has(r.yahooId)) continue
					seen.add(r.yahooId)
					read++
					const key = normalizeName(r.name)
					if (r.rosteredPct !== null) priced.push(r)
					// a single position from this source is no better than what StatsAPI
					// already gives, so only a genuine multi-position line is recorded
					if (r.positions.length > 1) eligibility.set(key, r.positions)
				}
			} catch {
				break
			}
			// sequential with a gap: parallel requests get throttled and silently
			// collapse the pool, which has happened here before
			await new Promise(r => setTimeout(r, 120))
		}
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
		const key = normalizeName(r.name)
		// Higher wins on a repeat. The only repeat Yahoo actually produces is the
		// two-way player it lists as both a batter and a pitcher; those are two
		// roster slots for one MLBAM id, and the man is rostered wherever either is.
		const prior = byName.get(key)
		if (prior === undefined || r.rosteredPct! > prior) byName.set(key, r.rosteredPct!)
	}
	return {
		byName,
		eligibility,
		read,
		note:
			`Yahoo "% Ros" for ${byName.size} of ${read} players read, swept ${pages} pages ` +
			`of 25 per position (offsets 0-${(pages - 1) * 25}), of whom ` +
			`${eligibility.size} print more than one eligible ` +
			`position. Players Yahoo did not list have no ownership figure — they are ` +
			`reported as unknown rather than as unowned.` +
			(discarded ?
				` ${discarded} more were discarded: ${leaked.size} club${leaked.size === 1 ? "" : "s"} ` +
				`came back with most of the roster on one percentage, which is the game's ` +
				`weather line rather than anybody's roster share.`
			:	"")
	}
}
