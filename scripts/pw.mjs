// loads the pre-installed playwright (global) or a local one.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
let pw;
try { pw = await import('playwright'); } catch {
  const root = execSync('npm root -g').toString().trim();
  pw = createRequire(root + '/')('playwright');
}
export const chromium = pw.chromium;
