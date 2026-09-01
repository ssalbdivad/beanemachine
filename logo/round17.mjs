// Round 17: solve the monogram alone, at size, against the reference.
//
// What the measurements actually say (normalised 68 wide x 100 tall):
//   N stems at x 13.5 and 54.5 — the N is WIDE, spanning most of the box
//   Y tail at x 34 — the MIDPOINT BETWEEN the N's stems, not off to one side
//   Y arms rise from near the stem tops and converge on the tail
//   at y=12 only two elements are visible: the arms are hidden inside the N's stems
// Every previous attempt put the Y beside the N. It belongs on top of it.
import { readFileSync, writeFileSync } from "node:fs"
const REF = JSON.parse(readFileSync("logo/reference-ny.json", "utf8"))
const BLUE = "var(--mets-blue)", ORANGE = "var(--mets-orange)"
const c = []
const add = (n, body, note = "") => c.push({ n: `${String(c.length + 1).padStart(2, "0")} ${n}`, body, note })

// nL/nR: N stem x. nH: N height. cy: where the Y's arms converge. inset: how far in
// from the stem tops the Y's arms begin (0 = exactly on them).
const NY = ({ sw = 8, nL = 10, nR = 58, nH = 70, cy = 45, tail = 95, inset = 0 } = {}) => {
  const mid = (nL + nR) / 2
  return `<g stroke="${ORANGE}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M${nL} 0 V${nH}"/>
    <path d="M${nL} 0 L${nR} ${nH}"/>
    <path d="M${nR} 0 V${nH}"/>
    <path d="M${nL + inset} 0 L${mid} ${cy}"/>
    <path d="M${nR - inset} 0 L${mid} ${cy}"/>
    <path d="M${mid} ${cy} V${tail}"/>
  </g>`
}
const place = (px, py, h, o = {}) => {
  const sw = o.sw ?? 8, nL = o.nL ?? 10, nR = o.nR ?? 58, tail = o.tail ?? 95
  const w = nR - nL + sw, ht = tail + sw
  const s = h / ht
  return `<g transform="translate(${(px - (w * s) / 2 - (nL - sw / 2) * s).toFixed(2)} ${(py - h / 2 + (sw / 2) * s).toFixed(2)}) scale(${s.toFixed(4)})">${NY(o)}</g>`
}
const NY_BB = { x: 116.9, y: 37.5, w: 341.1, h: 500 }
const realNY = (px, py, h) => {
  const s = h / NY_BB.h
  return `<g transform="translate(${(px - s * (NY_BB.x + NY_BB.w / 2)).toFixed(2)} ${(py - s * (NY_BB.y + NY_BB.h / 2)).toFixed(2)}) scale(${s.toFixed(4)})"><path d="${REF.ny}" fill="${ORANGE}"/></g>`
}
const tile = (inner, size = 80) => `<rect x="0" y="0" width="${size}" height="${size}" fill="${BLUE}"/>${inner}`

add("REFERENCE", tile(realNY(40, 40, 64)), "the original")
add("base", tile(place(40, 40, 64)), "Y superimposed on the N, arms from the stem tops")
for (const inset of [6, 12])
  add(`inset-${inset}`, tile(place(40, 40, 64, { inset })), `Y arms start ${inset} in from the stems`)
for (const sw of [6, 10, 12])
  add(`sw-${sw}`, tile(place(40, 40, 64, { sw })), `stroke ${sw}`)
for (const cy of [38, 52])
  add(`conv-${cy}`, tile(place(40, 40, 64, { cy })), `arms converge at y=${cy}`)
for (const [nL, nR] of [[14, 54], [6, 62]])
  add(`width-${nR - nL}`, tile(place(40, 40, 64, { nL, nR })), `N stems ${nR - nL} apart`)
add("shorter-N", tile(place(40, 40, 64, { nH: 62 })), "N shorter, tail relatively longer")
add("best-guess", tile(place(40, 40, 64, { sw: 7, inset: 5, cy: 46, nL: 8, nR: 60 })), "combined")

const cell = ({ n, body, note }) => `<figure>
    <svg viewBox="0 0 80 80" width="150" height="150">${body}</svg>
    <div class="small">
      <svg viewBox="0 0 80 80" width="40" height="40">${body}</svg>
      <svg viewBox="0 0 80 80" width="24" height="24">${body}</svg>
      <svg viewBox="0 0 80 80" width="16" height="16">${body}</svg>
    </div>
    <figcaption>${n}<br><i>${note}</i></figcaption>
  </figure>`
writeFileSync("logo/sheet17.html", `<!doctype html><meta charset="utf-8">
<style>
:root{--mets-blue:#002d72;--mets-orange:#ff5910}
body{margin:0;background:#faf8f3;font:12px ui-sans-serif,system-ui;color:#6f6a61}
.grid{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;padding:16px}
figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:5px;
  background:#fffdf9;border:1px solid #e5e0d5;border-radius:10px;padding:10px 4px}
.small{display:flex;align-items:center;gap:10px}
figcaption{font-size:10px;text-align:center;line-height:1.3}
i{color:#a09a8e;font-size:9px}
</style>
<div class="grid">${c.map(cell).join("")}</div>`)
writeFileSync("logo/candidates17.json", JSON.stringify(c, null, 1))
console.log(`round 17: ${c.length} monogram tests`)
