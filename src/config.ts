import { type } from "arktype"
import { readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Config, League } from "./schema.ts"

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
export const CONFIG_PATH = join(ROOT, "scoring.json")

export class ConfigError extends Error {}

/** Reads scoring.json and validates it against the ArkType schema. */
export const loadConfig = async (): Promise<Config> => {
	let raw: string
	try {
		raw = await readFile(CONFIG_PATH, "utf8")
	} catch {
		throw new ConfigError(`No scoring.json at ${CONFIG_PATH}.`)
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (e) {
		throw new ConfigError(`scoring.json isn't valid JSON: ${(e as Error).message}`)
	}
	const out = Config(parsed)
	if (out instanceof type.errors) throw new ConfigError(`scoring.json is invalid:\n${out}`)
	return out
}

/** Validates before writing, so an invalid config can never reach disk. */
export const saveConfig = async (config: Config): Promise<Config> => {
	const out = Config(config)
	if (out instanceof type.errors)
		throw new ConfigError(`Refusing to save an invalid config:\n${out}`)
	const tmp = `${CONFIG_PATH}.tmp`
	await writeFile(tmp, `${JSON.stringify(out, null, 2)}\n`)
	await rename(tmp, CONFIG_PATH)
	return out
}

export const validateLeague = (value: unknown): League => {
	const out = League(value)
	if (out instanceof type.errors) throw new ConfigError(`Invalid league:\n${out}`)
	return out
}
