// effects: shadows, layer/background/progressive blur, noise, texture, glass
await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });
const shadow = (type, x, y, r, s, c, a, extra = {}) => ({ type, color: rgba(c, a), offset: { x, y }, radius: r, spread: s, visible: true, blendMode: 'NORMAL', ...extra });
{
  const sec = await section('effect');
  const card = (f, effects, fills = [solid('#FFFFFF')], props = {}) => rect(f, 100, 70, 200, 160, fills, { cornerRadius: 16, effects, ...props });
  card(cell(sec, 'effect/drop-shadow', '#EEF1F5'), [shadow('DROP_SHADOW', 0, 12, 24, 0, '#0B1A33', 0.35)]);
  card(cell(sec, 'effect/drop-shadow-spread', '#EEF1F5'), [shadow('DROP_SHADOW', 10, 10, 0, 8, '#FF3366', 1)]);
  card(cell(sec, 'effect/drop-shadow-multi', '#EEF1F5'), [shadow('DROP_SHADOW', 0, 2, 4, 0, '#000000', 0.2), shadow('DROP_SHADOW', 0, 24, 48, -8, '#3300AA', 0.4), shadow('DROP_SHADOW', -20, -10, 30, 4, '#00CC88', 0.5)]);
  card(cell(sec, 'effect/drop-shadow-behind-transparent', '#EEF1F5'), [shadow('DROP_SHADOW', 14, 14, 10, 0, '#000000', 0.5, { showShadowBehindNode: true })], [solid('#3366FF', 0.35)]);
  card(cell(sec, 'effect/inner-shadow', '#EEF1F5'), [shadow('INNER_SHADOW', 6, 8, 12, 2, '#000000', 0.45)], [solid('#FFCC33')]);
  {
    const f = cell(sec, 'effect/drop-shadow-text', '#F4F4F4');
    const t = await text(f, 40, 100, 'Shadow', { style: 'Bold', size: 80, color: '#FF5533' });
    t.effects = [shadow('DROP_SHADOW', 4, 6, 6, 0, '#000000', 0.5)];
  }
  {
    const f = cell(sec, 'effect/drop-shadow-ellipse-stroke', '#EEF1F5');
    ellipse(f, 120, 70, 160, 160, [], { strokes: [solid('#2244FF')], strokeWeight: 10, effects: [shadow('DROP_SHADOW', 0, 10, 16, 0, '#2244FF', 0.6)] });
  }
  const blurSubject = async f => { await pattern(f); };
  {
    const f = cell(sec, 'effect/layer-blur');
    const g = figma.createFrame(); f.appendChild(g); g.resize(W, H); g.fills = []; g.name = 'subject';
    await blurSubject(g); g.effects = [{ type: 'LAYER_BLUR', blurType: 'NORMAL', radius: 12, visible: true }];
  }
  {
    const f = cell(sec, 'effect/layer-blur-shape');
    ellipse(f, 110, 60, 180, 180, [solid('#FF2266')], { effects: [{ type: 'LAYER_BLUR', blurType: 'NORMAL', radius: 30, visible: true }] });
  }
  {
    const f = cell(sec, 'effect/progressive-blur');
    const g = figma.createFrame(); f.appendChild(g); g.resize(W, H); g.fills = []; g.name = 'subject';
    await blurSubject(g); g.effects = [{ type: 'LAYER_BLUR', blurType: 'PROGRESSIVE', radius: 24, startRadius: 0, startOffset: { x: 0.5, y: 0 }, endOffset: { x: 0.5, y: 1 }, visible: true }];
  }
  {
    const f = cell(sec, 'effect/background-blur');
    await pattern(f);
    rect(f, 60, 60, 280, 180, [solid('#FFFFFF', 0.25)], { cornerRadius: 24, effects: [{ type: 'BACKGROUND_BLUR', blurType: 'NORMAL', radius: 20, visible: true }] });
  }
  {
    const f = cell(sec, 'effect/progressive-background-blur');
    await pattern(f);
    rect(f, 0, 150, W, 150, [solid('#FFFFFF', 0.1)], { effects: [{ type: 'BACKGROUND_BLUR', blurType: 'PROGRESSIVE', radius: 30, startRadius: 0, startOffset: { x: 0.5, y: 0 }, endOffset: { x: 0.5, y: 1 }, visible: true }] });
  }
  const noiseCard = (name, eff) => { const f = cell(sec, name); rect(f, 0, 0, W, H, [grad('GRADIENT_LINEAR', stops([0, '#2B5876'], [1, '#4E4376']), 20)], { effects: [eff] }); };
  noiseCard('effect/noise-mono', { type: 'NOISE', noiseType: 'MONOTONE', noiseSize: 2, density: 0.6, color: rgba('#FFFFFF', 0.35), visible: true });
  noiseCard('effect/noise-duo', { type: 'NOISE', noiseType: 'DUOTONE', noiseSize: 3, density: 0.5, color: rgba('#FF3366', 1), secondaryColor: rgba('#33FFCC', 1), visible: true });
  noiseCard('effect/noise-multi', { type: 'NOISE', noiseType: 'MULTITONE', noiseSize: 1.5, density: 0.8, opacity: 0.6, color: rgba('#FFFFFF', 1), visible: true });
  {
    const f = cell(sec, 'effect/texture');
    const g = figma.createFrame(); f.appendChild(g); g.resize(W, H); g.fills = []; g.name = 'subject';
    await pattern(g); g.effects = [{ type: 'TEXTURE', noiseSize: 4, radius: 3, clipToShape: true, visible: true }];
  }
  {
    const f = cell(sec, 'effect/glass');
    await pattern(f);
    rect(f, 80, 60, 240, 180, [solid('#FFFFFF', 0.08)], { cornerRadius: 40, effects: [{ type: 'GLASS', refraction: 0.6, depth: 30, lightIntensity: 0.6, lightAngle: 45, dispersion: 0.3, radius: 6, visible: true }] });
  }
  {
    const f = cell(sec, 'effect/frame-shadow-clip', '#EEF1F5');
    const inner = figma.createFrame(); f.appendChild(inner); inner.x = 80; inner.y = 50; inner.resize(240, 200); inner.cornerRadius = 20;
    inner.fills = [solid('#FFFFFF')]; inner.clipsContent = true; inner.effects = [shadow('DROP_SHADOW', 0, 16, 30, 0, '#000000', 0.3)];
    ellipse(inner, 140, 120, 200, 200, [solid('#7B61FF')]);
  }
  return finish(sec);
}
