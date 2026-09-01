import { writeFileSync } from "node:fs"
import { buildSnapshot } from "./data/snapshot.ts"

/** Refresh the data snapshot: nub src/refresh.ts */
const season = Number(process.argv.find(a => a.startsWith("--season="))?.slice(9) ?? 2026)
const snapshot = await buildSnapshot(season, new Date())
const path = "data/snapshot.json"
writeFileSync(path, JSON.stringify(snapshot))
const kb = Math.round(JSON.stringify(snapshot).length / 1024)
console.log(`${path} · ${snapshot.players.length} players · ${kb} KB · captured ${snapshot.capturedAt}`)
for (const s of snapshot.sources) console.log(`  ${String(s.rows).padStart(5)}  ${s.name}`)
