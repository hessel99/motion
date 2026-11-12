// human readable labels for agent tool calls ("Keyframe scale on Logo" instead of set_keyframes {...})

const q = (s: unknown) => `“${String(s)}”`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function toolLabel(rawName: string, input: any, layerName: (id: string) => string | undefined): string {
  const name = rawName.replace(/^mcp__motion__/, '').replace(/^mcp_motion_|^motion__/, '');
  const a = input ?? {};
  const ln = (id: any) => (typeof id === 'string' ? layerName(id) ?? id : '?');
  const lns = (ids: any) => (Array.isArray(ids) ? (ids.length <= 3 ? ids.map(ln).join(', ') : plural(ids.length, 'layer')) : 'selection');
  switch (name) {
    case 'get_document': return 'Read the document';
    case 'get_layer': return `Inspect ${ln(a.id)}`;
    case 'get_animation': return `Read animation${a.ids?.length ? ' of ' + lns(a.ids) : ''}`;
    case 'get_editor_context': return 'Check selection & playhead';
    case 'add_layer': return `Add ${a.type ?? 'layer'}${a.name ? ' ' + q(a.name) : a.text?.content ? ' ' + q(String(a.text.content).slice(0, 24)) : ''}`;
    case 'update_layer': return `Edit ${ln(a.id)}${a.props ? ' · ' + Object.keys(a.props).join(', ') : ''}`;
    case 'set_keyframes': return `Keyframe ${a.prop ?? ''} on ${ln(a.id)}`;
    case 'animate': {
      const tracks = Array.isArray(a.tracks) ? a.tracks : [];
      const layers = new Set(tracks.map((t: any) => t.id));
      return `Animate ${plural(tracks.length, 'track')} on ${layers.size <= 2 ? [...layers].map(ln).join(', ') : plural(layers.size, 'layer')}`;
    }
    case 'set_easing': return `Ease ${a.prop ?? ''} on ${ln(a.id)} → ${Array.isArray(a.ease) ? 'custom curve' : a.ease}`;
    case 'retime': return `Retime ${a.ids?.length ? lns(a.ids) : 'animation'}${a.scale && a.scale !== 1 ? ` ×${a.scale}` : ''}${a.offset ? ` ${a.offset > 0 ? '+' : ''}${a.offset}s` : ''}`;
    case 'stagger': return `Stagger ${lns(a.ids)} by ${a.step}s`;
    case 'apply_preset': return `Apply ${q(a.preset)} to ${lns(a.ids)}`;
    case 'set_text_animation': return a.remove ? 'Remove text animation' : `Text animation ${a.preset ? q(a.preset) : ''} on ${lns(a.ids)}`;
    case 'set_expression': return a.expr ? `Expression on ${a.prop}: ${String(a.expr).slice(0, 30)}` : `Remove ${a.prop} expression`;
    case 'delete_layers': return `Delete ${lns(a.ids)}`;
    case 'duplicate_layers': return `Duplicate ${lns(a.ids)}`;
    case 'group_layers': return `Group ${lns(a.ids)}${a.name ? ' as ' + q(a.name) : ''}`;
    case 'precompose': return `Pre-compose ${lns(a.ids)}`;
    case 'set_composition': return `Composition settings · ${Object.keys(a).join(', ')}`;
    case 'smart_animate': return 'Smart animate between two states';
    case 'set_markers': return 'Update markers';
    case 'set_time': return `Move playhead to ${a.t}s`;
    case 'playback': return a.play ? 'Play preview' : 'Pause preview';
    case 'select_layers': return `Select ${lns(a.ids)}`;
    case 'screenshot': return a.times?.length ? `Look at ${plural(Math.min(4, a.times.length), 'frame')}` : `Look at frame${a.t !== undefined ? ' ' + a.t + 's' : ''}`;
    case 'contact_sheet': return `Contact sheet${a.times?.length ? ` (${a.times.length} frames)` : a.frames ? ` (${a.frames} frames)` : ''}`;
    case 'save_variation': return `Save variation ${q(a.label ?? '')}`;
    case 'apply_variation': return 'Apply a variation';
    case 'open_composition': return 'Open composition';
    case 'export_video': return `Export ${a.format ?? 'mp4'}`;
    case 'undo': return 'Undo';
    default: return name.replace(/_/g, ' ');
  }
}
