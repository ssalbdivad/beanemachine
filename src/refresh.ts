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
const { snapshot, contact, sources } = await buildSnapshot(season, new Date())
/**
 * TWO files, because only one of them is on the critical path.
 *
 * Every byte of the snapshot is downloaded before the first ranked row can paint —
 * vite.config.ts's `prefetch-snapshot` asks for the whole file from the first byte of
 * markup, by design, because the ranking cannot start without it. The expected-stats
 * rows were 22.42% of those bytes (299,764 of 1,337,218; 48,743 of 180,667 gzipped at
 * level 9) and they steer no ranking: `model.json`'s `statcast.weight` is 0, so the
 * quality multiplier is 1 whether a row is present or absent. Measured rather than
 * argued — `rateAll` over the capture with the rows and without them agrees on
 * `bscore`, `points`, `addValue`, `replacement`, `slot` and the ranking itself for all
 * 1,446 rated players, and moves only the four fields that are ABOUT the rows.
 *
 * So they go beside it, in a file the browser asks for when a reader opens a
 * drill-down and otherwise never. Splitting is the only change: recombining the two
 * reproduces the previous capture byte for byte, and `hydrate` over the pair
 * deep-equals `hydrate` over the single file across 87,296 leaf values with every Map
 * walked by key type.
 */
const path = "data/snapshot.json"
const contactPath = "data/contact.json"
const text = JSON.stringify(snapshot)
const contactText = JSON.stringify(contact)
writeFileSync(path, text)
writeFileSync(contactPath, contactText)
// Both numbers, because the raw size is what the repo carries and the gzipped one is
// what a reader's connection actually pays. Level 9 is what a CDN precompresses at.
const size = (s: string) =>
	`${Math.round(s.length / 1024)} KB (${Math.round(gzipSync(Buffer.from(s), { level: 9 }).length / 1024)} KB gzipped)`
console.log(
	`${path} · ${snapshot.players.length} players · ${size(text)}` +
		` · captured ${snapshot.capturedAt}`
)
const rows =
	Object.keys(contact.underlying.hitting).length +
	Object.keys(contact.underlying.pitching).length
// Named as what it costs a reader and when: it is the one file here that is NOT
// fetched on the first paint, so printing its size beside the snapshot's without
// saying so would read as the critical path being bigger than it is.
console.log(`${contactPath} · ${rows} expected-stats rows · ${size(contactText)} · fetched on demand, not at first paint`)
for (const s of sources) console.log(`  ${String(s.rows).padStart(5)}  ${s.name}`)
