import { readFileSync, existsSync } from 'node:fs';
import { ComposeDeploymentHost, ServicePlanStore, ServiceProviderStager } from '@treeseed-cordis/deployment';
import { Context, CordisComposition, CordisServiceLocator, InstalledProviderLoader, type ProviderRegistration } from '@treeseed-cordis/sdk/runtime';
import { ServiceSchemas, PlatformSchemas, ProviderV4Schemas, ServiceTokens, CanonicalJson, type ServiceEngine, type ServiceExecutionContext, type ServiceIdentity, type ServiceReadiness, type ServiceInstance } from '@treeseed-cordis/sdk';
class EngineFixture implements ServiceEngine {
    readonly calls: string[] = [];
    constructor(private readonly service: ServiceInstance, private readonly installationId: string) { }
    async start(id: string, definition: ServiceInstance['definition']): Promise<void> { if (id !== this.service.serviceId || CanonicalJson.stringify(definition) !== CanonicalJson.stringify(this.service.definition))
        throw new Error('Foreign definition'); this.calls.push(id); }
    async ready(id: string): Promise<ServiceReadiness> { return { serviceId: id, ready: false, observations: ['explicit-staging-test-engine-no-containers'] }; }
    identity(id: string): ServiceIdentity { return { installationId: this.installationId, serviceId: id, providerId: this.service.provider.providerId, serviceGeneration: 'a'.repeat(64), resourceId: 'b'.repeat(64) }; }
}
class ContextFixture implements ServiceExecutionContext {
    constructor(readonly service: ServiceInstance) { }
    dependency(): never { throw new Error('No fixture dependency'); }
}
class ServiceStagingProgram {
    static async run(file: string): Promise<void> {
        const configuration = ServiceSchemas.configuration.parse(JSON.parse(readFileSync(file, 'utf8'))), plan = await new ComposeDeploymentHost().plan(configuration);
        if (plan.formatVersion !== 3)
            throw new Error('Wrong format');
        const store = new ServicePlanStore(configuration.installationDirectory), writer = store.writer();
        try {
            let record = store.accept({ protocol: 3, operation: 'submit', planId: plan.id, digest: plan.digest, idempotencyKey: 'native-staging-fixture' }, writer).record;
            record = { ...record, sequence: 1, phase: 'stage', result: null };
            store.append(record, writer);
            const stager = new ServiceProviderStager(plan), prepared = [];
            for (const service of plan.composition.services.slice(0, 2)) {
                const container = await stager.stage(service.serviceId, 'container', writer), probe = await stager.stage(service.serviceId, 'probe', writer);
                if ((await stager.stage(service.serviceId, 'container', writer)).digest !== container.digest)
                    throw new Error('Stage differs');
                prepared.push({ service, container, probe });
            }
            if (existsSync(configuration.release.directory + '/../SCRIPT_CANARY'))
                throw new Error('Staging imported a provider');
            record = { ...record, sequence: 2, phase: 'activate' };
            store.append(record, writer);
            const identities = [];
            for (const selected of prepared) {
                const engine = new EngineFixture(selected.service, configuration.installationId), execution = new ContextFixture(selected.service), scopeId = selected.container.scopeId, artifact = { kind: 'bundled' as const, identity: 'explicit-native-staging-test-fixtures' };
                class EnginePlugin {
                    static readonly provide = [ServiceTokens.engine.id];
                    static readonly inject: string[] = [];
                    static readonly Config = PlatformSchemas.empty;
                    constructor(context: Context) { context.provide(ServiceTokens.engine.id, engine); }
                }
                class ContextPlugin {
                    static readonly provide = [ServiceTokens.context.id];
                    static readonly inject: string[] = [];
                    static readonly Config = PlatformSchemas.empty;
                    constructor(context: Context) { context.provide(ServiceTokens.context.id, execution); }
                }
                const registrations: ProviderRegistration[] = [await InstalledProviderLoader.load(selected.container.file, selected.container.digest, ServiceTokens.container(), 'deployment', scopeId), await InstalledProviderLoader.load(selected.probe.file, selected.probe.digest, ServiceTokens.probe(), 'deployment', scopeId)];
                for (const [token, plugin] of [[ServiceTokens.engine, EnginePlugin], [ServiceTokens.context, ContextPlugin]] as const)
                    registrations.push({ token, plugin, artifact, configuration: {}, declaration: ProviderV4Schemas.declaration.parse({ id: 'fixture.' + token.id, pluginId: 'fixture', capability: token.id, contractVersion: ProviderV4Schemas.version, target: 'deployment', provide: plugin.provide, inject: [] }) });
                const selections = [];
                for (const registration of registrations)
                    selections.push({ scopeId, capability: registration.token.id, providerId: ProviderV4Schemas.declaration.parse(registration.declaration).id });
                const handle = await CordisComposition.start({ registrations, selections }, { scopeId, target: 'deployment', principalId: 'fixture-owner', resourceScope: configuration.installationDirectory });
                try {
                    const receiver: {
                        context?: Context;
                    } = {};
                    class Consumer {
                        static readonly inject = ['cordis.composition', ServiceTokens.container().id];
                        constructor(context: Context) { receiver.context = context; }
                    }
                    await handle.mount(Consumer, undefined);
                    const lease = await CordisServiceLocator.from(receiver.context!).acquire(ServiceTokens.container());
                    try {
                        identities.push(lease.value.identity().serviceId);
                        if ((await lease.value.ready()).ready || engine.calls.join(',') !== selected.service.serviceId)
                            throw new Error('Wrong native instance');
                    }
                    finally {
                        await lease.release();
                    }
                }
                finally {
                    await handle.dispose();
                }
            }
            process.stdout.write(JSON.stringify({ fixtureOnly: true, identities }) + '\n');
        }
        finally {
            writer.close();
        }
    }
}
await ServiceStagingProgram.run(process.argv[2]!);
