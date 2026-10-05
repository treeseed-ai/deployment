import { build } from 'esbuild';

// Host-development generations intentionally have a small fixed dependency
// inventory. Carry the archive parser's complete closure in this one artifact.
await build({
  entryPoints: ['src/supervisor/backup-stream.ts'],
  outfile: 'dist/src/supervisor/backup-stream.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: "import {createRequire as archiveCreateRequire} from 'node:module'; const require = archiveCreateRequire(import.meta.url);" },
});
