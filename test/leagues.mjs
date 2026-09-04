// Every league config the repo ships, put through the whole engine on the real
// snapshot. A preset is only real if the board's answer actually depends on it —
// so these assert against data/snapshot.json under each preset's own scoring,
// never against a fixture.
import { readFileSync } from "node:fs"
import { type } from "arktype"
import { hydrate } from "../src/data/snapshot.ts"
import { League, ScoringPeriod } from "../src/schema.ts"
import { rateAll, slotsFor } from "../src/engine/bscore.ts"
import { activeSlots, replacementBySlot, startingLineup } from "../src/engine/trade.ts"
import { HITTING_MAP, PITCHING_MAP } from "../src/engine/points.ts"
import {
  agentHeaders,
  detect,
  deriveScoringPeriod,
  importableInBrowser,
  importLeague,
  IN_BROWSER,
  readableInBrowser
} from "../src/import.ts"
import { resolvePeriod } from "../src/engine/period.ts"

const cfg = JSON.parse(readFileSync("scoring.json", "utf8"))
const snap = JSON.parse(readFileSync("data/snapshot.json", "utf8"))
const hy = hydrate(snap)
let pass = 0, fail = 0
const t = (n, ok, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : "  " + x}`) }

// Everything the repo ships that claims to be a League: the configured leagues,
// and the platform templates the client clones when you create one.
const shipped = [
  ...Object.entries(cfg.leagues).map(([key, league]) => ({ kind: "league", key, league })),
  ...Object.entries(cfg.platform_templates).map(([key, league]) => ({ kind: "template", key, league }))
]

const rate = (league, teams) => rateAll({
  league, teams, players: hy.players, underlying: hy.underlying, injuries: hy.injuries,
  teamGamesPlayed: hy.teamGamesPlayed, gamesByTeam: hy.gamesByTeam,
  opponentsByTeam: hy.opponentsByTeam, recentVolumeByWindow: hy.recentVolumeByWindow,
  recentStats: hy.recentStats
})

const BENCH = ["BN", "IL", "NA", "IL+"]
const categories = l => Object.keys(l.scoring.batting).length + Object.keys(l.scoring.pitching).length

t("the repo ships at least one league and one template",
  shipped.some(s => s.kind === "league") && shipped.some(s => s.kind === "template"),
  shipped.map(s => `${s.kind}:${s.key}`).join(" "))

// 1. Every preset must satisfy the same schema that guards storage. The client
// clones a template straight into League(), so an invalid template is a "new
// league" button that throws instead of creating one.
for (const s of shipped) {
  const out = League(s.league)
  t(`${s.kind} "${s.key}" validates against the League schema`, !(out instanceof type.errors), String(out))
}

// 2. A preset that scores nothing is a blank form, not a league type, and has to
// say so — otherwise it presents as configured while scoring every category zero.
const scored = shipped.filter(s => categories(s.league) > 0)
const blank = shipped.filter(s => categories(s.league) === 0)
for (const s of blank) {
  t(`${s.kind} "${s.key}" declares that it is unconfigured`,
    s.league.needs_review.length > 0 && s.league.provenance.verified === false,
    JSON.stringify(s.league.needs_review))
  // the Board's only gate on an unconfigured league is a missing team count
  t(`${s.kind} "${s.key}" states no team count, so the board refuses it`,
    s.league.meta.max_teams === null, String(s.league.meta.max_teams))
}

// rateAll refuses to default the team count, so a preset that doesn't state one
// cannot be rated at all — that is a property of the preset, asserted not assumed.
const rateable = scored.filter(s => s.league.meta.max_teams !== null)
for (const s of scored)
  t(`scored preset "${s.key}" states its team count`, s.league.meta.max_teams !== null,
    "replacement depth is teams × slots; without it there is no bscore")

// 3. The end-to-end battery, once per scored preset.
for (const s of rateable) {
  const { key, league } = s
  const r = rate(league, league.meta.max_teams)
  const live = r.filter(x => x.rateable)

  t(`"${key}" ranks a non-empty pool`, r.length > 0 && live.length > 0,
    `${r.length} rows, ${live.length} rateable`)
  t(`"${key}" produces finite numbers throughout`,
    r.every(x => Number.isFinite(x.bscore) && Number.isFinite(x.points) && Number.isFinite(x.replacement)))
  t(`"${key}" is returned in bscore order`, r.every((x, i) => i === 0 || r[i - 1].bscore >= x.bscore))

  // the identity the whole board rests on, stated on the row a user actually reads
  const top = r[0]
  t(`"${key}" top row: bscore is projected minus replacement`,
    Math.abs(top.bscore - (top.points - top.replacement)) < 0.02 && top.points === top.projected.points,
    `${top.player.name}: ${top.points} − ${top.replacement} = ${top.bscore}`)

  // an all-zero column is what a preset whose scoring never reached the engine
  // looks like, and it sorts and prints exactly like a real ranking
  t(`"${key}" separates players rather than scoring them all alike`,
    new Set(live.map(x => x.bscore)).size > live.length / 2,
    `${new Set(live.map(x => x.bscore)).size} distinct bscores over ${live.length} players`)

  // 4. Nothing this league scores may quietly vanish: every category is either a
  // line in the breakdown or a name in unscoreable, never neither.
  const accounted = ["hitting", "pitching"].every(group => {
    const table = Object.keys(group === "hitting" ? league.scoring.batting : league.scoring.pitching)
    return r.filter(x => x.player.group === group).every(x => {
      const seen = new Set([...Object.keys(x.projected.breakdown), ...x.projected.unscoreable])
      return table.every(c => seen.has(c)) && seen.size === table.length
    })
  })
  t(`"${key}" accounts for every scored category on every row`, accounted)

  // roster arithmetic, checked against the slot table rather than only against itself
  const counts = league.roster.counts
  const slots = league.roster.slots
  const sum = Object.values(slots).reduce((a, b) => a + b, 0)
  if (counts === null) {
    t(`"${key}" reports its roster counts as unread rather than inventing them`,
      sum === 0 && league.needs_review.length > 0)
  } else {
    t(`"${key}" roster counts add up`, counts.active + counts.bench + counts.injured_list === counts.total,
      `${counts.active} + ${counts.bench} + ${counts.injured_list} ≠ ${counts.total}`)
    t(`"${key}" roster counts match the slot table`,
      counts.total === sum &&
        counts.bench === (slots.BN ?? 0) &&
        counts.injured_list === BENCH.slice(1).reduce((a, c) => a + (slots[c] ?? 0), 0) &&
        counts.active === sum - BENCH.reduce((a, c) => a + (slots[c] ?? 0), 0),
      `slots total ${sum}, counts ${JSON.stringify(counts)}`)
    const tally = {}
    for (const slot of league.roster.slot_order ?? []) tally[slot] = (tally[slot] ?? 0) + 1
    t(`"${key}" slot_order tallies to the slot counts`,
      league.roster.slot_order === null || JSON.stringify(tally) === JSON.stringify(slots),
      JSON.stringify(tally))
  }

  // a slot no player is ever eligible for gets a replacement level of zero and is
  // then never filled — the league would be scored against a lineup it can't field
  const fillable = new Set(hy.players.flatMap(p => slotsFor(p)))
  const orphans = Object.keys(slots).filter(x => !BENCH.includes(x) && !fillable.has(x))
  t(`"${key}" names no roster slot the engine cannot fill`, orphans.length === 0, orphans.join(","))

  // replacement level falls back to 0 when a slot holds fewer eligible players
  // than teams × count, and a replacement of zero makes a player's whole point
  // total look like value over the wire. Nothing rateable may rest on that.
  const freebies = r.filter(x => x.rateable && x.replacement === 0)
  t(`"${key}" prices no rateable player against a replacement of zero`,
    freebies.length === 0,
    freebies.slice(0, 3).map(x => `${x.player.name} @ ${x.slot}`).join(", "))
}

// Sections 5-7 each need a preset of their kind to work on. Indexing straight
// into these dropped the whole run on a TypeError when one was empty, losing
// every result above it — the absence is itself a finding, so assert and skip.
const reference = rateable[0]?.league ?? null
t("some shipped preset both scores categories and states a team count",
  reference !== null, "nothing shippable to exercise the engine against")
if (reference !== null) {
  // 5. A category no source supplies must be named, not zeroed. QS and PICK are
  // canonical pitching keys with no StatsAPI field behind them, so a league
  // scoring them is the case this rule exists for.
  const missingKeys = [...cfg.stat_keys.pitching.filter(k => !(k in PITCHING_MAP)),
    ...cfg.stat_keys.batting.filter(k => !(k in HITTING_MAP))]
  t("some canonical stat key genuinely has no data source", missingKeys.length > 0, missingKeys.join(","))
  const withQs = structuredClone(reference)
  withQs.scoring.pitching = { ...withQs.scoring.pitching, QS: 5 }
  const rq = rate(withQs, withQs.meta.max_teams).filter(x => x.player.group === "pitching")
  t("an unsourceable category is reported in unscoreable, not scored as zero",
    rq.every(x => x.projected.unscoreable.includes("QS") && !("QS" in x.projected.breakdown)),
    JSON.stringify(rq[0].projected.unscoreable))

  // 6. Two presets must not rank the same board. Identical rankings from different
  // league types mean the scoring never reached the ranking.
  const rankings = rateable.map(s => ({
    key: s.key,
    top: rate(s.league, s.league.meta.max_teams).slice(0, 25).map(x => x.player.name).join(",")
  }))
  // Only one scored league ships, and that is deliberate rather than an oversight:
// this project refuses to write a scoring table it did not read from a real league,
// so the platform templates carry roster shape only and you supply the values by
// importing your league. The invariant worth asserting is therefore about the
// ENGINE — that two different tables really do produce different orderings, which
// assertion 6 covers against a derived table — plus the fact that every league that
// DOES carry scoring works end to end. This line records the coverage honestly so
// the gap stays visible instead of being quietly asserted away.
console.log(
  `  NOTE  ${scored.length} shipped league(s) carry scoring; ` +
    `${blank.length} template(s) ship roster shape only and need an import to rank`
)
t("at least one shipped league carries real scoring and ranks",
  scored.length >= 1,
  `${scored.length} scored`)

  // The control for the check above: the same comparison against a scoring table
  // built here, so a failure there can be pinned on what ships rather than on the
  // engine. Saves and holds against the shipped points table should move the board.
  const variant = structuredClone(reference)
  variant.scoring.batting = { SB: 10, R: 1, BB: 1 }
  variant.scoring.pitching = { SV: 20, HLD: 10, K: 1 }
  const a = rate(reference, reference.meta.max_teams).slice(0, 25).map(x => x.player.name).join(",")
  const b = rate(variant, variant.meta.max_teams).slice(0, 25).map(x => x.player.name).join(",")
  t("the engine does apply a preset's scoring to the ranking", a !== b,
    `${a.split(",")[0]} vs ${b.split(",")[0]}`)
}

// 7. A preset with nothing in it must not produce a board. The templates ship
// blank on purpose and the Board's only gate is the team count — its empty state
// tells you to "set the team count, and the board fills in". Do that on a fresh
// template and it does fill in, with every player at zero and nothing anywhere
// saying the league scores nothing.
const [emptyPreset] = blank
if (emptyPreset !== undefined) {
  const rz = rate(emptyPreset.league, 10)
  // The contract is not "return nothing" — reporting beats hiding, so the rows
  // still come back. It is that NONE of them is rateable, which is the flag every
  // consumer gates on, and which the Board now uses to refuse to render a field of
  // zeros as though it were a working ranking.
  t("a preset with no scoring yields nothing rateable",
    rz.length > 0 && rz.every(x => !x.rateable),
    `${emptyPreset.kind} "${emptyPreset.key}" with a team count set: ${rz.length} rows, ` +
      `every bscore 0, ${rz.filter(x => x.rateable).length} flagged rateable, ` +
      `${rz.filter(x => x.projected.unscoreable.length).length} reporting anything unscoreable`)
}

// Yahoo's second injured slot. No shipped preset carries one, so nothing above
// exercises it — and the two lists that decide what a slot means had already
// drifted apart over it: bscore priced a replacement bar for IL+ and trade.ts
// counted it as a spot to start, while import.ts marked it injured_only.
const withILPlus = (() => {
  const base = cfg.leagues["yahoo:228947"]
  return {
    ...base,
    roster: {
      ...base.roster,
      slots: { ...base.roster.slots, "IL+": 1 },
      slot_order: [...(base.roster.slot_order ?? []), "IL+"]
    }
  }
})()
t("an IL+ slot is not a spot anybody starts",
  !activeSlots(withILPlus).includes("IL+"),
  activeSlots(withILPlus).join(","))
t("and it sets no replacement bar, because nobody is claimed off waivers for it",
  !replacementBySlot(withILPlus, rate(withILPlus, withILPlus.meta.max_teams),
    withILPlus.meta.max_teams).has("IL+"))
t("adding one does not change what the roster is worth", (() => {
  const teams = withILPlus.meta.max_teams
  const base = cfg.leagues["yahoo:228947"]
  const pool = rate(base, teams)
  const bars = replacementBySlot(base, pool, teams)
  const spots = activeSlots(base)
  const roster = (() => {
    const taken = new Set(), out = []
    const byPoints = pool.filter(r => r.rateable).sort((a, b) => b.points - a.points)
    for (const slot of spots) {
      const pick = byPoints.find(r =>
        !taken.has(`${r.player.id}:${r.player.group}`) && r.slots.includes(slot))
      if (pick) { taken.add(`${pick.player.id}:${pick.player.group}`); out.push(pick) }
    }
    return out
  })()
  return startingLineup(base, roster, bars).points ===
    startingLineup(withILPlus, roster, bars).points
})())


// ── The Yahoo importer derives the scoring period ────────────────────────────────
// Every assertion below runs on the strings the shipped league's settings page really
// printed, read straight out of its own league_rules.raw_settings. A fixture written
// here would only prove that the fixture matches the parser; this way, a change in
// what Yahoo prints breaks the test instead of silently moving the board's window.
const shippedRaw = cfg.leagues["yahoo:228947"].league_rules.raw_settings
const storedPeriod = cfg.leagues["yahoo:228947"].scoring_period

t("the shipped league still carries the two settings the derivation reads",
  shippedRaw["Weekly Deadline"] === "Daily - Today" &&
    shippedRaw["Playoffs"] === "6 teams - Week 24, 25 and 26 (ends Sunday, Sep 27)" &&
    shippedRaw["Scoring Type"] === "Head-to-Head - Points",
  JSON.stringify([shippedRaw["Scoring Type"], shippedRaw["Weekly Deadline"], shippedRaw["Playoffs"]]))

const derived = deriveScoringPeriod(shippedRaw)
const periodOut = ScoringPeriod(derived.period)
t("the derived period validates against the schema that guards storage",
  !(periodOut instanceof type.errors), String(periodOut))

// The values in scoring.json were derived by hand from these same two lines. If the
// importer reproduces them from the page alone, nobody has to hand-edit the file again.
t("the importer reproduces the shipped league's period from its settings page alone",
  ["kind", "days", "starts_on", "anchor", "lineup_lock"]
    .every(k => derived.period[k] === storedPeriod[k]),
  `${JSON.stringify(derived.period)} vs ${JSON.stringify(storedPeriod)}`)
t("and it does so with nothing left needing review", derived.needsReview.length === 0,
  JSON.stringify(derived.needsReview))

// "Daily - Today" is when the lineup locks, not when the period ends. Conflating the
// two is the bug this whole derivation exists to avoid, so assert they differ: the
// lock is daily while the period is still a seven-day matchup.
t("the weekly deadline is read as the lock, leaving the period a seven-day matchup",
  derived.period.lineup_lock === "daily" && derived.period.kind === "matchup" &&
    derived.period.days === 7,
  JSON.stringify(derived.period))

// The arithmetic, checked on real dates rather than by counting on fingers. Yahoo
// names the period's END ("ends Sunday, Sep 27"), and the season is 2026 — the same
// settings table dates the trade deadline "August 6, 2026". Sep 27 2026 is indeed a
// Sunday, so the string is internally consistent, and the seven inclusive days ending
// on it open on Monday Sep 21. The day after the stated end is therefore the start.
const DAY_MS = 86400000
const endUTC = Date.UTC(2026, 8, 27)
const startUTC = endUTC - 6 * DAY_MS
t("the stated end weekday is real, and the day after it is where the period starts",
  /\b2026\b/.test(shippedRaw["Trade End Date"] ?? "") &&
    new Date(endUTC).getUTCDay() === 0 &&
    new Date(startUTC).getUTCDay() === 1 &&
    new Date(startUTC).toISOString().slice(0, 10) === "2026-09-21" &&
    derived.period.starts_on === "mon",
  `Sep 27 2026 is day ${new Date(endUTC).getUTCDay()}, start ${new Date(startUTC).toISOString().slice(0, 10)}, derived ${derived.period.starts_on}`)

// What the derivation is FOR: fed to the resolver, it must end the window on the
// Sunday the settings page named, not seven days from whenever you happen to look.
// Wednesday Sep 2 2026 sits inside the week that ends Sunday Sep 6.
const resolved = resolvePeriod({ scoring_period: derived.period }, "2026-09-02", "2026-09-27")
t("the derived period ends a Wednesday's window on the Sunday Yahoo named",
  resolved.kind === "matchup" && resolved.assumed === false &&
    resolved.start === "2026-09-02" && resolved.end === "2026-09-06" &&
    new Date(Date.parse("2026-09-06T00:00:00Z")).getUTCDay() === 0,
  JSON.stringify(resolved))

// source has to quote the settings verbatim, so a wrong value is traced rather than argued about
t("the period quotes both settings it was read from",
  derived.period.source.includes(`"${shippedRaw["Playoffs"]}"`) &&
    derived.period.source.includes(`"${shippedRaw["Weekly Deadline"]}"`),
  derived.period.source)

// Yahoo can restyle any of these strings at any time. Every unrecognized shape has to
// null its field and quote itself into needs_review — the rule numericSetting already
// follows for a non-numeric number — because a guessed period silently moves the board.
const withSettings = extra => ({ ...shippedRaw, ...extra })
const unparseable = deriveScoringPeriod(withSettings({ "Weekly Deadline": "Whenever, mostly" }))
t("an unparseable weekly deadline nulls the lock and quotes itself for review",
  unparseable.period.lineup_lock === null &&
    unparseable.needsReview.some(l => l.includes('"Whenever, mostly"')),
  JSON.stringify(unparseable.needsReview))
t("and it leaves the period itself alone, because the deadline is not the period",
  unparseable.period.kind === "matchup" && unparseable.period.days === 7 &&
    unparseable.period.starts_on === "mon",
  JSON.stringify(unparseable.period))

const weekdayLock = deriveScoringPeriod(withSettings({ "Weekly Deadline": "Monday" }))
t("a bare weekday deadline reads as a lineup locked for the period",
  weekdayLock.period.lineup_lock === "period" && weekdayLock.needsReview.length === 0,
  JSON.stringify(weekdayLock.period))

const noDeadline = (() => { const x = { ...shippedRaw }; delete x["Weekly Deadline"]; return x })()
t("a missing weekly deadline is unknown and said so, never assumed daily",
  deriveScoringPeriod(noDeadline).period.lineup_lock === null &&
    deriveScoringPeriod(noDeadline).needsReview.length > 0,
  JSON.stringify(deriveScoringPeriod(noDeadline).needsReview))

// A league that evidences no matchup period gets null, not a Monday-to-Sunday guess.
const roto = deriveScoringPeriod(withSettings({ "Scoring Type": "Rotisserie" }))
t("a league that does not state head-to-head play gets no period, and says why",
  roto.period.kind === null && roto.period.days === null && roto.period.starts_on === null &&
    roto.needsReview.some(l => l.includes('"Rotisserie"')),
  JSON.stringify(roto))

const noWeeks = deriveScoringPeriod(withSettings({ Playoffs: "No playoffs" }))
t("a playoffs line naming no numbered week evidences no period",
  noWeeks.period.kind === null && noWeeks.period.days === null &&
    noWeeks.needsReview.some(l => l.includes('"No playoffs"')),
  JSON.stringify(noWeeks))

const noEndDay = deriveScoringPeriod(withSettings({ Playoffs: "6 teams - Week 24, 25 and 26" }))
t("weeks with no weekday named keep the matchup but leave the start unknown",
  noEndDay.period.kind === "matchup" && noEndDay.period.days === 7 &&
    noEndDay.period.starts_on === null && noEndDay.needsReview.length > 0,
  JSON.stringify(noEndDay.period))

// The helper being right is worth nothing if importYahoo never calls it. This runs the
// real importer end to end against a stubbed fetch. Only the table markup is synthetic
// — every settings VALUE inside it is the shipped league's own, and the assertion is
// about the wiring: a freshly imported league arrives with its period already set.
const settingsPage = `<h1>Scoring &amp; Settings</h1>
<table><tr><th>Batters Stat Category</th><th>Value</th></tr>
<tr><td>Home Runs (HR)</td><td>10.4</td></tr></table>
<table><tr><th>Setting</th><th>Value</th></tr>${
  Object.entries(shippedRaw).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")
}</table>`
const realFetch = globalThis.fetch
globalThis.fetch = async url =>
  String(url).endsWith("/settings") ?
    { ok: true, status: 200, text: async () => settingsPage }
  : { ok: false, status: 404, text: async () => "" }
try {
  const imported = await importLeague("https://baseball.fantasysports.yahoo.com/b1/228947")
  t("a freshly imported Yahoo league arrives with its scoring period already set",
    ["kind", "days", "starts_on", "anchor", "lineup_lock"]
      .every(k => imported.league.scoring_period[k] === storedPeriod[k]),
    JSON.stringify(imported.league.scoring_period))
  const out = League(imported.league)
  t("and the imported league still validates against the League schema",
    !(out instanceof type.errors), String(out))
} finally {
  globalThis.fetch = realFetch
}

// ── Which platforms a browser is allowed to read for itself ──────────────────────
// Measured 2026-09-04, each with `Origin: https://beanemachine.com` on the exact
// endpoint the importer uses:
//
//   ESPN     lm-api-reads.fantasy.espn.com     access-control-allow-origin: https://beanemachine.com
//   Sleeper  api.sleeper.app                   access-control-allow-origin: *
//   Yahoo    baseball.fantasysports.yahoo.com  no access-control headers at all
//
// That table is the whole reason the hosted build can now import a league, so it is
// asserted rather than left as a comment. It is a claim about the PLATFORMS, not
// about this code, and it is the client's only input for deciding whether to read a
// league itself or hand the URL to the server — get it wrong in either direction and
// the hosted build either lies about what it can do or fires a doomed cross-origin
// request. test/static.mjs proves the ESPN and Sleeper halves against the live APIs.
t("ESPN and Sleeper are readable from a page; Yahoo, which sends no CORS headers, is not",
  readableInBrowser("espn") && readableInBrowser("sleeper") && !readableInBrowser("yahoo"),
  ["espn", "sleeper", "yahoo"].map(x => `${x}:${readableInBrowser(x)}`).join(" "))
t("and a platform nobody has taught it about is not assumed readable either",
  !readableInBrowser("fleaflicker") && !readableInBrowser(""))

// The URL form, which is what the client actually holds when the user hits Import.
const URLS = {
  "https://fantasy.espn.com/baseball/league?leagueId=81134470&seasonId=2021": true,
  "https://sleeper.com/leagues/289646328504385536": true,
  "https://baseball.fantasysports.yahoo.com/b1/228947/8": false,
  // not a league URL at all: not browser-importable, and `detect` is what gets to
  // say why — naming Yahoo for this would be a lie about a URL that names no platform
  "https://example.com/my-league": false
}
for (const [url, expected] of Object.entries(URLS))
  t(`"${url.slice(0, 52)}…" is ${expected ? "" : "not "}importable from a page`,
    importableInBrowser(url) === expected)
t("every URL the importer recognizes agrees with the platform table",
  Object.keys(URLS).every(url => {
    let platform
    try { platform = detect(url).platform } catch { return importableInBrowser(url) === false }
    return importableInBrowser(url) === readableInBrowser(platform)
  }))

// Under node there is no browser to speak for us, so the desktop user-agent still
// goes out — the header every scrape here has always carried. In a page it is
// dropped, which is what keeps each read a simple GET with no CORS preflight; that
// half is only observable in a browser, and test/static.mjs is where it is observed.
t("node still sends a user-agent, so nothing about the server-side scrape changed",
  IN_BROWSER === false && agentHeaders("UA/1.0")["user-agent"] === "UA/1.0",
  JSON.stringify({ IN_BROWSER, headers: agentHeaders("UA/1.0") }))

console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
