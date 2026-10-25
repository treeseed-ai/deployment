import { Socket } from 'node:net';
import { lstatSync, fstatSync, type Stats } from 'node:fs';
import { dirname, basename, resolve, join } from 'node:path';
import { CanonicalJson, PlatformSchemas, PlanningBlockedError, ServiceSchemas, ServiceWorkerSchemas, type ServiceWorkerRequest, type ServiceWorkerResponse, type ServiceStatus, type ServiceApplicationRecord } from '@treeseed-cordis/sdk';
import { SafeDirectory, StrictJson, PlanningFailure as Check } from './filesystem.js';
class ObserverExchange {
    private readonly socket = new Socket();
    private bytes = Buffer.alloc(0);
    private done = false;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private accept: ((value: ServiceWorkerResponse) => void) | undefined;
    private reject: ((error: Error) => void) | undefined;
    constructor(private readonly directory: SafeDirectory, private readonly identity: Stats, private readonly request: ServiceWorkerRequest, private readonly timeoutMs: number, private readonly name: 'host.sock' | 'worker.sock' = 'host.sock') { }
    run(): Promise<ServiceWorkerResponse> { return new Promise(this.start.bind(this)); }
    private start(accept: (value: ServiceWorkerResponse) => void, reject: (error: Error) => void): void { this.accept = accept; this.reject = reject; this.timer = setTimeout(this.failed.bind(this), this.timeoutMs); this.socket.on('error', this.failed.bind(this)); this.socket.on('data', this.data.bind(this)); this.socket.once('end', this.end.bind(this)); this.socket.once('close', this.closed.bind(this)); this.socket.connect(this.directory.childPath(this.name), this.connected.bind(this)); }
    static identity(directory: SafeDirectory, name: 'host.sock' | 'worker.sock' = 'host.sock'): Stats { directory.verify(); SafeDirectory.owner(fstatSync(directory.fd), true); const stat = lstatSync(directory.childPath(name)); Check.require(stat.isSocket() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600, 'WORKER_SOCKET_OWNER'); return stat; }
    private verify(): void { const current = ObserverExchange.identity(this.directory, this.name); Check.require(current.dev === this.identity.dev && current.ino === this.identity.ino, 'WORKER_SOCKET_CHANGED'); }
    private connected(): void { try {
        this.verify();
        this.socket.write(CanonicalJson.stringify(this.request) + '\n');
    }
    catch {
        this.failed();
    } }
    private data(bytes: Buffer): void { if (this.done)
        return; if (bytes.length + this.bytes.length > 4 * 1024 * 1024) {
        this.failed();
        return;
    } this.bytes = Buffer.concat([this.bytes, bytes]); }
    private end(): void { if (this.done)
        return; try {
        this.verify();
        Check.require(this.bytes.length > 0 && this.bytes.indexOf(10) === this.bytes.length - 1, 'INVALID_WORKER_RESPONSE');
        const response = ServiceWorkerSchemas.response.parse(StrictJson.parse(this.bytes.subarray(0, -1)));
        this.done = true;
        clearTimeout(this.timer);
        this.socket.destroy();
        this.accept!(response);
    }
    catch {
        this.failed();
    } }
    private closed(): void { if (!this.done)
        this.failed(); }
    private failed(): void { if (this.done)
        return; this.done = true; clearTimeout(this.timer); this.socket.destroy(); this.reject!(new Error('SERVICE_WORKER_EXCHANGE_FAILED')); }
}
/** The API gets only the observer directory, never the owner-local control directory. */
export class ServiceWorkerClient {
    private readonly socket: string;
    private readonly timeoutMs: number;
    constructor(options: ({
        installationDirectory: string;
    } | {
        socket: string;
    }) & {
        timeoutMs?: number;
    }) { if ('installationDirectory' in options)
        Check.require(options.installationDirectory.startsWith('/') && resolve(options.installationDirectory) === options.installationDirectory, 'WORKER_SOCKET_PATH'); this.socket = 'socket' in options ? options.socket : join(options.installationDirectory, '.cordis/run/host.sock'); Check.require(this.socket.startsWith('/') && resolve(this.socket) === this.socket && basename(this.socket) === 'host.sock', 'WORKER_SOCKET_PATH'); this.timeoutMs = options.timeoutMs ?? 10000; Check.require(Number.isInteger(this.timeoutMs) && this.timeoutMs >= 50 && this.timeoutMs <= 10000, 'WORKER_TIMEOUT'); }
    private async request(request: ServiceWorkerRequest): Promise<Extract<ServiceWorkerResponse, {
        success: true;
    }>> { request = ServiceWorkerSchemas.request.parse(request); Check.require(request.operation === 'status' || request.operation === 'application', 'OBSERVER_OPERATION_REFUSED'); return PrivateWorkerRequest.run(this.socket, request, this.timeoutMs); }
    async status(): Promise<ServiceStatus> { const result = (await this.request({ protocol: 3, operation: 'status' })).result; const status = ServiceSchemas.status.safeParse(result); if (!status.success)
        throw new Error('INVALID_WORKER_STATUS'); return status.data; }
    async application(id: string): Promise<ServiceApplicationRecord> { id = ServiceSchemas.applicationRecord.shape.id.parse(id); const result = (await this.request({ protocol: 3, operation: 'application', id })).result, record = ServiceSchemas.applicationRecord.safeParse(result); if (!record.success || record.data.id !== id)
        throw new Error('INVALID_WORKER_APPLICATION'); return record.data; }
}
class PrivateWorkerRequest {
    static async run(socket: string, request: ServiceWorkerRequest, timeoutMs: number): Promise<Extract<ServiceWorkerResponse, {
        success: true;
    }>> { const directory = SafeDirectory.open(dirname(socket)); try {
        const name = basename(socket) as 'host.sock' | 'worker.sock';
        Check.require(['host.sock', 'worker.sock'].includes(name), 'WORKER_SOCKET_PATH');
        const identity = ObserverExchange.identity(directory, name), response = await new ObserverExchange(directory, identity, request, timeoutMs, name).run();
        if (!response.success) {
            if (response.kind === 'runtime')
                throw new Error('SERVICE_WORKER_RUNTIME_FAILURE');
            const blockers = [];
            for (const blocker of response.blockers) {
                if (!/^[A-Z][A-Z0-9_]{0,62}$/.test(blocker.code))
                    throw new Error('INVALID_WORKER_RESPONSE');
                blockers.push({ code: blocker.code, message: 'Host request blocked: ' + blocker.code + '.' });
            }
            throw new PlanningBlockedError(blockers);
        }
        return response;
    }
    finally {
        directory.close();
    } }
}
export class ServiceWorkerOwnerClient {
    private readonly socket: string;
    private readonly timeoutMs: number;
    constructor(options: {
        installationDirectory: string;
        timeoutMs?: number;
    }) { Check.require(options.installationDirectory.startsWith('/') && resolve(options.installationDirectory) === options.installationDirectory, 'WORKER_SOCKET_PATH'); this.socket = join(options.installationDirectory, '.cordis/control/worker.sock'); this.timeoutMs = options.timeoutMs ?? 10000; Check.require(Number.isInteger(this.timeoutMs) && this.timeoutMs >= 50 && this.timeoutMs <= 10000, 'WORKER_TIMEOUT'); }
    private request(request: ServiceWorkerRequest): Promise<Extract<ServiceWorkerResponse, {
        success: true;
    }>> { return PrivateWorkerRequest.run(this.socket, ServiceWorkerSchemas.request.parse(request), this.timeoutMs); }
    async submit(request: Extract<ServiceWorkerRequest, {
        operation: 'submit';
    }>): Promise<{
        id: string;
        accepted: true;
    }> { const result = (await this.request(request)).result; return PlatformSchemas.apply.parse(result); }
    async status(): Promise<ServiceStatus> { return ServiceSchemas.status.parse((await this.request({ protocol: 3, operation: 'status' })).result); }
    async application(id: string): Promise<ServiceApplicationRecord> { id = ServiceSchemas.applicationRecord.shape.id.parse(id); const record = ServiceSchemas.applicationRecord.parse((await this.request({ protocol: 3, operation: 'application', id })).result); Check.require(record.id === id, 'INVALID_WORKER_APPLICATION'); return record; }
}
