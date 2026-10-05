import { readFileSync, mkdirSync, lstatSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const files = ['theme.properties', 'template.ftl', 'messages/messages_en.properties',
  'resources/css/tokens.css', 'resources/css/auth.css',
  'resources/css/treeseed.css', 'resources/img/treeseed-logo.svg'];

/** Exact published Identity assets; no source builds, network downloads or
 * executable theme input. The container sees a read-only generated directory. */
export function materializeIdentityTheme(runtimeRoot: string) {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.resolve('@treeseed/identity'))), '..');
  for (const file of files) {
    const source = join(packageRoot, 'themes/treeseed/login', file), stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000) throw new Error('Invalid published Identity theme asset');
    const destination = join(runtimeRoot, 'themes/treeseed/login', file);
    const relative = ['themes', 'treeseed', 'login', ...file.split('/').slice(0, -1)];
    let directory = runtimeRoot;
    for (const part of relative) {
      directory = join(directory, part); mkdirSync(directory, { recursive: true, mode: 0o755 });
      const info = lstatSync(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o022)) throw new Error('Unsafe Identity theme directory');
      chmodSync(directory, 0o755);
    }
    const temporary = `${destination}.tmp-${randomUUID()}`;
    writeFileSync(temporary, readFileSync(source), { mode: 0o644, flag: 'wx' });
    chmodSync(temporary, 0o644);
    renameSync(temporary, destination);
  }
}
