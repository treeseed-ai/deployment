import{GitSourcePlugin,GitSourceToken}from'./git-source.js';
import{PluginBuildPlugin,PluginBuildToken}from'./source-build.js';
import { createServer, type Server, Socket } from 'node:net';
import { lstatSync, chmodSync, fstatSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { Service } from 'cordis';
import { CapabilityToken, CanonicalJson, ProviderV4Schemas, ServiceSchemas, ServiceWorkerSchemas, PlanningBlockedError, type ServicePlan, type ServiceWorkerRequest, type ServiceWorkerResponse } from '@treeseed-cordis/sdk';
import { Context, CordisServiceLocator, type ProviderRegistration } from '@treeseed-cordis/sdk/runtime';
import { ServiceWorkerLimits } from './service-ipc.js';
import { ServiceApplicationToken, ServiceApplicationRuntime } from './service-application.js';
import { InstallationAuthorityToken, type InstallationAuthority } from './service-authority.js';
import { InstallationStore } from './installed.js';
import { NpmSourcePlugin, PackageSourceTokens } from './npm-source.js';
import { PluginManagerPlugin, PluginManagerToken } from './plugin-manager.js';
import { SafeDirectory, StrictJson, PlanningFailure as Check } from './filesystem.js';
class HostFailure {
    static blocked(code: string): ServiceWorkerResponse { return { protocol: 3, success: false, kind: 'blocked', blockers: [{ code, message: 'Host request blocked: ' + code + '.' }] }; }
    static error(error: unknown): ServiceWorkerResponse {
        if (error instanceof PlanningBlockedError) {
            const blockers = [];
            for (const blocker of error.blockers)
                if (/^[A-Z][A-Z0-9_]{0,62}$/.test(blocker.code))
                    blockers.push({ code: blocker.code, message: 'Host request blocked: ' + blocker.code + '.' });
            if (blockers.length)
                return { protocol: 3, success: false, kind: 'blocked', blockers };
        }
        return { protocol: 3, success: false, kind: 'runtime', blockers: [{ code: 'HOST_REQUEST_FAILED', message: 'The host request failed.' }] };
    }
}
interface HostLayout {
    verify(): void;
}
class HostDispatch {
    constructor(private readonly context: Context, private readonly layout: HostLayout) { }
    verify(): void { this.layout.verify(); }
    async execute(request: ServiceWorkerRequest, observer: boolean): Promise<ServiceWorkerResponse> {
        this.verify();
        if (observer && !['status', 'application', 'observation.context'].includes(request.operation))
            return HostFailure.blocked('OBSERVER_OPERATION_REFUSED');
        if (request.operation.startsWith('plugin.')) {
            const lease = await CordisServiceLocator.from(this.context).acquire(PluginManagerToken.instance);
            try { let result;
                if (request.operation === 'plugin.install') result = await lease.value.install(request.request);
                else if (request.operation === 'plugin.select') result = await lease.value.select(request.request);
                else if (request.operation === 'plugin.list') result = await lease.value.list(request.scope, request.target);
                else if (request.operation === 'plugin.inspect') result = await lease.value.inspect(request.requestId);
                else return HostFailure.blocked('OWNER_OPERATION_UNAVAILABLE');
                return ServiceWorkerSchemas.response.parse({ protocol: 3, success: true, result });
            } finally { await lease.release(); }
        }
        if (!['plan','submit', 'status', 'application', 'observation.context'].includes(request.operation))
            return HostFailure.blocked('OWNER_OPERATION_UNAVAILABLE');
        const lease = await CordisServiceLocator.from(this.context).acquire(ServiceApplicationToken.host);
        try {
            let result;
            if(request.operation==='plan')result=await lease.value.plan(request.configuration);
            else if (request.operation === 'observation.context')
                result = await lease.value.observationContext(request.serviceId);
            else if (request.operation === 'status')
                result = await lease.value.status();
            else if (request.operation === 'application')
                result = await lease.value.application(request.id);
            else if (request.operation === 'submit')
                result = await lease.value.submit(request);
            else
                return HostFailure.blocked('OWNER_OPERATION_UNAVAILABLE');
            return ServiceWorkerSchemas.response.parse({ protocol: 3, success: true, result });
        }
        finally {
            await lease.release();
        }
    }
}
class HostConnection {
    private bytes = Buffer.alloc(0);
    private accepted = false;
    private finished = false;
    private timer: ReturnType<typeof setTimeout>;
    private pending: Promise<void> | null = null;
    constructor(private readonly socket: Socket, private readonly endpoint: HostEndpoint, private readonly dispatch: HostDispatch, private readonly observer: boolean) { this.timer = setTimeout(this.expired.bind(this), 10000); socket.on('data', this.data.bind(this)); socket.once('error', this.failed.bind(this)); socket.once('close', this.closed.bind(this)); }
    private data(bytes: Buffer): void {
        if (this.finished)
            return;
        if (this.accepted) {
            this.failed();
            return;
        }
        if (this.bytes.length + bytes.length > 4 * 1024 * 1024) {
            this.respond(HostFailure.blocked('HOST_FRAME_LIMIT'));
            return;
        }
        this.bytes = Buffer.concat([this.bytes, bytes]);
        const newline = this.bytes.indexOf(10);
        if (newline === -1)
            return;
        this.accepted = true;
        if (newline !== this.bytes.length - 1) {
            this.respond(HostFailure.blocked('INVALID_HOST_REQUEST'));
            return;
        }
        let request: ServiceWorkerRequest;
        try {
            request = ServiceWorkerSchemas.request.parse(StrictJson.parse(this.bytes.subarray(0, -1)));
        }
        catch {
            this.respond(HostFailure.blocked('INVALID_HOST_REQUEST'));
            return;
        }
        if(!this.observer&&request.operation==='plan'){clearTimeout(this.timer);this.timer=setTimeout(this.expired.bind(this),ServiceWorkerLimits.planningTimeoutMs);}
        this.pending = this.execute(request);
    }
    private async execute(request: ServiceWorkerRequest): Promise<void> {
        try {
            this.respond(await this.dispatch.execute(request, this.observer));
        }
        catch (error) {
            this.respond(HostFailure.error(error));
        }
        finally {
            this.pending = null;
            if (this.finished)
                this.endpoint.settled(this);
        }
    }
    private respond(response: ServiceWorkerResponse): void {
        if (this.finished)
            return;
        const bytes = Buffer.from(CanonicalJson.stringify(response) + '\n');
        if (bytes.length > 4 * 1024 * 1024) {
            this.failed();
            return;
        }
        this.finished = true;
        clearTimeout(this.timer);
        this.socket.end(bytes);
        if (!this.pending)
            this.endpoint.settled(this);
    }
    private expired(): void { this.failed(); }
    private failed(): void {
        if (!this.finished) {
            this.finished = true;
            clearTimeout(this.timer);
            this.socket.destroy();
        }
        if (!this.pending)
            this.endpoint.settled(this);
    }
    private closed(): void { this.failed(); }
}
class HostEndpoint {
    private readonly server: Server = createServer(this.connected.bind(this));
    private identity: Stats | null = null;
    private closed = false;
    private stopping: Promise<void> | null = null;
    private readonly connections = new Set<HostConnection>();
    constructor(private readonly directory: SafeDirectory, private readonly name: 'host.sock' | 'worker.sock', private readonly dispatch: HostDispatch, private readonly observer: boolean) { this.server.on('error', this.serverError.bind(this)); }
    async start(): Promise<void> { Check.require(this.directory.entries().length === 0, 'WORKER_REPAIR_REQUIRED'); Check.require(Buffer.byteLength(join(this.directory.path, this.name)) <= 103, 'WORKER_SOCKET_PATH'); await new Promise<void>(this.listen.bind(this)); const before = lstatSync(this.directory.childPath(this.name)); Check.require(before.isSocket() && !before.isSymbolicLink() && before.uid === process.getuid?.() && before.nlink === 1, 'WORKER_SOCKET_OWNER'); this.identity = before; chmodSync(this.directory.childPath(this.name), 0o600); const after = this.stat(); Check.require(before.ino === after.ino && before.dev === after.dev, 'WORKER_SOCKET_CHANGED'); this.identity = after; this.verify(); }
    private listen(done: (value: void) => void, reject: (error: Error) => void): void { this.server.once('error', reject); this.server.listen(this.directory.childPath(this.name), this.listening.bind(this, done, reject)); }
    private listening(done: (value: void) => void, reject: (error: Error) => void): void { this.server.removeListener('error', reject); done(); }
    private serverError(): void { }
    private stat(): Stats { this.directory.verify(); SafeDirectory.owner(fstatSync(this.directory.fd), true); const stat = lstatSync(this.directory.childPath(this.name)); Check.require(stat.isSocket() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600, 'WORKER_SOCKET_OWNER'); return stat; }
    verify(): void {
        if (this.closed)
            return;
        Check.require(this.identity, 'WORKER_SOCKET_OWNER');
        const current = this.stat();
        Check.require(current.ino === this.identity.ino && current.dev === this.identity.dev && this.directory.entries().join(',') === this.name, 'WORKER_SOCKET_CHANGED');
    }
    private connected(socket: Socket): void {
        try {
            Check.require(!this.stopping && this.connections.size < 16, 'HOST_CONNECTION_LIMIT');
            this.dispatch.verify();
            this.verify();
            const connection = new HostConnection(socket, this, this.dispatch, this.observer);
            this.connections.add(connection);
        }
        catch {
            socket.destroy();
        }
    }
    settled(connection: HostConnection): void { this.connections.delete(connection); }
    async abandon(): Promise<void> {
        if (this.closed)
            return;
        if (!this.server.listening && this.identity === null) {
            this.closed = true;
            this.directory.close();
            return;
        }
        try {
            await this.stop();
        }
        catch (error) {
            this.server.unref();
            throw error;
        }
    }
    async stop(): Promise<void> {
        if (this.closed)
            return;
        this.verify();
        if (!this.stopping)
            this.stopping = this.closeServer();
        await this.stopping;
        this.closed = true;
        this.directory.verify();
        Check.require(this.directory.entries().length === 0, 'WORKER_SOCKET_CHANGED');
        this.directory.close();
    }
    private async closeServer(): Promise<void> {
        await new Promise<void>(this.close.bind(this));
        const deadline = Date.now() + 10000;
        while (this.connections.size && Date.now() < deadline)
            await new Promise(HostEndpoint.delay);
        Check.require(this.connections.size === 0, 'HOST_DRAIN_PENDING');
    }
    private close(done: (value: void) => void, reject: (error: Error) => void): void { this.server.close(this.closedServer.bind(this, done, reject)); }
    private closedServer(done: (value: void) => void, reject: (error: Error) => void, error?: Error): void {
        if (error) {
            reject(new Error('HOST_SOCKET_CLOSE_FAILED'));
            return;
        }
        done();
    }
    private static delay(done: (value: void) => void): void { setTimeout(done, 5); }
}
interface HostTransport {
    stop(): Promise<void>;
}
class TransportAdapter {
    parse(value: unknown): HostTransport { Check.require(value && typeof value === 'object' && typeof Reflect.get(value, 'stop') === 'function', 'INVALID_HOST_TRANSPORT'); return value as HostTransport; }
}
class HostTransportToken {
    static readonly instance = new CapabilityToken<HostTransport>('deployment.protocol', ProviderV4Schemas.version, new TransportAdapter());
}
class HostSockets implements HostTransport, HostLayout {
    private readonly endpoints: HostEndpoint[] = [];
    private stopped = false;
    private readonly dispatch: HostDispatch;
    constructor(private readonly authority: InstallationAuthority, context: Context) { this.dispatch = new HostDispatch(context, this); }
    verify(): void {
        Check.require(!this.stopped && this.endpoints.length === 2, 'HOST_LAYOUT_INVALID');
        for (const endpoint of this.endpoints)
            endpoint.verify();
    }
    async start(): Promise<void> {
        this.authority.writer.assert(this.authority.store.path);
        const state = SafeDirectory.open(this.authority.store.path + '/.cordis');
        try {
            for (const [name, socket, observer] of [['run', 'host.sock', true], ['control', 'worker.sock', false]] as const) {
                this.authority.writer.assert(this.authority.store.path);
                const directory = InstallationStore.mkdir(state, name), endpoint = new HostEndpoint(directory, socket, this.dispatch, observer);
                this.endpoints.push(endpoint);
                await endpoint.start();
            }
            state.verify();
        }
        catch (error) {
            for (const endpoint of this.endpoints)
                try {
                    await endpoint.abandon();
                }
                catch { }
            throw error;
        }
        finally {
            state.close();
        }
    }
    async stop(): Promise<void> {
        if (this.stopped)
            return;
        for (const endpoint of this.endpoints)
            endpoint.verify();
        for (const endpoint of this.endpoints)
            await endpoint.stop();
        this.stopped = true;
    }
}
class HostSocketPlugin {
    static readonly provide = [HostTransportToken.instance.id];
    static readonly inject = ['cordis.composition', InstallationAuthorityToken.instance.id, ServiceApplicationToken.host.id, PluginManagerToken.instance.id];
    static readonly Config = ServiceSchemas.plan;
    static readonly declaration = ProviderV4Schemas.declaration.parse({ id: 'deployment.private-unix-protocol', pluginId: 'deployment', capability: HostTransportToken.instance.id, contractVersion: ProviderV4Schemas.version, target: 'deployment', provide: this.provide, inject: this.inject });
    private readonly sockets: HostSockets;
    constructor(private readonly context: Context, _plan: ServicePlan) { this.sockets = new HostSockets(InstallationAuthorityToken.instance.parse(Reflect.get(context, InstallationAuthorityToken.instance.id)), context); context.effect(this.effect.bind(this)); }
    async [Service.init](): Promise<void> { await this.sockets.start(); this.context.provide(HostTransportToken.instance.id, this.sockets); }
    private effect(): () => Promise<void> { return this.sockets.stop.bind(this.sockets); }
}
export class ServiceHostRuntime extends ServiceApplicationRuntime {
    private transportStopped = false;
    static override async start(input: ServicePlan, bootstrap?: {
        nonce: string;
    }): Promise<ServiceHostRuntime> { const plan = ServiceSchemas.plan.parse(input), artifact = { kind: 'bundled' as const, identity: 'deployment-private-unix-protocol.1:' + plan.composition.worker.sha256 }, registrations: ProviderRegistration[] = [{token:PluginBuildToken.instance,plugin:PluginBuildPlugin,declaration:PluginBuildPlugin.declaration,configuration:plan,artifact},{token:GitSourceToken.instance,plugin:GitSourcePlugin,declaration:GitSourcePlugin.declaration,configuration:plan,artifact},{ token: PackageSourceTokens.npm, plugin: NpmSourcePlugin, declaration: NpmSourcePlugin.declaration, configuration: plan, artifact }, { token: PluginManagerToken.instance, plugin: PluginManagerPlugin, declaration: PluginManagerPlugin.declaration, configuration: plan, artifact }, { token: HostTransportToken.instance, plugin: HostSocketPlugin, declaration: HostSocketPlugin.declaration, configuration: plan, artifact }], scope = await this.mount(plan, registrations, bootstrap); return new ServiceHostRuntime(scope.handle, scope.context); }
    override async close(timeoutMs = 10000): Promise<void> {
        if (!this.transportStopped) {
            const lease = await CordisServiceLocator.from(this.context).acquire(HostTransportToken.instance);
            try {
                await lease.value.stop();
                this.transportStopped = true;
            }
            finally {
                await lease.release();
            }
        }
        await super.close(timeoutMs);
    }
}
