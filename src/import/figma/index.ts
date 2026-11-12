// figma clipboard import: cmd+c in figma, cmd+v here.
import type { Asset, Layer } from '../../core/model';
import { extractFigmaBuffer, decodeFigKiwi, looksLikeFigmaHtml } from './decode';
import { figmaMessageToLayers, type FigmaDesignData, type FigmaShaderHooks } from './convert';
import { rememberPaste } from './capture';

export { extractFigmaBuffer, decodeFigKiwi, looksLikeFigmaHtml } from './decode';
export { figmaMessageToLayers, decodeCommandsBlob, type FigmaDesignData, type FigmaShaderHooks, type ShaderHookContext } from './convert';
export { lastPaste, buildCaptureFiles, captureJson } from './capture';

// shader paints / effects: the shader runtime's converter (./shaders.ts) is picked up when it exists.
// it may export convertShaderPaint / convertShaderEffect (see FigmaShaderHooks); without it shader
// paints and effects are skipped with a warning.
const shaderMods = import.meta.glob('./shaders.ts', { eager: true }) as Record<string, Partial<FigmaShaderHooks>>;
let hooks: FigmaShaderHooks | undefined;
for (const m of Object.values(shaderMods)) {
  if (typeof m?.convertShaderPaint === 'function' || typeof m?.convertShaderEffect === 'function') {
    hooks = { convertShaderPaint: m.convertShaderPaint?.bind(m), convertShaderEffect: m.convertShaderEffect?.bind(m) };
  }
}
/** override the shader hooks (tests, or a runtime that loads later) */
export function setFigmaShaderHooks(h: FigmaShaderHooks | undefined) { hooks = h; }

/** parse text/html clipboard data. returns null if it isn't figma data (or can't be decoded). */
export function parseFigmaClipboard(html: string): { layers: Layer[]; roots: string[]; assets: Asset[]; design: FigmaDesignData } | null {
  if (!html || !looksLikeFigmaHtml(html)) return null;
  const ex = extractFigmaBuffer(html);
  if (!ex) return null;
  let message: any;
  try {
    message = decodeFigKiwi(ex.buffer).message;
  } catch (e) {
    console.warn('[figma import] could not decode clipboard buffer', e);
    rememberPaste(html, null, null, String(e));
    return null;
  }
  if (!message || !Array.isArray(message.nodeChanges)) { rememberPaste(html, message, null, 'no nodeChanges'); return null; }
  const res = figmaMessageToLayers(message, { shaders: hooks });
  rememberPaste(html, message, res.design.warnings ?? [], null);
  if (res.design.warnings?.length) console.info('[figma import] ' + res.design.warnings.join('; '));
  return res;
}
