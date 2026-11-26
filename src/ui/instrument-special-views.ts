// One canonical faceplate for the original instrument and track editor.
import { euclidHit } from "../engine/arp";
import { renderInstrumentChoice, type InstrumentControlContext } from "./instrument-controls";

const FM_LAYOUT: { pos: [number, number][]; edges: [number, number][]; car: number[] }[] = [
  { pos: [[100, 100], [100, 72], [100, 44], [100, 16]], edges: [[2, 1], [3, 2], [4, 3]], car: [1] },
  { pos: [[100, 100], [100, 66], [70, 28], [130, 28]], edges: [[2, 1], [3, 2], [4, 2]], car: [1] },
  { pos: [[100, 100], [70, 66], [70, 28], [130, 66]], edges: [[2, 1], [3, 2], [4, 1]], car: [1] },
  { pos: [[100, 100], [70, 66], [130, 66], [130, 28]], edges: [[2, 1], [3, 1], [4, 3]], car: [1] },
  { pos: [[70, 100], [70, 58], [130, 100], [130, 58]], edges: [[2, 1], [4, 3]], car: [1, 3] },
  { pos: [[50, 100], [100, 100], [150, 100], [100, 52]], edges: [[4, 1], [4, 2], [4, 3]], car: [1, 2, 3] },
  { pos: [[40, 100], [90, 100], [150, 100], [150, 58]], edges: [[4, 3]], car: [1, 2, 3] },
  { pos: [[34, 100], [78, 100], [122, 100], [166, 100]], edges: [], car: [1, 2, 3, 4] }
];

export function renderFmAlgorithm(context: InstrumentControlContext): string {
  const n = Math.max(1, Math.min(8, Number(context.patch.fmAlgo) || 1));
  const L = FM_LAYOUT[n - 1];
  const R = 12;
  const lines = L.edges.map(([a, b]) => {
    const [x1, y1] = L.pos[a - 1];
    const [x2, y2] = L.pos[b - 1];
    return `<line x1="${x1}" y1="${y1 + R}" x2="${x2}" y2="${y2 - R}" />`;
  }).join("");
  const outY = 118;
  const outs = L.car.map((c) => { const [x, y] = L.pos[c - 1]; return `<line x1="${x}" y1="${y + R}" x2="${x}" y2="${outY}" />`; }).join("");
  const xs = L.car.map((c) => L.pos[c - 1][0]);
  const bus = `<line x1="${Math.min(...xs) - 8}" y1="${outY}" x2="${Math.max(...xs) + 8}" y2="${outY}" />`;
  const [fx, fy] = L.pos[3];
  const fb = `<path class="fb" d="M ${fx + R} ${fy} C ${fx + 28} ${fy - 4}, ${fx + 28} ${fy - 24}, ${fx} ${fy - R}" />`;
  const ops = L.pos.map(([x, y], i) =>
    `<g class="op${L.car.includes(i + 1) ? " car" : ""}"><rect x="${x - R}" y="${y - R}" width="${R * 2}" height="${R * 2}" rx="2.5" /><text x="${x}" y="${y + 4.5}">${i + 1}</text></g>`).join("");
  const allX = L.pos.map((p) => p[0]);
  const allY = L.pos.map((p) => p[1]);
  const minX = Math.min(...allX) - R - 6;
  const maxX = Math.max(...allX, fx + 22) + R + 6;
  const minY = Math.min(...allY.map((y) => y - R), fy - 22) - 2;
  const maxY = outY + 3;
  const vbW = Math.max(116, maxX - minX);
  const vbH = maxY - minY;
  const vbX = (minX + maxX) / 2 - vbW / 2;
  return `<div class="fm-lcd" role="img" aria-label="Algorithm ${n}">
      <div class="fm-lcd-head"><span>ALGORITHM</span><b>${n}</b></div>
      <svg viewBox="${vbX.toFixed(1)} ${minY.toFixed(1)} ${vbW.toFixed(1)} ${vbH.toFixed(1)}" preserveAspectRatio="xMidYMid meet" shape-rendering="geometricPrecision" aria-hidden="true"><g class="wires">${lines}${outs}${bus}${fb}</g>${ops}</svg>
    </div>
    ${renderInstrumentChoice(context, "fmAlgo", [1, 2, 3, 4, 5, 6, 7, 8].map((k) => [String(k), String(k), `Algorithm ${k}`] as [string, string, string]))}`;
}

const RING_R = [28, 49, 70];

export function renderEuclideanRings(p: Readonly<Record<string, any>>): string {
  let svg = "";
  for (let r = 1; r <= 3; r++) {
    const steps = Math.max(1, Math.round(p[`euc${r}Steps`] ?? 16));
    const pulses = p[`euc${r}Pulses`] ?? 0;
    const rot = p[`euc${r}Rot`] ?? 0;
    const on = p[`euc${r}On`] !== "off";
    const rad = RING_R[r - 1];
    let dots = "";
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2 - Math.PI / 2;
      const x = 80 + Math.cos(a) * rad;
      const y = 80 + Math.sin(a) * rad;
      const hit = euclidHit(steps, pulses, rot, i);
      dots += `<circle class="eu-dot${hit ? " hit" : ""}" data-ring="${r}" data-i="${i}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${hit ? 5.2 : 3}" />`;
    }
    svg += `<g class="eu-ring eu-ring-${r}${on ? "" : " is-off"}"><circle class="eu-track" cx="80" cy="80" r="${rad}" />${dots}</g>`;
  }
  return `<div class="eu-wrap"><svg class="eu-svg" viewBox="0 0 160 160" aria-label="Euclidean rings">${svg}<circle class="eu-hub-rim" cx="80" cy="80" r="14" /><circle class="eu-hub" cx="80" cy="80" r="9" /></svg>
    <p class="eu-hint">Hold a chord: ring 1 plays its lowest note, ring 2 the next, ring 3 the next. HOLD keeps it going.</p></div>`;
}
