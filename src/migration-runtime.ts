import { CanonicalJson, ServiceSchemas, type InstalledPlan, type ServiceResourceReceipt } from '@treeseed-cordis/sdk';
import { LocalDockerCommands } from './service-images.js';
import { SafeDirectory, StrictJson, PlanningFailure as Check } from './filesystem.js';
/** Historical format boundary only; generic service planning/engine has no role dispatch. */
export class MigrationRuntime {
    private readonly commands = new LocalDockerCommands();
    constructor(private readonly plan: InstalledPlan, private readonly state: SafeDirectory) { }
    private async object(kind: string, id: string): Promise<Record<string, unknown>> { const value = StrictJson.parse(Buffer.from(await this.commands.run(this.plan.expectedEngine, [kind, 'inspect', id]))); Check.require(Array.isArray(value) && value.length === 1, 'MIGRATION_RESOURCE_IDENTITY'); return StrictJson.object(value[0]); }
    private labels(value: Record<string, unknown>, kind: string, slot?: string): void { const labels = StrictJson.object(value.Labels); for (const [key, expected] of Object.entries({ 'ai.treeseed.cordis.installation': this.plan.configuration.installationId, 'ai.treeseed.cordis.generation': this.plan.digest, 'com.docker.compose.project': this.plan.projectName, ...slot ? { ['com.docker.compose.' + kind]: slot } : {} }))
        Check.require(labels[key] === expected, 'MIGRATION_RESOURCE_IDENTITY'); }
    private receipt(kind: ServiceResourceReceipt['kind'], name: string, serviceId: InstalledPlan['composition']['services'][number]['role'] | null, definition: unknown, actualId: string | null, imageDigest: string | null = null): ServiceResourceReceipt { const scope = { installationId: this.plan.configuration.installationId, installationDirectory: this.plan.configuration.installationDirectory }, definitionDigest = CanonicalJson.digest(definition); return ServiceSchemas.resourceReceipt.parse({ ...scope, formatVersion: 3, resourceId: CanonicalJson.digest({ ...scope, kind, name, serviceId, definitionDigest }), kind, name, serviceId, creatingGeneration: this.plan.digest, definitionDigest, references: [this.plan.digest], actualId, contentDigest: null, imageDigest, path: null, ownerUid: process.getuid!(), legacy: { formatVersion: 2, planDigest: this.plan.digest, serviceId } }); }
    private async names(kind: string): Promise<string[]> { const args = kind === 'container' ? ['container', 'ls', '--all'] : [kind, 'ls'], text = await this.commands.run(this.plan.expectedEngine, [...args, '--filter', 'label=com.docker.compose.project=' + this.plan.projectName, '--format', kind === 'container' ? '{{.ID}}' : '{{.Name}}']); return text ? text.split('\n').sort() : []; }
    async inspect(): Promise<ServiceResourceReceipt[]> {
        await this.commands.verify(this.plan.expectedEngine);
        const run = this.state.directory('run', true);
        try {
            Check.require(run.entries().join(',') === 'authority.pem', 'MIGRATION_NON_SERVING_REQUIRED');
        }
        finally {
            run.close();
        }
        const artifacts = this.state.directory('artifacts', true);
        let bindings: Record<string, unknown>, compose: Record<string, unknown>;
        try {
            const record = StrictJson.object(StrictJson.parse(artifacts.file('images/bindings.json', undefined, 1024 * 1024, true)));
            Check.require(record.planDigest === this.plan.digest, 'MIGRATION_IMAGE_BINDING');
            bindings = StrictJson.object(record.bindings);
            compose = StrictJson.object(StrictJson.parse(artifacts.file('compose.json', undefined, 4 * 1024 * 1024, true)));
        }
        finally {
            artifacts.close();
        }
        Check.require(Object.keys(bindings).sort().join(',') === 'api,database,edge,identity', 'MIGRATION_IMAGE_BINDING');
        const containers = await this.names('container');
        Check.require(containers.length === 4, 'MIGRATION_RESOURCE_IDENTITY');
        const resources: ServiceResourceReceipt[] = [], seen = new Set<string>(), secrets = StrictJson.object(compose.secrets), definitions = StrictJson.object(compose.services);
        for (const id of containers) {
            const actual = await this.object('container', id), config = StrictJson.object(actual.Config), labels = StrictJson.object(config.Labels), role = labels['com.docker.compose.service'];
            Check.require(['database', 'identity', 'api', 'edge'].includes(String(role)) && !seen.has(String(role)), 'MIGRATION_RESOURCE_IDENTITY');
            seen.add(String(role));
            const service = this.plan.composition.services.find(MigrationRuntime.role.bind(null, String(role)));
            Check.require(service, 'MIGRATION_RESOURCE_IDENTITY');
            this.labels(config, 'service', service.role);
            const state = StrictJson.object(actual.State);
            Check.require(state.Running === false && state.Paused === false && state.Restarting === false && state.Pid === 0, 'MIGRATION_NON_SERVING_REQUIRED');
            const image = this.plan.artifacts.find(MigrationRuntime.image.bind(null, this.plan.recipe.services[service.role]!.image));
            Check.require(image?.kind === 'image' && typeof actual.Image === 'string' && config.Image === actual.Image && actual.Image === bindings[service.role] && [image.manifestDigest, image.configDigest].includes(actual.Image.slice(7)), 'MIGRATION_IMAGE_BINDING');
            const host = StrictJson.object(actual.HostConfig), declared = service.definition.service;
            Check.require(host.Privileged === false && host.NetworkMode === this.plan.projectName + '_default' && Array.isArray(host.SecurityOpt) && host.SecurityOpt.includes('no-new-privileges:true'), 'MIGRATION_RESOURCE_IDENTITY');
            if (declared.command)
                Check.require(CanonicalJson.stringify(config.Cmd) === CanonicalJson.stringify(declared.command), 'MIGRATION_RESOURCE_IDENTITY');
            if (declared.user === 'installation-owner')
                Check.require(config.User === String(process.getuid!()) + ':0', 'MIGRATION_RESOURCE_IDENTITY');
            const environment = new Set(Array.isArray(config.Env) ? config.Env : []);
            for (const [key, value] of Object.entries(declared.environment ?? {}))
                Check.require(environment.has(key + '=' + value), 'MIGRATION_RESOURCE_IDENTITY');
            const expected = new Map<string, {
                type: string;
                name: string;
                readOnly: boolean;
            }>();
            for (const volume of declared.volumes)
                expected.set(volume.target, { type: 'volume', name: this.plan.projectName + '_' + volume.source, readOnly: volume.readOnly });
            for (const secret of declared.secrets) {
                const source = StrictJson.object(secrets[secret.source]);
                Check.require(typeof source.file === 'string', 'MIGRATION_RESOURCE_IDENTITY');
                expected.set(secret.target, { type: 'bind', name: source.file, readOnly: true });
            }
            if (declared.workerSocket) {
                const specification = StrictJson.object(definitions[service.role]);
                Check.require(Array.isArray(specification.volumes), 'MIGRATION_RESOURCE_IDENTITY');
                let source: string | undefined;
                for (const item of specification.volumes) {
                    const mount = StrictJson.object(item);
                    if (mount.target === '/run/cordis-host' && mount.type === 'bind' && mount.read_only === true)
                        source = String(mount.source);
                }
                Check.require(source, 'MIGRATION_RESOURCE_IDENTITY');
                expected.set('/run/cordis-host', { type: 'bind', name: source, readOnly: true });
            }
            Check.require(Array.isArray(actual.Mounts) && actual.Mounts.length === expected.size, 'MIGRATION_RESOURCE_IDENTITY');
            for (const item of actual.Mounts) {
                const mount = StrictJson.object(item), target = expected.get(String(mount.Destination));
                Check.require(target && mount.Type === target.type && mount.RW === !target.readOnly && (target.type === 'volume' ? mount.Name : mount.Source) === target.name, 'MIGRATION_RESOURCE_IDENTITY');
                expected.delete(String(mount.Destination));
            }
            Check.require(expected.size === 0 && typeof actual.Id === 'string' && /^[a-f0-9]{64}$/.test(actual.Id) && typeof actual.Name === 'string', 'MIGRATION_RESOURCE_IDENTITY');
            resources.push(this.receipt('container', actual.Name.slice(1), service.role, service.definition, actual.Id, actual.Image.slice(7)));
        }
        const networks = await this.names('network');
        Check.require(networks.join(',') === this.plan.projectName + '_default', 'MIGRATION_RESOURCE_IDENTITY');
        const network = await this.object('network', networks[0]!);
        this.labels(network, 'network', 'default');
        Check.require(typeof network.Id === 'string' && network.Driver === 'bridge' && Object.keys(StrictJson.object(network.Containers ?? {})).length === 0, 'MIGRATION_RESOURCE_IDENTITY');
        resources.push(this.receipt('network', networks[0]!, null, { project: this.plan.projectName, driver: 'bridge' }, network.Id));
        const volumes = await this.names('volume'), expectedVolumes = Object.keys(this.plan.recipe.volumes).map(MigrationRuntime.volume.bind(null, this.plan.projectName)).sort();
        Check.require(CanonicalJson.stringify(volumes) === CanonicalJson.stringify(expectedVolumes), 'MIGRATION_RESOURCE_IDENTITY');
        for (const name of volumes) {
            const volume = await this.object('volume', name), slot = name.slice(this.plan.projectName.length + 1);
            this.labels(volume, 'volume', slot);
            Check.require(volume.Driver === 'local' && volume.Name === name, 'MIGRATION_RESOURCE_IDENTITY');
            let owner: InstalledPlan['composition']['services'][number]['role'] | null = null;
            for (const service of this.plan.composition.services)
                for (const declared of service.definition.service.volumes)
                    if (declared.source === slot) {
                        Check.require(owner === null || owner === service.role, 'MIGRATION_RESOURCE_IDENTITY');
                        owner = service.role;
                    }
            resources.push(this.receipt('volume', name, owner, { slot }, name));
        }
        for (const kind of ['container', 'network', 'volume']) {
            const args = kind === 'container' ? ['container', 'ls', '--all'] : [kind, 'ls'], text = await this.commands.run(this.plan.expectedEngine, [...args, '--format', kind === 'container' ? '{{.Names}}' : '{{.Name}}']);
            for (const name of text.split('\n'))
                if (name === this.plan.projectName || name.startsWith(this.plan.projectName + '_') || name.startsWith(this.plan.projectName + '-'))
                    Check.require(resources.some(MigrationRuntime.owned.bind(null, kind, name)), 'MIGRATION_RESOURCE_IDENTITY');
        }
        await this.commands.verify(this.plan.expectedEngine);
        return resources.sort(MigrationRuntime.order);
    }
    private static owned(kind: string, name: string, receipt: ServiceResourceReceipt): boolean { return receipt.kind === kind && receipt.name === name; }
    private static role(role: string, service: InstalledPlan['composition']['services'][number]): boolean { return service.role === role; }
    private static image(reference: string, artifact: InstalledPlan['artifacts'][number]): boolean { return artifact.kind === 'image' && artifact.reference === reference; }
    private static volume(project: string, slot: string): string { return project + '_' + slot; }
    private static order(left: ServiceResourceReceipt, right: ServiceResourceReceipt): number { return left.resourceId < right.resourceId ? -1 : left.resourceId > right.resourceId ? 1 : 0; }
}
