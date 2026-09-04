// Every league config the repo ships, put through the whole engine on the real
// snapshot. A preset is only real if the board's answer actually depends on it —
// so these assert against data/snapshot.json under each preset's own scoring,
// never against a fixture.
import { readFileSync } from "node:fs"
import { type } from "arktype"
import { hydrate } from "../src/data/snapshot.ts"
import { Config, League, ScoringPeriod } from "../src/schema.ts"
import { rateAll, slotsFor } from "../src/engine/bscore.ts"
import { activeSlots, replacementBySlot, startingLineup } from "../src/engine/trade.ts"
import { HITTING_MAP, PITCHING_MAP } from "../src/engine/points.ts"
import {
  agentHeaders,
  detect,
  deriveScoringPeriod,
  deriveMoveLimit,
  deriveInningsMinimum,
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

// ── Presets: a template that DOES ship values ───────────────────────────────────
// Every platform template used to be blank — 0 stats, 0 slots, no team count — so
// "new league from a yahoo template" created a league that could rank nothing, and
// the feature was decoration. A template that ships values fixes that and buys a
// new way to lie: values that look like they were read from YOUR league.
//
// The rule this suite enforces is the one the rest of the project already follows
// for `resolvePeriod`'s Monday fallback — an assumption is allowed as long as the
// thing states it. So a template carrying values must be unverified, must mark
// itself with the marker the UI matches on (PRESET_METHOD in src/client/panels.tsx,
// checked against this file below), must name where its numbers came from, and must
// list what to check. Sections 3 and 4 then run the whole engine over it, so a
// preset that says the right things and ranks nothing still fails.
const PRESET_METHOD = "preset:"
const presets = shipped.filter(s => s.kind === "template" && categories(s.league) > 0)
t("some template ships real values, so a new league can rank without an import",
  presets.length > 0,
  "every platform_template is blank: 'new league' cannot produce a board")
for (const s of presets) {
  const { provenance, needs_review } = s.league
  t(`preset "${s.key}" does not claim to have been read from your league`,
    provenance.verified === false, JSON.stringify(provenance))
  t(`preset "${s.key}" marks itself a preset, which is what the UI's notice keys on`,
    provenance.method.startsWith(PRESET_METHOD), provenance.method)
  t(`preset "${s.key}" names the league its numbers were actually read from`,
    /\b\d{4,}\b/.test(provenance.method) && provenance.sources.length > 0,
    provenance.method)
  t(`preset "${s.key}" tells the user which values to check against their own league`,
    needs_review.length >= 3 &&
      needs_review.some(n => /point value/i.test(n)) &&
      needs_review.some(n => /team/i.test(n)) &&
      needs_review.some(n => /roster|slot/i.test(n)),
    JSON.stringify(needs_review))
  // A preset that carried an identity would be a stranger's league wearing your
  // name: the values are borrowed on purpose, the league is not.
  t(`preset "${s.key}" carries no league id, team id or team name`,
    s.league.meta.league_id === null && s.league.meta.team_id === null &&
      s.league.meta.team_name === null,
    JSON.stringify(s.league.meta))
}

// The marker is a contract between the data and the UI: scoring.json writes it,
// src/client/panels.tsx matches on it to decide whether to show the "these are not
// your league's values" notice. Asserted from both ends, because a typo in either
// would silently drop the notice and leave a borrowed board looking verified.
t("the preset marker in scoring.json is the one panels.tsx matches on",
  readFileSync("src/client/panels.tsx", "utf8").includes(`export const PRESET_METHOD = "${PRESET_METHOD}"`),
  PRESET_METHOD)

// The one command a Yahoo user is told to run, asserted across the two files that
// say it. The page prints it (IMPORT_COMMAND in panels.tsx) and the tool prints it
// for itself (RUN in src/cli.ts); the instruction they used to give was
// `nub src/cli.ts <url>`, and `nub` is not installed on a machine that just cloned
// this repo — so the single instruction the one required tool gave was a command
// that does not exist. Both ends are checked, because a page telling you to run
// something the tool does not answer to is the same failure again.
const panelsSrc = readFileSync("src/client/panels.tsx", "utf8")
const cliSrc = readFileSync("src/cli.ts", "utf8")
t("the page and the CLI name the same runner, and it is not `nub`",
  /export const IMPORT_COMMAND = "node --experimental-strip-types src\/cli\.ts /.test(panelsSrc) &&
    cliSrc.includes("`node --experimental-strip-types ${SELF}`") &&
    !/\bnub\b/.test(panelsSrc),
  panelsSrc.match(/export const IMPORT_COMMAND = .*/)?.[0] ?? "IMPORT_COMMAND not found")

// Sleeper runs no fantasy baseball: src/import.ts refuses a Sleeper URL by name and
// cites the check — `/v1/state/mlb` names no season, so no MLB league can exist there. Offering it as a league
// type in a baseball app is a dead end with a button on it, so it is gone from the
// choices. This is the assertion that keeps it gone.
t("no template offers a platform that runs no fantasy baseball",
  !("sleeper" in cfg.platform_templates),
  Object.keys(cfg.platform_templates).join(","))

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

  // 6. What a preset's numbers actually are.
  //
  // This used to build a `rankings` array and then assert nothing with it, under a
  // comment explaining that only one scored league shipped so there was nothing to
  // compare. Two now ship — and the second is a deliberate COPY of the first, which
  // is the only way to put values in front of a Yahoo user without inventing any.
  // So the assertion is the copy itself: every point value in a preset must be
  // findable, unchanged, in a league this repo read from source. A value that
  // drifted from its source is a value somebody typed, and typing one here is
  // exactly what the project forbids.
  for (const s of presets) {
    const from = Object.values(cfg.leagues).find(
      l => JSON.stringify(l.scoring.batting) === JSON.stringify(s.league.scoring.batting) &&
        JSON.stringify(l.scoring.pitching) === JSON.stringify(s.league.scoring.pitching))
    t(`preset "${s.key}" carries a scoring table this repo read from a real league`,
      from !== undefined && from.provenance.verified === true,
      `${JSON.stringify(s.league.scoring)} matches no verified league in scoring.json`)
    if (from) {
      // Same table, same slots, same team count — so the ordering must match too.
      // If it did not, something between the config and the board would be reading
      // the preset differently from the league it was copied from.
      const a = rate(from, from.meta.max_teams).slice(0, 25).map(x => x.player.name).join(",")
      const b = rate(s.league, s.league.meta.max_teams).slice(0, 25).map(x => x.player.name).join(",")
      t(`and it ranks exactly as that league does, which is what a copy means`, a === b,
        `${a.split(",")[0]} vs ${b.split(",")[0]}`)
      t(`and it copies that league's roster too, so replacement depth matches`,
        JSON.stringify(from.roster.slots) === JSON.stringify(s.league.roster.slots) &&
          from.meta.max_teams === s.league.meta.max_teams,
        `${JSON.stringify(s.league.roster.slots)} vs ${JSON.stringify(from.roster.slots)}`)
    }
  }

  // Coverage, recorded rather than asserted away: how much of what ships can rank.
  console.log(
    `  NOTE  ${scored.length} of ${shipped.length} shipped configs carry scoring ` +
      `(${scored.map(x => x.key).join(", ")}); ${blank.length} blank ` +
      `(${blank.map(x => x.key).join(", ") || "none"})`
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
//   Yahoo    baseball.fantasysports.yahoo.com  no access-control headers at all
//
// That table is the whole reason the hosted build can import a league at all, so it
// is asserted rather than left as a comment. It is a claim about the PLATFORMS, not
// about this code, and it is the client's only input for deciding whether to read a
// league itself or hand the URL to the server — get it wrong in either direction and
// the hosted build either lies about what it can do or fires a doomed cross-origin
// request. test/static.mjs proves the ESPN half against the live API.
//
// Sleeper WAS on this list, answering `access-control-allow-origin: *`, and it is
// gone — not because the header changed but because CORS was never the question:
// Sleeper runs no fantasy baseball (`/v1/state/mlb` names no season), so a readable
// Sleeper league is another sport's league whose scoring this engine cannot use.
// This assertion used to say Sleeper was readable, which was true and useless; it
// now says Sleeper is refused, which is the fact that matters to a baseball user.
t("ESPN is readable from a page; Yahoo, which sends no CORS headers, is not",
  readableInBrowser("espn") && !readableInBrowser("yahoo"),
  ["espn", "yahoo"].map(x => `${x}:${readableInBrowser(x)}`).join(" "))
t("and Sleeper is not readable either, because there is no baseball league to read",
  !readableInBrowser("sleeper"), String(readableInBrowser("sleeper")))
t("and a platform nobody has taught it about is not assumed readable either",
  !readableInBrowser("fleaflicker") && !readableInBrowser(""))

// A Sleeper URL is a URL the user did not get wrong, so the refusal has to be about
// baseball rather than about the URL. That distinction is the difference between
// "you typed something odd" and "this platform cannot help you", and only one of
// them tells a Sleeper user what to do next.
const sleeperRefusal = (() => {
  try { detect("https://sleeper.com/leagues/289646328504385536"); return null }
  catch (e) { return e.message }
})()
t("a Sleeper URL is refused by name, citing baseball rather than the URL",
  sleeperRefusal !== null && /fantasy baseball/i.test(sleeperRefusal) &&
    !/unrecognized/i.test(sleeperRefusal),
  String(sleeperRefusal))
t("and the refusal points at the platforms that do run baseball leagues",
  /yahoo/i.test(sleeperRefusal ?? "") && /espn/i.test(sleeperRefusal ?? ""),
  String(sleeperRefusal))

// The URL form, which is what the client actually holds when the user hits Import.
const URLS = {
  "https://fantasy.espn.com/baseball/league?leagueId=81134470&seasonId=2021": true,
  // refused outright now, so not importable from a page or anywhere else
  "https://sleeper.com/leagues/289646328504385536": false,
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

/**
 * ── The carrier file: what a Yahoo user's one local command has to produce ──────
 *
 * Yahoo sends no CORS headers, so beanemachine.com can never read a Yahoo league's
 * free-agent list — and "which starters should I stream before the reset" is a
 * question about the players you can ADD. The hosted board's answer was therefore
 * a ranking of everyone in baseball with the availability question unanswered, and
 * its head was four pitchers rostered in 94-99% of leagues.
 *
 * The route that closes it is a file: `src/cli.ts` reads the pool on a machine and
 * writes it into scoring.json; `src/client/pool.ts` validates and stores it in the
 * browser. Two files, no shared code path at runtime, and nothing but this section
 * to notice if they drift — so the CLI's own written shape is put through the
 * store's own validator here, in node, where a rename fails loudly instead of
 * producing a file the page silently discards.
 */
const { StoredPoolShape } = await import("../src/client/pool.ts")

// What src/cli.ts writes, spelled out here rather than imported: the point is to
// catch the two ends disagreeing, and importing the writer's own object would make
// that impossible to detect.
const writtenPool = {
  at: new Date().toISOString(),
  leagueId: "228947",
  players: [
    { yahooId: "11728", name: "Shea Langeliers", team: "ATH", positions: ["C"] },
    { yahooId: "12781", name: "Max Meyer", team: "MIA", positions: ["SP"] }
  ],
  positionsRead: ["C", "1B", "2B", "3B", "SS", "OF", "Util", "SP", "RP"],
  note: "Top 25 free agents per position (C, 1B, …)."
}
const poolOut = StoredPoolShape(writtenPool)
t("the pool entry src/cli.ts writes is one src/client/pool.ts will store",
  !(poolOut instanceof type.errors), String(poolOut))

// The stamp is the whole difference between a fact and a claim. A free-agent list
// turns over whenever anybody in the league clicks Add, so a pool with no read time
// is last Tuesday's wire presented as today's — and this project's rule is that an
// assumption gets stated. The store REFUSES one rather than defaulting the time.
t("a pool with no read time is refused rather than stamped with a guess",
  StoredPoolShape({ ...writtenPool, at: undefined }) instanceof type.errors)
t("and one with no league id is refused too, so it cannot be served to another league",
  StoredPoolShape({ ...writtenPool, leagueId: undefined }) instanceof type.errors)

// The two ways the CLI's summary can lie by omission. Both reads can fail — a
// private league, a throttled sweep, a URL with no team in it — and the summary has
// to print the failure rather than a shorter list of successes.
const cliSource = readFileSync("src/cli.ts", "utf8")
t("the CLI reads the free agents and the roster in the same command as the settings",
  /fetchAvailable/.test(cliSource) && /fetchRoster/.test(cliSource) &&
    /--settings-only/.test(cliSource),
  "cli.ts no longer performs the two reads a browser cannot do")
t("and it prints the failure of either read rather than only its successes",
  /✗ \$\{"free agents"/.test(cliSource) && /✗ \$\{"your roster"/.test(cliSource))
t("the file path is the LAST thing it prints, because it is the only line to act on",
  cliSource.lastIndexOf("${CONFIG}") > cliSource.lastIndexOf("needs_review"),
  "the path is buried above the caveats again")

// An old file still has to load. Every carried key is optional and the committed
// seed carries none of them, which is what makes a file written before any of this
// existed load exactly as it did.
t("the committed scoring.json carries no pool, roster or lineup, and is still valid",
  !("pools" in cfg) && !("rosters" in cfg) && !("lineups" in cfg) &&
    !(Config(cfg) instanceof type.errors))
// …and the schema has to PRESERVE the carried keys rather than strip them, which is
// the one property the whole file route rests on: `Config` is applied to the file
// on the way in, and a validator that dropped undeclared keys would drop the pool.
const withPool = Config({ ...cfg, pools: { "yahoo:228947": writtenPool } })
t("and a config validated with a pool attached still has the pool afterwards",
  !(withPool instanceof type.errors) && withPool.pools?.["yahoo:228947"]?.players.length === 2,
  withPool instanceof type.errors ? String(withPool) : JSON.stringify(Object.keys(withPool)))


// --- ESPN: a league that imports and then actually ranks --------------------
//
// An imported ESPN league used to land its whole scoring table in
// `scoring.unmapped` and its roster slots as bare numbers, so the board refused it
// with "this league has no scoring yet" and offered no way forward. The import
// worked and the product did not.
//
// Both halves are now read off ESPN's own payload. The stat map was DERIVED, not
// copied: 212 roster rows of public league 81134470 for 2021, each carrying its
// season split keyed by these ids, joined by name to MLB StatsAPI's real 2021
// season. Agreement per id ran 83–100%, the shortfall being players ESPN's split
// covers differently from MLB's totals, and no id had a competing candidate.
//
// Offline, against the committed settings fixture — the network is the thing the
// derivation needed, not the thing the assertion needs.
const espnSettings = JSON.parse(
  readFileSync(new URL("./fixtures/espn-81134470-settings.json", import.meta.url), "utf8")
)
const { mapEspnScoring, deriveEspnPeriod } = await import("../src/import.ts")

const espnScoring = mapEspnScoring(espnSettings.settings.scoringSettings.scoringItems)
t("every one of this ESPN league's scoring stats is named",
  espnScoring.unmapped.length === 0 &&
    Object.keys(espnScoring.batting).length + Object.keys(espnScoring.pitching).length === 14,
  `${Object.keys(espnScoring.batting).length} batting + ${Object.keys(espnScoring.pitching).length} pitching, ` +
  `${espnScoring.unmapped.length} unmapped`)

/**
 * The independent check on the mapping, and the reason it can be trusted at all:
 * every sign comes out right for a points league. A wrong map would pay a hitter
 * for striking out or a pitcher for allowing a run, and that is visible without
 * knowing which stat is which.
 */
t("what a hitter is paid for is good and what he is docked for is bad",
  espnScoring.batting.TB > 0 && espnScoring.batting.R > 0 && espnScoring.batting.RBI > 0 &&
    espnScoring.batting.SB > 0 && espnScoring.batting.BB > 0 && espnScoring.batting.K < 0,
  JSON.stringify(espnScoring.batting))
t("and a pitcher is paid for outs, wins, saves and strikeouts, docked for the rest",
  espnScoring.pitching.OUT > 0 && espnScoring.pitching.W > 0 && espnScoring.pitching.SV > 0 &&
    espnScoring.pitching.K > 0 && espnScoring.pitching.H < 0 && espnScoring.pitching.BB < 0 &&
    espnScoring.pitching.ER < 0 && espnScoring.pitching.L < 0,
  JSON.stringify(espnScoring.pitching))

// A stat this map cannot name is kept verbatim, never guessed at.
const withUnknown = mapEspnScoring([{ statId: 99999, points: 3 }, { statId: 53, points: 5 }])
t("a stat id the map does not know is kept rather than guessed",
  withUnknown.unmapped.length === 1 && withUnknown.pitching.W === 5,
  JSON.stringify(withUnknown))
// ...and so is one carrying a per-position override the engine cannot express
const overridden = mapEspnScoring([{ statId: 53, points: 5, pointsOverrides: { "1": 7 } }])
t("a stat with a points override is not flattened to its base value",
  overridden.unmapped.length === 1 && Object.keys(overridden.pitching).length === 0)

/**
 * The scoring period, which ESPN states properly where Yahoo only implies it.
 * The unit `matchupPeriods` counts is settled by the payload itself: the top-level
 * `scoringPeriodId` reads 187, a day index, so if those arrays counted days this
 * league's season would be 25 days. They count weeks — 21 one-week matchups plus
 * two two-week playoff rounds is 25, against a regular season of about 26.
 */
const espnPeriod = deriveEspnPeriod(espnSettings.settings)
t("ESPN's own settings give a matchup period of seven days",
  espnPeriod.period.kind === "matchup" && espnPeriod.period.days === 7,
  JSON.stringify(espnPeriod.period))
t("and the source records how that was arrived at, not just the answer",
  /matchupPeriodLength 1/.test(espnPeriod.period.source ?? "") &&
    /25 matchup-period units/.test(espnPeriod.period.source ?? ""),
  espnPeriod.period.source ?? "")
t("what ESPN does not state is left null and named",
  espnPeriod.period.starts_on === null && espnPeriod.period.lineup_lock === null &&
    espnPeriod.needsReview.some(x => /Monday/.test(x)) &&
    espnPeriod.needsReview.some(x => /lineup_lock/.test(x)),
  espnPeriod.needsReview.join(" | ").slice(0, 160))

// a shape this has never seen is refused rather than read as a week
const odd = deriveEspnPeriod({ scheduleSettings: { matchupPeriodLength: 1, matchupPeriods: { 1: [1] } } })
t("a schedule this cannot read yields no period rather than a guess",
  odd.period.kind === null && odd.needsReview.some(x => /rolling window/.test(x)),
  odd.needsReview.join(" | "))
t("and so does a payload with no scheduleSettings at all",
  deriveEspnPeriod({}).period.kind === null)


// --- the public seed carries scoring, and nobody's team -----------------------
//
// src/cli.ts writes the free-agent pool, the roster and the lineup into
// scoring.json — that is the whole point of the file a Yahoo user carries to the
// hosted site, since those are the three things a browser can never read for
// itself. But scoring.json is ALSO the asset every first visit is seeded from, and
// the build used to copy it wholesale: one person's roster and their league's wire
// shipped to every stranger who opened the page, presented as the demo. Measured
// when it happened: 150 free agents and 24 rostered players, with the masthead
// telling visitors it had read a wire it had no business having.
//
// vite.config.ts strips the three carried stores on the way into public/. This is
// the assertion that keeps them out.
const seed = JSON.parse(readFileSync("public/scoring.json", "utf8"))
t("the seeded league is real scoring, or the demo board ranks nothing",
  Object.keys(seed.leagues ?? {}).length > 0 &&
    Object.values(seed.leagues).every(l => Object.keys(l.scoring?.batting ?? {}).length > 0),
  Object.keys(seed.leagues ?? {}).join(","))
for (const carried of ["pools", "rosters", "lineups"])
  t(`the seed carries no ${carried} — those belong to whoever ran the importer`,
    Object.keys(seed[carried] ?? {}).length === 0,
    `${carried}: ${Object.keys(seed[carried] ?? {}).join(",")}`)


// --- which platforms can be asked for a free-agent list ----------------------
//
// The capability and the door are separate things, and they came apart once. ESPN
// got a reader that works from the page with no server — measured, its preflight
// names `x-fantasy-filter` — and both callers still tested `platform !== "yahoo"`
// inline and returned early, so nothing ever asked. The board went on estimating
// availability from ownership for a league whose exact wire was one fetch away.
//
// One predicate now, asserted here, so the next platform is one edit and not a hunt.
const { canReadPool } = await import("../src/client/api.ts")
t("Yahoo can be asked (through the local server it needs)", canReadPool("yahoo"))
t("ESPN can be asked (straight from the page)", canReadPool("espn"))
t("a platform with no reader is not asked", !canReadPool("sleeper") && !canReadPool(null))

/**
 * The weekly add cap comes from the league, not from the reader.
 *
 * Yahoo prints "Max Acquisitions per Week" on the settings page and the import
 * already harvests every row of it, so the board asked for a number it was
 * holding. Read against the SHIPPED league's own settings rather than a fixture:
 * those are the strings Yahoo actually printed, and a fixture here would only
 * prove the fixture matches the parser.
 */
{
  const shipped = deriveMoveLimit(shippedRaw)
  t("the shipped league's stated weekly cap is read, not typed",
    shipped.perPeriod === 6, JSON.stringify(shipped))
  t("the cap quotes the row it came from",
    shipped.source === 'Max Acquisitions per Week "6"', shipped.source)

  // unlimited is not a big number
  const none = deriveMoveLimit({ "Max Acquisitions per Week": "No maximum" })
  t("a league with no weekly cap yields null, not a stand-in",
    none.perPeriod === null, JSON.stringify(none))
  t("even then the row is quoted, so the null can be traced",
    none.source === 'Max Acquisitions per Week "No maximum"', none.source)

  // a season cap is not a weekly budget
  const seasonOnly = deriveMoveLimit({ "Max Acquisitions for Entire Season": "40" })
  t("a season-long cap is never read as this week's budget",
    seasonOnly.perPeriod === null && seasonOnly.source === null,
    JSON.stringify(seasonOnly))

  t("a settings map without the row says nothing",
    deriveMoveLimit({}).perPeriod === null, "")
}

/**
 * The other per-period rule the league states: the weekly innings floor.
 *
 * "Min innings pitched per team per week" is why a lot of streaming happens —
 * fall short and the pitching side of the matchup is lost. Read off the shipped
 * league's real settings rows, same as the move cap.
 */
{
  const shipped = deriveInningsMinimum(shippedRaw)
  t("the shipped league's stated innings floor is read",
    shipped.perPeriod === 20, JSON.stringify(shipped))
  t("the floor quotes the row it came from",
    shipped.source === 'Min innings pitched per team per week "20"', shipped.source)
  t("a league that sets no floor yields null",
    deriveInningsMinimum({ "Min innings pitched per team per week": "No minimum" })
      .perPeriod === null)
  t("and a floor of zero is that same answer, not a floor of zero",
    deriveInningsMinimum({ "Min innings pitched per team per week": "0" })
      .perPeriod === null)
  t("a settings map without the row says nothing",
    deriveInningsMinimum({}).perPeriod === null && deriveInningsMinimum({}).source === null)
}

console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
