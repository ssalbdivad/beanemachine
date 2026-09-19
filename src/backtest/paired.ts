import { readFileSync, readdirSync } from "node:fs"

/**
 * WHAT A SEASON RUN ACTUALLY PROVED: `node --experimental-strip-types src/backtest/paired.ts`
 *
 * `compete.ts` prints totals and a paired win count — "bscore vs thoughtful-human
 * 63/111 (+16.9/wk)" — and that sentence reads far stronger than it is. 63 of 111
 * is 56.8%, which a fair coin produces about 8% of the time; a reader who sees a
 * win count with no p beside it has been told a story, not a result.
 *
 * So every pairing gets its effect size AND how sure it is, side by side, in the
 * same line, and the strongest claim available is the one that gets printed.
 *
 * THREE TESTS, BECAUSE THEY FAIL DIFFERENTLY.
 *
 *   · the SIGN test asks only who won each week. It throws away margin, so it cannot
 *     be fooled by one 400-point week, and it is the conservative answer.
 *   · the PAIRED t asks about the mean weekly margin. It is more powerful when the
 *     margins are well behaved and is misled when one week dominates.
 *   · the BOOTSTRAP resamples weeks with replacement and reports the interval the
 *     mean margin actually lives in, which is what survives a skewed distribution.
 *
 * Where they disagree, the disagreement IS the finding, and it is printed rather
 * than resolved: a t-test that is significant while the sign test is not means the
 * margin is carried by a handful of weeks.
 *
 * Weeks are PAIRED. Both strategies played the same week of the same season off the
 * same pool, so the only thing that differs is the judgement — which is what makes a
 * paired test legitimate here and an unpaired one nonsense.
 */

const args = process.argv.slice(2)
const pick = (flag: string): string | null =>
	args.find(a => a.startsWith(`--${flag}=`))?.slice(flag.length + 3) ?? null

interface Result {
	ranAt: string
	seasons: number[]
	movesPerWeek: number
	weeks: number
	statcast: string
	oracle?: number
	totals: Record<string, number>
	byWeek: Record<string, number[]>
}

/** The newest run, unless one is named. A file, not a glob: pooling two runs that
 *  swept different knobs is the mistake `verdict.ts` documents at length. */
const file =
	pick("file") ??
	readdirSync("data/results")
		.filter(f => f.endsWith(".json"))
		.map(f => ({ f, at: JSON.parse(readFileSync(`data/results/${f}`, "utf8")).ranAt as string }))
		.sort((a, b) => a.at.localeCompare(b.at))
		.at(-1)!.f

const run: Result = JSON.parse(readFileSync(file.includes("/") ? file : `data/results/${file}`, "utf8"))

/** Student's t, two-sided, via the regularised incomplete beta. Written out rather
 *  than approximated: a normal approximation at n=111 is close, and "close" is how a
 *  borderline p gets reported as a result. */
const logGamma = (x: number): number => {
	const c = [
		76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
		0.1208650973866179e-2, -0.5395239384953e-5
	]
	let y = x
	let tmp = x + 5.5
	tmp -= (x + 0.5) * Math.log(tmp)
	let ser = 1.000000000190015
	for (const ci of c) ser += ci / ++y
	return -tmp + Math.log((2.5066282746310005 * ser) / x)
}

const betacf = (a: number, b: number, x: number): number => {
	const FPMIN = 1e-300
	const qab = a + b
	const qap = a + 1
	const qam = a - 1
	let c = 1
	let d = 1 - (qab * x) / qap
	if (Math.abs(d) < FPMIN) d = FPMIN
	d = 1 / d
	let h = d
	for (let m = 1; m <= 300; m++) {
		const m2 = 2 * m
		let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
		d = 1 + aa * d
		if (Math.abs(d) < FPMIN) d = FPMIN
		c = 1 + aa / c
		if (Math.abs(c) < FPMIN) c = FPMIN
		d = 1 / d
		h *= d * c
		aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
		d = 1 + aa * d
		if (Math.abs(d) < FPMIN) d = FPMIN
		c = 1 + aa / c
		if (Math.abs(c) < FPMIN) c = FPMIN
		d = 1 / d
		const del = d * c
		h *= del
		if (Math.abs(del - 1) < 3e-16) break
	}
	return h
}

const betai = (a: number, b: number, x: number): number => {
	if (x <= 0) return 0
	if (x >= 1) return 1
	const bt = Math.exp(
		logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x)
	)
	return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b
}

const tTest = (diffs: number[]): { t: number; p: number; mean: number; se: number } => {
	const n = diffs.length
	const mean = diffs.reduce((s, d) => s + d, 0) / n
	const varr = diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / (n - 1)
	const se = Math.sqrt(varr / n)
	if (!se) return { t: 0, p: 1, mean, se: 0 }
	const t = mean / se
	const df = n - 1
	return { t, p: betai(df / 2, 0.5, df / (df + t * t)), mean, se }
}

/** Exact two-sided binomial, ties excluded — the sign test's own definition. */
const signTest = (wins: number, losses: number): number => {
	const n = wins + losses
	if (!n) return 1
	const lnChoose = (a: number, b: number) => logGamma(a + 1) - logGamma(b + 1) - logGamma(a - b + 1)
	let tail = 0
	const k = Math.min(wins, losses)
	for (let i = 0; i <= k; i++) tail += Math.exp(lnChoose(n, i) - n * Math.LN2)
	return Math.min(1, 2 * tail)
}

/** Deterministic bootstrap: a seeded LCG, so the interval is the same next week.
 *  An interval that moves between runs is not evidence, it is weather. */
const bootstrap = (diffs: number[], reps = 20000): { lo: number; hi: number } => {
	let seed = 0x2545f491
	const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
	const means: number[] = []
	const n = diffs.length
	for (let r = 0; r < reps; r++) {
		let sum = 0
		for (let i = 0; i < n; i++) sum += diffs[Math.floor(rand() * n)]!
		means.push(sum / n)
	}
	means.sort((a, b) => a - b)
	return { lo: means[Math.floor(reps * 0.025)]!, hi: means[Math.floor(reps * 0.975)]! }
}

/** How strong a claim the three tests jointly license, in words a reader can act on. */
const verdict = (pSign: number, pT: number): string =>
	pSign < 0.01 && pT < 0.01 ? "SOLID"
	: pSign < 0.05 && pT < 0.05 ? "significant"
	: pT < 0.05 ? "margin-carried (t only)"
	: pSign < 0.05 ? "wins-carried (sign only)"
	: pT < 0.15 || pSign < 0.15 ? "suggestive"
	: "nothing"

const names = Object.keys(run.byWeek)
const focus = pick("vs") ?? names[0]!
const weeks = run.byWeek[focus]?.length ?? 0

console.log(
	`\n${file}\n${run.seasons.join(", ")} · ${weeks} paired weeks · ${run.movesPerWeek} moves/wk` +
		(run.oracle ? ` · ceiling ${run.oracle.toFixed(0)}` : "")
)
console.log(`\nTOTALS`)
for (const [n, total] of Object.entries(run.totals).sort((a, b) => b[1] - a[1]))
	console.log(
		`  ${n.padEnd(18)} ${total.toFixed(0).padStart(8)}` +
			(run.oracle ? `  ${((total / run.oracle) * 100).toFixed(1).padStart(5)}% of perfect` : "")
	)

console.log(`\n${focus} — PAIRED, against each opponent`)
console.log(
	`  ${"opponent".padEnd(18)} ${"W-L-T".padEnd(11)} ${"mean/wk".padStart(9)} ${"95% CI".padStart(17)}  ${"p(sign)".padStart(8)} ${"p(t)".padStart(8)}  verdict`
)
for (const other of names) {
	if (other === focus) continue
	const a = run.byWeek[focus]!
	const b = run.byWeek[other]!
	const n = Math.min(a.length, b.length)
	const diffs: number[] = []
	let w = 0
	let l = 0
	let tie = 0
	for (let i = 0; i < n; i++) {
		const d = Math.round((a[i]! - b[i]!) * 10) / 10
		diffs.push(d)
		if (d > 0) w++
		else if (d < 0) l++
		else tie++
	}
	const { p: pT, mean, se } = tTest(diffs)
	const pSign = signTest(w, l)
	const ci = bootstrap(diffs)
	console.log(
		`  ${other.padEnd(18)} ${`${w}-${l}-${tie}`.padEnd(11)} ` +
			`${mean >= 0 ? "+" : ""}${mean.toFixed(1).padStart(8)} ` +
			`${`[${ci.lo >= 0 ? "+" : ""}${ci.lo.toFixed(1)}, ${ci.hi >= 0 ? "+" : ""}${ci.hi.toFixed(1)}]`.padStart(17)}  ` +
			`${pSign.toFixed(4).padStart(8)} ${pT.toFixed(4).padStart(8)}  ${verdict(pSign, pT)}` +
			(se ? `` : ` (no spread)`)
	)
}
console.log()
