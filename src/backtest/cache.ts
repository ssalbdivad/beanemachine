import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Disk cache for backtest fetches, keyed by URL.
 *
 * Building the corpus is hundreds of requests across ten seasons; iterating on the
 * algorithm must not repeat them. With the cache warm an entire sweep runs offline
 * in seconds, which is what makes it practical to actually test ideas rather than
 * guess at them.
 */
const DIR = "data/backtest-cache"

export interface FetchStats {
	hits: number
	misses: number
}
export const stats: FetchStats = { hits: 0, misses: 0 }

const pathFor = (url: string) =>
	join(DIR, `${createHash("sha1").update(url).digest("hex")}.txt`)

let inFlight = 0
const QUEUE: (() => void)[] = []
const MAX_CONCURRENT = 6

/** Politeness: these are free public APIs, so cap concurrency and retry gently. */
const slot = async <T,>(fn: () => Promise<T>): Promise<T> => {
	if (inFlight >= MAX_CONCURRENT) await new Promise<void>(r => QUEUE.push(r))
	inFlight++
	try {
		return await fn()
	} finally {
		inFlight--
		QUEUE.shift()?.()
	}
}

export const cachedFetch = async (url: string, accept = "application/json"): Promise<string> => {
	if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true })
	const file = pathFor(url)
	if (existsSync(file)) {
		stats.hits++
		return readFileSync(file, "utf8")
	}
	stats.misses++
	return slot(async () => {
		let lastError: unknown
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const res = await fetch(url, { headers: { accept } })
				if (!res.ok) throw new Error(`HTTP ${res.status}`)
				const text = await res.text()
				writeFileSync(file, text)
				return text
			} catch (e) {
				lastError = e
				await new Promise(r => setTimeout(r, 400 * (attempt + 1)))
			}
		}
		throw new Error(`${url} failed: ${lastError}`)
	})
}
