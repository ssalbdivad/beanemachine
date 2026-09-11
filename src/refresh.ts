import { writeFileSync } from "node:fs"
import { gzipSync } from "node:zlib"
import { buildSnapshot } from "./data/snapshot.ts"

/** Refresh the data snapshot: nub src/refresh.ts */
const season = Number(process.argv.find(a => a.startsWith("--season="))?.slice(9) ?? 2026)
/* `sources` is returned BESIDE the snapshot rather than on it. It is provenance for
   whoever runs this command — 11 rows naming each upstream read and how many rows it
   answered with — and no screen renders it, so writing it into the file shipped 1,226
   bytes (464 gzipped) to every browser to be discarded. The reader's version of this
   table is the source table in docs/METHODOLOGY.md. */
const { snapshot, sources } = await buildSnapshot(season, new Date())
const path = "data/snapshot.json"
const text = JSON.stringify(snapshot)
writeFileSync(path, text)
const kb = Math.round(text.length / 1024)
// Both numbers, because the raw size is what the repo carries and the gzipped one is
// what a reader's connection actually pays. Level 9 is what a CDN precompresses at.
const gz = Math.round(gzipSync(Buffer.from(text), { level: 9 }).length / 1024)
console.log(
	`${path} · ${snapshot.players.length} players · ${kb} KB (${gz} KB gzipped)` +
		` · captured ${snapshot.capturedAt}`
)
for (const s of sources) console.log(`  ${String(s.rows).padStart(5)}  ${s.name}`)
