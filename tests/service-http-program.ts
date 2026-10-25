import { readFileSync } from 'node:fs';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { type Socket } from 'node:net';
import { ServiceSchemas, type ProbeContext } from '@treeseed-cordis/sdk';
import { ServiceHttpClient, type ServiceHttpRequest } from '@treeseed-cordis/deployment';
class HttpProbeInput implements ProbeContext {
    readonly serviceId = 'selected-service'; readonly deadline = Date.now() + 3000;
    readonly expected = { installationId: 'fixture', compositionGeneration: 'a'.repeat(64), serviceGeneration: 'b'.repeat(64), assetDigest: 'c'.repeat(64) };
    readonly credentialReferences: readonly string[] = []; readonly authorityIds = ['secret://selected-service/public-ca'];
    readonly observation: NonNullable<ProbeContext['observation']>;
    readonly controller = new AbortController(); authorityReads = 0; privateReads = 0; cancelAuthority = false;
    get signal(): AbortSignal { return this.controller.signal; }
    constructor(readonly endpoint: string, private readonly ca: Buffer, origin = 'https://localhost:8443') { this.observation = ServiceSchemas.observationContext.parse({ formatVersion: 1, identity: { ...this.expected, serviceId: this.serviceId, origin, runtime: null }, dependencies: [] }); }
    async credential(_reference: string): Promise<Uint8Array> { this.privateReads++; throw new Error('CREDENTIAL_SECRET_CANARY'); }
    async authority(reference: string): Promise<Uint8Array> { this.authorityReads++; if (!this.authorityIds.includes(reference)) throw new Error('AUTHORITY_SECRET_CANARY'); if (this.cancelAuthority) this.controller.abort(); return Buffer.from(this.ca); }
}
class HttpProtocolFixture {
    private readonly server: Server; private readonly sockets = new Set<Socket>(); private accept: ((port: number) => void) | null = null; private closeResult: ((value: void) => void) | null = null;
    requests = 0;
    constructor(certificate?: { key: Buffer; cert: Buffer }) { this.server = certificate ? createHttpsServer(certificate, this.serve.bind(this)) : createServer(this.serve.bind(this)); this.server.on('connection', this.connected.bind(this)); this.server.on('tlsClientError', HttpProtocolFixture.ignored); }
    static ignored(_error: unknown): void { }
    private connected(socket: Socket): void { this.sockets.add(socket); socket.once('close', this.disconnected.bind(this, socket)); }
    private disconnected(socket: Socket): void { this.sockets.delete(socket); }
    get pending(): number { return this.sockets.size; }
    start(): Promise<number> { return new Promise(this.listen.bind(this)); }
    private listen(accept: (port: number) => void, reject: (error: Error) => void): void { this.accept = accept; this.server.once('error', reject); this.server.listen(0, '127.0.0.1', this.listening.bind(this)); }
    private listening(): void { const address = this.server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture listener'); this.accept!(address.port); }
    private serve(request: IncomingMessage, response: ServerResponse): void {
        this.requests++;
        if (request.method !== 'GET' || request.headers.authorization || request.headers.cookie) { response.writeHead(400); response.end(); return; }
        if (request.url === '/redirect') { response.writeHead(302, { location: 'https://SECRET_CANARY.invalid/' }); response.end(); return; }
        if (request.url === '/oversize') { response.end('x'.repeat(33)); return; }
        if (request.url === '/truncated') { response.writeHead(200, { 'content-length': 1000 }); response.end('short'); return; }
        if (request.url === '/stall') { response.writeHead(200); response.write('wait'); return; }
        if (request.url === '/encoded') { response.writeHead(200, { 'content-encoding': 'gzip' }); response.end('encoded'); return; }
        if (request.url === '/error') { response.writeHead(500); response.end('SERVER_SECRET_CANARY'); return; }
        if (request.url !== '/ok' || request.headers.host !== 'localhost:8443') { response.writeHead(400); response.end(); return; }
        response.end('fixture-probe-ok');
    }
    close(): Promise<void> { return new Promise(this.stop.bind(this)); }
    private stop(done: (value: void) => void): void { this.closeResult = done; for (const socket of this.sockets) socket.destroy(); this.server.close(this.closed.bind(this)); }
    private closed(): void { this.closeResult!(); }
}
class HttpProbeProgram {
    private static async drained(fixture: HttpProtocolFixture): Promise<void> { const until = Date.now() + 1000; while (fixture.pending && Date.now() < until) await new Promise(this.delay); if (fixture.pending) throw new Error('Probe transport left a socket'); }
    private static async denied(client: ServiceHttpClient, input: HttpProbeInput, request: ServiceHttpRequest): Promise<void> { let denied = false; try { await client.read(input, request); } catch (error) { if (String(error) !== 'Error: PROBE_HTTP_UNAVAILABLE') throw new Error('Unsafe transport error'); denied = true; } if (!denied) throw new Error('Unsafe probe transport accepted'); }
    static async run(file: string): Promise<void> {
        const paths = JSON.parse(readFileSync(file, 'utf8')) as { ca: string; wrongCa: string; key: string; cert: string }, ca = readFileSync(paths.ca), wrongCa = readFileSync(paths.wrongCa), http = new HttpProtocolFixture(), https = new HttpProtocolFixture({ key: readFileSync(paths.key), cert: readFileSync(paths.cert) }), client = new ServiceHttpClient();
        try {
            const plainPort = await http.start(), securePort = await https.start();
            for (const [scheme, port, fixture] of [['http', plainPort, http], ['https', securePort, https]] as const) {
                const endpoint = scheme + '://127.0.0.1:' + port + '/', input = new HttpProbeInput(endpoint, ca), reference = scheme === 'https' ? 'secret://selected-service/public-ca' : undefined;
                if ((await client.read(input, { path: '/ok', authorityReference: reference })).toString() !== 'fixture-probe-ok' || input.privateReads || input.authorityReads !== (reference ? 1 : 0)) throw new Error('Default transport failed');
                for (const path of ['/redirect', '/oversize', '/truncated', '/encoded', '/error']) { await this.denied(client, new HttpProbeInput(endpoint, ca), { path, maximumBytes: 32, authorityReference: reference }); await this.drained(fixture); }
                const cancelled = new HttpProbeInput(endpoint, ca), timer = setTimeout(cancelled.controller.abort.bind(cancelled.controller), 100), started = Date.now();
                try { await this.denied(client, cancelled, { path: '/stall', authorityReference: reference }); if (Date.now() - started > 2000) throw new Error('Cancellation exceeded bound'); } finally { clearTimeout(timer); } await this.drained(fixture);
                const invalid = new HttpProbeInput(endpoint, ca), before = fixture.requests; await this.denied(client, invalid, { path: '//SECRET_CANARY', authorityReference: reference }); if (invalid.authorityReads || before !== fixture.requests) throw new Error('Invalid path performed effects');
            }
            const endpoint = 'https://127.0.0.1:' + securePort + '/', reference = 'secret://selected-service/public-ca';
            await this.denied(client, new HttpProbeInput(endpoint, wrongCa), { path: '/ok', authorityReference: reference });
            await this.denied(client, new HttpProbeInput(endpoint, ca, 'https://127.0.0.1:8443'), { path: '/ok', authorityReference: reference });
            const cancelled = new HttpProbeInput(endpoint, ca); cancelled.cancelAuthority = true; const before = https.requests; await this.denied(client, cancelled, { path: '/ok', authorityReference: reference }); if (before !== https.requests) throw new Error('Late authority callback connected');
            await this.denied(client, new HttpProbeInput('http://SECRET_CANARY.invalid:8080/', ca), { path: '/ok' });
            await this.drained(http); await this.drained(https);
            process.stdout.write(JSON.stringify({ fixtureOnly: true, http: true, verifiedTls: true, wrongTrustDenied: true, malformedDenied: true, abortDrained: true }) + '\n');
        } finally { await http.close(); await https.close(); }
    }
    private static delay(done: (value: void) => void): void { setTimeout(done, 20); }
}
await HttpProbeProgram.run(process.argv[2]!);
