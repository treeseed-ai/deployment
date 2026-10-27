import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PackageDefinition, CanonicalJson } from '@treeseed-cordis/sdk';
import { PostgresServicePlugin, PostgresReadinessPlugin } from '@treeseed-cordis/deployment';
import { ServiceRuntimeFixture } from './service-runtime-fixture.js';
import { ServiceProjection } from '../../src/service-projection.js';
/** Genuine production provider classes, packaged under an explicitly test-only archive identity. */
export class PostgresServiceFixture extends ServiceRuntimeFixture {
    async prepared(): Promise<this> {
        await this.services();
        const entry = join(this.root, 'postgres-entry.ts'), source = join(this.root, 'plugin/package'), module = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../../src/service-postgres.ts' : '../../src/service-postgres.js', import.meta.url));
        writeFileSync(entry, `import {writeFileSync} from 'node:fs';export {PostgresServicePlugin,PostgresReadinessPlugin} from ${JSON.stringify(module)};class Canary{static run():void{writeFileSync(${JSON.stringify(join(this.root, 'POSTGRES_IMPORT_CANARY'))},'imported');}}Canary.run();`);
        const build = spawnSync('bun', ['build', entry, '--target=node', '--outfile', join(source, 'index.js')], { encoding: 'utf8' });
        if (build.status !== 0) throw new Error('Production provider fixture compilation failed: ' + build.stderr);
        const image = this.preparedImage(PostgresServicePlugin.image.reference, 'postgres');
        if (image.indexSha256 !== PostgresServicePlugin.image.indexSha256 || image.manifestDigest !== PostgresServicePlugin.image.manifestDigest) throw new Error('Prepared Postgres selection changed');
        const metadata = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as Record<string, unknown>;
        metadata.cordisPackage = PackageDefinition.define('@fixture/plugin', '1.0.0', 'deployment', [PackageDefinition.export(PostgresServicePlugin, 'index.js', 'PostgresServicePlugin'), PackageDefinition.export(PostgresReadinessPlugin, 'index.js', 'PostgresReadinessPlugin')], [], [PostgresServicePlugin.image]);
        this.release.images = [image]; this.configuration.plugins[0]!.id = 'deployment'; this.release.requiredPluginIds = ['deployment']; this.release.requiredServices = ['container.service', 'probe.service'];
        this.release.composition.services = this.release.composition.services.slice(0, 2); this.release.composition.profile.requiredBindings = [];
        this.recipe = { services: {}, volumes: {}, secrets: {} }; this.configuration.credentialReferences = [];
        for (const service of this.release.composition.services) {
            service.provider = { ...service.provider, pluginId: 'deployment', providerId: PostgresServicePlugin.declaration.id, classExport: 'PostgresServicePlugin' };
            service.bindings = [{ port: 'postgres', bindingId: service.serviceId, contractId: 'storage.postgres', contractVersion: '1.0.0' }]; this.release.composition.profile.requiredBindings.push(service.serviceId);
            service.dependencies = []; service.configuration = {}; service.transitionPolicy = PostgresServicePlugin.container.transitionPolicy;
            service.readiness = { provider: { ...service.provider, providerId: PostgresReadinessPlugin.declaration.id, classExport: 'PostgresReadinessPlugin' }, scheme: 'tcp', configuration: {}, endpoint: { serviceId: service.serviceId, portId: 'postgres' }, deadlineMs: 5000, observationContract: 'storage.postgres', credentialReferences: ['secret://' + service.serviceId + '/database-password'] };
            const projection = ServiceProjection.resolve(service, PostgresServicePlugin.container, this.release.composition, this.configuration); service.definition = projection.definition; service.resources = projection.resources;
            const volume = 'r-' + CanonicalJson.digest({ serviceId: service.serviceId, slot: 'data' }).slice(0, 48), secret = 'r-' + CanonicalJson.digest({ serviceId: service.serviceId, slot: 'database-password' }).slice(0, 48);
            this.recipe.volumes[volume] = {}; this.recipe.secrets[secret] = { file: '.cordis/credentials/' + service.serviceId + '/database-password' }; this.configuration.credentialReferences.push('secret://' + service.serviceId + '/database-password');
            this.recipe.services[service.serviceId] = { image: image.reference, volumes: [{ type: 'volume', source: volume, target: '/var/lib/postgresql/data', read_only: false }], secrets: [secret] };
        }
        const first = this.release.composition.services[0]!, port = Number(new URL(this.configuration.origin).port); first.definition.ports[0]!.publication = { host: '127.0.0.1', port }; this.recipe.services[first.serviceId]!.ports = [{ host_ip: '127.0.0.1', published: port, target: 5432, protocol: 'tcp' }];
        await this.saveMetadata(metadata); return this;
    }
}
