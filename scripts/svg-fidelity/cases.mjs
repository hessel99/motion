// nasty svg test cases for the svg import fidelity check (scripts/figma-fidelity.mjs --only svg).
// ground truth is chromium's own rendering of the same svg. every case is 400x300 so the report
// lines up with the figma frames. deterministic (seeded) so runs are comparable.

const W = 400, H = 300;
const svg = (body, attrs = `width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"`) => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}>${body}</svg>`;

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const r1 = v => Math.round(v * 10) / 10;

/** random path mixing every command, absolute and relative, with implicit repeats and arcs */
function randomPath(seed) {
  const r = rng(seed);
  const P = () => `${r1(20 + r() * 360)} ${r1(20 + r() * 260)}`;
  const d = r() * 40 - 20;
  const parts = [`M${P()}`];
  for (let i = 0; i < 10; i++) {
    const k = Math.floor(r() * 9);
    if (k === 0) parts.push(`L${P()} ${P()}`); // implicit repeat
    else if (k === 1) parts.push(`l${r1(d)},${r1(-d)}`);
    else if (k === 2) parts.push(`H${r1(20 + r() * 360)}V${r1(20 + r() * 260)}`);
    else if (k === 3) parts.push(`C${P()} ${P()} ${P()}`);
    else if (k === 4) parts.push(`S${P()} ${P()}`);
    else if (k === 5) parts.push(`Q${P()} ${P()}T${P()}`);
    else if (k === 6) parts.push(`A${r1(20 + r() * 80)} ${r1(10 + r() * 60)} ${r1(r() * 90)} ${r() < 0.5 ? 1 : 0} ${r() < 0.5 ? 1 : 0} ${P()}`);
    else if (k === 7) parts.push(`a${r1(30 + r() * 40)},${r1(30 + r() * 40)} 0 1,0 ${r1(d)},${r1(d)}`);
    else parts.push(`c${r1(d)} ${r1(d * 2)} ${r1(-d)} ${r1(d)} ${r1(d * 1.5)} ${r1(-d)}`);
  }
  parts.push('Z');
  return parts.join(' ');
}

export const SVG_CASES = [
  ['svg/arcs', svg(`<rect width="400" height="300" fill="#fff"/>
    <path d="M60 150 A60 40 0 0 1 180 150 A60 40 0 1 0 300 150" fill="none" stroke="#e11d48" stroke-width="8"/>
    <path d="M60 230 a50 50 0 1 1 100 0 a50 50 0 1 1 -100 0 z M220 200 a40 60 30 0 0 80 40 l20 -60 a20 20 0 0 1 20 20 z" fill="#2563eb" fill-opacity=".7"/>
    <path d="M40 40 A30 30 0 0 0 100 40 A30 60 90 1 1 160 60" fill="#16a34a" stroke="#14532d" stroke-width="3"/>`)],
  ['svg/transforms', svg(`<rect width="400" height="300" fill="#fff"/>
    <g transform="translate(200 150)"><g transform="rotate(30) scale(1.5 0.8)"><rect x="-50" y="-30" width="100" height="60" fill="#f59e0b" stroke="#000" stroke-width="4"/></g>
    <g transform="skewX(25) translate(-140 -100)"><rect width="60" height="60" fill="#8b5cf6"/></g>
    <g transform="matrix(0.8 0.3 -0.4 0.9 80 20)"><circle r="30" fill="#06b6d4"/></g>
    <g transform="scale(-1 1) translate(-160 40)"><text font-family="Inter, sans-serif" font-size="28" fill="#111">flip</text></g></g>`)],
  ['svg/use-defs-symbol', svg(`<defs><symbol id="s" viewBox="0 0 10 10"><path d="M5 0 L10 10 L0 10 Z" fill="currentColor"/></symbol>
    <g id="pair"><use href="#s" width="40" height="40" color="#ef4444"/><use xlink:href="#s" x="45" width="40" height="40" color="#3b82f6"/></g></defs>
    <rect width="400" height="300" fill="#fafafa"/>
    <use href="#pair" x="20" y="20"/><use href="#pair" x="150" y="40" transform="rotate(10)"/>
    <use href="#s" x="250" y="150" width="120" height="80" style="color:#10b981"/>
    <use href="#pair" transform="translate(40 200) scale(2)"/>`)],
  ['svg/linear-gradients', svg(`<defs>
    <linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff0066"/><stop offset=".5" stop-color="#ffcc00" stop-opacity=".5"/><stop offset="1" stop-color="#00ccff"/></linearGradient>
    <linearGradient id="b" gradientUnits="userSpaceOnUse" x1="200" y1="0" x2="260" y2="0" spreadMethod="reflect"><stop offset="0" stop-color="#111"/><stop offset="1" stop-color="#eee"/></linearGradient>
    <linearGradient id="c" x2="0.25" spreadMethod="repeat" gradientTransform="rotate(30 .5 .5)"><stop offset="0" stop-color="#7c3aed"/><stop offset="1" stop-color="#22d3ee"/></linearGradient>
    <linearGradient id="d" href="#a" gradientTransform="translate(.2 0) scale(.5 1)"/></defs>
    <rect width="190" height="140" fill="url(#a)"/><rect x="200" width="200" height="140" fill="url(#b)"/>
    <rect y="150" width="190" height="150" fill="url(#c)"/><ellipse cx="300" cy="225" rx="95" ry="70" fill="url(#d)"/>`)],
  ['svg/radial-gradients', svg(`<defs>
    <radialGradient id="a" cx=".5" cy=".5" r=".5" fx=".25" fy=".3"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#1d4ed8"/></radialGradient>
    <radialGradient id="b" gradientUnits="userSpaceOnUse" cx="300" cy="80" r="40" spreadMethod="repeat"><stop offset="0" stop-color="#f97316"/><stop offset="1" stop-color="#fde68a"/></radialGradient>
    <radialGradient id="c" gradientTransform="translate(.5 .5) scale(.5 1) translate(-.5 -.5)"><stop offset=".2" stop-color="#be123c"/><stop offset=".9" stop-color="#fecdd3"/></radialGradient></defs>
    <circle cx="100" cy="80" r="70" fill="url(#a)"/><rect x="200" width="200" height="160" fill="url(#b)"/><rect x="20" y="170" width="360" height="120" rx="20" fill="url(#c)"/>`)],
  ['svg/clip-paths', svg(`<defs>
    <clipPath id="a"><circle cx="100" cy="100" r="80"/></clipPath>
    <clipPath id="b" clipPathUnits="objectBoundingBox"><polygon points="0.5,0 1,1 0,1"/></clipPath>
    <clipPath id="c"><text x="210" y="260" font-family="Inter, sans-serif" font-weight="900" font-size="90">CLIP</text></clipPath>
    <clipPath id="d" clip-path="url(#a)"><rect x="60" y="0" width="200" height="300"/></clipPath></defs>
    <rect width="400" height="300" fill="#fff"/>
    <g clip-path="url(#d)"><rect width="400" height="300" fill="#0ea5e9"/><path d="M0 0 L400 300" stroke="#fff" stroke-width="30"/></g>
    <rect x="220" y="20" width="160" height="140" fill="#f43f5e" clip-path="url(#b)"/>
    <g clip-path="url(#c)"><rect y="170" width="400" height="130" fill="#22c55e"/><rect y="230" width="400" height="70" fill="#14532d"/></g>`)],
  ['svg/masks', svg(`<defs>
    <linearGradient id="g"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient>
    <mask id="m"><rect width="400" height="300" fill="url(#g)"/><circle cx="300" cy="150" r="60" fill="#fff"/></mask>
    <mask id="n" maskContentUnits="objectBoundingBox"><circle cx=".5" cy=".5" r=".45" fill="#fff" fill-opacity=".6"/></mask></defs>
    <rect width="400" height="300" fill="#fef3c7"/>
    <g mask="url(#m)"><rect width="400" height="150" fill="#7c3aed"/><rect y="150" width="400" height="150" fill="#db2777"/></g>
    <rect x="20" y="20" width="120" height="120" fill="#065f46" mask="url(#n)"/>`)],
  ['svg/dashes-caps-joins', svg(`<rect width="400" height="300" fill="#fff"/>
    <path d="M30 40 H370" stroke="#111" stroke-width="10" stroke-dasharray="30 10 5 10" stroke-linecap="round"/>
    <path d="M30 80 H370" stroke="#111" stroke-width="10" stroke-dasharray="20" stroke-dashoffset="15" stroke-linecap="square"/>
    <path d="M30 120 H370" stroke="#e11d48" stroke-width="6" stroke-dasharray="1 9" stroke-linecap="round"/>
    <polyline points="30,270 80,160 130,270" fill="none" stroke="#2563eb" stroke-width="18" stroke-linejoin="miter" stroke-miterlimit="10"/>
    <polyline points="150,270 200,160 250,270" fill="none" stroke="#2563eb" stroke-width="18" stroke-linejoin="bevel"/>
    <polyline points="270,270 320,160 370,270" fill="none" stroke="#2563eb" stroke-width="18" stroke-linejoin="round"/>
    <polyline points="20,150 60,140 100,150" fill="none" stroke="#000" stroke-width="8" stroke-linejoin="miter" stroke-miterlimit="1"/>`)],
  ['svg/fill-rules', svg(`<rect width="400" height="300" fill="#fff"/>
    <path d="M100 20 L160 200 L10 85 L190 85 L40 200 Z" fill="#dc2626" fill-rule="evenodd"/>
    <path d="M300 20 L360 200 L210 85 L390 85 L240 200 Z" fill="#2563eb" fill-rule="nonzero"/>
    <path d="M20 220 h360 v70 h-360 z M40 235 v40 h320 v-40 z M200 240 a15 15 0 1 0 0.01 0z" fill="#059669" fill-rule="evenodd"/>`)],
  ['svg/text', svg(`<rect width="400" height="300" fill="#fff"/>
    <text x="20" y="50" font-family="Inter, sans-serif" font-size="36" font-weight="700" fill="#111">Bold title</text>
    <text x="20" y="100" font-family="Inter, sans-serif" font-size="22" fill="#374151">Mixed <tspan fill="#dc2626" font-weight="700">red</tspan> and <tspan font-style="italic" fill="#2563eb">blue</tspan></text>
    <text x="200" y="150" text-anchor="middle" font-family="Inter, sans-serif" font-size="28" letter-spacing="4">CENTERED</text>
    <text x="380" y="200" text-anchor="end" font-family="Inter, sans-serif" font-size="24">right aligned</text>
    <text x="20 50 80 110" y="250 240 250 240" font-family="Inter, sans-serif" font-size="30" fill="#7c3aed">WAVE</text>
    <text x="200" y="280" font-family="serif" font-size="24" dy="-5" transform="rotate(-8 200 280)">serif rotated</text>`)],
  ['svg/css-styles', svg(`<style>
      .a { fill: #f97316; stroke: #7c2d12; stroke-width: 6px; }
      #b { fill: rgb(14, 165, 233); opacity: .8 }
      rect.c { fill: hsl(140, 70%, 45%) } g.k > circle { fill: #a855f7 }
      .d { fill: red !important } .e { stroke-dasharray: 12 6; stroke: #111; stroke-width: 4; fill: none }
    </style>
    <rect width="400" height="300" fill="#fff"/>
    <circle class="a" cx="80" cy="80" r="50"/><rect id="b" x="160" y="30" width="100" height="100"/>
    <rect class="c" x="290" y="30" width="90" height="100" fill="blue"/>
    <g class="k"><circle cx="80" cy="220" r="50"/></g>
    <rect class="d" x="160" y="170" width="100" height="100" style="fill:blue"/>
    <ellipse class="e" cx="330" cy="220" rx="50" ry="40" style="stroke:#0f766e"/>`)],
  ['svg/percent-units', svg(`<rect width="100%" height="100%" fill="#f1f5f9"/>
    <rect x="10%" y="10%" width="30%" height="40%" fill="#0284c7"/>
    <circle cx="70%" cy="35%" r="15%" fill="#e11d48"/>
    <rect x="1in" y="2in" width="5cm" height="10mm" fill="#16a34a"/>
    <rect x="250" y="200" width="6em" height="3em" font-size="16" fill="#f59e0b"/>
    <line x1="0" y1="95%" x2="100%" y2="95%" stroke="#111" stroke-width="1pt"/>`)],
  ['svg/viewbox-slice', svg(`<rect x="-50" y="-50" width="200" height="200" fill="#fde68a"/><circle cx="50" cy="50" r="45" fill="#2563eb"/><rect x="0" y="0" width="20" height="20" fill="#dc2626"/>`,
    `width="${W}" height="${H}" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice"`)],
  ['svg/viewbox-meet-xmin', svg(`<rect width="100" height="100" fill="#fde68a"/><circle cx="50" cy="50" r="45" fill="#2563eb"/><rect x="80" y="80" width="20" height="20" fill="#dc2626"/>`,
    `width="${W}" height="${H}" viewBox="0 0 100 100" preserveAspectRatio="xMinYMax meet"`)],
  ['svg/viewbox-none', svg(`<rect width="100" height="100" fill="#fde68a"/><circle cx="50" cy="50" r="45" fill="#2563eb" stroke="#000" stroke-width="4"/>`,
    `width="${W}" height="${H}" viewBox="0 0 100 100" preserveAspectRatio="none"`)],
  ['svg/opacity-stack', svg(`<rect width="400" height="300" fill="#fff"/>
    <g opacity=".5"><rect x="40" y="40" width="160" height="120" fill="#2563eb"/><rect x="120" y="100" width="160" height="120" fill="#dc2626"/></g>
    <rect x="220" y="40" width="140" height="120" fill="#16a34a" fill-opacity=".5" stroke="#000" stroke-width="16" stroke-opacity=".3"/>
    <circle cx="300" cy="230" r="50" fill="rgba(147, 51, 234, .6)"/>`)],
  ['svg/primitives', svg(`<rect width="400" height="300" fill="#fff"/>
    <rect x="20" y="20" width="120" height="80" rx="30" ry="15" fill="#0ea5e9"/>
    <ellipse cx="230" cy="60" rx="70" ry="40" fill="#f472b6"/>
    <polygon points="330,20 380,100 280,100" fill="#facc15" stroke="#854d0e" stroke-width="3"/>
    <polyline points="20,200 60,140 100,220 140,150 180,230" fill="#bbf7d0" stroke="#166534" stroke-width="4"/>
    <line x1="200" y1="140" x2="380" y2="280" stroke="#111" stroke-width="5" stroke-linecap="round"/>
    <rect x="220" y="160" width="60" height="60" rx="100" fill="#a855f7"/>`)],
  ['svg/colors', svg(`<rect width="400" height="300" fill="white"/>
    <g color="#0d9488"><rect x="20" y="20" width="80" height="80" fill="currentColor"/><rect x="110" y="20" width="80" height="80" fill="none" stroke="currentColor" stroke-width="8"/></g>
    <rect x="200" y="20" width="80" height="80" fill="#f0a"/><rect x="290" y="20" width="80" height="80" fill="cornflowerblue"/>
    <rect x="20" y="120" width="80" height="80" fill="hsl(25 95% 53%)"/><rect x="110" y="120" width="80" height="80" fill="rgb(20% 40% 60%)"/>
    <rect x="200" y="120" width="80" height="80" fill="#3b82f680"/><rect x="290" y="120" width="80" height="80" fill="transparent" stroke="rebeccapurple" stroke-width="6"/>`)],
  ['svg/nested-svg', svg(`<rect width="400" height="300" fill="#f8fafc"/>
    <svg x="20" y="20" width="160" height="120" viewBox="0 0 10 10"><rect width="10" height="10" fill="#2563eb"/><circle cx="5" cy="5" r="4" fill="#fff"/></svg>
    <svg x="200" y="20" width="180" height="260" viewBox="0 0 50 50" preserveAspectRatio="xMidYMin meet" overflow="hidden"><rect x="-10" y="-10" width="70" height="70" fill="#f97316"/><path d="M0 50 L25 0 L50 50 Z" fill="#7c2d12"/></svg>`)],
  ['svg/markers', svg(`<defs><marker id="arr" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#dc2626"/></marker>
    <marker id="dot" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5"><circle cx="5" cy="5" r="4" fill="#2563eb"/></marker></defs>
    <rect width="400" height="300" fill="#fff"/>
    <path d="M40 250 L120 80 L220 200 L360 60" fill="none" stroke="#111" stroke-width="4" marker-start="url(#arr)" marker-mid="url(#dot)" marker-end="url(#arr)"/>`)],
  ['svg/pattern', svg(`<defs><pattern id="p" width="20" height="20" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="10" height="20" fill="#f59e0b"/></pattern>
    <pattern id="q" width=".25" height=".25"><circle cx="10" cy="10" r="8" fill="#2563eb"/></pattern></defs>
    <rect width="400" height="300" fill="#fff"/><rect x="20" y="20" width="170" height="260" fill="url(#p)"/><rect x="210" y="20" width="170" height="260" fill="url(#q)" stroke="#000"/>`)],
  ['svg/filters', svg(`<defs><filter id="b"><feGaussianBlur stdDeviation="6"/></filter>
    <filter id="s" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="6" dy="8" stdDeviation="5" flood-color="#000" flood-opacity=".5"/></filter></defs>
    <rect width="400" height="300" fill="#fff"/><circle cx="110" cy="150" r="70" fill="#e11d48" filter="url(#b)"/>
    <rect x="220" y="80" width="140" height="140" rx="16" fill="#38bdf8" filter="url(#s)"/>`)],
  ['svg/path-syntax-edge', svg(`<rect width="400" height="300" fill="#fff"/>
    <path d="M20,20l50-0,0,50-50,0z m100,0 h50v50h-50z M220 20 L270 20 270 70 220 70Z" fill="#334155"/>
    <path d="M20 120c0-30 60-30 60 0s60 30 60 0 60-30 60 0" fill="none" stroke="#db2777" stroke-width="6"/>
    <path d="M220 120q30-40 60 0t60 0t40 0" fill="none" stroke="#059669" stroke-width="6"/>
    <path d="M20 200l.5.5 10-5e1 1.5.5L40 260 60 200.5.5.5" fill="none" stroke="#7c3aed" stroke-width="3"/>
    <path d="M100 280 V200 H300 V280 Z" fill="none" stroke="#0f172a" stroke-width="2"/>`)],
  ['svg/stroke-scaling', svg(`<rect width="400" height="300" fill="#fff"/>
    <g transform="scale(3 1)"><circle cx="30" cy="80" r="20" fill="none" stroke="#2563eb" stroke-width="6"/></g>
    <g transform="scale(3 1)"><circle cx="90" cy="80" r="20" fill="none" stroke="#dc2626" stroke-width="6" vector-effect="non-scaling-stroke"/></g>
    <rect x="40" y="170" width="120" height="100" fill="none" stroke="#000" stroke-width="20" transform="rotate(10 100 220)"/>
    <rect x="230" y="170" width="120" height="100" fill="#fde68a" stroke="#000" stroke-width="20" paint-order="stroke"/>`)],
  ['svg/inheritance-visibility', svg(`<rect width="400" height="300" fill="#fff"/>
    <g fill="#16a34a" stroke="#14532d" stroke-width="5"><rect x="20" y="20" width="100" height="100"/><circle cx="200" cy="70" r="50" fill="#f59e0b"/><rect x="280" y="20" width="100" height="100" style="display:none"/></g>
    <g visibility="hidden"><rect x="20" y="160" width="100" height="100" fill="#000"/><rect x="150" y="160" width="100" height="100" fill="#dc2626" visibility="visible"/></g>
    <rect x="280" y="160" width="100" height="100" fill="#000" display="none"/>`)],
  ['svg/image-data-uri', svg(`<rect width="400" height="300" fill="#fff"/>
    <image x="20" y="20" width="360" height="260" preserveAspectRatio="xMidYMid meet" href="data:image/svg+xml;base64,${typeof btoa === 'function' ? btoa('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="20" height="20" fill="#e11d48"/><rect x="20" width="20" height="20" fill="#2563eb"/></svg>') : Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="20" height="20" fill="#e11d48"/><rect x="20" width="20" height="20" fill="#2563eb"/></svg>').toString('base64')}"/>`)],
  ...[11, 23, 37].map(seed => [`svg/random-path-${seed}`, svg(`<rect width="400" height="300" fill="#fff"/><path d="${randomPath(seed)}" fill="#6366f1" fill-opacity=".8" fill-rule="evenodd" stroke="#111" stroke-width="2"/>`)]),
].map(([name, text]) => ({ name, svg: text, w: W, h: H }));
