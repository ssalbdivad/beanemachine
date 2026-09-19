/**
 * HOW LONG AGO, IN ONE PLACE, because three places gave three answers.
 *
 * This app labels the age of four different things — the free-agent list, the capture,
 * the last extension read, the seats it holds — and each screen had grown its own
 * arithmetic. Measured against the same instant:
 *
 *     90 minutes   `since` "2h ago"    `ago` "1h ago"    (round against floor)
 *     30 hours     `since` "30h ago"   `ago` "1d ago"    `freshness` "30h ago"
 *     40 hours     `since` "40h ago"   `ago` "1d ago"    `freshness` "2d ago"
 *
 * Three labels for one moment, on three screens of one product, and nothing in any of
 * them was wrong on its own terms — `ago` floored because a floor never overstates,
 * `freshness` switched to days at its own staleness line, `since` rounded. They simply
 * had no reason to agree, which is what a copied function is.
 *
 * So the LABEL is one function and the VERDICTS stay where they were. Whether a capture
 * is stale, and how many whole days of baseball have happened since, are judgements
 * about a particular thing and belong to the screen that makes them; what "40 hours ago"
 * is called is not.
 *
 * Its own module rather than pool.ts's, because `Connect.tsx` deliberately imports
 * nothing that touches storage — its comment said so while carrying a copy of this
 * instead, which is the cost the split was avoiding.
 */
export const since = (at: string, now: number): { label: string; hours: number } => {
	const hours = (now - Date.parse(at)) / 3_600_000
	if (!Number.isFinite(hours)) return { label: "at an unreadable time", hours: NaN }
	/* A clock that disagrees with the stamp is a reader's own clock, not a negative age. */
	if (hours < 0) return { label: "just now", hours: 0 }
	/* Minutes, and never "0m ago": under a minute is still a read that just happened, and
	   a zero there reads as a bug rather than as freshness. */
	if (hours < 1) return { label: `${Math.max(1, Math.round(hours * 60))}m ago`, hours }
	/* Hours out to two days. A wire turns over about once a day, so "30h ago" is a fact a
	   reader can act on where "1d ago" is not. */
	if (hours < 48) return { label: `${Math.round(hours)}h ago`, hours }
	return { label: `${Math.round(hours / 24)}d ago`, hours }
}
