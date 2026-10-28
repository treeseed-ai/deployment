import { CaddyServicePlugin } from '../src/service-caddy.js';
import { KataSandboxPlugin } from '../src/kata-backend.js';
import { ProjectTooling } from '@treeseed-cordis/sdk/source-policy';
import { CanonicalJson, PackageDefinition, type NativeDescriptorClass } from '@treeseed-cordis/sdk';
import { readFileSync, writeFileSync } from 'node:fs';
import { PostgresServicePlugin, PostgresReadinessPlugin } from '../src/service-postgres.js';

interface PackageMetadata {
  name: string;
  version: string;
  cordisPackage?: unknown;
}
class DeploymentTooling {
  private static readonly sources: Array<[NativeDescriptorClass, string, string]> = [
    [PostgresServicePlugin, 'service-postgres', 'PostgresServicePlugin'],
    [PostgresReadinessPlugin, 'service-postgres', 'PostgresReadinessPlugin'],
    [CaddyServicePlugin, 'service-caddy', 'CaddyServicePlugin'],
    [KataSandboxPlugin, 'kata-backend', 'KataSandboxPlugin'],
  ];
  static run(): void {
    ProjectTooling.run();
    const mode = process.argv[2];
    if (mode !== 'build' && mode !== 'check') return;
    const metadata = JSON.parse(readFileSync('package.json', 'utf8')) as PackageMetadata;
    const descriptor = this.descriptor(metadata);
    if (mode === 'check') this.verify(metadata.cordisPackage, descriptor);
    else this.publish(metadata, descriptor);
  }
  private static descriptor(metadata: PackageMetadata): object {
    const providers = [];
    for (const [plugin, file, name] of this.sources)
      providers.push(PackageDefinition.export(plugin, 'dist/src/' + file + '.js', name));
    return PackageDefinition.define(
      metadata.name,
      metadata.version,
      'deployment',
      providers,
      [],
      [PostgresServicePlugin.image, CaddyServicePlugin.image],
    );
  }
  private static verify(actual: unknown, expected: object): void {
    if (CanonicalJson.stringify(actual) !== CanonicalJson.stringify(expected))
      throw new Error('DEPLOYMENT_PACKAGE_METADATA_DRIFT');
  }
  private static publish(metadata: PackageMetadata, descriptor: object): void {
    metadata.cordisPackage = descriptor;
    writeFileSync('package.json', JSON.stringify(metadata, null, 2) + '\n');
  }
}
DeploymentTooling.run();
