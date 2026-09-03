/**
 * The ownership feed, checked for the failure that made it useless.
 *
 * "% Ros" is the only thing in this project that claims to know what the FIELD
 * thinks, and market edge — for a long time the board's default ranking — is
 * bscore minus the median at the same ownership decile. So a wrong ownership
 * number does not degrade one column; it reorders the whole board.
 *
 * Yahoo nests a weather forecast inside each outdoor game's tooltip, and
 * `parsePage` read "the first percentage left in the row block" after stripping
 * the three labelled forecast lines it knew about. It did not know about all of
 * them. The result was that a per-GAME number reached the field: on the capture
 * committed as data/snapshot.json, every Yankee and every Angel read 47%, every
 * Dodger and Cardinal 54%, every Oriole and Rockie 20%, and 225 players across
 * four games read 51% — those are the day's matchups, not roster shares.
 *
 * The club-variance invariant below is what makes that shape impossible to ship
 * again, and it needs no fixture and no network: real roster shares vary within a
 * club. A star and his team's fifth starter are not owned in the same fraction of
 * leagues. Whenever most of a club's players agree to the percent, the number
 * being read belongs to the game rather than to the player.
 *
 * The three sections after it cover the coverage failure that left `uscore` blank
 * for 74 of the top 120 rendered rows:
 *
 *   - `count=` is an OFFSET. Both readers computed `page * 25` from page ONE, so
 *     offset 0 was never requested and the top 25 at every position had no price.
 *     Measured 2026-09-03 against league 228947: count=0, 25 and 50 return three
 *     disjoint sets of 25.
 *   - a page's LAST row was dropped, because the row block was matched with a
 *     9000-character lazy span anchored on "next row or end of input" and ~90KB of
 *     page footer follows the final row. Every page returned 25 and parsed as 24.
 *   - the forecast was ruled out by a blocklist of labels, which missed the
 *     sentence form "There is a 51% chance of precipitation" — number BEFORE the
 *     label. Ownership is now read positively from the `<td><div>` stat cell,
 *     which the forecast table has no equivalent of.
 *
 * Together these took the sweep from 668 priced names to 1114, 558 to 883 joined
 * to the committed snapshot, and 49 of the 120 highest-volume players priced to
 * 119.
 */
import { readFileSync } from "node:fs"
import { leakedByTeam, pageUrl, parsePage } from "../src/data/yahoo-pool.ts"

let pass = 0, fail = 0
const t = (n, ok, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : "  " + x}`) }

// --- the invariant itself, on constructed input ------------------------------

// A whole club on one number is the signature of the leak.
const leaked = leakedByTeam(
  Array.from({ length: 26 }, (_, i) => ({ team: "NYY", rosteredPct: 47, id: i }))
)
t("a club whose players all share one percentage is flagged", leaked.has("NYY"), [...leaked].join(","))
t("and the flagged value is the shared one", leaked.get("NYY") === 47, String(leaked.get("NYY")))

// Real shares vary, so a club with a spread is left alone.
const spread = leakedByTeam(
  Array.from({ length: 26 }, (_, i) => ({ team: "NYM", rosteredPct: i * 3, id: i }))
)
t("a club with genuinely varied shares is not flagged", !spread.has("NYM"), [...spread].join(","))

// Two players agreeing is a coincidence, not a leak — the check must not fire on
// a club Yahoo listed only a couple of players from.
const thin = leakedByTeam([
  { team: "ATH", rosteredPct: 51, id: 1 },
  { team: "ATH", rosteredPct: 51, id: 2 }
])
t("two players on one value is too thin to call a leak", !thin.has("ATH"), [...thin].join(","))

// The genuine reads inside a leaked club survive: the leak nulls a VALUE, not a club.
const mixed = leakedByTeam([
  ...Array.from({ length: 24 }, (_, i) => ({ team: "LAD", rosteredPct: 54, id: i })),
  { team: "LAD", rosteredPct: 99, id: 100 },
  { team: "LAD", rosteredPct: 96, id: 101 }
])
t("a leaked club still flags only the one shared value", mixed.get("LAD") === 54, String(mixed.get("LAD")))

// Zero is a real roster share, not a leak. Exempting it is what keeps the check
// from blanking the bottom of the board: on the 2026-09-03 sweep the unexempted
// rule flagged NYM (24 of 41 players at 0%), LAA (23 of 38) and SF (26 of 41) and
// would have discarded 73 honest prices.
const zeros = leakedByTeam(
  Array.from({ length: 26 }, (_, i) => ({ team: "SF", rosteredPct: i < 20 ? 0 : i, id: i }))
)
t("a club most of whose players are genuinely unowned is not flagged", !zeros.has("SF"), [...zeros].join(","))

// --- the paging contract: count is an offset ---------------------------------

// The whole defect in one line. Page 0 asks for offset 0; asking for 25 first is
// how the top 25 at every position went unpriced.
t("page 0 requests offset 0", pageUrl("228947", "baseball", "SP", 0, "ALL").endsWith("count=0"),
  pageUrl("228947", "baseball", "SP", 0, "ALL"))
t("page 1 requests offset 25", pageUrl("228947", "baseball", "SP", 1, "ALL").endsWith("count=25"))
t("the free-agent reader pages the same way", pageUrl("228947", "baseball", "OF", 0, "A").endsWith("count=0"))

// --- parsing one page --------------------------------------------------------

/**
 * A page in Yahoo's shape: the name link carries `title=`, the player-note link
 * repeats the id WITHOUT one, the outdoor game's tooltip nests an AccuWeather
 * table whose cells are bare `<td>`s, and the real "% Ros" is a `<td><div>`. The
 * footer after the last row is deliberately longer than the 9000-character span
 * the old matcher allowed, because that is exactly what dropped the 25th row.
 */
const row = (id, name, pct, weather = true) =>
  `<tr><td><a href="/players/${id}" data-ys-playerid="${id}" class="name" title="${name}">${name}</a>` +
  `<span data-ys-playerid="${id}" class="note"></span>` +
  `<span class="Nowrap">MIL - SP,RP</span>` +
  (weather ?
    `<span title="<table><tr><td>Thunderstorms today with a high of 90&deg;F. There is a 51% chance of precipitation.</td></tr>` +
    `<tr><td class='Pend-sm'>Humidity:</td><td>76%</td></tr>` +
    `<tr><td class='Pend-sm'>Precipitation:</td><td>34%</td></tr></table>"></span>`
  : "") +
  `<td class="Alt Ta-end"><div >984.40</div></td>` +
  (pct === null ? "" : `<td class="Ta-end Nowrap Bdrend"><div >${pct}%</div></td>`) +
  `<td class="Alt Ta-end"><div >155.0</div></td></tr>`

const page =
  `<table>` + row(1, "Jacob Misiorowski", 98) + row(2, "Yoshinobu Yamamoto", 99) +
  row(3, "Shohei Ohtani (Pitcher)", 96) + row(4, "Nobody Listed", null) +
  row(5, "Sandy Alcantara", 95) + `</table>` + "<footer>".padEnd(90000, "x")

const parsed = parsePage(page)
t("every row on the page is parsed, including the last one before a long footer",
  parsed.length === 5, `${parsed.length} of 5`)
t("the last row is the one that used to be dropped",
  parsed.at(-1)?.name === "Sandy Alcantara", String(parsed.at(-1)?.name))
t("ownership comes from the stat cell, not from the forecast sentence",
  parsed[0].rosteredPct === 98, String(parsed[0].rosteredPct))
t("nor from the humidity or the precipitation line",
  parsed[1].rosteredPct === 99, String(parsed[1].rosteredPct))
t("a row with no stat cell is unknown, never zero",
  parsed[3].rosteredPct === null, String(parsed[3].rosteredPct))
t("the two-way player's slot qualifier is stripped from his name",
  parsed[2].name === "Shohei Ohtani", parsed[2].name)
t("the player-note link's repeat of the id does not become a second row",
  new Set(parsed.map(p => p.yahooId)).size === 5)
t("the position line is still read", parsed[0].positions.join(",") === "SP,RP", parsed[0].positions.join(","))

// The forecast alone must never be mistaken for a price: a row with weather and no
// stat cell reads as unknown rather than as the chance of rain.
const forecastOnly = parsePage(`<table>${row(9, "Rain Delay", null)}</table>`)
t("a weather tooltip alone yields no ownership", forecastOnly[0].rosteredPct === null,
  String(forecastOnly[0].rosteredPct))

// --- the committed capture, which is where this was found --------------------

const snap = JSON.parse(readFileSync(new URL("../data/snapshot.json", import.meta.url), "utf8"))
const team = new Map(snap.players.map(p => [String(p.id), p.teamId]))
const own = snap.ownership ?? {}
t("the committed snapshot has an ownership map at all", Object.keys(own).length > 0)

// Regrouped by club, exactly as the check does — asserted on real data so the
// number in the comment above can always be re-derived rather than believed.
const byTeam = new Map()
for (const [id, pct] of Object.entries(own)) {
  const tm = team.get(id)
  if (tm === undefined) continue
  if (!byTeam.has(tm)) byTeam.set(tm, [])
  byTeam.get(tm).push(pct)
}
const constant = [...byTeam.values()].filter(vals => {
  if (vals.length < 10) return false
  const counts = new Map()
  for (const v of vals) counts.set(v, (counts.get(v) ?? 0) + 1)
  return Math.max(...counts.values()) / vals.length > 0.5
})
// This capture is the diseased one. The assertion records that, so the day a
// clean capture is committed this line fails and has to be updated deliberately
// rather than the evidence quietly evaporating.
t("the committed capture is the known-bad one this check was written for",
  constant.length >= 15, `${constant.length} of ${byTeam.size} clubs sit on one value`)

console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
