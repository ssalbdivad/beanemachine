// Round 15: the low-res interlock failed — merging the Y's right arm into the N's
// stem left an "N with a descender". At cap-emblem size the interlock is illegible
// regardless, and orange-on-blue NY already says Mets. So: a chunky, plainly legible
// NY in Billy's own stroke weight, with an optional overlap that hints at the lock.
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

/* NY in a local box: N spans 0..nW, Y starts at gap, both 60 tall.
   `lock` slides the Y left so its arm crosses the N's right stem. */
const NY = ({ sw = 10, nW = 26, gap = 36, yW = 28, lock = 0, tail = 60, cap = "round" } = {}) => {
  const yx = gap - lock, ymid = yx + yW / 2
  return `<g stroke="${ORANGE}" stroke-width="${sw}" stroke-linecap="${cap}" stroke-linejoin="round" fill="none">
    <path d="M0 60 L0 0 L${nW} 60 L${nW} 0"/>
    <path d="M${yx} 0 L${ymid} 30 L${yx + yW} 0"/>
    <path d="M${ymid} 30 V${tail}"/>
  </g>`
}
const width = ({ nW = 26, gap = 36, yW = 28, lock = 0, sw = 10 } = {}) => gap - lock + yW + sw
const placeNY = (cx, cy, h, o = {}) => {
  const s = h / (60 + (o.sw ?? 10))
  const w = width(o)
  return `<g transform="translate(${(cx - (w * s) / 2 + ((o.sw ?? 10) / 2) * s).toFixed(2)} ${(cy - h / 2 + ((o.sw ?? 10) / 2) * s).toFixed(2)}) scale(${s.toFixed(4)})">${NY(o)}</g>`
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
const on = (o, h = 15) => `${face()}${capShape}${placeNY(CX, NY_Y, h, o)}`

add("REAL", `${face()}${capShape}${realNY(CX, NY_Y, 18)}`, "detailed original, for reference")
for (const sw of [8, 10, 12])
  add(`sw${sw}`, on({ sw }), `stroke ${sw}`)
for (const lock of [0, 6, 12])
  add(`lock${lock}`, on({ lock }), lock ? `Y overlaps N by ${lock}` : "no overlap")
for (const h of [13, 15, 17])
  add(`h${h}`, on({}, h), `emblem ${h} tall`)
add("tail-short", on({ tail: 52 }), "shorter Y tail")
add("tail-long", on({ tail: 68 }), "Y tail below the N")
add("butt", on({ cap: "butt" }), "flat stroke caps")

add("cmp-real", `<rect x="0" y="0" width="80" height="80" fill="${BLUE}"/>${realNY(40, 40, 62)}`, "original, isolated")
add("cmp-new", `<rect x="0" y="0" width="80" height="80" fill="${BLUE}"/>${placeNY(40, 40, 50)}`, "low-res, isolated")
add("cmp-lock", `<rect x="0" y="0" width="80" height="80" fill="${BLUE}"/>${placeNY(40, 40, 50, { lock: 8 })}`, "low-res w/ overlap, isolated")

const isTile = n => n.startsWith("cmp")
const cell = ({ n, body, note }) => {
  const vb = isTile(n) ? "0 0 80 80" : "4 -6 106 82"
  const [w, h] = isTile(n) ? [130, 130] : [178, 138]
  return `<figure>
    <svg viewBox="${vb}" width="${w}" height="${h}">${body}</svg>
    <div class="small">
      <svg viewBox="${vb}" width="44" height="${isTile(n) ? 44 : 34}">${body}</svg>
      <svg viewBox="${vb}" width="26" height="${isTile(n) ? 26 : 20}">${body}</svg>
      <svg viewBox="${vb}" width="18" height="${isTile(n) ? 18 : 14}">${body}</svg>
    </div>
    <figcaption>${n}<br><i>${note}</i></figcaption>
  </figure>`
}
writeFileSync("logo/sheet15.html", `<!doctype html><meta charset="utf-8">
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
writeFileSync("logo/candidates15.json", JSON.stringify(c, null, 1))
console.log(`round 15: ${c.length} variants`)
