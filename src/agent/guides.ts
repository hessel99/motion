// motion-design knowledge the agent loads on demand (get_guide tool, MCP resources): the handbook,
// the director workflow, the cookbook and one recipe per style. bundled as raw markdown, so the
// base system prompt stays small and cache friendly.

const RAW = import.meta.glob('./guides/**/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export interface Guide {
  /** "handbook", "workflow", "cookbook", "styles/swiss" */
  name: string;
  title: string;
  /** one line (the "> " line under the title) */
  summary: string;
  text: string;
  kind: 'guide' | 'style' | 'example';
}

function parse(path: string, text: string): Guide {
  const name = path.replace(/^\.\/guides\//, '').replace(/\.md$/, '');
  const title = text.match(/^#\s+(.+)$/m)?.[1].trim() ?? name;
  const summary = text.match(/^>\s+(.+)$/m)?.[1].trim() ?? '';
  return { name, title, summary, text: text.trim(), kind: name.startsWith('styles/') ? 'style' : name.startsWith('examples/') ? 'example' : 'guide' };
}

const ORDER = ['workflow', 'handbook', 'cookbook'];
const rank = (g: Guide) => (g.kind === 'guide' ? ORDER.indexOf(g.name) + 1 || 50 : g.kind === 'style' ? 100 : 200);
export const GUIDES: Guide[] = Object.entries(RAW)
  .map(([p, t]) => parse(p, t))
  .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

export const STYLE_GUIDES = GUIDES.filter(g => g.kind === 'style');
/** gold examples (guides/examples/*.md): proven tool-call sequences, retrieved by brief similarity */
export const EXAMPLES = GUIDES.filter(g => g.kind === 'example');

const STOP = new Set('a an the and or of to in on for with my our your me make it is be this that some from by as at into up out please can you want need i we'.split(' '));
const words = (s: string) => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).map(w => w.replace(/(ing|es|s)$/, '')).filter(w => w.length > 1 && !STOP.has(w));

/** the gold examples most similar to a brief (tags weigh 3, title 2, the example's brief 1) */
export function findExamples(brief: string, n = 2): Guide[] {
  const q = new Set(words(brief));
  if (!q.size) return EXAMPLES.slice(0, n);
  const scored = EXAMPLES.map(g => {
    const tags = words(g.summary.replace(/^tags:\s*/i, ''));
    const title = words(g.title);
    const body = words(g.text.match(/## Brief\s+([\s\S]*?)(?=\n## )/)?.[1] ?? '');
    let sc = 0;
    for (const w of new Set(tags)) if (q.has(w)) sc += 3;
    for (const w of new Set(title)) if (q.has(w)) sc += 2;
    for (const w of new Set(body)) if (q.has(w)) sc += 1;
    return { g, sc };
  }).sort((a, b) => b.sc - a.sc);
  return scored.slice(0, n).map(x => x.g);
}

const norm = (s: string) => s.toLowerCase().replace(/\.md$/, '').replace(/[^a-z0-9/]+/g, '-').replace(/^-|-$/g, '');

/** find a guide by name, loosely: "swiss", "styles/swiss", "Swiss / International", "Neo brutalist" */
export function findGuide(name: string): Guide | undefined {
  const n = norm(String(name ?? ''));
  if (!n) return undefined;
  return GUIDES.find(g => g.name === n)
    ?? GUIDES.find(g => g.name === 'styles/' + n)
    ?? GUIDES.find(g => norm(g.title) === n)
    ?? GUIDES.find(g => g.kind === 'style' && (norm(g.title).startsWith(n) || g.name.slice(7).startsWith(n)));
}

/** one line per guide: what get_guide({}) returns */
export function guideIndex(kind: 'guide' | 'style' | 'example' = 'guide'): string {
  const list = GUIDES.filter(g => g.kind === kind);
  return list.map(g => `- ${g.name}: ${g.summary || g.title}`).join('\n');
}

/** the "## " sections of a guide (headings) */
export function guideSections(g: Guide): string[] {
  return [...g.text.matchAll(/^##\s+(.+)$/gm)].map(m => m[1].trim());
}

/** one "## " section (matched loosely by heading prefix / number), or undefined */
export function guideSection(g: Guide, section: string): string | undefined {
  const want = section.toLowerCase().trim();
  const parts = g.text.split(/^(?=##\s)/m);
  const hit = parts.find(p => { const h = p.match(/^##\s+(.+)$/m)?.[1].toLowerCase() ?? ''; return h === want || h.startsWith(want) || h.replace(/^\d+\.\s*/, '').startsWith(want); });
  return hit?.trim();
}
