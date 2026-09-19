// RUN `node logo/build-pick.mjs` FIRST. It writes logo/pick.html, which this file
// screenshots; neither is in the repo any more.
//
// pick.html used to be committed — 250,107 bytes, 296 lines, 55% of everything tracked
// under logo/ (451,858 bytes total). It was pure build output: on 2026-09-19 the committed
// copy was diffed against a fresh `node logo/build-pick.mjs` and the two were byte-identical,
// so the repo was carrying a quarter of a megabyte that one command reproduces exactly.
// Its siblings were already treated that way — .gitignore ignores logo/sheet*.html and
// logo/pick.png — and pick.html escaped only because the pattern is `sheet*`, not `pick*`.
// logo/finalists.json is NOT build output: nothing writes it, it is the hand-curated
// shortlist, and it stays.
import { chromium } from "playwright-core"
import { readFileSync, writeFileSync } from "node:fs"
const b = await chromium.launch({ executablePath: readFileSync("/tmp/bc-chrome.txt","utf8").trim(), args:["--no-sandbox"] })
// wrap the fragment the way the Artifact host does
writeFileSync("logo/.preview.html", `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}img{max-width:100%}</style></head><body>${readFileSync("logo/pick.html","utf8")}</body></html>`)
const p = await b.newPage({ viewport:{width:1120,height:1200}, deviceScaleFactor:2 })
await p.goto("file://" + process.cwd() + "/logo/.preview.html")
await p.waitForTimeout(1200)
await p.screenshot({ path:"logo/pick.png", fullPage:true })
await b.close()
console.log("ok")
