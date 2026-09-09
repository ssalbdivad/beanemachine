import { type } from "arktype"
import { readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Config } from "./schema.ts"

/**
 * scoring.json on disk. The app no longer reads or writes it — leagues live in
 * the browser's storage — so this is the offline path: `nub run import` writes
 * the committed file, which is also what seeds a browser that has nothing stored.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

/**
 * Where scoring.json lives, and the caller decides.
 *
 * This module held its own `CONFIG_PATH` fixed at the package root while
 * `src/cli.ts` computed a different one and printed THAT to the reader. Inside a
 * clone the two agree, which is why nothing noticed for as long as the only way to
 * run this was from a clone. Through `npx` they do not: the package root is a hashed
 * directory under `~/.npm/_npx`, so the file was written somewhere nobody would find
 * it while the last line of output confidently named the working directory.
 *
 * Verified by running the published command in an empty directory and looking at
 * what was in it afterwards, which was nothing.
 */
export const defaultConfigPath = join(ROOT, "scoring.json")

export class ConfigError extends Error {}

/** Reads scoring.json and validates it against the ArkType schema. */
export const loadConfig = async (path: string = defaultConfigPath): Promise<Config> => {
	let raw: string
	try {
		raw = await readFile(path, "utf8")
	} catch {
		throw new ConfigError(`No scoring.json at ${path}.`)
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
export const saveConfig = async (
	config: Config,
	path: string = defaultConfigPath
): Promise<Config> => {
	const out = Config(config)
	if (out instanceof type.errors)
		throw new ConfigError(`Refusing to save an invalid config:\n${out}`)
	const tmp = `${path}.tmp`
	await writeFile(tmp, `${JSON.stringify(out, null, 2)}\n`)
	await rename(tmp, path)
	return out
}
