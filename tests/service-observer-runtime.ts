import { createServer, type ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ServiceWorkerClient } from '@treeseed-cordis/deployment';
class DeniedSubmission {
    private readonly socket = new Socket(); private bytes = ''; private accept: ((value: boolean) => void) | null = null; private reject: ((error: Error) => void) | null = null;
    run(): Promise<boolean> { return new Promise(this.start.bind(this)); }
    private start(accept: (value: boolean) => void, reject: (error: Error) => void): void { this.accept = accept; this.reject = reject; this.socket.setTimeout(10000); this.socket.once('error', this.failed.bind(this)); this.socket.once('timeout', this.failed.bind(this)); this.socket.on('data', this.data.bind(this)); this.socket.once('end', this.ended.bind(this)); this.socket.connect('/run/cordis-host/host.sock', this.connected.bind(this)); }
    private connected(): void { this.socket.write(JSON.stringify({ protocol: 3, operation: 'submit', planId: 'plan-' + 'a'.repeat(64), digest: 'a'.repeat(64), idempotencyKey: 'container-denied-canary' }) + '\n'); }
    private data(bytes: Buffer): void { this.bytes += bytes.toString(); if (this.bytes.length > 65536) this.failed(); }
    private ended(): void { try { const response = JSON.parse(this.bytes) as { success: boolean; blockers: Array<{ code: string }> }; this.socket.destroy(); this.accept!(!response.success && response.blockers.some(DeniedSubmission.refused)); } catch { this.failed(); } }
    private static refused(value: { code: string }): boolean { return value.code === 'OBSERVER_OPERATION_REFUSED'; }
    private failed(): void { this.socket.destroy(); this.reject!(new Error('Fixture observer exchange failed')); }
}
class ObserverRuntime {
    private static readonly client = new ServiceWorkerClient({ socket: '/run/cordis-host/host.sock' });
    static async run(): Promise<void> { await this.client.observationContext(process.env.FIXTURE_SERVICE_ID!); createServer(this.request.bind(this)).listen(8080, '0.0.0.0'); }
    private static request(_request: unknown, response: ServerResponse): void { void this.respond(response); }
    private static async respond(response: ServerResponse): Promise<void> {
        try { const observation = await this.client.observationContext(process.env.FIXTURE_SERVICE_ID!), names = readdirSync('/run/cordis-host'); let readonly = false; try { writeFileSync('/run/cordis-host/WRITE_CANARY', 'denied'); } catch (error) { readonly = ['EROFS', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''); }
            const denied = await new DeniedSubmission().run(), entryDigest = createHash('sha256').update(readFileSync('/fixture/runtime.js')).digest('hex'); response.end(JSON.stringify({ identity: observation.identity, entryDigest, readonly, controlHidden: names.length === 1 && names[0] === 'host.sock' && !existsSync('/run/cordis-host/worker.sock'), denied }));
        } catch { response.statusCode = 503; response.end('{}'); }
    }
}
await ObserverRuntime.run();
