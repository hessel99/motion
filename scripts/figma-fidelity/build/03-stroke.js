// strokes: align, dashes, caps, joins, per-side, gradient, multiple, text
await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });
{
  const sec = await section('stroke');
  const box = (f, props) => rect(f, 100, 60, 200, 180, [solid('#DDE7FF')], { strokes: [solid('#1A1A1A')], strokeWeight: 12, ...props });
  box(cell(sec, 'stroke/center'), { strokeAlign: 'CENTER' });
  box(cell(sec, 'stroke/inside'), { strokeAlign: 'INSIDE' });
  box(cell(sec, 'stroke/outside'), { strokeAlign: 'OUTSIDE' });
  box(cell(sec, 'stroke/radius-outside'), { strokeAlign: 'OUTSIDE', cornerRadius: 40 });
  box(cell(sec, 'stroke/dash-center'), { dashPattern: [24, 12], strokeWeight: 6 });
  box(cell(sec, 'stroke/dash-outside-round'), { dashPattern: [2, 14], strokeWeight: 8, strokeAlign: 'OUTSIDE', strokeCap: 'ROUND', cornerRadius: 30 });
  box(cell(sec, 'stroke/gradient'), { strokes: [grad('GRADIENT_LINEAR', stops([0, '#FF0066'], [1, '#00CCFF']), 45)], strokeWeight: 16, cornerRadius: 24 });
  box(cell(sec, 'stroke/multiple'), { strokes: [solid('#00AA66'), { ...solid('#FF0000'), opacity: 0.5 }], strokeWeight: 14 });
  {
    const f = cell(sec, 'stroke/per-side');
    const fr = figma.createFrame(); f.appendChild(fr); fr.x = 100; fr.y = 60; fr.resize(200, 180); fr.fills = [solid('#FFF1D6')];
    fr.strokes = [solid('#222222')]; fr.strokeAlign = 'INSIDE';
    fr.strokeTopWeight = 2; fr.strokeRightWeight = 10; fr.strokeBottomWeight = 20; fr.strokeLeftWeight = 0;
  }
  {
    const f = cell(sec, 'stroke/caps');
    const caps = ['NONE', 'ROUND', 'SQUARE', 'ARROW_LINES', 'ARROW_EQUILATERAL', 'TRIANGLE_FILLED', 'CIRCLE_FILLED', 'DIAMOND_FILLED'];
    for (let i = 0; i < caps.length; i++) {
      const v = await vec(f, 60, 25 + i * 34, 0, 0, 'M 0 0 L 280 0', [], { strokes: [solid('#1A1A1A')], strokeWeight: 10 });
      try { v.strokeCap = caps[i]; } catch (e) { v.name = 'cap-failed-' + caps[i]; }
      v.x = 60; v.y = 25 + i * 34;
    }
  }
  {
    const f = cell(sec, 'stroke/joins');
    const joins = ['MITER', 'BEVEL', 'ROUND'];
    for (let i = 0; i < 3; i++) {
      const v = await vec(f, 30 + i * 125, 70, 0, 0, 'M 0 160 L 50 0 L 100 160', [], { strokes: [solid('#3344AA')], strokeWeight: 18, strokeJoin: joins[i] });
      v.x = 30 + i * 125; v.y = 70;
    }
  }
  {
    const f = cell(sec, 'stroke/open-curve');
    const v = await vec(f, 40, 50, 0, 0, 'M 0 100 C 60 -40 140 240 200 100 C 260 -40 300 0 320 120', [], { strokes: [solid('#E63946')], strokeWeight: 8, strokeCap: 'ROUND' });
    v.x = 40; v.y = 50;
  }
  {
    const f = cell(sec, 'stroke/text-stroke');
    await text(f, 30, 90, 'Outline', { style: 'Bold', size: 90, fills: [solid('#FFFFFF')] }).then(t => { t.strokes = [solid('#111111')]; t.strokeWeight = 3; t.strokeAlign = 'OUTSIDE'; });
  }
  {
    const f = cell(sec, 'stroke/ellipse-inside-dashed');
    ellipse(f, 110, 60, 180, 180, [solid('#FDE68A')], { strokes: [solid('#B45309')], strokeWeight: 10, strokeAlign: 'INSIDE', dashPattern: [20, 10] });
  }
  {
    const f = cell(sec, 'stroke/hairline');
    for (let i = 0; i < 10; i++) rect(f, 20 + i * 37, 40, 30, 220, [], { strokes: [solid('#000000')], strokeWeight: 0.5 + i * 0.25 });
  }
  return finish(sec);
}
