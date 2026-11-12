// director tools: on-demand motion knowledge (get_guide) and the storyboard workflow
// (propose_storyboard → the user approves an editable card → update_progress per beat).
// registered in TOOLS (tools.ts) next to the editing tools.

import { st } from './tool-kit';
import type { ToolContent, ToolDef } from './tools';
import { findGuide, findExamples, guideIndex, guideSection, guideSections, GUIDES, EXAMPLES } from './guides';
import { beatNote, noteStyle, tasteOn, TASTE_GUIDE_HINT } from './taste';
import { approvalMode, storyboards } from './storyboard';

const text = (v: unknown): ToolContent[] => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }];

const beatSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'short, e.g. "Hook", "Logo resolve"' },
    start: { type: 'number', description: 'seconds' },
    end: { type: 'number', description: 'seconds' },
    description: { type: 'string', description: 'what happens: elements + motion, one or two sentences' },
    style: { type: 'string', description: 'style notes: eases/springs, signature move, palette' },
  },
  required: ['name', 'start', 'end', 'description'],
};

export const GUIDE_TOOLS: ToolDef[] = [
  {
    name: 'get_guide',
    readOnly: true,
    description: 'Load motion-design knowledge on demand. No name: the index.' + TASTE_GUIDE_HINT + ' "workflow" (director method, scope rules), "handbook" (principles with numbers, timing tables, easing names, critique rubric), "concepts" (read the artwork + brand; metaphor → motion recipes: door opens, leaf grows, rocket launches; anti-patterns), "cookbook" (worked recipes with exact tool calls), "styles" (index of style recipes), "styles/<name>" (palette, type, easing, timing, signature moves of one style). section: return only one "## " section (e.g. "Timing tables").',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'guide name, e.g. "handbook", "styles", "styles/swiss"' },
        section: { type: 'string', description: 'optional "## " heading (prefix match) to load only that part' },
        brief: { type: 'string', description: 'with name "examples": the brief, to get the 1-2 most similar gold examples' },
      },
    },
    run: ({ name, section, brief }) => {
      if (/^examples?\/?$/i.test(String(name ?? '').trim()) && tasteOn()) {
        if (!brief) return text(`Gold examples (get_guide {name: "examples", brief: "<the brief>"} returns the closest 1-2 with their exact tool calls):\n${guideIndex('example')}`);
        return text(findExamples(String(brief), 2).map(g => g.text).join('\n\n---\n\n') || 'no examples');
      }
      if (!name || !String(name).trim()) return text(`Guides (get_guide {name}):\n${guideIndex('guide')}\n- styles: index of the ${GUIDES.filter(g => g.kind === 'style').length} style recipes${tasteOn() ? `\n- examples: ${EXAMPLES.length} gold examples (pass brief)` : ''}`);
      if (/^styles?\/?$/i.test(String(name).trim())) return text(`Style recipes (get_guide {name: "styles/<name>"}):\n${guideIndex('style')}`);
      const g = findGuide(name);
      if (g?.kind === 'style') noteStyle(g.name);
      if (!g) throw new Error(`no guide "${name}". guides: ${GUIDES.map(x => x.name).join(', ')}`);
      if (section) {
        const s = guideSection(g, String(section));
        if (!s) throw new Error(`no section "${section}" in ${g.name}. sections: ${guideSections(g).join(' | ')}`);
        return text(s);
      }
      return text(g.text);
    },
  },
  {
    name: 'propose_storyboard',
    description: 'Director mode for full pieces (several beats / a named style / >= 5 s): show your plan to the user as an editable storyboard card. Beats in time order with name, start/end (s), description and style notes. For logos / brand marks / artwork also pass 2-3 concepts rooted in what the artwork depicts (after looking at it) and the recommended one; the user picks on the card. The result says whether to wait for the user\'s approval (then end your turn; the approved, possibly edited version comes back as the next message) or to build right away. Not for small edits.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        style: { type: 'string', description: 'style name (from get_guide styles), or a blend "A + B"' },
        styleReason: { type: 'string', description: 'one line: why this style fits the brief' },
        duration: { type: 'number', description: 'total seconds' },
        beats: { type: 'array', items: beatSchema, description: '3-5 beats of 2-4 s are typical' },
        notes: { type: 'string', description: 'optional: palette, typography, music, open questions' },
        concepts: { type: 'array', items: { type: 'object', properties: { name: { type: 'string', description: 'e.g. "Door opens"' }, idea: { type: 'string', description: 'what moves and how, rooted in what the artwork depicts' }, why: { type: 'string', description: 'why it fits the brand' } }, required: ['name', 'idea'] }, description: 'logo / brand / artwork briefs: 2-3 concepts the user picks from; the beats describe the recommended one' },
        recommended: { type: 'number', description: 'index of the recommended concept (0-based)' },
      },
      required: ['title', 'beats'],
    },
    run: (a) => {
      const sb = storyboards.propose(a);
      const head = `storyboard "${sb.title}" shown to the user (${sb.beats.length} beats, ${sb.duration}s).`;
      if (approvalMode() === 'auto') return text(`${head} Auto-approved: build it now, beat by beat (update_progress {beat:1, status:"active"} … {status:"done"}).`);
      return text(`${head} Wait for approval: end your turn now with one short line. The approved (maybe edited) storyboard arrives as the next message; follow that version.`);
    },
  },
  {
    name: 'update_progress',
    description: 'Report storyboard progress per beat (shown on the card). Call with status "active" before building a beat and "done" after it: all edits in between become ONE undo step named after the beat. beat = 1-based number or beat name.',
    inputSchema: {
      type: 'object',
      properties: {
        beat: { anyOf: [{ type: 'number' }, { type: 'string' }], description: '1-based beat number or its name' },
        status: { enum: ['active', 'done', 'skipped'] },
        note: { type: 'string', description: 'optional, a few words (what was built / why skipped)' },
      },
      required: ['beat', 'status'],
    },
    run: ({ beat, status, note }) => {
      const r = storyboards.progress(st(), beat, status, note);
      const sb = storyboards.current!;
      const done = sb.beats.filter(b => b.status === 'done' || b.status === 'skipped').length;
      return text(`beat ${r.index + 1} "${r.beat.name}" ${status}; ${done}/${sb.beats.length} beats finished${sb.state === 'done' ? ' — now critique (the critique tool, then contact_sheet; rubric: get_guide handbook, section "Critique")' : ''}${status === 'done' ? beatNote(st(), [r.beat.start, r.beat.end]) : ''}`);
    },
  },
];
