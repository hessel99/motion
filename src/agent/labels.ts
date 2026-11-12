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
    case 'list_styles': return 'Read colors & components';
    case 'link_style': return a.style ? `Link ${a.prop ?? ''} of ${lns(a.ids)} to ${q(a.style)}` : `Detach ${a.prop ?? ''} of ${lns(a.ids)}`;
    case 'set_style': return `Set style ${q(a.name)}`;
    case 'set_style_mode': return `Switch to ${q(a.mode)} mode`;
    case 'create_component': return `Make ${ln(a.id)} a component`;
    case 'add_instance': return `Add ${q(a.component)} instance`;
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
    case 'build_scene': return `Build scene · ${plural(Array.isArray(a.layers) ? a.layers.length : 0, 'layer')}`;
    case 'add_shape_path': return a.op ? `Shape: ${a.op}` : 'Add path shape';
    case 'shape_library': return a.shape ? `Add shape ${q(a.shape)}` : 'List shapes';
    case 'draw_on': return `Draw on ${lns(a.ids)}`;
    case 'morph': return `Morph ${ln(a.id)}`;
    case 'arrange': return `Arrange ${lns(a.ids)} (${a.layout ?? 'layout'})`;
    case 'choreograph': return `Choreograph ${lns(a.ids)} · ${a.pattern ?? 'sequential'}`;
    case 'secondary_motion': return `Follow-through on ${lns(a.ids)}`;
    case 'loop': return `Loop ${lns(a.ids)}${a.mode ? ' · ' + a.mode : ''}`;
    case 'camera_rig': return 'Camera rig';
    case 'align_to_beats': return `Align ${lns(a.ids)} to beats`;
    case 'type_layout': return `Type layout${a.key ? ' ' + q(a.key) : ''}`;
    case 'split_text': return `Split ${ln(a.id)} into ${a.by ?? 'char'}s`;
    case 'text_on_path': return 'Text on path';
    case 'inspect_motion': return `Measure motion${a.ids?.length ? ' of ' + lns(a.ids) : ''}`;
    case 'check_frame': return 'Check frames';
    case 'timeline_summary': return 'Read the timeline';
    case 'preview_strip': return `Preview strip${a.layout ? ' (' + a.layout + ')' : ''}`;
    case 'preview_video': return 'Render GIF preview';
    case 'get_guide': return a.name ? `Read guide ${q(a.name + (a.section ? ' › ' + a.section : ''))}` : 'List guides';
    case 'propose_storyboard': return `Storyboard ${q(a.title ?? '')}${Array.isArray(a.beats) ? ` · ${plural(a.beats.length, 'beat')}` : ''}`;
    case 'update_progress': return `Beat ${a.beat} ${a.status === 'active' ? 'started' : a.status ?? ''}`;
    case 'inspect_artwork': return `Look at the parts of ${a.id ? ln(a.id) : a.ids?.length ? lns(a.ids) : 'the selection'}`;
    case 'split_shape': return `Split ${ln(a.id)} into ${a.mode === 'subpaths' ? 'contours' : 'parts'}`;
    case 'set_pivot': return `Move pivot of ${a.id ? ln(a.id) : lns(a.ids)}${typeof a.at === 'string' ? ' to ' + a.at : ''}`;
    case 'rig': return `Rig ${a.kind ?? ''} on ${lns(a.ids)}`;
    case 'get_audio_analysis': return a.from !== undefined || a.to !== undefined ? `Listen to ${a.from ?? 0}–${a.to ?? 'end'}s` : 'Listen to the music';
    case 'sync_to_audio': return `Sync ${a.ids?.length ? lns(a.ids) : 'animation'} to the ${a.mode ?? 'beats'}`;
    case 'audio_reactive': return `${a.prop ?? ''} of ${lns(a.ids)} follows the ${a.band ?? 'music'}`;
    case 'place_on_beats': return `Entrances on ${a.pattern ?? 'beats'}`;
    case 'list_sfx_families': return 'Sound families';
    case 'preview_sfx': return `Preview ${q(a.family ?? '')} sounds`;
    case 'add_sound_effects': return `Sound effects · ${a.family ?? ''}`;
    case 'set_sfx_family': return `Sound family → ${q(a.family ?? '')}`;
    default: return name.replace(/_/g, ' ');
  }
}
