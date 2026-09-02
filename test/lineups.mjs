// Batting-order capture, asserted against the live StatsAPI rather than a fixture.
// This is a data-layer suite, so unlike test/engine.mjs it makes real requests — the
// thing under test IS the read, and a fixture would only prove the fixture parses.
// The window is fixed and closed (fifteen played days, one request per call) so the
// numbers below are the numbers that were measured, not a moving target.
import { fetchLineupSlots, MIN_LINEUP_STARTS } from "../src/data/lineups.ts"

const START = "2026-08-18", END = "2026-09-01", SPLIT = "2026-08-26"
let pass = 0, fail = 0
const t = (n, ok, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : "  " + x}`) }

// An independent recount straight from the feed. Every assertion about what the
// module reported is checked against this rather than against the module itself.
const feed = await (await fetch(
  `https://statsapi.mlb.com/api/v1/schedule?sportId=1&gameType=R` +
  `&startDate=${START}&endDate=${END}&hydrate=lineups`,
  { headers: { accept: "application/json" } }
)).json()
const raw = new Map(), names = new Map()
for (const day of feed.dates ?? [])
  for (const game of day.games ?? [])
    for (const side of ["homePlayers", "awayPlayers"]) {
      const card = game.lineups?.[side]
      if (!Array.isArray(card)) continue
      card.forEach((p, i) => {
        if (typeof p?.id !== "number") return
        names.set(p.id, p.fullName)
        raw.set(p.id, [...(raw.get(p.id) ?? []), { date: day.date, slot: i + 1 }])
      })
    }
const median = v => { const s = [...v].sort((a, b) => a - b), m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const mean = v => v.reduce((a, c) => a + c, 0) / v.length

const slots = await fetchLineupSlots(START, END, SPLIT)

t("lineup cards were actually read", slots.size > 250 && raw.size > 350,
  `${slots.size} reported of ${raw.size} hitters seen over ${(feed.dates ?? []).length} dates`)

// 1. every figure is a real batting position. Halves may be null, never out of range.
const positions = [...slots.values()].flatMap(v => [v.slot, v.recentSlot, v.priorSlot])
  .filter(x => x !== null)
t("every reported slot is a batting position between 1 and 9",
  positions.length > 0 && positions.every(x => Number.isFinite(x) && x >= 1 && x <= 9),
  `${positions.filter(x => !(x >= 1 && x <= 9)).length} out of range of ${positions.length}`)

// 2. starts is a count of cards, so it must survive an independent recount
t("starts equals the cards he actually appeared on",
  [...slots].every(([id, v]) => v.starts === raw.get(id).length))

// 3. a known everyday leadoff hitter comes back at the top of the order.
// Named deliberately: this is the check that the array is batting order and not, say,
// fielding position. If his role genuinely changes this needs revisiting, which is
// the cost of asserting against live data instead of a fixture.
const ELLY = 682829
const elly = slots.get(ELLY)
t("an everyday leadoff hitter reads as a top-of-the-order bat",
  elly !== undefined && elly.slot <= 2 && elly.starts >= 10,
  elly ? `${names.get(ELLY)}: slot ${elly.slot} over ${elly.starts} starts` : "not reported")

// and not on the strength of one man — the top of the order must be populated by
// regulars, which a fielding-position array would not produce
const topRegulars = [...slots.values()].filter(v => v.slot <= 2 && v.starts >= 10)
t("the top of the order is filled with regulars", topRegulars.length >= 30,
  `${topRegulars.length} players at slot <= 2 with 10+ starts`)

// 4. below the minimum a player is absent, not reported at zero. Absent is unknown.
const thin = [...raw].filter(([, v]) => v.length < MIN_LINEUP_STARTS)
t("some players really are under the minimum in this window", thin.length > 20,
  `${thin.length} of ${raw.size} hitters under ${MIN_LINEUP_STARTS} starts`)
t("a player under the minimum is excluded rather than reported at zero",
  thin.every(([id]) => !slots.has(id)))
t("nothing reported is a zero, a blank, or under the minimum",
  [...slots.values()].every(v => v.starts >= MIN_LINEUP_STARTS && v.slot >= 1))
t("and every player who clears it is reported",
  [...raw].filter(([, v]) => v.length >= MIN_LINEUP_STARTS).every(([id]) => slots.has(id)))

// 5. the recent/prior split must actually partition the window
const recentOf = id => raw.get(id).filter(o => o.date >= SPLIT).map(o => o.slot)
const priorOf = id => raw.get(id).filter(o => o.date < SPLIT).map(o => o.slot)
t("the two halves account for every start and overlap on none",
  [...slots].every(([id, v]) => recentOf(id).length + priorOf(id).length === v.starts))
t("each half is the median of exactly the starts on its side of the date",
  [...slots].every(([id, v]) =>
    v.recentSlot === (recentOf(id).length >= MIN_LINEUP_STARTS ? median(recentOf(id)) : null) &&
    v.priorSlot === (priorOf(id).length >= MIN_LINEUP_STARTS ? median(priorOf(id)) : null)))

const bothKnown = [...slots.values()].filter(v => v.recentSlot !== null && v.priorSlot !== null)
t("both halves are known for a large population, so the split is usable",
  bothKnown.length > 100, `${bothKnown.length} players with both halves`)
t("the split shows real movement rather than repeating one number",
  bothKnown.some(v => Math.abs(v.recentSlot - v.priorSlot) >= 2),
  `${bothKnown.filter(v => Math.abs(v.recentSlot - v.priorSlot) >= 2).length} moved 2+ slots`)

// a half thinner than the minimum is unknown, never inherited from the whole window
const thinHalf = [...slots].filter(([id]) => recentOf(id).length < MIN_LINEUP_STARTS)
t("a half with too few starts is null rather than borrowing the window's slot",
  thinHalf.length > 0 && thinHalf.every(([, v]) => v.recentSlot === null),
  `${thinHalf.length} players with a thin recent half`)

// 6. the boundaries of the split, which pin down what recentFrom means
const noSplit = await fetchLineupSlots(START, END)
t("no recentFrom asks for no split, and gets nulls rather than a duplicated slot",
  noSplit.size === slots.size &&
  [...noSplit.values()].every(v => v.recentSlot === null && v.priorSlot === null))
const allRecent = await fetchLineupSlots(START, END, START)
t("splitting at the window start puts the whole window in the recent half",
  [...allRecent].every(([, v]) => v.recentSlot === v.slot && v.priorSlot === null))
const allPrior = await fetchLineupSlots(START, END, "2026-09-02")
t("splitting past the window end puts the whole window in the prior half",
  [...allPrior].every(([, v]) => v.priorSlot === v.slot && v.recentSlot === null))

// 7. the typical slot is the median, which is the whole reason it is not the mean:
// a regular who fills in down the order once must still read as his own slot
const skewed = [...raw]
  .filter(([id, v]) => slots.has(id) && Math.abs(median(v.map(o => o.slot)) - mean(v.map(o => o.slot))) >= 1)
  .sort((a, b) => b[1].length - a[1].length)
t("a regular with an odd game down the order is summarised at his real slot",
  skewed.length > 0 && skewed.every(([id, v]) => slots.get(id).slot === median(v.map(o => o.slot))),
  skewed.length
    ? `${names.get(skewed[0][0])}: ${skewed[0][1].length} starts, median ` +
      `${median(skewed[0][1].map(o => o.slot))} vs mean ${mean(skewed[0][1].map(o => o.slot)).toFixed(2)}` +
      ` — ${skewed.length} such players`
    : "no skewed player in this window")

console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
