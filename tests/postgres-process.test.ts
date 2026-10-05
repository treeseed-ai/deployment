import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: fixture.spawn }));
import { postgresDocker } from '../src/supervisor/postgres-process.js';

describe('PostgreSQL operation diagnostics', () => {
  it('identifies the failed project and exit without disclosing command values or stderr', async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: { resume: () => void }; kill: () => void };
    child.stdout = new EventEmitter(); child.stderr = { resume: vi.fn() }; child.kill = vi.fn();
    fixture.spawn.mockReturnValue(child);
    const result = postgresDocker(['compose', '--file', '/private/secret.yml', '--project-name', 'treeseed-ai-lab',
      'up', '--env', 'TOKEN=secret-value'], 1);
    child.emit('close', 1);
    await expect(result).rejects.toThrow('PostgreSQL container operation failed: operation=up, project=treeseed-ai-lab, exit=1, timedOut=false');
  });
});
