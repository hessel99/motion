import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
// dev only: VITE_FIGMA_CAPTURE_DIR=/folder npm run dev writes every figma paste there
// (src/app/figma-capture.ts posts it; never part of a build)
function figmaCaptureDev() {
  const dir = process.env.VITE_FIGMA_CAPTURE_DIR;
  return {
    name: 'figma-capture-dev',
    apply: 'serve' as const,
    configureServer(server: any) {
      if (!dir) return;
      server.middlewares.use('/__figma-capture', async (req: any, res: any) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        const { mkdir, writeFile } = await import('node:fs/promises');
        const { join, resolve } = await import('node:path');
        const name = String(new URL(req.url, 'http://x').searchParams.get('name') || 'figma-paste.figcapture.json').replace(/[^\w.-]+/g, '_').slice(0, 120);
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', async () => {
          await mkdir(resolve(dir), { recursive: true });
          await writeFile(join(resolve(dir), name), Buffer.concat(chunks));
          res.end('ok');
        });
      });
    },
  };
}
export default defineConfig({
  plugins: [preact(), figmaCaptureDev()],
  base: './',
  // the version this renderer was built as (Settings → Updates; update bundles carry their own)
  define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version) },
  build: { target: 'es2022', sourcemap: true },
  // agent worktrees live in .claude/: never watch or scan them (they re-triggered dep optimization)
  server: { port: 5173, watch: { ignored: ['**/.claude/**', '**/release/**', '**/bench/results/**'] } },
  // every runtime dependency pre-bundled up front: lazily discovered deps (importers, exporters,
  // the lab) made vite re-optimize mid-session and load preact twice ("reading '__H'")
  optimizeDeps: {
    include: ['preact', 'preact/hooks', 'preact/jsx-runtime', '@preact/signals', 'fflate', 'fzstd', 'gifenc', 'kiwi-schema', 'mediabunny', 'opentype.js'],
    entries: ['index.html', 'src/**/*.ts', 'src/**/*.tsx'],
  },
  test: { environment: 'node', exclude: ['**/node_modules/**', '.claude/**', 'release/**', 'dist/**'] },
} as any);
