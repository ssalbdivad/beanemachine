import { chromium } from "playwright-core"
import { readFileSync } from "node:fs"
const b = await chromium.launch({ executablePath: readFileSync("/tmp/bc-chrome.txt","utf8").trim(), args:["--no-sandbox"] })
const p = await b.newPage({ viewport:{width:1180,height:800}, deviceScaleFactor:2 })
await p.goto("file://" + process.cwd() + "/logo/sheet19.html")
await p.waitForTimeout(300)
await p.screenshot({ path:"logo/sheet19.png", fullPage:true })
await b.close()
console.log("rendered logo/sheet19.png")
