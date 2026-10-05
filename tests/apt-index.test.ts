import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scanPackageIndex } from '../scripts/apt-index.js';

vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, spawnSync: vi.fn(original.spawnSync) };
});
const directories: string[] = [];
afterEach(() => { vi.mocked(spawnSync).mockReset(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function target() { const root = mkdtempSync(join(tmpdir(), 'treeseed-apt-index-test-')); directories.push(root); return root; }
describe('unbounded scanner stdout', () => {
  it('streams more than the default subprocess buffer through a real child process', async () => {
    const { spawnSync: realSpawn } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.mocked(spawnSync).mockImplementation((_command, _args, options) => realSpawn(process.execPath,
      ['-e', "process.stdout.write('Filename: pool/development/package.deb\\nDescription: ' + 'x'.repeat(2*1024*1024) + '\\n')"], options));
    const root = target();
    expect(scanPackageIndex(root, 'pool/development', join(root, 'Packages')).length).toBeGreaterThan(2 * 1024 * 1024);
    expect(spawnSync).toHaveBeenCalledWith('dpkg-scanpackages', ['--multiversion', 'pool/development', '/dev/null'],
      { cwd: root, stdio: ['ignore', expect.any(Number), 'inherit'] });
  });
  it.each(['', 'Filename: /etc/passwd', 'Filename: pool/development/../other.deb', 'Filename: pool/stable/other.deb'])('rejects invalid output %s', output => {
    vi.mocked(spawnSync).mockImplementation((_command, _args, options: any) => {
      writeFileSync(options.stdio[1], output); return { status: 0 } as any;
    });
    const root = target();
    expect(() => scanPackageIndex(root, 'pool/development', join(root, 'Packages'))).toThrow('repository-relative');
  });
  it('fails closed on scanner failure', () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1 } as any);
    const root = target();
    expect(() => scanPackageIndex(root, 'pool/development', join(root, 'Packages'))).toThrow('generation failed');
  });
});
