// Round 8: an actual interlocking NY, and a brim with real size.
// The monogram is built as strokes in a local 0..23 x 0..18 box, then placed on the
// crown. Structure of the real mark: N's right stem and Y's left arm cross — that
// crossing IS the "interlocking". Y's tail drops below the N's baseline.
import { writeFileSync } from "node:fs"
const INK = "var(--ink)", ACC = "var(--acc)", LENS = "var(--lens)", GLINT = "var(--glint)"
const BLUE = "var(--mets-blue)", ORANGE = "var(--mets-orange)"
const c = []
const add = (n, body, note = "") => c.push({ n: `${String(c.length + 1).padStart(2, "0")} ${n}`, body, note })

const P = (d, w = 3.6, col = INK) =>
  `<path d="${d}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`
const F = (d, fill, stroke = INK, w = 3.4) =>
  `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"/>`
const rr = (x, y, w, h, r, sw = 3.8, fill = "none", col = INK) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${col}" stroke-width="${sw}"/>`
const ci = (x, y, r, sw = 3.8, fill = "none", col = INK) =>
  `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${col}" stroke-width="${sw}"/>`
const dot = (x, y, r, col = INK) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${col}"/>`

/* ---------- the interlocking NY ---------- */
// yGap: how far the Y sits right of the N (smaller = more overlap = more interlocked)
// sw: stroke weight in local units
const NY = ({ sw = 4, yGap = 9, tail = 8, splay = 7 } = {}) => `
  <g stroke="${ORANGE}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M0 0 V18"/>
    <path d="M0 0 L10 18"/>
    <path d="M10 0 V18"/>
    <path d="M${yGap} 0 L${yGap + splay} 10"/>
    <path d="M${yGap + splay * 2} 0 L${yGap + splay} 10"/>
    <path d="M${yGap + splay} 10 V${10 + tail}"/>
  </g>`
// place the monogram centred at (cx, cy) scaled to `h` tall
const placeNY = (cx, cy, h, opts = {}) => {
  const gap = opts.yGap ?? 9, splay = opts.splay ?? 7, tail = opts.tail ?? 8
  const w = gap + splay * 2, ht = 10 + tail
  const s = h / ht
  return `<g transform="translate(${cx - (w * s) / 2} ${cy - (ht * s) / 2}) scale(${s})">${NY(opts)}</g>`
}

const CX = 40, HL = 10, HR = 70, HT = 18, HB = 66
const EY = 44, LR = 12, LX = 27, RX = 53
const head = () => rr(HL, HT, HR - HL, HB - HT, 15)
const smile = (y = 57, w = 7) => P(`M${CX - w} ${y} q${w} ${w * 0.72} ${w * 2} 0`, 3.4, INK)
const glint = (cx, cy, r) => P(`M${cx - r * 0.42} ${cy - r * 0.52} a${r * 0.62} ${r * 0.62} 0 0 1 ${r * 0.5} -${r * 0.28}`, 2.4, GLINT)
const specs = (fr = ACC) => `
  ${P(`M${LX - LR} ${EY - 2} H${HL + 3} l-3 4`, 3.4, fr)}${P(`M${RX + LR} ${EY - 2} H${HR - 3} l3 4`, 3.4, fr)}
  ${ci(LX, EY, LR, 3.8, LENS, fr)}${ci(RX, EY, LR, 3.8, LENS, fr)}
  ${P(`M${LX + LR} ${EY - 1} h${RX - LX - 2 * LR}`, 3.4, fr)}
  ${dot(LX, EY + 1, 4)}${dot(RX, EY + 1, 4)}
  ${glint(LX, EY, LR)}${glint(RX, EY, LR)}`

/* ---------- cap: taller crown to hold the monogram, and a real brim ---------- */
const crown = peak => `M7 30 C 7 ${peak}, 73 ${peak}, 73 30 Z`
const brims = {
  small:  "M69 28 C 83 27, 90 30, 87 33 C 79 34.5, 71 32.5, 66 30.5 Z",
  medium: "M69 27 C 86 26, 96 30, 92 35 C 82 37, 72 34, 65 31 Z",
  big:    "M68 26 C 88 25, 102 30, 97 36.5 C 85 39.5, 72 35.5, 64 31.5 Z",
  huge:   "M68 25 C 90 24, 108 30, 102 38 C 88 42, 72 36.5, 63 31.5 Z"
}
const cap = (peak, brimKey, nyH, nyOpts = {}) => `
  ${F(crown(peak), BLUE)}
  ${F(brims[brimKey], BLUE)}
  ${placeNY(CX, (peak + 30) / 2 + 1, nyH, nyOpts)}`

const bot = (capMarkup) => `${head()}${specs()}${smile()}${capMarkup}`

/* monogram alone, big, so the construction can actually be judged */
add("NY-alone-default", `<rect x="0" y="0" width="104" height="78" fill="${BLUE}"/>${placeNY(52, 39, 46)}`, "the monogram by itself")
add("NY-alone-tight", `<rect x="0" y="0" width="104" height="78" fill="${BLUE}"/>${placeNY(52, 39, 46, { yGap: 7 })}`, "more overlap")
add("NY-alone-wide", `<rect x="0" y="0" width="104" height="78" fill="${BLUE}"/>${placeNY(52, 39, 46, { yGap: 11, splay: 8 })}`, "less overlap, wider Y")
add("NY-alone-bold", `<rect x="0" y="0" width="104" height="78" fill="${BLUE}"/>${placeNY(52, 39, 46, { sw: 5 })}`, "heavier stroke")

/* brim size sweep, monogram at a readable height */
for (const bk of ["small", "medium", "big", "huge"])
  add(`brim-${bk}`, bot(cap(4, bk, 17)), `crown peak 4 · ${bk} brim · NY 17 tall`)

/* monogram size sweep on the big brim */
for (const h of [14, 17, 20])
  add(`ny-${h}`, bot(cap(4, "big", h)), `NY ${h} units tall`)

/* overlap + weight variants on the chosen cap */
add("ny-tight", bot(cap(4, "big", 17, { yGap: 7 })), "tighter interlock")
add("ny-bold", bot(cap(4, "big", 17, { sw: 5 })), "heavier monogram")
add("ny-shorttail", bot(cap(4, "big", 17, { tail: 5 })), "shorter Y tail")
add("crown-taller", bot(cap(1, "big", 19)), "taller crown, bigger NY")

const cell = ({ n, body, note }) => `
  <figure>
    <svg viewBox="0 0 104 78" width="152" height="114">${body}</svg>
    <div class="small">
      <svg viewBox="0 0 104 78" width="40" height="30">${body}</svg>
      <svg viewBox="0 0 104 78" width="26" height="19">${body}</svg>
      <svg viewBox="0 0 104 78" width="18" height="13">${body}</svg>
    </div>
    <figcaption>${n}<br><i>${note}</i></figcaption>
  </figure>`

writeFileSync("logo/sheet8.html", `<!doctype html><meta charset="utf-8">
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
writeFileSync("logo/candidates8.json", JSON.stringify(c, null, 1))
console.log(`round 8: ${c.length} variants`)
