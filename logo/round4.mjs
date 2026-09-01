// Round 4: refine the two survivors — the "core bot" (beanball as its chest core,
// Blitzcrank-chunky shoulders) and the head-only bust that has to work as a favicon.
import { writeFileSync } from "node:fs"
const INK = "var(--ink)", ACC = "var(--acc)"
const c = []
const add = (n, body, note = "") => c.push({ n: `${String(c.length + 1).padStart(2, "0")} ${n}`, body, note })

const P = (d, w = 3.6, col = INK) =>
  `<path d="${d}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`
const rr = (x, y, w, h, r, sw = 3.6, fill = "none", col = INK) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${col}" stroke-width="${sw}"/>`
const ci = (x, y, r, sw = 3.6, fill = "none", col = INK) =>
  `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${col}" stroke-width="${sw}"/>`
const dot = (x, y, r, col = INK) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${col}"/>`
const beanball = (cx, cy, r, sw = 3.2) =>
  ci(cx, cy, r, sw) + P(`M${cx} ${cy - r} C ${cx - r * 0.85} ${cy - r * 0.45}, ${cx + r * 0.85} ${cy + r * 0.45}, ${cx} ${cy + r}`, sw, ACC)

const spec = {
  goggle: (lx, rx, y, r) =>
    ci(lx, y, r, 3.6, "var(--lens)", ACC) + ci(rx, y, r, 3.6, "var(--lens)", ACC) +
    P(`M${lx + r} ${y} h${rx - lx - 2 * r}`, 3.4, ACC) + dot(lx, y, r * 0.4) + dot(rx, y, r * 0.4),
  round: (lx, rx, y, r) =>
    ci(lx, y, r, 3, "var(--lens)", ACC) + ci(rx, y, r, 3, "var(--lens)", ACC) +
    P(`M${lx + r} ${y} h${rx - lx - 2 * r}`, 2.8, ACC) + dot(lx, y, r * 0.38) + dot(rx, y, r * 0.38),
  square: (lx, rx, y, r) =>
    rr(lx - r, y - r * 0.86, r * 2, r * 1.72, 3.5, 3.4, "var(--lens)", ACC) +
    rr(rx - r, y - r * 0.86, r * 2, r * 1.72, 3.5, 3.4, "var(--lens)", ACC) +
    P(`M${lx + r} ${y} h${rx - lx - 2 * r}`, 3.2, ACC) + dot(lx, y, r * 0.38) + dot(rx, y, r * 0.38)
}
const head = {
  boxy: () => rr(26, 12, 36, 27, 10),
  dome: () => P("M26 33 v-9 a18 14 0 0 1 36 0 v9 a6 6 0 0 1 -6 6 h-24 a6 6 0 0 1 -6 -6 z"),
  round: () => ci(44, 25.5, 18)
}
const arms = {
  // chunky shoulder blocks — the Blitzcrank read
  pads: () => rr(8, 46, 13, 17, 6) + rr(67, 46, 13, 17, 6) + P("M21 54 h2") + P("M67 54 h-2"),
  // stubby bent arms
  stubby: () => P("M22 50 h-7 a5 5 0 0 0 -5 5 v7", 4) + P("M66 50 h7 a5 5 0 0 1 5 5 v7", 4),
  // one arm up holding the bean aloft
  wave: () => P("M22 50 h-7 a5 5 0 0 0 -5 5 v6", 4) + P("M66 52 l8 -6 a5 5 0 0 1 6 8", 4)
}
const feet = () => rr(27, 74, 13, 8, 4) + rr(48, 74, 13, 8, 4)
const antenna = (x, y) => P(`M${x} ${y} v-6`, 3.4) + dot(x, y - 8.5, 3.4, ACC)

/* A. core bot — the beanball is its chest */
for (const hk of ["boxy", "dome", "round"])
  for (const gk of ["goggle", "round"])
    for (const ak of ["pads", "stubby"])
      add(`corebot-${hk}-${gk}-${ak}`,
        `${antenna(44, 12)}${head[hk]()}${spec[gk](36, 52, 25, 6.6)}${P("M40 33.5 q4 3.5 8 0", 3, INK)}
         ${rr(22, 42, 44, 32, 13)}${beanball(44, 58, 11)}${arms[ak]()}${feet()}`,
        `${hk} head · ${gk} specs · ${ak} arms`)

/* B. core bot holding the bean up instead */
for (const hk of ["boxy", "round"])
  add(`hoist-${hk}`,
    `${antenna(40, 12)}${head[hk]()}${spec.goggle(32, 48, 25, 6.6)}${P("M36 33.5 q4 3.5 8 0", 3, INK)}
     ${rr(22, 42, 40, 32, 13)}${dot(42, 58, 4, ACC)}${ci(42, 58, 8, 3)}
     ${P("M62 50 l9 -7 a5 5 0 0 1 6 8", 4)}${beanball(78, 34, 10)}${feet()}`,
    `${hk} · holding the bean aloft`)

/* C. head-only bust — the favicon workhorse */
for (const hk of ["boxy", "dome", "round"])
  for (const gk of ["goggle", "round", "square"])
    add(`bust-${hk}-${gk}`,
      `${antenna(44, 14)}
       ${hk === "boxy" ? rr(20, 14, 48, 36, 13) : hk === "round" ? ci(44, 32, 24) : P("M20 44 v-12 a24 19 0 0 1 48 0 v12 a7 7 0 0 1 -7 7 h-34 a7 7 0 0 1 -7 -7 z")}
       ${spec[gk](34, 56, 30, 9)}${P("M38 42 q6 5 12 0", 3.2, INK)}
       ${P("M20 34 h-6", 3.4)}${P("M68 34 h6", 3.4)}`,
      `bust · ${hk} · ${gk}`)

/* D. bust cradling the bean (analysis, still compact) */
for (const gk of ["goggle", "round"])
  add(`bust-bean-${gk}`,
    `${antenna(40, 14)}${rr(18, 14, 44, 34, 12)}${spec[gk](31, 51, 29, 8.4)}${P("M35 40 q5 4.5 10 0", 3.2, INK)}
     ${P("M62 38 a6 6 0 0 1 6 6", 3.4)}${beanball(72, 52, 11)}`,
    `bust + bean · ${gk}`)

const cell = ({ n, body, note }) => `
  <figure>
    <svg viewBox="0 0 88 88" width="122" height="122">${body}</svg>
    <div class="small">
      <svg viewBox="0 0 88 88" width="32" height="32">${body}</svg>
      <svg viewBox="0 0 88 88" width="20" height="20">${body}</svg>
      <svg viewBox="0 0 88 88" width="16" height="16">${body}</svg>
    </div>
    <figcaption>${n}<br><i>${note}</i></figcaption>
  </figure>`

writeFileSync("logo/sheet4.html", `<!doctype html><meta charset="utf-8">
<style>
:root{--ink:#191c1f;--acc:#2f7d5b;--lens:#e8f1ec}
body{margin:0;background:#faf8f3;font:12px ui-sans-serif,system-ui;color:#6f6a61}
.grid{display:grid;grid-template-columns:repeat(6,1fr);gap:7px;padding:16px}
figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:4px;
  background:#fffdf9;border:1px solid #e5e0d5;border-radius:10px;padding:9px 4px}
.small{display:flex;align-items:center;gap:9px}
figcaption{font-size:9.5px;text-align:center;line-height:1.3}
i{color:#a09a8e;font-size:8.5px}
</style>
<div class="grid">${c.map(cell).join("")}</div>`)
writeFileSync("logo/candidates4.json", JSON.stringify(c, null, 1))
console.log(`round 4: ${c.length} candidates`)
