/**
 * Batting-order slots, read from the lineup cards MLB actually posted.
 *
 * The playing-time term the model already measures is plate appearances per team
 * game, and it is a LAGGING observation: a hitter promoted from eighth to second
 * carries three weeks of eighth-slot volume that understates what he is about to do.
 * The batting order is the leading indicator, and it is published the moment the
 * card goes up — before a single plate appearance of the new role has been taken.
 *
 * Nothing here multiplies anything, and nothing here is wired into a projection.
 * Five seasons of measurement in this project say playing time dominates and rate
 * adjustments barely change which players you hold, but no backtest has yet measured
 * what a slot change is worth. So this is captured to be SHOWN to the reader as
 * information, on the rule that anything unmeasured must not silently move a
 * recommendation.
 */
const BASE = "https://statsapi.mlb.com/api/v1"

const json = async (url: string): Promise<any> => {
	const res = await fetch(url, { headers: { accept: "application/json" } })
	if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
	return res.json()
}

/**
 * Starts below which a slot is not reported at all.
 *
 * The same guard as `pitcherQuality` in src/engine/matchup.ts, which throws out a
 * pitcher under 100 batters faced because a September call-up with nine is not a
 * matchup signal. A call-up with one start is not a leadoff hitter either.
 *
 * Measured rather than picked. Over 2026-08-12..2026-09-02 (298 games, 456 hitters)
 * each player's starts were split into his odd- and even-numbered ones and each half
 * given its own median slot. The two halves land within one slot for 67% of players
 * with exactly two starts and 75% with three, against 91% at four and 95% at five; at
 * one start the check cannot be run at all, because one half is empty. So the estimate
 * starts reproducing at four.
 *
 * The floor is set one start past that knee because the two errors are not
 * symmetric. Excluding a marginal player costs nothing — he is simply absent, and
 * absent already reads as unknown. Reporting a fill-in as a leadoff hitter is a
 * claim the data does not support. Five excluded 88 of the 456 hitters in that
 * window, and not one of them had started more than 21% of his club's games in it.
 */
export const MIN_LINEUP_STARTS = 5

/**
 * Median, not mean.
 *
 * A player who bats second most days and once ninth in a blowout is a second-slot
 * hitter, and the mean says he is a third- or fourth-slot hitter. This is not an
 * edge case: over the measured window the two disagree by half a slot or more for
 * 75 of the 275 players with ten or more starts (27%). The sharpest case was Nick
 * Sogard — 21 starts, median slot 1, mean slot 3.57. He is a leadoff hitter who also
 * fills in down the order, and only the median says so.
 *
 * For an even number of starts this averages the two central values, so a man who
 * genuinely splits between second and third reads 2.5. That is a real statement about
 * him rather than an arbitrary tie-break, and unlike the mean it cannot be dragged by
 * a single blowout, because it can only ever land between the two middle slots. Twenty
 * of those 275 players came back on a half.
 */
const median = (v: number[]): number => {
	const s = [...v].sort((a, b) => a - b)
	const m = s.length >> 1
	// Only ever called on a non-empty array: every caller has already checked that the
	// player cleared MIN_LINEUP_STARTS, so both indices are in bounds.
	const hi = s[m]!
	return s.length % 2 ? hi : (s[m - 1]! + hi) / 2
}

export interface LineupSlots {
	/**
	 * Posted lineup cards this player appeared in over the window — a direct
	 * playing-time observation, and the one field here that needs no model at all.
	 *
	 * It counts cards, not completed games. Today's card is posted hours before
	 * first pitch and is deliberately included, since a fresh card is the whole
	 * point of a leading indicator — so on a day with games in progress this can
	 * exceed the player's completed games by one. A caller dividing it by games
	 * PLAYED would repeat the error `fetchSchedule(..., playedOnly)` exists to
	 * prevent, where a denominator counted a game the numerator could not contain.
	 */
	starts: number
	/** His typical batting position over the whole window, 1 (leadoff) to 9. */
	slot: number
	/**
	 * The same figure over the starts on or after `recentFrom`, so that a promotion
	 * or demotion is visible as `recentSlot` against `priorSlot`.
	 *
	 * `null` means it is unknown, never that he batted ninth and never zero: either
	 * no `recentFrom` was given, so no split was asked for, or that side of the split
	 * holds fewer than MIN_LINEUP_STARTS. A caller who splits the window too finely
	 * gets nulls rather than noise.
	 */
	recentSlot: number | null
	/** His slot over the starts strictly before `recentFrom`. Null as above. */
	priorSlot: number | null
}

/**
 * Typical batting-order slot per player over a date window, with a recent/prior split.
 *
 * One request covers the whole range: `hydrate=lineups` puts `homePlayers` and
 * `awayPlayers` on each game, each an array of nine players IN BATTING ORDER, index 0
 * batting leadoff. Measured on 2026-08-12..2026-09-02: 298 games, 586 posted cards,
 * every one of them nine deep, 456 distinct hitters at a median of 13 starts, 1.5MB
 * in under half a second.
 *
 * A game with no posted card is skipped, and it needs no other handling. Over that
 * window all 284 games that had finished carried a lineup — coverage on completed
 * games was 284/284. The only four games without one were that day's games still
 * marked Scheduled, and two more had a single side posted while the other club had
 * not filed yet. Nothing is missing to backfill: those cards did not exist yet. The
 * consequence is that `starts` is a count of cards observed and so a lower bound, not
 * an assertion that a man sat.
 *
 * A player who never clears MIN_LINEUP_STARTS is absent from the map. Absent means
 * unknown — that no slot can be stated for him — and a caller must not read it as a
 * zero, a ninth slot, or a benching.
 */
export const fetchLineupSlots = async (
	startDate: string,
	endDate: string,
	/**
	 * Inclusive YYYY-MM-DD start of the "recent" half; everything before it is
	 * "prior". Compared as a string against the feed's own `date`, which is the
	 * same zero-padded YYYY-MM-DD, so the ordering is lexicographic and exact.
	 * Omitted means no split was requested and both halves come back null.
	 */
	recentFrom?: string
): Promise<Map<number, LineupSlots>> => {
	const data = await json(
		`${BASE}/schedule?sportId=1&gameType=R&startDate=${startDate}&endDate=${endDate}` +
			`&hydrate=lineups`
	)
	const seen = new Map<number, { date: string; slot: number }[]>()
	for (const day of data.dates ?? [])
		for (const game of day.games ?? [])
			for (const side of ["homePlayers", "awayPlayers"] as const) {
				const card = game.lineups?.[side]
				if (!Array.isArray(card)) continue
				card.forEach((p: any, i: number) => {
					// The slot is the position in the array, so it is only ever read off a
					// card that actually posted. A doubleheader contributes two starts on
					// one date, which is right: two cards are two observations.
					if (typeof p?.id === "number")
						seen.set(p.id, [...(seen.get(p.id) ?? []), { date: day.date, slot: i + 1 }])
				})
			}
	const out = new Map<number, LineupSlots>()
	for (const [id, obs] of seen) {
		if (obs.length < MIN_LINEUP_STARTS) continue
		const half = (recent: boolean): number | null => {
			if (recentFrom === undefined) return null
			const v = obs.filter(o => o.date >= recentFrom === recent).map(o => o.slot)
			return v.length >= MIN_LINEUP_STARTS ? median(v) : null
		}
		out.set(id, {
			starts: obs.length,
			slot: median(obs.map(o => o.slot)),
			recentSlot: half(true),
			priorSlot: half(false)
		})
	}
	return out
}
