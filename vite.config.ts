import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
export default defineConfig({
  plugins: [preact()],
  base: './',
  build: { target: 'es2022', sourcemap: true },
  server: { port: 5173 },
  test: { environment: 'node' },
} as any);
