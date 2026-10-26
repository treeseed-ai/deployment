import { createServer } from 'node:http';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installSandboxBrokerShutdown } from '../../src/sandbox/broker-shutdown.js';
import { WarmSandboxPool } from '../../src/sandbox/warm-sandbox-pool.js';

const root = process.argv[2]!, fail = process.argv[3] === 'fail';
let created!: () => void, release!: () => void, signals = 0, destroys = 0;
const ready = new Promise<void>(resolve => { created = resolve; }), repeated = new Promise<void>(resolve => { release = resolve; });
const pool = new WarmSandboxPool({
  async create() { await writeFile(join(root, 'pristine'), 'owned pristine capacity'); created(); return 'pristine'; },
  async destroy(id) {
    destroys++; process.send?.({ type: 'draining' }); await repeated;
    await writeFile(join(root, 'observed.json'), JSON.stringify({ signals, destroys }));
    if (fail) throw new Error('Original owned teardown failure.');
    await rm(join(root, id));
  },
  onFailure() { process.exitCode = 1; },
});
pool.prewarm({ image: 'test-pristine-resource', cpuCores: 1, memoryBytes: 1024 }); await ready;
await writeFile(join(root, 'retained-work'), 'original retained work');
const servers = await Promise.all(Array.from({ length: 3 }, async () => {
  const server = createServer((_request, response) => response.end('ready'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); return server;
}));
installSandboxBrokerShutdown(servers, () => pool.drain());
process.channel?.ref();
process.on('SIGTERM', () => { if (++signals === 2) { release(); process.channel?.unref(); } });
process.send?.({ type: 'ready', ports: servers.map(server => { const address = server.address(); if (!address || typeof address === 'string') throw new Error('Native listener address required'); return address.port; }) });
