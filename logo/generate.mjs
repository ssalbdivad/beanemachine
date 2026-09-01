// Explores the beanemachine logo space: robot × bean × baseball × analysis.
// Primitives are combined into candidates, rendered to a contact sheet, and judged by eye.
import { writeFileSync } from "node:fs"

const INK = "var(--ink)", ACC = "var(--acc)", SOFT = "var(--soft)"
const S = (d, extra = "") => `<path d="${d}" fill="none" stroke="${INK}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`
const A = (d, extra = "") => `<path d="${d}" fill="none" stroke="${ACC}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`

/* ---- primitives ---- */
// a baseball: circle plus the two facing seams
const ball = (cx, cy, r, sw = 3.2, seam = ACC) => `
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${INK}" stroke-width="${sw}"/>
  <path d="M${cx - r * 0.66} ${cy - r * 0.75} C ${cx - r * 0.2} ${cy - r * 0.35}, ${cx - r * 0.2} ${cy + r * 0.35}, ${cx - r * 0.66} ${cy + r * 0.75}"
        fill="none" stroke="${seam}" stroke-width="${sw}" stroke-linecap="round"/>
  <path d="M${cx + r * 0.66} ${cy - r * 0.75} C ${cx + r * 0.2} ${cy - r * 0.35}, ${cx + r * 0.2} ${cy + r * 0.35}, ${cx + r * 0.66} ${cy + r * 0.75}"
        fill="none" stroke="${seam}" stroke-width="${sw}" stroke-linecap="round"/>`

// a kidney bean, a few readings of the same idea
const beans = {
  kidney: "M40 14 C50 14 54 24 54 32 C54 43 45 51 34 51 C23 51 14 44 14 34 C14 26 20 20 26 20 C31 20 32 24 30 28 C28 32 30 36 34 36 C39 36 40 30 38 24 C37 19 37 14 40 14 Z",
  plump: "M38 13 C50 13 55 23 55 33 C55 44 46 52 34 52 C22 52 12 44 12 33 C12 23 20 16 28 16 C33 16 34 21 32 26 C30 31 33 35 37 34 C42 33 42 26 40 20 C39 15 36 13 38 13 Z",
  simple: "M32 13 C46 13 54 22 54 33 C54 44 45 51 33 51 C21 51 11 44 11 33 C11 23 19 15 29 15"
}

/* ---- candidate families ---- */
const c = []
const add = (name, body, note) => c.push({ n: `${String(c.length + 1).padStart(2, "0")} ${name}`, body, note })

// A. robot head, baseball face
for (const [i, r] of [10, 12, 14].entries())
  add(`head-ball-${i}`, `
    ${S("M18 16 h28 a6 6 0 0 1 6 6 v20 a6 6 0 0 1 -6 6 h-28 a6 6 0 0 1 -6 -6 v-20 a6 6 0 0 1 6 -6 z")}
    ${S("M32 16 v-6")}${A("M32 8 m-3 0 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0")}
    ${ball(32, 32, r, 2.6)}`)

// B. magnifier over a bean
for (const [k, d] of Object.entries(beans))
  add(`lens-bean-${k}`, `
    <path d="${d}" fill="none" stroke="${INK}" stroke-width="3.2" stroke-linejoin="round"/>
    <circle cx="38" cy="28" r="15" fill="none" stroke="${ACC}" stroke-width="3.2"/>
    ${A("M49 39 L58 49")}`)

// C. bean with circuit traces
for (const [k, d] of Object.entries(beans))
  add(`circuit-bean-${k}`, `
    <path d="${d}" fill="none" stroke="${INK}" stroke-width="3.2" stroke-linejoin="round"/>
    ${A("M22 32 h10 v-8 h10")}${A("M26 42 h14 v-6")}
    <circle cx="44" cy="24" r="3" fill="${ACC}"/><circle cx="40" cy="36" r="3" fill="${ACC}"/>`)

// D. robot eye whose iris is a baseball
for (const [i, w] of [22, 26, 30].entries())
  add(`eye-ball-${i}`, `
    ${S(`M${32 - w} 32 C ${32 - w * 0.5} ${32 - w * 0.62}, ${32 + w * 0.5} ${32 - w * 0.62}, ${32 + w} 32 C ${32 + w * 0.5} ${32 + w * 0.62}, ${32 - w * 0.5} ${32 + w * 0.62}, ${32 - w} 32 Z`)}
    ${ball(32, 32, 9, 2.6)}`)

// E. scanner sweeping a baseball
for (const [i, y] of [22, 30, 38].entries())
  add(`scan-${i}`, `
    ${ball(32, 34, 16, 3.2, INK)}
    ${A(`M8 ${y} h48`)}
    ${A("M12 12 h8 M12 12 v8 M52 12 h-8 M52 12 v8")}`)

// F. bean-shaped robot head with antenna + eyes
for (const [k, d] of Object.entries(beans))
  add(`bot-bean-${k}`, `
    <path d="${d}" fill="none" stroke="${INK}" stroke-width="3.2" stroke-linejoin="round"/>
    <circle cx="27" cy="31" r="3.4" fill="${ACC}"/><circle cx="41" cy="31" r="3.4" fill="${ACC}"/>
    ${S("M33 13 v-5")}<circle cx="33" cy="6" r="3" fill="${ACC}"/>`)

// G. calipers measuring a baseball
for (const [i, g] of [17, 20, 23].entries())
  add(`caliper-${i}`, `
    ${ball(32, 34, 15, 3.2, INK)}
    ${A(`M${32 - g} 12 v40`)}${A(`M${32 + g} 12 v40`)}
    ${A(`M${32 - g} 12 h6`)}${A(`M${32 + g} 12 h-6`)}`)

// H. baseball rising out of a bar chart
for (const [i, h] of [[10, 18, 26], [8, 20, 30], [12, 16, 22]].entries())
  add(`bars-ball-${i}`, `
    ${S(`M14 52 v-${h[0]}`)}${S(`M24 52 v-${h[1]}`)}${S(`M34 52 v-${h[2]}`)}
    ${ball(46, 22, 11, 2.8)}`)

// I. rounded-square bot, seam mouth
for (const [i, m] of [0.5, 0.8, 1.1].entries())
  add(`seam-mouth-${i}`, `
    ${S("M16 14 h32 a6 6 0 0 1 6 6 v24 a6 6 0 0 1 -6 6 h-32 a6 6 0 0 1 -6 -6 v-24 a6 6 0 0 1 6 -6 z")}
    <circle cx="24" cy="28" r="3.4" fill="${ACC}"/><circle cx="40" cy="28" r="3.4" fill="${ACC}"/>
    ${A(`M22 39 C 27 ${39 + 5 * m}, 37 ${39 + 5 * m}, 42 39`)}`)

// J. bean inside a bracket (analysis framing)
for (const [k, d] of Object.entries(beans))
  add(`bracket-bean-${k}`, `
    <path d="${d}" fill="none" stroke="${INK}" stroke-width="3.2" stroke-linejoin="round" transform="scale(.82) translate(7 7)"/>
    ${A("M12 14 h-6 v36 h6")}${A("M52 14 h6 v36 h-6")}`)

// K. robot head made of two seams (minimal mark)
for (const [i, sp] of [8, 11, 14].entries())
  add(`twin-seam-${i}`, `
    ${S(`M${32 - sp} 14 C ${32 - sp + 7} 24, ${32 - sp + 7} 40, ${32 - sp} 50`)}
    ${S(`M${32 + sp} 14 C ${32 + sp - 7} 24, ${32 + sp - 7} 40, ${32 + sp} 50`)}
    <circle cx="32" cy="32" r="4" fill="${ACC}"/>`)

// L. bot peering through a lens at a bean
for (const [i, r] of [12, 14, 16].entries())
  add(`bot-lens-${i}`, `
    ${S("M8 20 h16 a4 4 0 0 1 4 4 v16 a4 4 0 0 1 -4 4 h-16 a4 4 0 0 1 -4 -4 v-16 a4 4 0 0 1 4 -4 z")}
    <circle cx="12" cy="32" r="2.6" fill="${ACC}"/><circle cx="20" cy="32" r="2.6" fill="${ACC}"/>
    <circle cx="46" cy="32" r="${r}" fill="none" stroke="${ACC}" stroke-width="3.2"/>
    ${S("M46 26 c4 0 6 3 6 6 c0 4 -3 6 -7 6 c-4 0 -7 -3 -7 -6 c0 -3 2 -4 4 -4")}`)

// M. abacus / counter bead + seam
for (const [i, n] of [2, 3, 4].entries())
  add(`counter-${i}`, `
    ${S("M12 16 v32")}${S("M52 16 v32")}
    ${Array.from({ length: n }, (_, j) => S(`M12 ${22 + j * 9} h40`)).join("")}
    ${Array.from({ length: n }, (_, j) => `<circle cx="${22 + j * 10}" cy="${22 + j * 9}" r="4" fill="${ACC}"/>`).join("")}`)

// N. hexagonal bot head with baseball eye
for (const [i, e] of [7, 9, 11].entries())
  add(`hex-bot-${i}`, `
    ${S("M32 10 L52 21 V43 L32 54 L12 43 V21 Z")}
    ${ball(32, 32, e, 2.6)}`)

// O. seam that doubles as a data curve
for (const [i, k] of [0.6, 0.9, 1.2].entries())
  add(`seam-curve-${i}`, `
    ${S("M10 46 C 22 46, 26 20, 38 20 C 48 20, 52 32, 56 36")}
    ${A(`M18 ${44 - 6 * k} c4 4 4 8 0 12`)}${A(`M30 ${28 - 4 * k} c4 4 4 8 0 12`)}
    <circle cx="52" cy="34" r="4" fill="${ACC}"/>`)

// P. bean + antenna, ultra-minimal
add("min-bean-antenna", `
  <path d="${beans.simple}" fill="none" stroke="${INK}" stroke-width="3.4" stroke-linecap="round"/>
  ${A("M44 16 l6 -8")}<circle cx="51" cy="7" r="3" fill="${ACC}"/>`)
add("min-ball-antenna", `${ball(32, 36, 16, 3.2)}${S("M32 20 v-8")}<circle cx="32" cy="9" r="3.4" fill="${ACC}"/>`)
add("bean-in-ball", `${ball(32, 32, 20, 2.8, INK)}<path d="${beans.simple}" fill="none" stroke="${ACC}" stroke-width="3" transform="scale(.52) translate(29 29)"/>`)
add("chip-bean", `
  ${S("M20 20 h24 v24 h-24 z")}
  ${A("M20 26 h-8 M20 32 h-8 M20 38 h-8 M44 26 h8 M44 32 h8 M44 38 h8")}
  <path d="${beans.simple}" fill="none" stroke="${ACC}" stroke-width="3" transform="scale(.44) translate(28 28)"/>`)
add("visor-bot", `
  ${S("M12 18 h40 a4 4 0 0 1 4 4 v20 a4 4 0 0 1 -4 4 h-40 a4 4 0 0 1 -4 -4 v-20 a4 4 0 0 1 4 -4 z")}
  ${A("M16 32 h12")}${ball(42, 32, 8, 2.6)}`)

/* ---- contact sheet ---- */
const cell = ({ n, body }) => `
  <figure>
    <svg viewBox="0 0 64 64" width="96" height="96">${body}</svg>
    <figcaption>${n}</figcaption>
  </figure>`

writeFileSync("logo/sheet.html", `<!doctype html><meta charset="utf-8">
<style>
:root{--ink:#191c1f;--acc:#2f7d5b;--soft:#e8f1ec}
body{margin:0;background:#faf8f3;font:12px ui-sans-serif,system-ui;color:#6f6a61}
.grid{display:grid;grid-template-columns:repeat(10,1fr);gap:4px 0;padding:16px}
figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:2px;
  background:#fffdf9;border:1px solid #e5e0d5;border-radius:8px;padding:6px 2px}
figcaption{font-size:9px;letter-spacing:.01em;text-align:center}
</style>
<div class="grid">${c.map(cell).join("")}</div>`)

writeFileSync("logo/candidates.json", JSON.stringify(c, null, 2))
console.log(`generated ${c.length} candidates`)
