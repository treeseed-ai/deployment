import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { checkServerIdentity, type PeerCertificate } from 'node:tls';
import { isIP } from 'node:net';
import { z } from 'zod';
import { ServiceSchemas, type ProbeContext } from '@treeseed-cordis/sdk';
import { AuthorityArchive } from './service-export.js';
export interface ServiceHttpRequest { path: string; maximumBytes?: number; authorityReference?: string; }
export interface ServiceHttpRequests { read(context: ProbeContext, request: ServiceHttpRequest): Promise<Buffer>; }
class HttpAdmission {
    private static part(value: string): boolean { return value !== '.' && value !== '..'; }
    private static path(value: string): boolean { return /^\/[A-Za-z0-9_.,@+\/-]*$/.test(value) && !value.includes('//') && value.split('/').every(HttpAdmission.part); }
    static readonly request = z.strictObject({ path: z.string().max(2048).refine(HttpAdmission.path), maximumBytes: z.number().int().min(1).max(8 * 1024 * 1024).default(256 * 1024), authorityReference: ServiceSchemas.secretReference.optional() });
    static accepted(context: ProbeContext): boolean { return Number.isFinite(context.deadline) && !context.signal.aborted && Date.now() < context.deadline; }
    static require(value: unknown): asserts value { if (!value) throw new Error('PROBE_HTTP_UNAVAILABLE'); }
    static endpoint(context: ProbeContext): URL { const endpoint = new URL(context.endpoint); this.require(['http:', 'https:'].includes(endpoint.protocol) && isIP(endpoint.hostname) === 4 && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash && endpoint.pathname === '/'); return endpoint; }
    static origin(context: ProbeContext): URL | null {
        if (!context.observation) return null;
        const identity = ServiceSchemas.observationContext.parse(context.observation).identity;
        this.require(identity.serviceId === context.serviceId && identity.installationId === context.expected.installationId && identity.compositionGeneration === context.expected.compositionGeneration && identity.serviceGeneration === context.expected.serviceGeneration && identity.assetDigest === context.expected.assetDigest);
        return new URL(identity.origin);
    }
}
class TlsIdentity {
    constructor(private readonly name: string) { }
    check(_name: string, certificate: PeerCertificate): Error | undefined { return checkServerIdentity(this.name, certificate); }
}
class HttpAttempt {
    private request: ClientRequest | null = null;
    private response: IncomingMessage | null = null;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private readonly abort = this.failed.bind(this);
    private chunks: Buffer[] = []; private size = 0; private result: Buffer | null = null; private fault = false; private done = false;
    private accept: ((bytes: Buffer) => void) | null = null; private reject: ((error: Error) => void) | null = null;
    constructor(private readonly context: ProbeContext, private readonly endpoint: URL, private readonly input: z.infer<typeof HttpAdmission.request>, private readonly origin: URL | null, private readonly ca: Buffer | null) { }
    run(): Promise<Buffer> { return new Promise(this.start.bind(this)); }
    private start(accept: (bytes: Buffer) => void, reject: (error: Error) => void): void {
        this.accept = accept; this.reject = reject;
        try {
            HttpAdmission.require(HttpAdmission.accepted(this.context));
            const hostname = (this.origin?.hostname ?? this.endpoint.hostname).replace(/^\[|\]$/g, ''), identity = new TlsIdentity(hostname), options: RequestOptions = { hostname: this.endpoint.hostname, port: Number(this.endpoint.port || (this.endpoint.protocol === 'https:' ? 443 : 80)), method: 'GET', path: this.input.path, agent: false, maxHeaderSize: 16384, headers: { host: this.origin?.host ?? this.endpoint.host, accept: 'application/octet-stream' }, rejectUnauthorized: true, ca: this.ca ?? undefined, servername: isIP(hostname) ? undefined : hostname, checkServerIdentity: identity.check.bind(identity) };
            this.request = this.endpoint.protocol === 'https:' ? httpsRequest(options, this.received.bind(this)) : httpRequest(options, this.received.bind(this));
            this.request.once('error', this.failed.bind(this)); this.request.once('close', this.closed.bind(this)); this.context.signal.addEventListener('abort', this.abort, { once: true });
            this.timer = setTimeout(this.failed.bind(this), Math.max(1, Math.min(120000, this.context.deadline - Date.now())));
            if (!HttpAdmission.accepted(this.context)) this.failed(); else this.request.end();
        } catch { this.failed(); }
    }
    private received(response: IncomingMessage): void {
        this.response = response;
        const length = response.headers['content-length'];
        if (this.fault || !response.statusCode || response.statusCode < 200 || response.statusCode >= 300 || response.headers['content-encoding'] || (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > this.input.maximumBytes))) { this.failed(); return; }
        response.on('data', this.data.bind(this)); response.once('error', this.failed.bind(this)); response.once('aborted', this.failed.bind(this)); response.once('end', this.ended.bind(this));
    }
    private data(bytes: Buffer): void { if (this.fault || this.done) return; this.size += bytes.length; if (this.size > this.input.maximumBytes || !HttpAdmission.accepted(this.context)) { this.failed(); return; } this.chunks.push(bytes); }
    private ended(): void { if (this.fault || !this.response?.complete || !HttpAdmission.accepted(this.context)) { this.failed(); return; } this.result = Buffer.concat(this.chunks); this.request!.destroy(); }
    private failed(): void { if (this.done) return; this.fault = true; this.response?.destroy(); if (this.request) this.request.destroy(); else this.closed(); }
    private closed(): void { if (this.done) return; this.done = true; clearTimeout(this.timer); this.context.signal.removeEventListener('abort', this.abort); this.response?.destroy(); this.request?.destroy(); if (!this.fault && this.result !== null && HttpAdmission.accepted(this.context)) this.accept!(this.result); else this.reject!(new Error('PROBE_HTTP_UNAVAILABLE')); }
}
/** Coherent transport only; native owner probes decide protocol readiness and acknowledgements. */
export class ServiceHttpClient implements ServiceHttpRequests {
    async read(context: ProbeContext, request: ServiceHttpRequest): Promise<Buffer> {
        try {
            const input = HttpAdmission.request.parse(request); HttpAdmission.require(HttpAdmission.accepted(context)); const endpoint = HttpAdmission.endpoint(context), origin = HttpAdmission.origin(context); let ca: Buffer | null = null;
            if (endpoint.protocol === 'https:') { HttpAdmission.require(origin?.protocol === 'https:' && input.authorityReference && context.authorityIds.includes(input.authorityReference)); ca = AuthorityArchive.certificate(await context.authority(input.authorityReference)); }
            else HttpAdmission.require(input.authorityReference === undefined);
            HttpAdmission.require(HttpAdmission.accepted(context)); return await new HttpAttempt(context, endpoint, input, origin, ca).run();
        } catch { throw new Error('PROBE_HTTP_UNAVAILABLE'); }
    }
}
