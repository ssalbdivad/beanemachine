import { chromium } from "playwright-core"
const OUT="/tmp/claude-1000/-home-ssalb-beanemachine/06b459da-12cc-45a6-97dc-81da5f3e1212/scratchpad"
const b = await chromium.launch({ args: ["--no-sandbox"] })
const p = await b.newPage({ viewport: { width: 390, height: 844 } })
await p.goto("http://127.0.0.1:5299/", { waitUntil: "networkidle" })
await p.waitForSelector(".board-row", { timeout: 30000 })
const tabs = await p.$$eval(".views button", n => n.map(e => e.textContent))
console.log("tabs:", tabs.join(" | "))
for (let i=0;i<tabs.length;i++){
  await p.click(`.views button:nth-child(${i+1})`); await p.waitForTimeout(1500)
  const h = await p.evaluate(()=>document.documentElement.scrollHeight)
  const w = await p.evaluate(()=>document.body.innerText.split(/\s+/).filter(Boolean).length)
  console.log(`${tabs[i]}: ${h}px  ${w} words`)
}
await b.close()
