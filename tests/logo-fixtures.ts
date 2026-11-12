// generic (idea-less) logo stings the logo critic must score clearly lower than the gold logo examples:
// every part pops or fades in, the wordmark fades in over the top. built with the real tools.

const mark = (anim: (i: number) => any) => [
  { key: 'm1', type: 'ellipse', x: 640, y: 420, w: 160, h: 160, fill: '#38BDF8', ...anim(0) },
  { key: 'm2', type: 'rect', x: 700, y: 520, w: 180, h: 60, radius: 30, fill: '#F8FAFC', ...anim(1) },
  { key: 'm3', type: 'polygon', points: 3, x: 760, y: 400, w: 120, h: 110, fill: '#F59E0B', ...anim(2) },
];

/** parts pop in (scale 0 → 100, Back Out) one after another, wordmark fades up */
export const POP_LOGO = {
  comp: { duration: 5, background: '#0F172A' },
  layers: [
    ...mark(i => ({ enter: { t: 0.3 + i * 0.12, duration: 0.5, from: { scale: 0 }, ease: 'Back Out' } })),
    { key: 'word', text: 'Lumo', fontSize: 140, fontWeight: 800, x: 940, y: 440, fill: '#F8FAFC', enter: { t: 0.8, duration: 0.6, from: { opacity: 0 } } },
  ],
};

/** everything fades in together, then sits */
export const FADE_LOGO = {
  comp: { duration: 5, background: '#0F172A' },
  layers: [
    ...mark(() => ({ enter: { t: 0, duration: 1, from: { opacity: 0 } } })),
    { key: 'word', text: 'Lumo', fontSize: 140, fontWeight: 800, x: 940, y: 440, fill: '#F8FAFC', enter: { t: 0, duration: 1, from: { opacity: 0 } } },
  ],
};

/** a slow scale-in of everything at once, wordmark with it, a 7 s piece that locks late */
export const ZOOM_LOGO = {
  comp: { duration: 9, background: '#0F172A' },
  layers: [
    ...mark(() => ({ enter: { t: 0, duration: 4.5, from: { scale: 60, opacity: 0 }, ease: 'Ease In Out' } })),
    { key: 'word', text: 'Lumo', fontSize: 140, fontWeight: 800, x: 940, y: 440, fill: '#F8FAFC', enter: { t: 0, duration: 4.5, from: { scale: 60, opacity: 0 }, ease: 'Ease In Out' } },
  ],
};
