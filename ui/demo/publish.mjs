// Copy the demo build (dist/demo) into ../docs for GitHub Pages, replacing the old build but keeping docs/refactor/.
import { cpSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
const out = '../docs',
  keep = new Set(['refactor']);
for (const f of readdirSync(out, { withFileTypes: true }))
  if (!keep.has(f.name)) rmSync(`${out}/${f.name}`, { recursive: true, force: true });
cpSync('dist/demo', out, { recursive: true });
writeFileSync(`${out}/.nojekyll`, '');
console.log('demo published to docs/');
