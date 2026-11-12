// figma clipboard import: cmd+c in figma, cmd+v here.
import type { Asset, Layer } from '../../core/model';
import { extractFigmaBuffer, decodeFigKiwi, looksLikeFigmaHtml } from './decode';
import { figmaMessageToLayers } from './convert';

export { extractFigmaBuffer, decodeFigKiwi, looksLikeFigmaHtml } from './decode';
export { figmaMessageToLayers, decodeCommandsBlob } from './convert';

/** parse text/html clipboard data. returns null if it isn't figma data (or can't be decoded). */
export function parseFigmaClipboard(html: string): { layers: Layer[]; roots: string[]; assets: Asset[] } | null {
  if (!html || !looksLikeFigmaHtml(html)) return null;
  const ex = extractFigmaBuffer(html);
  if (!ex) return null;
  let message: any;
  try {
    message = decodeFigKiwi(ex.buffer).message;
  } catch (e) {
    console.warn('[figma import] could not decode clipboard buffer', e);
    return null;
  }
  if (!message || !Array.isArray(message.nodeChanges)) return null;
  return figmaMessageToLayers(message);
}
