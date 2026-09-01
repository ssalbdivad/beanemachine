// Round 6: the winning head-only Beanbot, in a Mets cap.
// Constraints: royal blue + orange must not fight the green bean, and the cap
// can't eat the glasses. The antenna has to go somewhere — through the button, or gone.
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

const HL = 15, HR = 73, EY = 40
const head = () => rr(HL, 18, HR - HL, 44, 15)
const smile = (y = 53, w = 7) => P(`M${44 - w} ${y} q${w} ${w * 0.72} ${w * 2} 0`, 3.4, INK)
const glint = (cx, cy, r) => P(`M${cx - r * 0.42} ${cy - r * 0.52} a${r * 0.62} ${r * 0.62} 0 0 1 ${r * 0.5} -${r * 0.28}`, 2.4, GLINT)

// the specs that won round 5: round lenses, bar bridge, hook temples, wide-set
const specs = (fr = ACC, r = 12, lx = 30, rx = 58) => `
  ${P(`M${lx - r} ${EY - 2} H${HL + 3} l-3 4`, 3.4, fr)}${P(`M${rx + r} ${EY - 2} H${HR - 3} l3 4`, 3.4, fr)}
  ${ci(lx, EY, r, 3.8, LENS, fr)}${ci(rx, EY, r, 3.8, LENS, fr)}
  ${P(`M${lx + r} ${EY - 1} h${rx - lx - 2 * r}`, 3.4, fr)}
  ${dot(lx, EY + 1, 4)}${dot(rx, EY + 1, 4)}
  ${glint(lx, EY, r)}${glint(rx, EY, r)}`

/* --- cap styles --- */
// front-facing brim, curving down over the brow
const capFront = (emblem, button) => `
  ${F("M14 27 C 14 10, 74 10, 74 27 Z", BLUE)}
  ${F("M10 27 C 24 33, 64 33, 78 27 C 74 24, 18 24, 10 27 Z", BLUE)}
  ${emblem}${button}`
// brim swept to the side — more silhouette, reads at tiny sizes
const capSide = (dir, emblem, button) => {
  const brim = dir === "r"
    ? "M70 26 C 84 25, 88 29, 86 31 C 80 32, 72 31, 68 29 Z"
    : "M18 26 C 4 25, 0 29, 2 31 C 8 32, 16 31, 20 29 Z"
  return `${F("M14 27 C 14 10, 74 10, 74 27 Z", BLUE)}${F(brim, BLUE)}${emblem}${button}`
}
// backwards cap: strap band in front, brim behind
const capBack = (emblem, button) => `
  ${F("M14 27 C 14 10, 74 10, 74 27 Z", BLUE)}
  ${P("M18 24 h52", 3.4, ORANGE)}${emblem}${button}`

const emblems = {
  // an orange front-panel mark, kept abstract rather than aping the NY monogram
  dot:   `${dot(44, 19, 4.6, ORANGE)}`,
  seam:  `${P("M39 22 C 43 17, 45 17, 49 22", 3.2, ORANGE)}`,
  none:  "",
  bean:  `${ci(44, 19, 5.4, 2.8, "none", ORANGE)}${P("M44 14 C 40 16.5, 48 21.5, 44 24", 2.4, ORANGE)}`
}
const buttons = {
  antenna: `${P("M44 10 v-5", 3.4)}${dot(44, 2.6, 3.6, ORANGE)}`,
  knob:    `${dot(44, 10, 3.2, ORANGE)}`,
  none:    ""
}

const bot = (cap, { fr = ACC } = {}) => `${cap}${head()}${specs(fr)}${smile()}
  ${/* re-draw the cap over the head so it sits on top, not behind */""}${cap}`

/* front brim */
for (const [ek, ev] of Object.entries(emblems))
  add(`front-${ek}`, `${head()}${specs()}${smile()}${capFront(ev, buttons.antenna)}`, `front brim · ${ek} emblem · antenna`)
for (const bk of ["knob", "none"])
  add(`front-dot-${bk}`, `${head()}${specs()}${smile()}${capFront(emblems.dot, buttons[bk])}`, `front brim · ${bk} top`)

/* side brim */
for (const d of ["r", "l"])
  for (const ek of ["dot", "seam", "bean"])
    add(`side${d}-${ek}`, `${head()}${specs()}${smile()}${capSide(d, emblems[ek], buttons.antenna)}`, `brim ${d === "r" ? "right" : "left"} · ${ek}`)

/* backwards */
add("back-dot", `${head()}${specs()}${smile()}${capBack(emblems.dot, buttons.antenna)}`, "backwards cap")

/* palette tests: green specs vs ink specs under a blue cap */
add("front-dot-inkspecs", `${head()}${specs(INK)}${smile()}${capFront(emblems.dot, buttons.antenna)}`, "ink frames (green reserved for the bean)")
add("sider-dot-inkspecs", `${head()}${specs(INK)}${smile()}${capSide("r", emblems.dot, buttons.antenna)}`, "ink frames · side brim")
add("front-bean-inkspecs", `${head()}${specs(INK)}${smile()}${capFront(emblems.bean, buttons.antenna)}`, "ink frames · bean emblem")

const cell = ({ n, body, note }) => `
  <figure>
    <svg viewBox="0 0 88 70" width="136" height="108">${body}</svg>
    <div class="small">
      <svg viewBox="0 0 88 70" width="34" height="27">${body}</svg>
      <svg viewBox="0 0 88 70" width="22" height="17">${body}</svg>
      <svg viewBox="0 0 88 70" width="16" height="13">${body}</svg>
    </div>
    <figcaption>${n}<br><i>${note}</i></figcaption>
  </figure>`

writeFileSync("logo/sheet6.html", `<!doctype html><meta charset="utf-8">
<style>
:root{--ink:#191c1f;--acc:#2f7d5b;--lens:#eaf3ee;--glint:#ffffff;--mets-blue:#002d72;--mets-orange:#ff5910}
body{margin:0;background:#faf8f3;font:12px ui-sans-serif,system-ui;color:#6f6a61}
.grid{display:grid;grid-template-columns:repeat(6,1fr);gap:7px;padding:16px}
figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:4px;
  background:#fffdf9;border:1px solid #e5e0d5;border-radius:10px;padding:9px 4px}
.small{display:flex;align-items:center;gap:9px}
figcaption{font-size:9.5px;text-align:center;line-height:1.3}
i{color:#a09a8e;font-size:8.5px}
</style>
<div class="grid">${c.map(cell).join("")}</div>`)
writeFileSync("logo/candidates6.json", JSON.stringify(c, null, 1))
console.log(`round 6: ${c.length} capped variants`)
