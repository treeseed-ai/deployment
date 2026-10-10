import assert from 'node:assert/strict';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve, sep } from 'node:path';

/** The joined installation owns CLI resolution; checkout source is never a fallback. */
export function installedCli(): string {
 const manifestPath = createRequire(import.meta.url).resolve('@treeseed/cli/package.json');
 const root = dirname(manifestPath), manifest: {name?: string; bin?: {trsd?: unknown}} = JSON.parse(readFileSync(manifestPath, 'utf8'));
 assert.equal(manifest.name, '@treeseed/cli');
 assert.ok(typeof manifest.bin?.trsd === 'string' && manifest.bin.trsd.length > 0, 'SOURCE_ACCEPTANCE_CLI: Installed public binary required');
 const entry = resolve(root, manifest.bin.trsd);
 assert.ok(entry.startsWith(root + sep) && realpathSync(root) === root && realpathSync(entry) === entry
  && lstatSync(entry).isFile() && !lstatSync(entry).isSymbolicLink(), 'SOURCE_ACCEPTANCE_CLI: Installed binary custody required');
 return entry;
}
