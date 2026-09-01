// Round 2. Round 1 taught us:
//  - the kidney-bean paths read as spirals -> drop them
//  - the strongest directions were: eye+ball, bot head+ball, ball+antenna, calipers
//  - and the key insight: a coffee bean's crease IS a baseball seam. One S-curve,
//    both readings. That hybrid is the mark.
import { writeFileSync } from "node:fs"
const INK = "var(--ink)", ACC = "var(--acc)"
const c = []
const add = (n, body, note = "") => c.push({ n: `${String(c.length + 1).padStart(2, "0")} ${n}`, body, note })

// the hybrid: a circle (baseball) or ellipse (bean) split by one S crease
const crease = (cx, cy, rx, ry, w = 3.2, col = ACC) =>
  `<path d="M${cx - rx * 0.02} ${cy - ry} C ${cx - rx * 0.85} ${cy - ry * 0.45}, ${cx + rx * 0.85} ${cy + ry * 0.45}, ${cx + rx * 0.02} ${cy + ry}"
     fill="none" stroke="${col}" stroke-width="${w}" stroke-linecap="round"/>`
const seams = (cx, cy, r, w = 3, col = ACC) => `
  <path d="M${cx - r * 0.62} ${cy - r * 0.78} C ${cx - r * 0.18} ${cy - r * 0.36}, ${cx - r * 0.18} ${cy + r * 0.36}, ${cx - r * 0.62} ${cy + r * 0.78}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linecap="round"/>
  <path d="M${cx + r * 0.62} ${cy - r * 0.78} C ${cx + r * 0.18} ${cy - r * 0.36}, ${cx + r * 0.18} ${cy + r * 0.36}, ${cx + r * 0.62} ${cy + r * 0.78}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linecap="round"/>`
const S = (d, w = 3.2, col = INK) => `<path d="${d}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`
const dot = (x, y, r = 3.2, col = ACC) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${col}"/>`
const ring = (x, y, r, w = 3.2, col = INK) => `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${col}" stroke-width="${w}"/>`

/* A. the beanball: one shape, both readings */
for (const [i, ry] of [20, 17, 14].entries())
  add(`beanball-${i}`, `${ring(32, 32, 20)}${crease(32, 32, 20, ry)}`, "circle + single crease")
for (const [i, rx] of [21, 18, 15].entries())
  add(`beanball-oval-${i}`, `<ellipse cx="32" cy="32" rx="${rx}" ry="20" fill="none" stroke="${INK}" stroke-width="3.2"/>${crease(32, 32, rx, 20)}`, "ellipse reads more bean")

/* B. beanball as a robot head: antenna + eyes */
for (const [i, a] of [[32, 8], [44, 12], [20, 12]].entries())
  add(`beanbot-antenna-${i}`, `
    ${ring(32, 34, 19)}${crease(32, 34, 19, 17)}
    ${S(`M${a[0]} ${a[1] + 6} L${a[0]} ${a[1]}`)}${dot(a[0], a[1] - 1, 3)}`)
for (const [i, e] of [5, 7, 9].entries())
  add(`beanbot-eyes-${i}`, `
    ${ring(32, 32, 20)}${crease(32, 32, 20, 18, 3.2, "var(--faint)")}
    ${dot(32 - e, 28, 3.2)}${dot(32 + e, 28, 3.2)}
    ${S("M26 40 C 29 43, 35 43, 38 40", 3, ACC)}`)

/* C. machine eye reading a beanball  (round-1 favourite, refined) */
for (const [i, w] of [24, 27, 30].entries())
  add(`eye-${i}`, `
    ${S(`M${32 - w} 32 C ${32 - w * 0.5} ${32 - w * 0.6}, ${32 + w * 0.5} ${32 - w * 0.6}, ${32 + w} 32 C ${32 + w * 0.5} ${32 + w * 0.6}, ${32 - w * 0.5} ${32 + w * 0.6}, ${32 - w} 32 Z`)}
    ${ring(32, 32, 10, 3)}${crease(32, 32, 10, 9)}`)
for (const [i, r] of [9, 11].entries())
  add(`eye-seam-${i}`, `
    ${S("M4 32 C 14 18, 50 18, 60 32 C 50 46, 14 46, 4 32 Z")}
    ${ring(32, 32, r, 3)}${seams(32, 32, r, 2.6)}`)

/* D. bot head framing a beanball */
for (const [i, k] of [[6, 18], [8, 16], [4, 20]].entries())
  add(`head-${i}`, `
    ${S(`M14 14 h36 a${k[0]} ${k[0]} 0 0 1 ${k[0]} ${k[0]} v20 a${k[0]} ${k[0]} 0 0 1 -${k[0]} ${k[0]} h-36 a${k[0]} ${k[0]} 0 0 1 -${k[0]} -${k[0]} v-20 a${k[0]} ${k[0]} 0 0 1 ${k[0]} -${k[0]} z`)}
    ${S("M32 14 v-6")}${dot(32, 6, 3)}
    ${ring(32, 34, k[1] * 0.52, 2.8)}${crease(32, 34, k[1] * 0.52, k[1] * 0.47)}`)

/* E. lens / scanner reading a beanball */
for (const [i, r] of [15, 17].entries())
  add(`lens-${i}`, `
    ${ring(30, 29, r, 3.2)}${S(`M${30 + r * 0.72} ${29 + r * 0.72} L54 53`, 3.6)}
    ${ring(30, 29, r * 0.52, 2.6, ACC)}${crease(30, 29, r * 0.52, r * 0.47, 2.6, ACC)}`)
for (const [i, y] of [[14, 50], [18, 46]].entries())
  add(`scan-${i}`, `
    ${ring(32, 32, 17)}${crease(32, 32, 17, 15, 3.2, "var(--faint)")}
    ${S(`M8 ${y[0]} v-4 h6 M56 ${y[0]} v-4 h-6 M8 ${y[1]} v4 h6 M56 ${y[1]} v4 h-6`, 3, ACC)}
    ${S("M10 32 h44", 3, ACC)}`)

/* F. calipers measuring a beanball */
for (const [i, g] of [20, 23].entries())
  add(`caliper-${i}`, `
    ${ring(32, 33, 16)}${crease(32, 33, 16, 14)}
    ${S(`M${32 - g} 13 v40 M${32 - g} 13 h5 M${32 - g} 53 h5`, 3, ACC)}
    ${S(`M${32 + g} 13 v40 M${32 + g} 13 h-5 M${32 + g} 53 h-5`, 3, ACC)}`)

/* G. minimal: beanball with an antenna, nothing else */
add("min-0", `${ring(32, 36, 17)}${crease(32, 36, 17, 15)}${S("M32 19 v-8")}${dot(32, 8, 3.4)}`)
add("min-1", `${ring(32, 36, 17)}${seams(32, 36, 17, 2.8)}${S("M32 19 v-8")}${dot(32, 8, 3.4)}`)
add("min-2", `${ring(32, 34, 18)}${crease(32, 34, 18, 16)}${S("M46 20 l7 -7", 3)}${dot(54, 11, 3.4)}`)

/* H. beanball + counting marks (the "counter" half of the name) */
for (const [i, n] of [3, 4].entries())
  add(`count-${i}`, `
    ${ring(38, 32, 16)}${crease(38, 32, 16, 14)}
    ${Array.from({ length: n }, (_, j) => S(`M${8 + j * 4} ${44 - j * 2} v${8 + j * 4}`, 3, ACC)).join("")}`)

/* I. two beanballs = the "machine" reading pairs (stat comparison) */
add("pair-0", `${ring(22, 32, 13)}${crease(22, 32, 13, 12)}${ring(44, 32, 13, 3.2, "var(--faint)")}${crease(44, 32, 13, 12, 3.2, "var(--faint)")}`)
add("pair-1", `${ring(24, 26, 12)}${crease(24, 26, 12, 11)}${ring(40, 40, 12)}${crease(40, 40, 12, 11)}`)

const cell = ({ n, body, note }) => `
  <figure>
    <div class="big"><svg viewBox="0 0 64 64" width="104" height="104">${body}</svg></div>
    <div class="small">
      <svg viewBox="0 0 64 64" width="28" height="28">${body}</svg>
      <svg viewBox="0 0 64 64" width="18" height="18">${body}</svg>
    </div>
    <figcaption>${n}<br><i>${note}</i></figcaption>
  </figure>`

writeFileSync("logo/sheet2.html", `<!doctype html><meta charset="utf-8">
<style>
:root{--ink:#191c1f;--acc:#2f7d5b;--faint:#b9b2a5}
body{margin:0;background:#faf8f3;font:12px ui-sans-serif,system-ui;color:#6f6a61}
.grid{display:grid;grid-template-columns:repeat(8,1fr);gap:6px;padding:16px}
figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:4px;
  background:#fffdf9;border:1px solid #e5e0d5;border-radius:10px;padding:8px 4px}
.small{display:flex;align-items:center;gap:8px;opacity:.85}
figcaption{font-size:9.5px;text-align:center;line-height:1.3}
i{color:#a09a8e;font-size:8.5px}
</style>
<div class="grid">${c.map(cell).join("")}</div>`)
writeFileSync("logo/candidates2.json", JSON.stringify(c, null, 1))
console.log(`round 2: ${c.length} candidates`)
