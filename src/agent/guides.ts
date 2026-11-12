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
  kind: 'guide' | 'style';
}

function parse(path: string, text: string): Guide {
  const name = path.replace(/^\.\/guides\//, '').replace(/\.md$/, '');
  const title = text.match(/^#\s+(.+)$/m)?.[1].trim() ?? name;
  const summary = text.match(/^>\s+(.+)$/m)?.[1].trim() ?? '';
  return { name, title, summary, text: text.trim(), kind: name.startsWith('styles/') ? 'style' : 'guide' };
}

const ORDER = ['workflow', 'handbook', 'cookbook'];
const rank = (g: Guide) => (g.kind === 'guide' ? ORDER.indexOf(g.name) + 1 || 50 : 100);
export const GUIDES: Guide[] = Object.entries(RAW)
  .map(([p, t]) => parse(p, t))
  .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

export const STYLE_GUIDES = GUIDES.filter(g => g.kind === 'style');

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
export function guideIndex(kind?: 'guide' | 'style'): string {
  const list = GUIDES.filter(g => !kind || g.kind === kind);
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
