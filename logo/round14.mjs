// Round 14: a low-res NY drawn in Billy's own stroke language.
//
// Structure taken from the measured original (normalised to a 68 x 100 box):
//   N left stem  centre x 13.5, y 0..70
//   N right stem centre x 54.5, y 0..70
//   diagonal between them
//   Y tail       centre x 34  — exactly midway between the N's stems — y 45..97
//   the Y's right arm merges into the N's right stem; that merge IS the interlock
// Earlier failure was proportion, not detail: this box is TALLER than wide (0.68).
import { readFileSync, writeFileSync } from "node:fs"
const REF = JSON.parse(readFileSync("logo/reference-ny.json", "utf8"))
const INK = "var(--ink)", ACC = "var(--acc)", LENS = "var(--lens)", GLINT = "var(--glint)"
const BLUE = "var(--mets-blue)", ORANGE = "var(--mets-orange)"
const c = []
const add = (n, body, note = "") => c.push({ n: `${String(c.length + 1).padStart(2, "0")} ${n}`, body, note })

const P = (d, w = 3.6, col = INK) =>
  `<path d="${d}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`
const rr = (x, y, w, h, r, sw, fill, col) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${col}" stroke-width="${sw}"/>`
const ci = (x, y, r, sw, fill, col) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${col}" stroke-width="${sw}"/>`
const dot = (x, y, r, col = INK) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${col}"/>`

/* ---- the low-res monogram, in a 68 x 100 local box ---- */
const NYlo = ({ sw = 12, yArm = 46, tail = 97, conv = 45, cap = "round" } = {}) => `
  <g stroke="${ORANGE}" stroke-width="${sw}" stroke-linecap="${cap}" stroke-linejoin="round" fill="none">
    <path d="M13.5 0 V70"/>
    <path d="M13.5 0 L54.5 70"/>
    <path d="M54.5 0 V70"/>
    <path d="M${yArm} 0 L34 ${conv}"/>
    <path d="M34 ${conv} V${tail}"/>
  </g>`
const placeLo = (cx, cy, h, o = {}) => {
  const s = h / (o.tail ?? 97)
  return `<g transform="translate(${(cx - 34 * s).toFixed(2)} ${(cy - h / 2).toFixed(2)}) scale(${s.toFixed(4)})">${NYlo(o)}</g>`
}
// alternates the user floated
const NYalt = {
  lower: sw => `<g stroke="${ORANGE}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M10 34 V97"/><path d="M10 46 q0 -12 12 -12 t12 12 V97"/>
    <path d="M44 34 L54 70 L64 34"/><path d="M54 70 V97"/></g>`,
  plain: sw => `<g stroke="${ORANGE}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M6 70 V10 L30 70 V10"/><path d="M40 10 L52 42 L64 10"/><path d="M52 42 V70"/></g>`
}
const placeAlt = (kind, cx, cy, h, sw) => {
  const s = h / 97
  return `<g transform="translate(${(cx - 34 * s).toFixed(2)} ${(cy - h / 2).toFixed(2)}) scale(${s.toFixed(4)})">${NYalt[kind](sw)}</g>`
}
const NY_BB = { x: 116.9, y: 37.5, w: 341.1, h: 500 }
const realNY = (cx, cy, h) => {
  const s = h / NY_BB.h
  return `<g transform="translate(${(cx - s * (NY_BB.x + NY_BB.w / 2)).toFixed(2)} ${(cy - s * (NY_BB.y + NY_BB.h / 2)).toFixed(2)}) scale(${s.toFixed(4)})"><path d="${REF.ny}" fill="${ORANGE}"/></g>`
}

const CX = 40, HL = 10, HR = 70, HT = 20, BASE = 31, K = -14
const HB = 71, EY = 45, LR = 11, SMILE_Y = 61
const apex = (BASE * 2 + 6 * K) / 8
const NY_Y = (apex + BASE) / 2 + 0.5
// slab brim from round 13 — straight edges, clean vertices
const capPath = `M6 ${BASE} C 6 ${K}, 74 ${K}, 74 ${BASE} L 103 32.5 L 103 39.5 L 64 ${BASE} L 6 ${BASE} Z`
const capShape = `<path d="${capPath}" fill="${BLUE}" stroke="${INK}" stroke-width="3.4" stroke-linejoin="round" stroke-linecap="round"/>`
const face = () => `
  ${rr(HL, HT, HR - HL, HB - HT, 15, 3.8, "none", INK)}
  ${P(`M${27 - LR} ${EY - 2} H${HL + 3} l-3 4`, 3.4, ACC)}${P(`M${53 + LR} ${EY - 2} H${HR - 3} l3 4`, 3.4, ACC)}
  ${ci(27, EY, LR, 3.8, LENS, ACC)}${ci(53, EY, LR, 3.8, LENS, ACC)}
  ${P(`M${27 + LR} ${EY - 1} h${53 - 27 - 2 * LR}`, 3.4, ACC)}
  ${dot(27, EY + 1, 3.8)}${dot(53, EY + 1, 3.8)}
  ${P(`M${27 - LR * 0.42} ${EY - LR * 0.52} a${LR * 0.62} ${LR * 0.62} 0 0 1 ${LR * 0.5} -${LR * 0.28}`, 2.4, GLINT)}
  ${P(`M${53 - LR * 0.42} ${EY - LR * 0.52} a${LR * 0.62} ${LR * 0.62} 0 0 1 ${LR * 0.5} -${LR * 0.28}`, 2.4, GLINT)}
  ${P(`M${CX - 7} ${SMILE_Y} q7 5 14 0`, 3.4, INK)}`

add("REAL (current)", `${face()}${capShape}${realNY(CX, NY_Y, 18)}`, "the detailed original, for reference")
for (const sw of [9, 12, 15])
  add(`lo-sw${sw}`, `${face()}${capShape}${placeLo(CX, NY_Y, 20, { sw })}`, `low-res · stroke ${sw}`)
add("lo-merged", `${face()}${capShape}${placeLo(CX, NY_Y, 20, { yArm: 54.5 })}`, "Y arm merged into N's right stem")
add("lo-butt", `${face()}${capShape}${placeLo(CX, NY_Y, 20, { cap: "butt" })}`, "flat stroke caps")
add("lo-shorttail", `${face()}${capShape}${placeLo(CX, NY_Y, 20, { tail: 85 })}`, "shorter Y tail")
add("lo-big", `${face()}${capShape}${placeLo(CX, NY_Y, 24)}`, "low-res · larger")
add("lo-small", `${face()}${capShape}${placeLo(CX, NY_Y, 17)}`, "low-res · smaller")
add("alt-lowercase", `${face()}${capShape}${placeAlt("lower", CX, NY_Y, 20, 12)}`, "lowercase ny")
add("alt-plain", `${face()}${capShape}${placeAlt("plain", CX, NY_Y, 20, 11)}`, "plain N + Y, not interlocked")

/* monogram alone, on blue, next to the real one */
add("compare-real", `<rect x="0" y="0" width="80" height="80" fill="${BLUE}"/>${realNY(40, 40, 62)}`, "original, isolated")
add("compare-lo", `<rect x="0" y="0" width="80" height="80" fill="${BLUE}"/>${placeLo(40, 40, 62)}`, "low-res, isolated")

const isTile = n => n.includes("compare")
const cell = ({ n, body, note }) => {
  const vb = isTile(n) ? "0 0 80 80" : "4 -6 106 82"
  const [w, h] = isTile(n) ? [136, 136] : [182, 141]
  return `
  <figure>
    <svg viewBox="${vb}" width="${w}" height="${h}">${body}</svg>
    <div class="small">
      <svg viewBox="${vb}" width="46" height="${isTile(n) ? 46 : 36}">${body}</svg>
      <svg viewBox="${vb}" width="26" height="${isTile(n) ? 26 : 20}">${body}</svg>
      <svg viewBox="${vb}" width="18" height="${isTile(n) ? 18 : 14}">${body}</svg>
    </div>
    <figcaption>${n}<br><i>${note}</i></figcaption>
  </figure>`
}

writeFileSync("logo/sheet14.html", `<!doctype html><meta charset="utf-8">
<style>
:root{--ink:#191c1f;--acc:#2f7d5b;--lens:#eaf3ee;--glint:#ffffff;--mets-blue:#002d72;--mets-orange:#ff5910}
body{margin:0;background:#faf8f3;font:12px ui-sans-serif,system-ui;color:#6f6a61}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:16px}
figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:4px;
  background:#fffdf9;border:1px solid #e5e0d5;border-radius:10px;padding:10px 4px}
.small{display:flex;align-items:center;gap:10px}
figcaption{font-size:10px;text-align:center;line-height:1.3}
i{color:#a09a8e;font-size:9px}
</style>
<div class="grid">${c.map(cell).join("")}</div>`)
writeFileSync("logo/candidates14.json", JSON.stringify(c, null, 1))
console.log(`round 14: ${c.length} variants`)
