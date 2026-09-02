import { type } from "arktype"
import raw from "../../model.json" with { type: "json" }

/**
 * The tunable surface of the model, loaded from `model.json` and validated at
 * import time.
 *
 * Weights live in data rather than in code so that iterating on the algorithm is
 * editing one file, and so that what the model believes can be diffed, reviewed
 * and reverted on its own. Validation is not ceremony: a typo in a weight is
 * silent otherwise — it produces a plausible-looking recommendation built on a
 * number nobody chose.
 */
const SideWeights = type({ hitting: "number", pitching: "number" })
const Clamp = type({ min: "number", max: "number" })
const Why = type("string[]")

export const ModelWeights = type({
	version: "number",
	about: Why,
	recentForm: {
		volumeWeight: "0 <= number <= 1",
		blend: SideWeights,
		rate: SideWeights,
		windows: { hitting: { "[string]": "number" }, pitching: { "[string]": "number" } },
		why: Why
	},
	statcast: {
		weight: "0 <= number <= 1",
		lambda: { mode: "'rising' | 'falling' | 'fixed'", prior: "number > 0", cap: "0 <= number <= 1" },
		scope: "'wide' | 'battedBall'",
		clamp: Clamp,
		why: Why
	},
	matchup: { weight: "0 <= number <= 1", clamp: Clamp, why: Why },
	park: { weight: "0 <= number <= 1", clamp: Clamp, why: Why },
	shrinkage: { default: "number > 0", perStat: { "[string]": "number" }, why: Why }
})

export type ModelWeights = typeof ModelWeights.infer

/** Throws on import if model.json is malformed — better than a silent bad weight. */
export const MODEL: ModelWeights = ModelWeights.assert(raw)

/** Windows arrive from JSON keyed by string; the engine wants them keyed by days. */
export const windowsFor = (group: "hitting" | "pitching"): Record<number, number> =>
	Object.fromEntries(
		Object.entries(MODEL.recentForm.windows[group]).map(([d, w]) => [Number(d), w])
	)
