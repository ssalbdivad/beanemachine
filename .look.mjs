import { chromium } from "playwright-core"
const OUT="/tmp/claude-1000/-home-ssalb-beanemachine/06b459da-12cc-45a6-97dc-81da5f3e1212/scratchpad"
const b = await chromium.launch({ args: ["--no-sandbox"] })
for (const [w,h,tag] of [[1280,1000,"desk"],[390,844,"phone"]]) {
  for (const scheme of ["light","dark"]) {
    const p = await b.newPage({ viewport:{width:w,height:h}, colorScheme: scheme })
    await p.goto("http://127.0.0.1:5299/", { waitUntil:"networkidle" })
    await p.waitForSelector(".board-row", { timeout:30000 })
    await p.waitForTimeout(1200)
    await p.screenshot({ path:`${OUT}/v2-${tag}-${scheme}.png`, fullPage:false })
    const y = await p.evaluate(()=>{const r=document.querySelector(".board-row");return r?Math.round(r.getBoundingClientRect().top+window.scrollY):-1})
    if (scheme==="light") console.log(`${tag}: first ranked row at y=${y}`)
    await p.close()
  }
}
await b.close()
