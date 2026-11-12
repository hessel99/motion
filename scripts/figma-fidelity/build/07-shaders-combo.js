// figma shaders: every fill shader as a fill, every effect shader on a frame holding the test pattern.
// the plugin api can only apply shaders that figma.listAvailableShaders() returns (the account's own
// library shaders); figma's first-party shaders have to be applied by hand in the editor: their frames
// are created with the test pattern and an empty slot, and the dump marks them `shaderMissing`.
// SHADERS is filled in from the list_shaders mcp tool (names + kinds only, no source).
const SHADERS = [
  ['effect', 'Crayon sketch'], ['effect', 'Duotone'], ['effect', 'Glowing particles'], ['effect', 'Warp'], ['effect', 'Slice shift'],
  ['effect', 'Shape-based particles'], ['effect', 'Pixelate'], ['effect', 'Pixel stretch'], ['effect', 'Pattern refraction'], ['effect', 'Moving blobs'],
  ['effect', 'Light rays'], ['effect', 'Lens distortion'], ['effect', 'Hatching'], ['effect', 'Halftone'], ['effect', 'Gradient map'],
  ['effect', 'Gooey merge'], ['effect', 'Filter presets'], ['effect', 'Dither'], ['effect', 'CRT Screen'], ['effect', 'Colored edges'],
  ['effect', 'Color adjust'], ['effect', 'Chromatic metal'], ['effect', 'Channel mixer'], ['effect', 'Bloom'], ['effect', 'Bokeh blur'],
  ['effect', 'Outlines'], ['effect', 'Midpoint mirror'],
  ['fill', 'Water caustic'], ['fill', 'Pattern grid'], ['fill', 'Nebula'], ['fill', 'Moving gradient'], ['fill', 'Moire'], ['fill', 'Mesh gradient'],
  ['fill', 'Glowing wave'], ['fill', 'Fractal noise'], ['fill', 'Concentric patterns'], ['fill', 'Clouds'], ['fill', 'Waveform gradient'],
];
await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });
const avail = await figma.listAvailableShaders();
const byName = new Map();
for (const s of avail) byName.set(s.name, s);
const applied = [], missing = [];
async function shaderRef(name) {
  const s = byName.get(name);
  if (!s) return null;
  if (!s.imported) await figma.importShaderById(s.id);
  return s.id;
}
{
  const sec = await section('shader-fill');
  for (const [kind, name] of SHADERS) {
    if (kind !== 'fill') continue;
    const f = cell(sec, 'shader-fill/' + name);
    const r = rect(f, 0, 0, W, H, [solid('#808080')]); r.name = 'shader-slot';
    const id = await shaderRef(name);
    if (id) { r.fills = [{ type: 'SHADER', id, visible: true }]; applied.push(name); } else missing.push(name);
  }
  var rf = finish(sec);
}
{
  const sec = await section('shader-effect');
  for (const [kind, name] of SHADERS) {
    if (kind !== 'effect') continue;
    const f = cell(sec, 'shader-effect/' + name);
    const g = figma.createFrame(); f.appendChild(g); g.resize(W, H); g.fills = []; g.name = 'shader-slot'; g.clipsContent = true;
    await pattern(g);
    const id = await shaderRef(name);
    if (id) { g.effects = [{ type: 'SHADER', id, visible: true }]; applied.push(name); } else missing.push(name);
  }
  var re = finish(sec);
}
{
  const sec = await section('combo');
  const brand = async (name, withShader, withEffectShader) => {
    const f = cell(sec, name);
    f.fills = [grad('GRADIENT_LINEAR', stops([0, '#0F0C29'], [0.5, '#302B63'], [1, '#24243E']), 60)];
    const bg = rect(f, 0, 0, W, H, [grad('GRADIENT_RADIAL', stops([0, '#FF6A88', 0.9], [1, '#FF6A88', 0]), 0, 0.75, 0.2, 1.2, 1.2)]);
    bg.effects = [{ type: 'NOISE', noiseType: 'MONOTONE', noiseSize: 1.2, density: 0.7, color: rgba('#FFFFFF', 0.18), visible: true }];
    bg.name = 'glow';
    if (withShader) {
      const ov = rect(f, 0, 150, W, 150, [solid('#808080')], { opacity: 0.55, blendMode: 'SCREEN' }); ov.name = 'shader-overlay';
      const id = await shaderRef('Waveform gradient');
      if (id) ov.fills = [{ type: 'SHADER', id, visible: true }];
    }
    const lockup = figma.createFrame(); f.appendChild(lockup); lockup.name = 'lockup'; lockup.fills = []; lockup.resize(300, 90); lockup.x = 50; lockup.y = 105; lockup.clipsContent = false;
    await vec(lockup, 0, 5, 90, 79, MARK, [grad('GRADIENT_LINEAR', stops([0, '#FFD3A5'], [1, '#FD6585']), 90)], {}, 'EVENODD');
    await text(lockup, 110, 12, 'motion', { style: 'Bold', size: 58, color: '#FFFFFF', letterSpacing: { unit: 'PERCENT', value: -3 } });
    if (withEffectShader) {
      const id = await shaderRef('Crayon sketch');
      if (id) lockup.effects = [{ type: 'SHADER', id, visible: true }];
    }
  };
  await brand('combo/brand-no-shader', false, false);
  await brand('combo/brand', true, false);
  await brand('combo/brand-effect-shader', true, true);
  var rc = finish(sec);
}
return { fill: rf, effect: re, combo: rc, applied, missing };
