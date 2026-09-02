// Season-long competition as a regression test.
//
// The correlation suite says the ranking is good; this says a manager using it
// wins. It replays 2021-2025 week by week from the disk cache, so it needs a warm
// cache (`nub run compete` once) but then runs offline.
//
// Not in the default `test` script because it depends on that cache. Run with:
//   node test/compete.mjs
import { readFileSync } from "node:fs"
import { playSeason, STRATEGIES } from "../src/backtest/season.ts"

const league = JSON.parse(readFileSync("scoring.json", "utf8")).leagues["yahoo:228947"]
const SEASONS = [2021, 2022, 2023, 2024, 2025]
let pass = 0,
	fail = 0
const t = (n, ok, x = "") => {
	ok ? pass++ : fail++
	console.log(`${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : "  " + x}`)
}

const totals = new Map()
const weekly = new Map()
for (const season of SEASONS) {
	// one move per week: the measured optimum, and what autonomous mode defaults to
	const { results } = await playSeason(season, league, STRATEGIES, {
		movesPerWeek: 1,
		warmupDays: 28
	})
	for (const r of results) {
		totals.set(r.strategy, (totals.get(r.strategy) ?? 0) + r.total)
		weekly.set(r.strategy, [...(weekly.get(r.strategy) ?? []), ...r.byWeek])
	}
}

const bscore = totals.get("bscore")
const std = totals.get("season-to-date")
const hot = totals.get("hot-hand")
console.log(
	`  bscore ${bscore.toFixed(0)} · season-to-date ${std.toFixed(0)} · hot-hand ${hot.toFixed(0)}`
)

t("bscore beats season-to-date over five seasons", bscore > std, `${bscore} vs ${std}`)
t("bscore beats hot-hand over five seasons", bscore > hot, `${bscore} vs ${hot}`)

// Totals are three samples; weeks are sixty-eight. A model that wins on aggregate
// while losing most weeks has won a coin toss, and this league is head-to-head.
const mine = weekly.get("bscore") ?? []
const theirs = weekly.get("season-to-date") ?? []
const wins = mine.filter((v, i) => v > (theirs[i] ?? Infinity)).length
t(
	"bscore wins a clear majority of individual weeks vs season-to-date",
	wins / mine.length > 0.65,
	`${wins}/${mine.length}`
)

const margin = mine.reduce((a, c, i) => a + (c - (theirs[i] ?? 0)), 0) / mine.length
t("and by a large margin per week", margin > 40, `${margin.toFixed(1)}/wk`)

// hot-hand is the harder opponent: ranking by raw projected points splits weeks
// against it 36/68, and only the replacement adjustment turns that into a majority
const hotWeeks = weekly.get("hot-hand") ?? []
const vsHot = mine.filter((v, i) => v > (hotWeeks[i] ?? Infinity)).length
t("bscore wins a clear majority of weeks vs hot-hand too", vsHot / mine.length > 0.58, `${vsHot}/${mine.length}`)

// the replacement adjustment must be earning its place
const control = totals.get("projected-points")
t("value over replacement beats ranking by raw projected points",
  bscore > control, `${bscore} vs ${control}`)

console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
