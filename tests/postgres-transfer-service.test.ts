import { beforeEach, expect, it, vi } from 'vitest';
import { component } from './fixtures.js';
import { retainedPostgresService } from '../src/supervisor/postgres-transfer-service.js';
const docker = vi.hoisted(() => vi.fn());
vi.mock('../src/supervisor/postgres-process.js', () => ({ postgresDocker: docker }));
beforeEach(() => vi.resetAllMocks());
function fixture() {
  const source = component('api', 'stable', 'a'); source.images[0]!.repository = 'postgres';
  const image = `sha256:${'a'.repeat(64)}`;
  docker.mockImplementation(async (args: string[]) => args[0] === 'image' ? image : args[0] === 'ps' ? 'b'.repeat(64) : `${image}\tfalse\tservice\n`);
  return { source, image };
}
it('selects only the retained stopped service with the published image', async () => {
  const f = fixture(); expect(await retainedPostgresService(f.source)).toBe('service');
  expect(docker.mock.calls.every(([args]) => !args.includes('start') && !args.includes('Config.Env'))).toBe(true);
});
it.each(['running', 'wrong-image', 'unknown-service', 'duplicate'] as const)('rejects %s custody', async failure => {
  const f = fixture(); docker.mockImplementation(async (args: string[]) => {
    if (args[0] === 'image') return f.image;
    if (args[0] === 'ps') return failure === 'duplicate' ? `${'b'.repeat(64)}\n${'c'.repeat(64)}` : 'b'.repeat(64);
    return `${failure === 'wrong-image' ? 'sha256:' + 'd'.repeat(64) : f.image}\t${failure === 'running' ? 'true' : 'false'}\t${failure === 'unknown-service' ? 'other' : 'service'}`;
  });
  await expect(retainedPostgresService(f.source)).rejects.toThrow();
});
