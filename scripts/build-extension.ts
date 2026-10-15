// Bundles the GNOME Shell extension (TSX + gnim) into extension/dist with esbuild.
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const ext = path.join(root, 'extension');
const dist = path.join(ext, 'dist');

/** gnim JSX runtime per context: GNOME Shell (St/Clutter) or Gtk 4 (preferences). */
const ENTRIES = [
  { entry: 'src/shell/index.tsx', out: 'extension.js', jsxImportSource: 'gnim/gnome' },
  { entry: 'src/prefs/index.tsx', out: 'prefs.js', jsxImportSource: 'gnim/gtk4' },
] as const;

export async function buildExtension(): Promise<string> {
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });
  await Promise.all(
    ENTRIES.map(({ entry, out, jsxImportSource }) =>
      build({
        entryPoints: [path.join(ext, entry)],
        outfile: path.join(dist, out),
        bundle: true,
        format: 'esm',
        // lowers decorators (gnim's @register) to plain JS
        target: 'es2022',
        sourcemap: false,
        external: ['gi://*', 'resource://*', 'system', 'gettext', 'cairo'],
        // explicit config: tsconfig `paths` (gnim -> declarations) are for type-checking only
        tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', jsxImportSource, experimentalDecorators: false } },
        logLevel: 'warning',
      }),
    ),
  );
  for (const f of ['metadata.json', 'stylesheet.css']) fs.copyFileSync(path.join(ext, f), path.join(dist, f));
  return dist;
}

if (import.meta.main) console.log(`extension: ${await buildExtension()}`);
