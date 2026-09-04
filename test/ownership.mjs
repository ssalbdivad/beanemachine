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


// --- reading a roster off a team's own Yahoo page -----------------------------
//
// "My team" is the gate to the starting lineup and to every trade verdict, and it
// used to open on an empty search box asking for twenty-seven players by hand. The
// page it now reads is the same one src/import.ts already downloads for the team
// NAME, so nothing new has to be reachable — but the parse has to be pinned,
// because a roster that quietly loses a player misprices every lineup under it.
const { parseRoster } = await import("../src/data/yahoo-pool.ts")

// One <tr> per player, slot in the first <td>, "NYY - C,1B" beside the name —
// the shape the real page uses, so the fixture cannot drift from it silently.
const rosterRow = (id, name, slot = "C", meta = "NYY - C,1B") =>
  `<tr><td>${slot}</td><td>` +
  `<a class="name F-link" data-ys-playerid="${id}" title="${name}">${name}</a>` +
  `<span>${meta}</span></td></tr>`

const roster = parseRoster(
  `<table>${rosterRow(1, "Ben Rice", "C")}${rosterRow(2, "Juan Soto", "OF", "NYM - OF")}</table>`
)
t("a roster page yields one entry per player",
  roster.length === 2 && roster[0].name === "Ben Rice" && roster[1].name === "Juan Soto",
  JSON.stringify(roster))
t("and carries Yahoo's own id for each", roster.map(x => x.yahooId).join(",") === "1,2")

// Yahoo repeats a player's id across the row (the note link, the icon), and a
// roster listing him twice would double-count him in every slot he fills.
const dupes = parseRoster(
  `<table>${rosterRow(7, "Byron Buxton")}${rosterRow(7, "Byron Buxton")}</table>`
)
t("a player repeated in the markup is stored once", dupes.length === 1, JSON.stringify(dupes))

t("a page with no roster rows yields nothing rather than throwing",
  parseRoster("<html><body>Please sign in</body></html>").length === 0)
t("an entry without a readable name is skipped rather than stored blank",
  parseRoster(`<tr><td>C</td><td><a data-ys-playerid="9"></a></td></tr>`).length === 0)

// The SEAT is what the add/drop planner reasons over, so it is read rather than
// assumed — a fabricated "BN" for everybody would have the plan report points
// "sitting on your bench" that nothing established were benched.
t("the seat is read from the row's first cell",
  roster[0].slot === "C" && roster[1].slot === "OF",
  roster.map(x => x.slot).join(","))
t("and the league's own eligibility line comes with it",
  roster[0].positions.join("/") === "C/1B" && roster[1].positions.join("/") === "OF",
  JSON.stringify(roster.map(x => x.positions)))
t("a first cell that is not a slot leaves the seat null rather than guessing",
  parseRoster(`<tr><td>Wed 7:05</td><td><a data-ys-playerid="5" title="X Y">X Y</a></td></tr>`)[0]
    .slot === null)

// The join to MLBAM runs through normalizeName, the same join ownership uses.
const { normalizeName } = await import("../src/data/yahoo-pool.ts")
t("a roster name normalizes onto the same key ownership joins by",
  normalizeName("José Soriano") === normalizeName("Jose Soriano"))

// --- the roster read, per platform ------------------------------------------
//
// Yahoo is scraped because Yahoo has no public API. ESPN and Sleeper both publish
// JSON for a publicly-viewable league, and src/import.ts already reads their
// SETTINGS through the same endpoints.
//
// What is pinned here is the property that has to hold whatever the platform
// serves: every path returns {players, note} and NEVER throws on a shape it did
// not expect. A roster read WRONG is worse than one not read, because the lineup
// and every add/drop under it would be priced against a team you do not have.
// The section after it replays two real leagues' payloads through the readers.
const { fetchTeamRoster } = await import("../src/data/rosters.ts")

const unsupported = await fetchTeamRoster({ platform: "fantrax", leagueId: "1", teamId: "1" })
t("an unsupported platform is named rather than silently returning nothing",
  unsupported.players.length === 0 && /fantrax/.test(unsupported.note), unsupported.note)

const blank = await fetchTeamRoster({ platform: "", leagueId: "1", teamId: "1" })
t("a missing platform still answers in the same shape",
  Array.isArray(blank.players) && typeof blank.note === "string", JSON.stringify(blank))

// A reader that throws would take the whole page down; every one of them catches.
const unreachable = await fetchTeamRoster({
  platform: "espn", leagueId: "0", teamId: "0", sport: "flb", season: 1900
})
t("a platform that cannot be reached returns a note, never an exception",
  Array.isArray(unreachable.players) && unreachable.players.length === 0 &&
    unreachable.note.length > 0, unreachable.note)

// --- ESPN and Sleeper, against what the live leagues actually served ----------
//
// The comment above used to say no publicly-viewable league was available to
// verify either reader against. That is no longer true, and the readers were
// wrong in ways only a real payload could show:
//
//   - ESPN's lineupSlotId table in this file was FOOTBALL's (20 = BN, 21 = IL).
//     In baseball, bench is 16 and IL is 17, and 20/21 never occur — so the seat
//     came back null for every player on every team, not just for the starters
//     the old comment anticipated.
//   - Sleeper's player ids are per-sport namespaces that COLLIDE, and the reader
//     took the sport from the caller. Its own default, "mlb", read the NFL league
//     below as twelve plausible baseball players who were not on the team.
//
// The payloads both leagues served are committed under test/fixtures/ and replayed
// here through a stubbed fetch, so this suite stays offline and deterministic
// while still asserting against real bytes rather than against a hand-written
// shape that cannot drift the way the platform does. Provenance:
//
//   espn-81134470-2021.json    ESPN league 81134470, season 2021, ?view=mRoster&view=mSettings.
//                              8 teams, 212 rostered rows. The id is the one the
//                              espn-api wrapper publishes as its own baseball
//                              integration-test league. Trimmed to the fields the
//                              reader touches; no team names or owners are in it.
//   sleeper-*-289646328504385536.json  Sleeper's own documented example league
//                              (NFL, 2018, 12 teams) plus the 187 NFL dictionary
//                              entries it rosters. owner_id is an account id for a
//                              real person, so the committed copy carries synthetic
//                              stand-ins of the same shape — every assertion below
//                              is about roster_id, players and seats.
//   sleeper-players-mlb.sample.json  20 real entries from Sleeper's MLB dictionary,
//                              including the three ids whose collision is asserted.
const fx = name =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"))
const espnFixture = fx("espn-81134470-2021.json")
const sleeperLeague = fx("sleeper-league-289646328504385536.json")
const sleeperRosters = fx("sleeper-rosters-289646328504385536.json")
const sleeperNfl = fx("sleeper-players-nfl.slim.json")
const sleeperMlb = fx("sleeper-players-mlb.sample.json")

const liveFetch = globalThis.fetch
let requested = []
const served = body => ({ ok: true, status: 200, json: async () => body })
const refused = status => ({ ok: false, status, json: async () => null })
/** Replay the saved payloads. Anything not routed 404s, which is also what ESPN
 *  does for a season a league never played. */
const replay = routes => {
  requested = []
  globalThis.fetch = async url => {
    const u = String(url)
    requested.push(u)
    for (const [match, reply] of routes) if (u.includes(match)) return reply
    return refused(404)
  }
}
const espnOnly = () => replay([["seasons/2021", served(espnFixture)]])
const sleeperOk = (dict = sleeperNfl, sport = "nfl", rosters = sleeperRosters, league = sleeperLeague) =>
  replay([
    [`/league/${league.league_id}/rosters`, served(rosters)],
    [`/league/${league.league_id}`, served(league)],
    [`/players/${sport}`, served(dict)]
  ])

// ESPN: the seat table, which is the thing that was wrong -----------------------

// The payload's own evidence that the old mapping named nothing: 20 and 21 are
// football's bench and IL and do not occur in a baseball league at all.
const espnSlotIds = new Set(
  espnFixture.teams.flatMap(t => t.roster.entries.map(e => e.lineupSlotId))
)
t("ESPN's baseball payload never uses lineupSlotId 20 or 21, which the reader used to look for",
  !espnSlotIds.has(20) && !espnSlotIds.has(21), [...espnSlotIds].sort((a, b) => a - b).join(","))

espnOnly()
const espn1 = await fetchTeamRoster({
  platform: "espn", leagueId: "81134470", teamId: "1", sport: "flb", season: 2021
})
t("ESPN team 1 reads back the 25 players the live league served",
  espn1.players.length === 25, `${espn1.players.length} — ${espn1.note}`)
t("and every one of the 25 has a seat, where the football numbering gave 0",
  espn1.players.every(p => p.slot), JSON.stringify(espn1.players.filter(p => !p.slot)))
t("and every one of the 25 has the eligibility ESPN stated",
  espn1.players.every(p => p.positions.length),
  JSON.stringify(espn1.players.filter(p => !p.positions.length).map(p => p.name)))

// Named rows, so a renumbering shows up here rather than in a lineup.
const betts = espn1.players.find(p => p.name === "Mookie Betts")
t("slot 5 is OF, read off the man the league had in it",
  betts?.slot === "OF" && betts.positions.join("/") === "OF" && betts.team === "LAD",
  JSON.stringify(betts))
t("slot 6 is the 2B/SS seat, not football's flex",
  espn1.players.find(p => p.name === "Bo Bichette")?.slot === "2B/SS",
  JSON.stringify(espn1.players.find(p => p.name === "Bo Bichette")))
t("slot 7 is the 1B/3B seat", espn1.players.find(p => p.name === "Matt Chapman")?.slot === "1B/3B")
t("slot 16 is the bench, and this team has four men on it",
  espn1.players.filter(p => p.slot === "BN").length === 4,
  espn1.players.filter(p => p.slot === "BN").map(p => p.name).join(","))
// proTeamId 0 is free agency, not a club: three men on this end-of-2021 capture
// had hit the market, and inventing a team for them would be the same class of
// mistake as inventing a seat.
t("a proTeamId of 0 is reported as no club rather than as a team",
  espn1.players.filter(p => !p.team).length === 3 &&
    espn1.players.find(p => p.name === "Trevor Story")?.team === null,
  espn1.players.filter(p => !p.team).map(p => p.name).join(","))

espnOnly()
const espn4 = await fetchTeamRoster({
  platform: "espn", leagueId: "81134470", teamId: "4", sport: "flb", season: 2021
})
t("slot 17 is the IL, and its occupants are the men the league parked there",
  espn4.players.filter(p => p.slot === "IL").map(p => p.name).sort().join(",") ===
    "Jake McGee,Michael Brantley",
  espn4.players.filter(p => p.slot === "IL").map(p => p.name).join(","))

// All eight rosters, so the count in the doc comment is re-derivable rather than
// believed, and so a team that quietly shrank fails here.
espnOnly()
let espnTotal = 0
let espnUnseated = 0
for (const id of [1, 2, 3, 4, 5, 6, 7, 8]) {
  const one = await fetchTeamRoster({
    platform: "espn", leagueId: "81134470", teamId: String(id), sport: "flb", season: 2021
  })
  espnTotal += one.players.length
  espnUnseated += one.players.filter(p => !p.slot).length
}
t("all eight rosters read back the league's 212 rows", espnTotal === 212, String(espnTotal))
t("with a seat on every one of them", espnUnseated === 0, String(espnUnseated))

// A wrong team number and a wrong league are different mistakes.
espnOnly()
const espn99 = await fetchTeamRoster({
  platform: "espn", leagueId: "81134470", teamId: "99", sport: "flb", season: 2021
})
t("a team number that isn't in the league names the ones that are",
  espn99.players.length === 0 && /1, 2, 3, 4, 5, 6, 7, 8/.test(espn99.note), espn99.note)

// ESPN 404s a season a league never played, and the default season is the current
// one — so a league read between years must fall back rather than report privacy.
espnOnly()
const espnRetry = await fetchTeamRoster({
  platform: "espn", leagueId: "81134470", teamId: "1", sport: "flb", season: 2022
})
t("a 404 season is retried against the season before it",
  espnRetry.players.length === 25 && requested.length === 2, `${requested.length} requests`)

// Truncated and unexpected payloads: a note, never a throw, and never a roster.
for (const [what, body] of [
  ["an empty object", {}],
  ["a payload with no teams array", { teams: "gone" }],
  ["a team with no roster on it", { teams: [{ id: 1 }] }],
  ["a roster whose entries carry no player", { teams: [{ id: 1, roster: { entries: [{ lineupSlotId: 16 }, {}] } }] }]
]) {
  replay([["seasons/", served(body)]])
  const out = await fetchTeamRoster({
    platform: "espn", leagueId: "81134470", teamId: "1", sport: "flb", season: 2021
  })
  t(`ESPN serving ${what} still answers {players, note}`,
    Array.isArray(out.players) && out.players.length === 0 && typeof out.note === "string" &&
      out.note.length > 0, JSON.stringify(out))
}

// A body that isn't JSON at all is the shape a login wall or an error page has.
replay([["seasons/", { ok: true, status: 200, json: async () => { throw new Error("not json") } }]])
const espnJunk = await fetchTeamRoster({
  platform: "espn", leagueId: "81134470", teamId: "1", sport: "flb", season: 2021
})
t("ESPN serving something that isn't JSON is a note, not an exception",
  espnJunk.players.length === 0 && espnJunk.note.length > 0, espnJunk.note)

for (const status of [401, 403]) {
  replay([["seasons/", refused(status)]])
  const priv = await fetchTeamRoster({
    platform: "espn", leagueId: "81134470", teamId: "1", sport: "flb", season: 2021
  })
  t(`ESPN's HTTP ${status} is reported as a private league, not as a missing one`,
    /publicly viewable/.test(priv.note), priv.note)
}

// Sleeper --------------------------------------------------------------------

// The collision the reader now refuses rather than resolving. These three ids are
// on roster 1 of the NFL league; the MLB dictionary has entirely different men
// under them, and the old code returned those.
t("the same Sleeper id names a different man in each sport",
  sleeperNfl["1352"].full_name === "Robert Woods" && sleeperMlb["1352"].full_name === "Jordan Hicks" &&
    sleeperNfl["2118"].full_name === "Eric Ebron" && sleeperMlb["2118"].full_name === "Brandon Woodruff",
  `${sleeperNfl["1352"]?.full_name} / ${sleeperMlb["1352"]?.full_name}`)

// A baseball app asking Sleeper for baseball must be refused, and refused BEFORE
// the dictionary is touched — a wrong roster is worse than no roster.
sleeperOk(sleeperMlb, "mlb")
const slpDefault = await fetchTeamRoster({
  platform: "sleeper", leagueId: "289646328504385536", teamId: "1"
})
t("a Sleeper league that isn't the sport we asked for is refused rather than resolved",
  slpDefault.players.length === 0 && /plays NFL/.test(slpDefault.note), slpDefault.note)
t("and refused without downloading the multi-megabyte player list",
  !requested.some(u => u.includes("/players/")), requested.join(" "))

// A failing dictionary is a state, and it must not be remembered as one: the next
// read has to be able to succeed.
sleeperOk()
globalThis.fetch = (real => async url => {
  requested.push(String(url))
  if (String(url).includes("/players/")) return refused(503)
  return real(url)
})(globalThis.fetch)
const slpNoDict = await fetchTeamRoster({
  platform: "sleeper", leagueId: "289646328504385536", teamId: "1", sport: "nfl"
})
t("a player list that will not load is a note rather than a roster of ids",
  slpNoDict.players.length === 0 && slpNoDict.note.length > 0, slpNoDict.note)

sleeperOk()
const slp1 = await fetchTeamRoster({
  platform: "sleeper", leagueId: "289646328504385536", teamId: "1", sport: "nfl"
})
t("Sleeper roster 1 reads back the 15 players the live league served",
  slp1.players.length === 15, `${slp1.players.length} — ${slp1.note}`)

// starters[] is ordered and aligns with roster_positions minus the bench, which is
// where the seats come from. The old code threw this away and called everybody null
// or BN.
const seatLine = slp1.players.filter(p => p.slot !== "BN").map(p => p.slot).sort().join(",")
t("the nine seats come back as the league's own chart, not as a started flag",
  seatLine === "DEF,FLEX,FLEX,QB,RB,RB,TE,WR,WR", seatLine)
t("and each seat holds the man the league had in it",
  slp1.players.find(p => p.name === "Lamar Jackson")?.slot === "QB" &&
    slp1.players.find(p => p.name === "Alvin Kamara")?.slot === "RB" &&
    slp1.players.find(p => p.name === "Robert Woods")?.slot === "FLEX",
  slp1.players.map(p => `${p.slot}:${p.name}`).join(" "))
t("the six men off the field are benched, none of them left unseated",
  slp1.players.filter(p => p.slot === "BN").length === 6 && slp1.players.every(p => p.slot),
  slp1.players.filter(p => !p.slot).map(p => p.name).join(","))

// The dictionary is 8-15 MB and Sleeper's docs ask for one call a day, so a second
// read must not fetch it again.
const before = requested.filter(u => u.includes("/players/")).length
const slp12 = await fetchTeamRoster({
  platform: "sleeper", leagueId: "289646328504385536", teamId: "12", sport: "nfl"
})
t("a second roster read reuses the player list rather than re-downloading it",
  requested.filter(u => u.includes("/players/")).length === before, String(before))
t("Sleeper roster 12 reads back its 14 players", slp12.players.length === 14, String(slp12.players.length))

// owner_id is an account id for a real person. It is accepted as a way in and then
// discarded — it must never reach the note the user reads or the roster we store.
sleeperOk()
const byOwner = await fetchTeamRoster({
  platform: "sleeper", leagueId: "289646328504385536", teamId: sleeperRosters[0].owner_id, sport: "nfl"
})
t("a roster found by its owner id still reports the roster number",
  byOwner.players.length === 15 && /roster 1\b/.test(byOwner.note), byOwner.note)
t("and the owner id itself never appears in what the user is shown",
  !byOwner.note.includes(String(sleeperRosters[0].owner_id)), byOwner.note)

// Sleeper states one position per baseball player: fantasy_positions is populated
// on 32 of 6,379 MLB entries and every one of the 32 is a club, not a player. So
// eligibility has to come from `position`, and the sample proves the shape.
const mlbEntries = Object.values(sleeperMlb)
t("Sleeper's MLB entries carry a position but no fantasy_positions",
  mlbEntries.filter(p => p.position).length === mlbEntries.length &&
    mlbEntries.filter(p => p.fantasy_positions?.length).every(p => p.fantasy_positions.join() === "DEF"),
  JSON.stringify(mlbEntries.filter(p => p.fantasy_positions?.length).map(p => p.fantasy_positions)))

// Seats that do not line up are left unset rather than guessed at — an off-by-one
// here would put every man in his neighbour's seat.
const shortStarters = sleeperRosters.map(r =>
  r.roster_id === 1 ? { ...r, starters: r.starters.slice(0, 8) } : r
)
sleeperOk(sleeperNfl, "nfl", shortStarters)
const mismatched = await fetchTeamRoster({
  platform: "sleeper", leagueId: "289646328504385536", teamId: "1", sport: "nfl"
})
t("starters that don't match the seat chart leave the seats unset and say so",
  mismatched.players.length === 15 && /didn't line up/.test(mismatched.note) &&
    mismatched.players.filter(p => p.slot && p.slot !== "BN").length === 0,
  mismatched.note)

// Truncated and unexpected payloads, again: a note, never a throw.
for (const [what, routes] of [
  ["a league that says nothing", [["/league/289646328504385536", served(null)]]],
  ["a league with no sport on it",
    [["/league/289646328504385536/rosters", served(sleeperRosters)],
     ["/league/289646328504385536", served({ league_id: "289646328504385536" })]]],
  ["no rosters at all",
    [["/league/289646328504385536/rosters", served([])],
     ["/league/289646328504385536", served(sleeperLeague)]]],
  ["rosters that aren't an array",
    [["/league/289646328504385536/rosters", served({ oops: true })],
     ["/league/289646328504385536", served(sleeperLeague)]]],
  ["a roster with no players on it",
    [["/league/289646328504385536/rosters", served([{ roster_id: 1, players: null, starters: null }])],
     ["/league/289646328504385536", served(sleeperLeague)]]],
  ["a player list with none of the roster's ids in it",
    [["/league/289646328504385536/rosters", served(sleeperRosters)],
     ["/league/289646328504385536", served(sleeperLeague)],
     ["/players/nba", served({})]]]
]) {
  replay(routes)
  const sport = what.includes("none of the roster's ids") ? "nba" : "nfl"
  const league = what.includes("none of the roster's ids") ?
    { ...sleeperLeague, sport: "nba" } : null
  if (league) replay([...routes.slice(0, 1), ["/league/289646328504385536", served(league)], ...routes.slice(2)])
  const out = await fetchTeamRoster({
    platform: "sleeper", leagueId: "289646328504385536", teamId: "1", sport
  })
  t(`Sleeper serving ${what} still answers {players, note}`,
    Array.isArray(out.players) && out.players.length === 0 && typeof out.note === "string" &&
      // the note has to SAY which of these it was, or the manual path is offered
      // for a reason nobody can act on
      /league|sport|roster|player list/i.test(out.note), JSON.stringify(out))
}

globalThis.fetch = liveFetch

console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
