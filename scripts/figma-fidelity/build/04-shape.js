// shapes: radius, smoothing, arcs, star/polygon/line, rotation, flips, nested clipping, groups
await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });
{
  const sec = await section('shape');
  const sh = '#4F46E5';
  rect(cell(sec, 'shape/corner-radius'), 80, 50, 240, 200, [solid(sh)], { cornerRadius: 32 });
  rect(cell(sec, 'shape/corner-per-corner'), 80, 50, 240, 200, [solid(sh)], { topLeftRadius: 0, topRightRadius: 40, bottomRightRadius: 90, bottomLeftRadius: 10 });
  rect(cell(sec, 'shape/corner-smoothing'), 80, 50, 240, 200, [solid(sh)], { cornerRadius: 60, cornerSmoothing: 1 });
  rect(cell(sec, 'shape/corner-radius-clamped'), 80, 50, 240, 120, [solid(sh)], { cornerRadius: 200 });
  ellipse(cell(sec, 'shape/ellipse-arc'), 100, 50, 200, 200, [solid('#F97316')], { arcData: { startingAngle: 0, endingAngle: 4.2, innerRadius: 0 } });
  ellipse(cell(sec, 'shape/donut'), 100, 50, 200, 200, [solid('#10B981')], { arcData: { startingAngle: 0.5, endingAngle: 6.0, innerRadius: 0.55 } });
  { const f = cell(sec, 'shape/star'); const s = figma.createStar(); f.appendChild(s); s.x = 100; s.y = 50; s.resize(200, 200); s.pointCount = 7; s.innerRadius = 0.45; s.fills = [solid('#EAB308')]; }
  { const f = cell(sec, 'shape/polygon'); const s = figma.createPolygon(); f.appendChild(s); s.x = 100; s.y = 50; s.resize(200, 190); s.pointCount = 6; s.fills = [solid('#06B6D4')]; s.cornerRadius = 12; }
  { const f = cell(sec, 'shape/line'); const l = figma.createLine(); f.appendChild(l); l.x = 50; l.y = 150; l.resize(300, 0); l.strokes = [solid('#111111')]; l.strokeWeight = 6; l.rotation = 20; }
  { const f = cell(sec, 'shape/rotation'); const r = rect(f, 120, 80, 160, 120, [grad('GRADIENT_LINEAR', stops([0, '#22D3EE'], [1, '#A855F7']))], { cornerRadius: 12 }); r.rotation = 30; }
  {
    const f = cell(sec, 'shape/flip-h');
    const g = figma.createFrame(); f.appendChild(g); g.resize(200, 160); g.fills = [grad('GRADIENT_LINEAR', stops([0, '#F43F5E'], [1, '#FACC15']))];
    await text(g, 20, 50, 'Flip', { style: 'Bold', size: 56, color: '#FFFFFF' });
    g.relativeTransform = [[-1, 0, 300], [0, 1, 70]];
  }
  {
    const f = cell(sec, 'shape/flip-v-rotated');
    const g = figma.createFrame(); f.appendChild(g); g.resize(200, 160); g.fills = [grad('GRADIENT_LINEAR', stops([0, '#22C55E'], [1, '#0EA5E9']))];
    await text(g, 20, 50, 'Flip', { style: 'Bold', size: 56, color: '#FFFFFF' });
    const a = 0.3; g.relativeTransform = [[Math.cos(a), Math.sin(a), 110], [Math.sin(a), -Math.cos(a), 220]];
  }
  {
    const f = cell(sec, 'shape/nested-clip');
    const a = figma.createFrame(); f.appendChild(a); a.x = 40; a.y = 40; a.resize(320, 220); a.fills = [solid('#1E293B')]; a.cornerRadius = 24; a.clipsContent = true;
    const b = figma.createFrame(); a.appendChild(b); b.x = 160; b.y = 80; b.resize(220, 200); b.fills = [solid('#38BDF8')]; b.cornerRadius = 40; b.clipsContent = true; b.rotation = 15;
    ellipse(b, 60, 60, 200, 200, [solid('#F472B6')]);
  }
  {
    const f = cell(sec, 'shape/nested-noclip');
    const a = figma.createFrame(); f.appendChild(a); a.x = 60; a.y = 60; a.resize(200, 140); a.fills = [solid('#FDE68A')]; a.clipsContent = false;
    ellipse(a, 120, 60, 180, 180, [solid('#EF4444', 0.8)]);
  }
  {
    const f = cell(sec, 'shape/group-rotated');
    const a = rect(f, 120, 90, 100, 80, [solid('#6366F1')]);
    const b = ellipse(f, 190, 130, 90, 90, [solid('#F59E0B')]);
    const g = figma.group([a, b], f); g.rotation = -25;
  }
  {
    const f = cell(sec, 'shape/frame-radius-clip-image');
    const a = figma.createFrame(); f.appendChild(a); a.x = 80; a.y = 50; a.resize(240, 200); a.cornerRadius = 60; a.clipsContent = true;
    a.fills = [{ type: 'IMAGE', imageHash: testImage(), scaleMode: 'FILL' }];
  }
  return finish(sec);
}
