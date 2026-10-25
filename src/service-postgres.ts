import { Service } from 'cordis';
import postgres from 'postgres';
import { Context } from '@treeseed-cordis/sdk/composition';
import { PlatformSchemas, ProviderV4Schemas, ServiceProjectionSchemas, ServiceTokens, PluginManagementSchemas, type ContainerService, type ServiceEngine, type ServiceExecutionContext, type ServiceIdentity, type ServiceReadiness, type ServiceProbe, type ProbeContext } from '@treeseed-cordis/sdk';
export class PostgresServicePlugin implements ContainerService {
    static readonly provide = ['container.service']; static readonly inject = ['deployment.services', 'service.context']; static readonly Config = PlatformSchemas.empty;
    static readonly replacement = { kind: 'restart' as const, qualificationDigest: null, stateVersion: 1 };
    static readonly declaration = ProviderV4Schemas.declaration.parse({ id: 'deployment.postgres.service', pluginId: 'deployment', capability: 'container.service', contractVersion: ProviderV4Schemas.version, target: 'deployment', provide: this.provide, inject: this.inject });
    static readonly image = PluginManagementSchemas.image.parse({ id: 'postgres', reference: 'postgres@sha256:e4cb93687b062cd25a0e8f672d85a7708235009d70d31f8a7698d9370092a9c4', source: { kind: 'prepared' }, manifestDigest: 'e4cb93687b062cd25a0e8f672d85a7708235009d70d31f8a7698d9370092a9c4', indexSha256: 'd538f74d92b3b72ecfd667bc56b81c48695a819ba0b74526a9580657cec26acd' });
    static readonly container = ServiceProjectionSchemas.container.parse({ definition: { imageId: 'postgres', user: 'image-default', environment: { POSTGRES_DB: 'cordis', POSTGRES_USER: 'cordis', POSTGRES_PASSWORD_FILE: '/run/cordis/database-password' }, ports: [{ id: 'postgres', target: 5432 }], volumes: [{ source: 'data', target: '/var/lib/postgresql/data', readOnly: false }], secrets: [{ slot: 'database-password', target: '/run/cordis/database-password' }], workerSocket: false }, resources: { volumes: ['data'], slots: { 'database-password': { kind: 'random' } }, grants: [], authorities: [] }, providedContracts: [{ port: 'postgres', contractId: 'storage.postgres', contractVersion: '1.0.0' }], dependencies: [], observationContract: 'storage.postgres', transitionPolicy: { kind: 'restart-required', stateVersion: 1 } });
    private readonly engine: ServiceEngine;
    private readonly execution: ServiceExecutionContext;
    constructor(private readonly context: Context) { this.engine = ServiceTokens.engine.parse(Reflect.get(context, ServiceTokens.engine.id)); this.execution = ServiceTokens.context.parse(Reflect.get(context, ServiceTokens.context.id)); }
    async [Service.init](): Promise<void> { await this.engine.start(this.execution.service.serviceId, this.execution.service.definition); this.context.provide(ServiceTokens.container().id, this); }
    identity(): ServiceIdentity { return this.engine.identity(this.execution.service.serviceId); }
    ready(): Promise<ServiceReadiness> { return this.engine.ready(this.execution.service.serviceId); }
}
class PostgresAttempt {
    private sql: ReturnType<typeof postgres> | null = null;
    private closing: Promise<void> | null = null;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private readonly cancelBound = this.cancel.bind(this);
    constructor(private readonly context: ProbeContext) { }
    private accepted(): boolean { return !this.context.signal.aborted && Date.now() < this.context.deadline; }
    private static notice(_notice: unknown): void { }
    private static ignored(_error: unknown): void { }
    private cancel(): void { if (this.sql && !this.closing) this.closing = this.sql.end({ timeout: 0 }).catch(PostgresAttempt.ignored); }
    async run(): Promise<boolean> {
        try {
            if (!this.accepted()) return false;
            const reference = 'secret://' + this.context.serviceId + '/database-password', endpoint = new URL(this.context.endpoint);
            if (endpoint.protocol !== 'tcp:' || !/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/' || !endpoint.port || !this.context.credentialReferences.includes(reference)) return false;
            const bytes = await this.context.credential(reference), password = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            if (!this.accepted() || !/^[a-f0-9]{64}$/.test(password)) return false;
            const remaining = Math.max(1, this.context.deadline - Date.now());
            this.sql = postgres({ host: endpoint.hostname, port: Number(endpoint.port), database: 'cordis', username: 'cordis', password, ssl: false, max: 1, prepare: false, fetch_types: false, connect_timeout: Math.max(1, Math.ceil(remaining / 1000)), idle_timeout: 1, max_lifetime: 1, onnotice: PostgresAttempt.notice, debug: false, connection: { application_name: 'cordis-readiness', statement_timeout: remaining } });
            this.context.signal.addEventListener('abort', this.cancelBound, { once: true }); this.timer = setTimeout(this.cancelBound, remaining);
            if (!this.accepted()) return false;
            const rows = await this.sql.unsafe<{ cordis_ready: number }[]>('SELECT 1 AS cordis_ready');
            return this.accepted() && rows.length === 1 && rows[0]!.cordis_ready === 1;
        } catch { return false; }
        finally { clearTimeout(this.timer); this.context.signal.removeEventListener('abort', this.cancelBound); this.cancel(); await this.closing; }
    }
}
export class PostgresReadinessPlugin implements ServiceProbe {
    static readonly provide = ['probe.service']; static readonly inject: string[] = []; static readonly Config = PlatformSchemas.empty; static readonly replacement = PostgresServicePlugin.replacement;
    static readonly declaration = ProviderV4Schemas.declaration.parse({ id: 'deployment.postgres.readiness', pluginId: 'deployment', capability: 'probe.service', contractVersion: ProviderV4Schemas.version, target: 'deployment', provide: this.provide, inject: this.inject });
    static readonly probe = { observationContracts: ['storage.postgres'], schemes: ['tcp'], maximumDeadlineMs: 120000 };
    constructor(context: Context) { context.provide(ServiceTokens.probe().id, this); }
    async observe(context: ProbeContext): Promise<ServiceReadiness> { const measured = await new PostgresAttempt(context).run(), ready = measured && !context.signal.aborted && Date.now() < context.deadline; return { serviceId: context.serviceId, ready, observations: [ready ? 'storage.postgres.query' : 'storage.postgres.unavailable'] }; }
}
