// masks (alpha / vector / luminance), boolean operations, vector networks + winding, instances with overrides
await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });
const backdrop = f => {
  const bars = ['#EF4444', '#F59E0B', '#10B981', '#3B82F6', '#8B5CF6'];
  bars.forEach((c, i) => rect(f, 0, i * 60, W, 60, [solid(c)]));
  for (let i = 0; i < 8; i++) ellipse(f, 20 + i * 48, 20 + (i % 3) * 90, 40, 40, [solid('#FFFFFF', 0.8)]);
};
{
  const sec = await section('geometry');
  for (const mt of ['ALPHA', 'VECTOR', 'LUMINANCE']) {
    const f = cell(sec, 'mask/' + mt.toLowerCase());
    const m = mt === 'LUMINANCE'
      ? rect(f, 50, 40, 300, 220, [grad('GRADIENT_LINEAR', stops([0, '#FFFFFF'], [1, '#000000']))], { cornerRadius: 60 })
      : mt === 'ALPHA'
        ? ellipse(f, 50, 20, 300, 260, [grad('GRADIENT_RADIAL', stops([0, '#000000', 1], [1, '#000000', 0]))])
        : ellipse(f, 50, 20, 300, 260, [solid('#000000', 0.3)]);
    const tmp = figma.createFrame(); f.appendChild(tmp); tmp.resize(W, H); tmp.fills = []; backdrop(tmp);
    const kids = tmp.children.slice();
    const g = figma.group([m, ...kids], f); tmp.remove();
    m.isMask = true; m.maskType = mt; g.name = 'masked';
  }
  {
    const f = cell(sec, 'mask/text-mask');
    const t = await text(f, 20, 80, 'MASK', { style: 'Bold', size: 130 });
    const img = rect(f, 0, 0, W, H, [{ type: 'IMAGE', imageHash: testImage(), scaleMode: 'FILL' }]);
    const g = figma.group([t, img], f); t.isMask = true; g.name = 'text-masked';
  }
  {
    const f = cell(sec, 'mask/two-masks');
    const m1 = rect(f, 20, 20, 170, 260, [solid('#000000')], { cornerRadius: 30 });
    const a = rect(f, 0, 0, W, H, [grad('GRADIENT_LINEAR', stops([0, '#F43F5E'], [1, '#6366F1']))]);
    const g1 = figma.group([m1, a], f); m1.isMask = true;
    const m2 = ellipse(f, 210, 40, 170, 220, [solid('#000000')]);
    const b = rect(f, 0, 0, W, H, [grad('GRADIENT_LINEAR', stops([0, '#22C55E'], [1, '#0EA5E9']), 90)]);
    const g2 = figma.group([m2, b], f); m2.isMask = true;
    void g1; void g2;
  }
  const ops = { union: 'union', subtract: 'subtract', intersect: 'intersect', exclude: 'exclude' };
  for (const k of Object.keys(ops)) {
    const f = cell(sec, 'bool/' + k);
    const a = rect(f, 70, 60, 180, 160, [solid('#6366F1')], { cornerRadius: 20 });
    const b = ellipse(f, 170, 90, 170, 170, [solid('#F59E0B')]);
    const s = figma.createStar(); f.appendChild(s); s.x = 120; s.y = 150; s.resize(110, 110); s.fills = [solid('#10B981')];
    const r = figma[ops[k]]([a, b, s], f);
    r.name = k;
    // boolean results take a neutral default fill: give each op its own color
    r.fills = [solid({ union: '#6366F1', subtract: '#F59E0B', intersect: '#10B981', exclude: '#DB2777' }[k])];
  }
  {
    const f = cell(sec, 'bool/nested-with-stroke');
    const a = rect(f, 60, 60, 160, 160, [solid('#0EA5E9')]);
    const b = ellipse(f, 140, 100, 180, 140, [solid('#0EA5E9')]);
    const u = figma.union([a, b], f);
    const c = ellipse(f, 170, 130, 60, 60, [solid('#000000')]);
    const s = figma.subtract([u, c], f);
    s.strokes = [solid('#0F172A')]; s.strokeWeight = 6; s.fills = [grad('GRADIENT_LINEAR', stops([0, '#38BDF8'], [1, '#A78BFA']))];
  }
  {
    const f = cell(sec, 'vector/even-odd');
    await vec(f, 60, 20, 280, 260, 'M 140 0 L 222 260 L 0 98 L 280 98 L 58 260 Z', [solid('#DC2626')], {}, 'EVENODD');
  }
  {
    const f = cell(sec, 'vector/nonzero');
    await vec(f, 60, 20, 280, 260, 'M 140 0 L 222 260 L 0 98 L 280 98 L 58 260 Z', [solid('#2563EB')], {}, 'NONZERO');
  }
  {
    const f = cell(sec, 'vector/holes-nested');
    await vec(f, 50, 25, 300, 250, 'M 0 0 L 300 0 L 300 250 L 0 250 Z M 40 40 L 40 210 L 260 210 L 260 40 Z M 80 80 L 220 80 L 220 170 L 80 170 Z M 120 110 L 120 140 L 180 140 L 180 110 Z', [solid('#059669')], {}, 'NONZERO');
  }
  {
    const f = cell(sec, 'vector/curves');
    await vec(f, 40, 30, 320, 240, 'M 0 120 C 0 0 160 0 160 120 C 160 240 320 240 320 120 Q 240 -60 160 120 Q 80 300 0 120 Z', [grad('GRADIENT_LINEAR', stops([0, '#F97316'], [1, '#DB2777']), 30)], {}, 'EVENODD');
  }
  {
    const f = cell(sec, 'vector/network-regions');
    const v = figma.createVector(); f.appendChild(v);
    await v.setVectorNetworkAsync({
      vertices: [{ x: 0, y: 0 }, { x: 150, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 220 }, { x: 150, y: 220 }, { x: 0, y: 220 }, { x: 150, y: 110 }],
      segments: [
        { start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 4 }, { start: 4, end: 5 }, { start: 5, end: 0 },
        { start: 1, end: 6 }, { start: 6, end: 4 }, { start: 0, end: 6, tangentStart: { x: 60, y: 60 }, tangentEnd: { x: -40, y: -20 } },
      ],
      regions: [
        { windingRule: 'NONZERO', loops: [[0, 6, 8]], fills: [solid('#F59E0B')] },
        { windingRule: 'NONZERO', loops: [[1, 2, 3, 7, 6]], fills: [solid('#3B82F6')] },
        { windingRule: 'NONZERO', loops: [[8, 7, 4, 5]], fills: [solid('#10B981')] },
      ],
    });
    v.x = 50; v.y = 40;
    v.strokes = [solid('#111827')]; v.strokeWeight = 4; v.strokeJoin = 'ROUND';
  }
  {
    const f = cell(sec, 'vector/open-network-stroke');
    const v = figma.createVector(); f.appendChild(v);
    await v.setVectorNetworkAsync({
      vertices: [{ x: 0, y: 100 }, { x: 100, y: 0 }, { x: 200, y: 100 }, { x: 100, y: 200 }, { x: 300, y: 100 }],
      segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 2, end: 4, tangentStart: { x: 40, y: -80 }, tangentEnd: { x: -40, y: 80 } }],
      regions: [],
    });
    v.x = 50; v.y = 50; v.fills = []; v.strokes = [solid('#7C3AED')]; v.strokeWeight = 10; v.strokeCap = 'ROUND'; v.strokeJoin = 'ROUND';
  }
  {
    const f = cell(sec, 'vector/scaled-vector');
    const v = await vec(f, 0, 0, 0, 0, MARK, [solid('#0F172A')], {}, 'EVENODD');
    v.resize(320, 120); v.x = 40; v.y = 90;
  }
  {
    const f = cell(sec, 'vector/flattened-text');
    const t = await text(f, 30, 80, 'Path', { style: 'Bold', size: 120, color: '#BE123C' });
    figma.flatten([t], f);
  }
  var rg = finish(sec);
}
{
  const sec = await section('instance');
  const fm = cell(sec, 'instance/main-component');
  const comp = figma.createComponent(); fm.appendChild(comp); comp.name = 'Button'; comp.resize(240, 80); comp.x = 80; comp.y = 110;
  comp.fills = [grad('GRADIENT_LINEAR', stops([0, '#6366F1'], [1, '#EC4899']))]; comp.cornerRadius = 40;
  comp.effects = [{ type: 'DROP_SHADOW', color: rgba('#000000', 0.25), offset: { x: 0, y: 6 }, radius: 12, spread: 0, visible: true, blendMode: 'NORMAL' }];
  const icon = ellipse(comp, 24, 20, 40, 40, [solid('#FFFFFF')]); icon.name = 'icon';
  const label = await text(comp, 80, 24, 'Continue', { style: 'Bold', size: 26, color: '#FFFFFF' }); label.name = 'label';
  {
    const f = cell(sec, 'instance/default');
    const i = comp.createInstance(); f.appendChild(i); i.x = 80; i.y = 110;
  }
  {
    const f = cell(sec, 'instance/overrides');
    const i = comp.createInstance(); f.appendChild(i); i.x = 80; i.y = 110;
    i.fills = [solid('#0F172A')];
    const l = i.findOne(n => n.name === 'label'); l.characters = 'Override'; l.fills = [solid('#FACC15')];
    const ic = i.findOne(n => n.name === 'icon'); ic.fills = [solid('#22C55E')];
  }
  {
    const f = cell(sec, 'instance/resized-rotated');
    const i = comp.createInstance(); f.appendChild(i); i.resize(320, 100); i.x = 50; i.y = 120; i.rotation = 12;
  }
  {
    const f = cell(sec, 'instance/nested');
    const card = figma.createComponent(); f.appendChild(card); card.name = 'Card'; card.resize(300, 220); card.x = 50; card.y = 40;
    card.fills = [solid('#F1F5F9')]; card.cornerRadius = 20;
    await text(card, 24, 20, 'Card title', { style: 'Bold', size: 28 });
    const inner = comp.createInstance(); card.appendChild(inner); inner.x = 30; inner.y = 120;
    const f2 = cell(sec, 'instance/nested-instance');
    const ci = card.createInstance(); f2.appendChild(ci); ci.x = 50; ci.y = 40;
    const lab = ci.findOne(n => n.name === 'label'); if (lab) lab.characters = 'Nested';
  }
  var ri = finish(sec);
}
return { geometry: rg, instance: ri };
