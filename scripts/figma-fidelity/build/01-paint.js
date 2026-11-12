// paints (every paint type, multiple fills, image scale modes + filters) and layer/paint blend modes
await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
{
  const sec = await section('paint');
  const R = (f, fills, props) => rect(f, 50, 40, 300, 220, fills, props);
  R(cell(sec, 'paint/solid'), [solid('#3366FF')]);
  R(cell(sec, 'paint/solid-alpha'), [solid('#FF3355', 0.45)]);
  R(cell(sec, 'paint/linear'), [grad('GRADIENT_LINEAR', stops([0, '#FF0066'], [1, '#00AAFF']))]);
  R(cell(sec, 'paint/linear-angle-4stops'), [grad('GRADIENT_LINEAR', stops([0, '#FFE000'], [0.3, '#FF4D00'], [0.7, '#7A00FF'], [1, '#00E0B0']), 37)]);
  R(cell(sec, 'paint/linear-stop-alpha'), [grad('GRADIENT_LINEAR', stops([0, '#0044FF', 1], [1, '#0044FF', 0]), 90)]);
  R(cell(sec, 'paint/linear-short-span'), [grad('GRADIENT_LINEAR', stops([0, '#111111'], [1, '#FFCC00']), 0, 0.5, 0.5, 0.3, 1)]);
  R(cell(sec, 'paint/radial'), [grad('GRADIENT_RADIAL', stops([0, '#FFFFFF'], [0.5, '#FF7A00'], [1, '#3A0050']))]);
  R(cell(sec, 'paint/radial-offset-elliptic'), [grad('GRADIENT_RADIAL', stops([0, '#00FFAA'], [1, '#001133']), 25, 0.35, 0.4, 1.4, 0.7)]);
  R(cell(sec, 'paint/angular'), [grad('GRADIENT_ANGULAR', stops([0, '#FF0000'], [0.33, '#00FF00'], [0.66, '#0000FF'], [1, '#FF0000']))]);
  R(cell(sec, 'paint/angular-rotated'), [grad('GRADIENT_ANGULAR', stops([0, '#111144'], [0.5, '#FFDD55'], [1, '#111144']), 60, 0.4, 0.5)]);
  R(cell(sec, 'paint/diamond'), [grad('GRADIENT_DIAMOND', stops([0, '#FFFFFF'], [0.6, '#33AA88'], [1, '#002222']))]);
  R(cell(sec, 'paint/multi-fill'), [solid('#FFEEDD'), grad('GRADIENT_LINEAR', stops([0, '#FF0055', 0.8], [1, '#FF0055', 0]), 45), { ...grad('GRADIENT_RADIAL', stops([0, '#0066FF', 1], [1, '#0066FF', 0]), 0, 0.7, 0.7, 0.8, 0.8), opacity: 0.7 }]);
  R(cell(sec, 'paint/paint-opacity'), [{ ...grad('GRADIENT_LINEAR', stops([0, '#000000'], [1, '#FF00FF'])), opacity: 0.5 }]);
  R(cell(sec, 'paint/hidden-paint'), [solid('#22CC88'), { ...solid('#FF0000'), visible: false }]);
  R(cell(sec, 'paint/fill-blend-multiply'), [grad('GRADIENT_LINEAR', stops([0, '#FFCC00'], [1, '#00CCFF'])), { ...solid('#FF3366'), blendMode: 'MULTIPLY' }]);
  const img = testImage();
  R(cell(sec, 'paint/image-fill'), [{ type: 'IMAGE', imageHash: img, scaleMode: 'FILL' }]);
  R(cell(sec, 'paint/image-fit'), [solid('#202020'), { type: 'IMAGE', imageHash: img, scaleMode: 'FIT' }]);
  rect(cell(sec, 'paint/image-tile'), 0, 0, W, H, [{ type: 'IMAGE', imageHash: img, scaleMode: 'TILE', scalingFactor: 0.5 }]);
  R(cell(sec, 'paint/image-crop'), [{ type: 'IMAGE', imageHash: img, scaleMode: 'CROP', imageTransform: [[0.5, 0, 0.25], [0, 0.5, 0.3]] }]);
  R(cell(sec, 'paint/image-rotated'), [{ type: 'IMAGE', imageHash: img, scaleMode: 'FILL', rotation: 90 }]);
  R(cell(sec, 'paint/image-filters'), [{ type: 'IMAGE', imageHash: img, scaleMode: 'FILL', filters: { exposure: 0.3, contrast: 0.4, saturation: -0.6, temperature: 0.5, tint: 0.3, highlights: -0.4, shadows: 0.5 } }]);
  R(cell(sec, 'paint/image-opacity-over-solid'), [solid('#0033AA'), { type: 'IMAGE', imageHash: img, scaleMode: 'FILL', opacity: 0.5 }]);
  ellipse(cell(sec, 'paint/ellipse-gradient'), 70, 20, 260, 260, [grad('GRADIENT_LINEAR', stops([0, '#FF9A9E'], [1, '#6A11CB']), 120)]);
  const t = await text(cell(sec, 'paint/text-gradient'), 30, 90, 'Gradient', { style: 'Bold', size: 84, fills: [grad('GRADIENT_LINEAR', stops([0, '#FF0080'], [1, '#7928CA']))] });
  void t;
  var r1 = finish(sec);
}

{
  const sec = await section('blend');
  const modes = ['NORMAL', 'DARKEN', 'MULTIPLY', 'LINEAR_BURN', 'COLOR_BURN', 'LIGHTEN', 'SCREEN', 'LINEAR_DODGE', 'COLOR_DODGE', 'OVERLAY', 'SOFT_LIGHT', 'HARD_LIGHT', 'DIFFERENCE', 'EXCLUSION', 'HUE', 'SATURATION', 'COLOR', 'LUMINOSITY'];
  for (const m of modes) {
    const f = cell(sec, 'blend/' + m.toLowerCase().replace(/_/g, '-'));
    // backdrop: hue bars + a gray ramp
    const bars = ['#E63946', '#F4A261', '#E9C46A', '#2A9D8F', '#264653', '#8338EC', '#FFFFFF', '#000000'];
    bars.forEach((c, i) => rect(f, i * 50, 0, 50, 200, [solid(c)]));
    rect(f, 0, 200, W, 100, [grad('GRADIENT_LINEAR', stops([0, '#000000'], [1, '#FFFFFF']))]);
    ellipse(f, 60, 40, 280, 220, [grad('GRADIENT_LINEAR', stops([0, '#00C2FF'], [0.5, '#FF2E93'], [1, '#B6FF00']), 45)], { blendMode: m });
  }
  {
    // pass-through group vs normal group with a multiply child
    const f = cell(sec, 'blend/group-pass-through-vs-normal');
    rect(f, 0, 0, W, H, [grad('GRADIENT_LINEAR', stops([0, '#FFD000'], [1, '#00A0FF']))]);
    const a = ellipse(f, 30, 60, 160, 160, [solid('#FF0055')], { blendMode: 'MULTIPLY' });
    const g1 = figma.group([a], f); g1.name = 'pass-through';
    const b = ellipse(f, 210, 60, 160, 160, [solid('#FF0055')], { blendMode: 'MULTIPLY' });
    const g2 = figma.group([b], f); g2.name = 'normal'; g2.blendMode = 'NORMAL';
  }
  {
    const f = cell(sec, 'blend/layer-opacity-overlap');
    rect(f, 0, 0, W, H, [solid('#F0F0F0')]);
    const a = rect(f, 60, 60, 180, 140, [solid('#0055FF')]);
    const b = rect(f, 160, 110, 180, 140, [solid('#FF2200')]);
    const g = figma.group([a, b], f); g.opacity = 0.5;
  }
  var r2 = finish(sec);
}
return { paint: r1, blend: r2, created };
