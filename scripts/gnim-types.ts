// Generates declaration files for gnim into extension/types/gnim.
// gnim ships TypeScript sources that do not type-check against the current @girs typings;
// the extension is type-checked against these declarations instead (tsconfig `paths`),
// while esbuild bundles the real sources.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, 'node_modules', 'gnim', 'dist');
const work = path.join(root, 'extension', 'types', '.gnim-src');
const out = path.join(root, 'extension', 'types', 'gnim');

fs.rmSync(path.join(root, 'extension', 'types'), { recursive: true, force: true });
fs.cpSync(src, work, { recursive: true });
try {
  execFileSync(path.join(root, 'node_modules', '.bin', 'tsc'), ['-p', path.join(root, 'extension', 'tsconfig.gnim.json')], { stdio: 'pipe' });
} catch {
  // type errors inside gnim are expected: declarations are emitted anyway (noEmitOnError: false)
}
fs.rmSync(work, { recursive: true, force: true });
const count = fs.readdirSync(out, { recursive: true }).filter((f) => String(f).endsWith('.d.ts')).length;
if (count === 0) throw new Error('aucune déclaration générée pour gnim');
console.log(`gnim: ${count} déclarations dans ${path.relative(root, out)}`);
