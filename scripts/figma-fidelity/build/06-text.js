// text: fonts, weights, variable-font instances, styled runs, spacing, line height, decoration, case,
// lists, alignment, auto-resize, truncation, paragraph spacing
const LOREM = 'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.';
{
  const sec = await section('text');
  await text(cell(sec, 'text/inter-regular'), 24, 24, 'Hamburgefonstiv 0123', { size: 36 });
  {
    const f = cell(sec, 'text/inter-weights');
    const st = ['Thin', 'Light', 'Regular', 'Medium', 'Semi Bold', 'Bold', 'Black'];
    for (let i = 0; i < st.length; i++) await text(f, 24, 10 + i * 40, 'Weight ' + st[i], { style: st[i], size: 30 });
  }
  {
    const f = cell(sec, 'text/variable-font-weight');
    const st = ['Thin', 'Light', 'Regular', 'SemiBold', 'Bold', 'ExtraBlack'];
    for (let i = 0; i < st.length; i++) await text(f, 24, 10 + i * 46, 'Roboto Flex ' + st[i], { family: 'Roboto Flex', style: st[i], size: 32 });
  }
  {
    const f = cell(sec, 'text/italic-serif');
    await text(f, 24, 30, 'Playfair Italic', { family: 'Playfair Display', style: 'Italic', size: 44 });
    await text(f, 24, 110, 'Source Serif Bold', { family: 'Source Serif 4', style: 'Bold', size: 40 });
    await text(f, 24, 190, 'mono {code} 0O1l', { family: 'JetBrains Mono', style: 'Regular', size: 32 });
  }
  {
    const f = cell(sec, 'text/styled-runs');
    const t = await text(f, 24, 24, 'Bold red, italic blue, big green, tiny', { size: 30, w: 350 });
    await font('Inter', 'Bold'); await font('Inter', 'Italic');
    t.setRangeFontName(0, 8, { family: 'Inter', style: 'Bold' }); t.setRangeFills(0, 8, [solid('#DC2626')]);
    t.setRangeFontName(10, 21, { family: 'Inter', style: 'Italic' }); t.setRangeFills(10, 21, [solid('#2563EB')]);
    t.setRangeFontSize(23, 32, 48); t.setRangeFills(23, 32, [solid('#16A34A')]);
    t.setRangeFontSize(34, 38, 14);
    t.setRangeTextDecoration(0, 4, 'UNDERLINE');
  }
  {
    const f = cell(sec, 'text/letter-spacing');
    await text(f, 24, 30, 'TRACKING +20%', { style: 'Medium', size: 30, letterSpacing: { unit: 'PERCENT', value: 20 } });
    await text(f, 24, 110, 'tight -5%', { style: 'Bold', size: 44, letterSpacing: { unit: 'PERCENT', value: -5 } });
    await text(f, 24, 200, 'pixels 6px', { size: 30, letterSpacing: { unit: 'PIXELS', value: 6 } });
  }
  await text(cell(sec, 'text/line-height-px'), 24, 20, LOREM, { size: 22, w: 350, lineHeight: { unit: 'PIXELS', value: 40 } });
  await text(cell(sec, 'text/line-height-percent'), 24, 20, LOREM, { size: 22, w: 350, lineHeight: { unit: 'PERCENT', value: 85 } });
  await text(cell(sec, 'text/line-height-auto'), 24, 20, LOREM, { size: 22, w: 350 });
  {
    const f = cell(sec, 'text/decoration');
    await text(f, 24, 40, 'Underlined text', { size: 36, textDecoration: 'UNDERLINE' });
    await text(f, 24, 140, 'Struck through', { size: 36, textDecoration: 'STRIKETHROUGH' });
  }
  {
    const f = cell(sec, 'text/case');
    await text(f, 24, 10, 'upper case', { size: 30, textCase: 'UPPER' });
    await text(f, 24, 80, 'LOWER CASE', { size: 30, textCase: 'LOWER' });
    await text(f, 24, 150, 'title case words', { size: 30, textCase: 'TITLE' });
    try { await text(f, 24, 220, 'Small Caps', { family: 'Source Serif 4', size: 30, textCase: 'SMALL_CAPS' }); } catch (e) { f.children[f.children.length - 1].remove(); await text(f, 24, 220, 'small caps unsupported', { size: 20 }); }
  }
  {
    const f = cell(sec, 'text/lists');
    const t = await text(f, 24, 20, 'First bullet\nSecond bullet\nOne\nTwo\nThree', { size: 24, w: 350 });
    t.setRangeListOptions(0, 26, { type: 'UNORDERED' });
    t.setRangeListOptions(27, t.characters.length, { type: 'ORDERED' });
  }
  for (const al of ['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED']) await text(cell(sec, 'text/align-' + al.toLowerCase()), 24, 20, LOREM, { size: 24, w: 352, textAlignHorizontal: al });
  {
    const f = cell(sec, 'text/align-vertical');
    for (const [i, av] of ['TOP', 'CENTER', 'BOTTOM'].entries()) {
      const t = await text(f, 10 + i * 130, 40, av, { size: 22, w: 120, textAlignHorizontal: 'CENTER', textAutoResize: 'NONE' });
      t.resize(120, 220); t.textAlignVertical = av;
      const r = rect(f, 10 + i * 130, 40, 120, 220, [], { strokes: [solid('#94A3B8')], strokeWeight: 1 }); void r;
    }
  }
  {
    const f = cell(sec, 'text/auto-resize');
    await text(f, 24, 20, 'Width and height', { size: 28, textAutoResize: 'WIDTH_AND_HEIGHT' });
    await text(f, 24, 80, 'Fixed width, auto height wraps here', { size: 28, w: 220 });
    const t3 = await text(f, 24, 190, 'Fixed box clipped overflow text', { size: 28, w: 200, textAutoResize: 'NONE' }); t3.resize(200, 40);
  }
  {
    const f = cell(sec, 'text/truncate');
    const t = await text(f, 24, 40, LOREM, { size: 26, w: 340 });
    t.textAutoResize = 'TRUNCATE'; t.textTruncation = 'ENDING'; t.maxLines = 2;
  }
  await text(cell(sec, 'text/paragraph-spacing'), 24, 10, 'Paragraph one is here.\nParagraph two follows.\nAnd three.', { size: 22, w: 350, paragraphSpacing: 24 });
  {
    const f = cell(sec, 'text/rotated-opacity');
    const t = await text(f, 80, 60, 'Rotated', { style: 'Bold', size: 64, color: '#7C3AED' });
    t.rotation = -20; t.opacity = 0.6;
  }
  {
    const f = cell(sec, 'text/large-display', '#0B0B0F');
    await text(f, 16, 40, 'Ag', { style: 'Black', size: 200, color: '#F8FAFC' });
  }
  {
    const f = cell(sec, 'text/unicode');
    await text(f, 24, 30, 'Über café naïve — “quotes” …', { size: 28, w: 350 });
    await text(f, 24, 150, 'ﬁ ﬂ ligatures fi fl → ✓', { size: 28, w: 350 });
  }
  return finish(sec);
}
