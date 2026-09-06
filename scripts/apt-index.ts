import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';

export function scanPackageIndex(apt: string, poolRelative: string, output: string): string {
  const descriptor = openSync(output, 'w');
  try {
    const result = spawnSync('dpkg-scanpackages', ['--multiversion', poolRelative, '/dev/null'], {
      cwd: apt, stdio: ['ignore', descriptor, 'inherit'],
    });
    if (result.error || result.status !== 0) throw new Error('APT package index generation failed.');
  } finally { closeSync(descriptor); }
  const packages = readFileSync(output, 'utf8');
  const filenames = packages.split('\n').filter(line => line.startsWith('Filename: ')).map(line => line.slice('Filename: '.length));
  if (filenames.length === 0 || filenames.some(filename => !filename.startsWith(`${poolRelative}/`) || filename.startsWith('/') || filename.includes('..')))
    throw new Error('APT package indexes must contain repository-relative pool paths.');
  return packages;
}
