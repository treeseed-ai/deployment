import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { postgresRuntimePaths } from '../scripts/postgres-runtime-dependencies.js';

it('ships the PostgreSQL dependency closure without depending on the source workset', () => {
  const selected = new Set<string>(postgresRuntimePaths);
  const root = mkdtempSync(join(tmpdir(), 'treeseed-manager-pg-test-'));
  try {
    for (const name of selected) {
      const source = resolve('node_modules', name);
      const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
      for (const dependency of Object.keys(manifest.dependencies ?? {})) expect(selected.has(dependency), `${name} requires ${dependency}`).toBe(true);
      cpSync(source, join(root, 'node_modules', name), { recursive: true });
    }
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', "import pg from 'pg'; if(typeof pg.Client !== 'function') process.exit(1)"],
      { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 10_000 });
    expect(result).toBe('');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
