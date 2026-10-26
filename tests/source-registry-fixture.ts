import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, readdirSync, existsSync, chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ProviderV4Schemas, PluginManagementSchemas } from '@treeseed-cordis/sdk';
import { RuntimeContainerFixture, ProbeFixture } from './service-fixture-plugins.js';

/** Genuine packages served by this fixture derive metadata from these exact native classes. */
export class ExtensionContainerFixture extends RuntimeContainerFixture {
    static override readonly declaration = ProviderV4Schemas.declaration.parse({ ...RuntimeContainerFixture.declaration, id: 'extension.container', pluginId: 'extension' });
}
export class StatefulExtensionFixture extends ExtensionContainerFixture {
    static override readonly replacement = { kind: 'migration', qualificationDigest: null, stateVersion: 2 };
    static override readonly container = PluginManagementSchemas.container.parse({ ...ExtensionContainerFixture.container, transitionPolicy: { kind: 'additive', stateVersion: 2 } });
}
export class ExtensionProbeFixture extends ProbeFixture {
    static override readonly declaration = ProviderV4Schemas.declaration.parse({ ...ProbeFixture.declaration, id: 'extension.probe', pluginId: 'extension' });
}
export class RegistryFixture {
    private readonly server: Server;
    private closed = false;
    version = '1.0.0';
    requests = 0;
    authorization = false;
    tamperTrust = false;
    crossOrigin = false;
    invalidIntegrity = false;
    trustChanges = 0;
    archiveRequests = 0;
    forbiddenRequests = 0;
    corruptArchive = false;
    metadataDelayMs = 0;
    private port = 0;
    constructor(private readonly root: string, private readonly installation: string, private readonly packageName = '@fixture/npm-source', private readonly versions = ['1.0.0', '2.0.0', '3.0.0', '4.0.0']) { this.server = createServer({ key: readFileSync(join(root, 'key.pem')), cert: readFileSync(join(root, 'cert.pem')) }, this.reply.bind(this)); }
    private reply(request: IncomingMessage, response: ServerResponse): void {
        if (this.metadataDelayMs && !(request.url ?? '').endsWith('.tgz')) { setTimeout(this.serve.bind(this, request, response), this.metadataDelayMs); return; }
        this.serve(request, response);
    }
    private serve(request: IncomingMessage, response: ServerResponse): void {
        const match = /^\/(source-(?:1\.0\.0|2\.0\.0|3\.0\.0|4\.0\.0)|runtime-1\.0\.0)\.tgz$/.exec(request.url ?? '');
        if (match) {
            this.archiveRequests++;
            const bytes = readFileSync(join(this.root, match[1] + '.tgz'));
            response.end(this.corruptArchive ? Buffer.alloc(bytes.length, 0x41) : bytes);
            return;
        }
        const decoded = decodeURIComponent((request.url ?? '').split('?')[0]!);
        if (decoded === '/@fixture/forbidden')
            this.forbiddenRequests++;
        const ordinary = decoded === '/@fixture/runtime', name = ordinary ? '@fixture/runtime' : this.packageName;
        this.requests++;
        this.changeTrust();
        this.authorization ||= request.headers.authorization !== undefined;
        const versions: Record<string, unknown> = {};
        for (const version of ordinary ? ['1.0.0'] : this.versions) {
            const archive = readFileSync(join(this.root, ordinary ? 'runtime-1.0.0.tgz' : 'source-' + version + '.tgz'));
            versions[version] = { name, version, dist: { tarball: (this.crossOrigin ? 'https://unapproved.invalid/' : this.origin()) + (ordinary ? 'runtime-1.0.0.tgz' : 'source-' + version + '.tgz'), integrity: this.invalidIntegrity ? 'sha512-AAAA' : 'sha512-' + createHash('sha512').update(archive).digest('base64') }, scripts: { postinstall: 'bun postinstall.ts' } };
        }
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ name, 'dist-tags': { latest: ordinary ? '1.0.0' : this.version }, versions }));
    }
    private changeTrust(): void {
        if (!this.tamperTrust)
            return;
        const artifacts = join(this.installation, '.cordis/artifacts');
        for (const name of readdirSync(artifacts))
            if (name.startsWith('source-resolution-')) {
                const path = join(artifacts, name, 'source-ca.pem');
                if (existsSync(path)) {
                    const bytes = readFileSync(path);
                    chmodSync(path, 0o600);
                    writeFileSync(path, bytes);
                    chmodSync(path, 0o400);
                    this.trustChanges++;
                }
            }
    }
    origin(): string {
        const address = this.server.address();
        if (!address || typeof address === 'string')
            throw new Error('Registry not listening');
        return 'https://127.0.0.1:' + address.port + '/';
    }
    async listen(): Promise<void> { this.closed = false; await new Promise<void>(this.start.bind(this)); const address = this.server.address(); if (!address || typeof address === 'string') throw new Error('Registry not listening'); this.port = address.port; }
    private start(done: () => void, reject: (error: Error) => void): void { this.server.once('error', reject); this.server.listen(this.port, '127.0.0.1', done); }
    async close(): Promise<void> {
        if (this.closed)
            return;
        this.closed = true;
        await new Promise<void>(this.stop.bind(this));
    }
    private stop(done: () => void): void { this.server.closeAllConnections(); this.server.close(this.stopped.bind(this, done)); }
    private stopped(done: () => void, error?: Error): void {
        if (error)
            throw error;
        done();
    }
}
