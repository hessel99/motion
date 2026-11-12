// style picker: one chip per style recipe (src/agent/guides/styles/*.md). the picked style prefixes
// the next brief, telling the agent which recipe to load (get_guide "styles/<name>").
import { STYLE_GUIDES, type Guide } from '../../agent/guides';

/** "Swiss / International" → "Swiss"; short chip labels */
export const styleLabel = (g: Guide) => g.title.split(/\s*[/(]\s*/)[0].trim();

/** the line put in front of the brief */
export function stylePrefix(name: string): string {
  const g = STYLE_GUIDES.find(x => x.name === name);
  return g ? `[Style: ${g.title} — load get_guide "${g.name}" and follow its palette, type, easing and signature moves.]` : '';
}

export function StylePicker(props: { value: string; onChange: (name: string) => void; disabled?: boolean }) {
  return (
    <div class="ag-styles" role="radiogroup" aria-label="Style">
      <span class="ag-styles-label">Style</span>
      {STYLE_GUIDES.map(g => (
        <button
          type="button"
          role="radio"
          aria-checked={props.value === g.name}
          class={'ag-qchip ag-style' + (props.value === g.name ? ' on' : '')}
          title={`${g.title}: ${g.summary}`}
          disabled={props.disabled}
          onClick={() => props.onChange(props.value === g.name ? '' : g.name)}
        >{styleLabel(g)}</button>
      ))}
    </div>
  );
}
