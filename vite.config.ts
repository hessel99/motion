import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
export default defineConfig({
  plugins: [preact()],
  base: './',
  build: { target: 'es2022', sourcemap: true },
  server: { port: 5173 },
  // every runtime dependency pre-bundled up front: lazily discovered deps (importers, exporters,
  // the lab) made vite re-optimize mid-session and load preact twice ("reading '__H'")
  optimizeDeps: {
    include: ['preact', 'preact/hooks', 'preact/jsx-runtime', '@preact/signals', 'fflate', 'fzstd', 'gifenc', 'kiwi-schema', 'mediabunny', 'opentype.js'],
    entries: ['index.html', 'src/**/*.ts', 'src/**/*.tsx'],
  },
  test: { environment: 'node', exclude: ['**/node_modules/**', '.claude/**', 'release/**', 'dist/**'] },
} as any);
