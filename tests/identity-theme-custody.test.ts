import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { materializeIdentityTheme } from '../src/identity/theme.js';

it('declares every materialized Identity theme asset for host-development custody', () => {
  const root = mkdtempSync(join(tmpdir(), 'identity-theme-custody-'));
  try {
    materializeIdentityTheme(root);
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter(path => statSync(join(root, path)).isFile())
      .map(path => `node_modules/@treeseed/identity/${path}`).sort();
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(manifest.treeseed.hostRuntimeAssets.toSorted()).toEqual(files);
    expect(files.length).toBeGreaterThan(0);
  } finally { rmSync(root, { recursive: true }); }
});
