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
