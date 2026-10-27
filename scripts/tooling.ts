import { CaddyServicePlugin } from '../src/service-caddy.js';
import { ProjectTooling } from '@treeseed-cordis/sdk/source-policy';
import { CanonicalJson, PackageDefinition } from '@treeseed-cordis/sdk';
import { readFileSync, writeFileSync } from 'node:fs';
import { PostgresServicePlugin, PostgresReadinessPlugin } from '../src/service-postgres.js';
class DeploymentTooling {
    static run(): void {
        ProjectTooling.run(); const mode = process.argv[2]; if (mode !== 'build' && mode !== 'check') return;
        const metadata = JSON.parse(readFileSync('package.json', 'utf8')) as { name: string; version: string; cordisPackage?: unknown }, providers = [PackageDefinition.export(PostgresServicePlugin, 'dist/src/service-postgres.js', 'PostgresServicePlugin'), PackageDefinition.export(PostgresReadinessPlugin, 'dist/src/service-postgres.js', 'PostgresReadinessPlugin'), PackageDefinition.export(CaddyServicePlugin, 'dist/src/service-caddy.js', 'CaddyServicePlugin')], descriptor = PackageDefinition.define(metadata.name, metadata.version, 'deployment', providers, [], [PostgresServicePlugin.image, CaddyServicePlugin.image]);
        if (mode === 'check') { if (CanonicalJson.stringify(metadata.cordisPackage) !== CanonicalJson.stringify(descriptor)) throw new Error('DEPLOYMENT_PACKAGE_METADATA_DRIFT'); return; }
        metadata.cordisPackage = descriptor; writeFileSync('package.json', JSON.stringify(metadata, null, 2) + '\n');
    }
}
DeploymentTooling.run();
