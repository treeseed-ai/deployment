import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceReleaseFixture, PreparedReleaseFixture } from './release-fixture.js';
import { RuntimeContainerFixture, ProbeFixture, QualificationProbeFixture } from './service-fixture-plugins.js';
import { ServiceProjection } from '../src/service-projection.js';
import { CanonicalJson, ServiceSchemas, PackageDefinition, type ServiceRelease } from '@treeseed-cordis/sdk';
interface Descriptor {
    digest: string;
    size: number;
    mediaType?: string;
    platform?: {
        os: string;
        architecture: string;
    };
}
/** Disposable genuine image producer. Its commands never run in the implementation path. */
export class ServiceRuntimeFixture extends ServiceReleaseFixture {
    private readonly imageTag = 'cordis-task3c-fixture:' + PreparedReleaseFixture.sha(this.root).slice(0, 16);
    private project = '';
    authorityCertificate: string | null = null;
    static readonly base = 'node@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553';
    private static run(name: string, args: string[], cwd?: string): string {
        const result = spawnSync(name, args, { cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
        if (result.status !== 0)
            throw new Error('Fixture prerequisite failed: ' + name + ' ' + args.slice(0, 3).join(' ') + ' ' + result.stderr.slice(-2000));
        return result.stdout.trim();
    }
    publicAuthority(): string {
        const directory = join(this.root, 'public-authority'); mkdirSync(directory, { mode: 0o700 });
        this.authorityCertificate = join(directory, 'root.crt');
        ServiceRuntimeFixture.run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-days', '1', '-subj', '/CN=Cordis public authority fixture', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', join(directory, 'fixture-key.pem'), '-out', this.authorityCertificate]);
        return this.authorityCertificate;
    }
    async running(qualification = false, authority = false): Promise<this> {
        await this.services();
        this.project = 'cordis-' + CanonicalJson.digest({ installationId: this.configuration.installationId, installationDirectory: this.installation }).slice(0, 16);
        const inspect = spawnSync('docker', ['image', 'inspect', ServiceRuntimeFixture.base], { encoding: 'utf8' });
        if (inspect.status !== 0)
            ServiceRuntimeFixture.run('docker', ['image', 'pull', ServiceRuntimeFixture.base]);
        const build = join(this.root, 'runtime-image');
        mkdirSync(build);
        if (authority) copyFileSync(this.publicAuthority(), join(build, 'authority.pem'));
        writeFileSync(join(build, 'http.ts'), `import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';import {readFileSync,writeFileSync,existsSync} from 'node:fs';export class FixtureServer {static start():void {if(existsSync('/fixture/authority.pem')&&!existsSync('/data/root.crt'))writeFileSync('/data/root.crt',readFileSync('/fixture/authority.pem'));if(!existsSync('/data/identity'))writeFileSync('/data/identity',process.env.FIXTURE_SERVICE_ID!);createServer(this.serve.bind(this)).listen(8080,'0.0.0.0');}static serve(_request:IncomingMessage,response:ServerResponse):void {const configuration=JSON.parse(readFileSync('/run/cordis/configuration.json','utf8')) as {service:string;password:string};const password=readFileSync('/run/cordis/password','utf8');response.setHeader('content-type','application/json');response.end(JSON.stringify({serviceId:configuration.service,passwordPresent:password.length===64&&password===configuration.password,volumeMarker:readFileSync('/data/identity','utf8')}));}}FixtureServer.start();`);
        ServiceRuntimeFixture.run('bun', ['build', join(build, 'http.ts'), '--target=node', '--outfile', join(build, 'http.js')]);
        writeFileSync(join(build, 'Dockerfile'), 'FROM ' + ServiceRuntimeFixture.base + '\nCOPY http.js /fixture/http.js\n' + (authority ? 'COPY authority.pem /fixture/authority.pem\n' : '') + 'CMD ["node","/fixture/http.js"]\n');
        ServiceRuntimeFixture.run('docker', ['build', '--network=none', '--pull=false', '--tag', this.imageTag, build]);
        const image = this.exportImage();
        this.release.images = [image];
        const source = join(this.root, 'plugin/package'), metadata = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as Record<string, unknown>;
        metadata.cordisPackage = PackageDefinition.define('@fixture/plugin', '1.0.0', 'fixture', [PackageDefinition.export(RuntimeContainerFixture, 'index.js', 'RuntimeContainerFixture'), PackageDefinition.export(ProbeFixture, 'index.js', 'ProbeFixture'), PackageDefinition.export(QualificationProbeFixture, 'index.js', 'QualificationProbeFixture')], [], [{ id: image.id, reference: image.reference, manifestDigest: image.manifestDigest, indexSha256: image.indexSha256, source: { kind: 'prepared' } }]);
        this.recipe = { services: {}, volumes: {}, secrets: {} };
        this.configuration.credentialReferences = [];
        for (const service of this.release.composition.services) {
            service.provider = { ...service.provider, providerId: RuntimeContainerFixture.declaration.id, classExport: 'RuntimeContainerFixture' };
            service.configuration = {};
            service.readiness.deadlineMs = 5000;
            service.dependencies = [];
            const projection = ServiceProjection.resolve(service, RuntimeContainerFixture.container, this.release.composition, this.configuration);
            service.definition = projection.definition;
            service.resources = projection.resources;
            service.transitionPolicy = RuntimeContainerFixture.container.transitionPolicy;
            const spec: typeof this.recipe.services[string] = { image: image.reference, volumes: [], secrets: [] };
            for (const volume of service.definition.volumes) {
                const name = 'r-' + CanonicalJson.digest({ serviceId: service.serviceId, slot: volume.source }).slice(0, 48);
                this.recipe.volumes[name] = {};
                spec.volumes!.push({ type: 'volume', source: name, target: volume.target, read_only: volume.readOnly });
            }
            for (const slot of Object.keys(service.resources.slots)) {
                const name = 'r-' + CanonicalJson.digest({ serviceId: service.serviceId, slot }).slice(0, 48);
                this.recipe.secrets[name] = { file: '.cordis/credentials/' + service.serviceId + '/' + slot };
                this.configuration.credentialReferences.push('secret://' + service.serviceId + '/' + slot);
            }
            for (const secret of service.definition.secrets)
                spec.secrets!.push('r-' + CanonicalJson.digest({ serviceId: service.serviceId, slot: secret.slot }).slice(0, 48));
            this.recipe.services[service.serviceId] = spec;
        }
        if (qualification) {
            const selected = this.release.composition.services[2]!;
            selected.readiness.provider = { ...selected.readiness.provider, providerId: QualificationProbeFixture.declaration.id, classExport: 'QualificationProbeFixture' };
            selected.readiness.credentialReferences = ['secret://' + selected.serviceId + '/password'];
            selected.readiness.deadlineMs = 250;
        }
        const first = this.release.composition.services[0]!, port = Number(new URL(this.configuration.origin).port);
        first.definition.ports[0]!.publication = { host: '127.0.0.1', port };
        this.recipe.services[first.serviceId]!.ports = [{ host_ip: '127.0.0.1', published: port, target: 8080, protocol: 'tcp' }];
        await this.saveMetadata(metadata);
        return this;
    }
    private blob(root: string, descriptor: Descriptor): Buffer {
        const bytes = readFileSync(join(root, 'blobs/sha256', descriptor.digest.slice(7)));
        if ('sha256:' + PreparedReleaseFixture.sha(bytes) !== descriptor.digest || bytes.length !== descriptor.size)
            throw new Error('Invalid fixture OCI descriptor');
        return bytes;
    }
    private select(root: string, items: Descriptor[]): Descriptor {
        for (const item of items) {
            if (item.platform && (item.platform.os !== 'linux' || item.platform.architecture !== 'amd64'))
                continue;
            const data = JSON.parse(this.blob(root, item).toString()) as {
                manifests?: Descriptor[];
                config?: Descriptor;
            };
            if (data.manifests) {
                try {
                    return this.select(root, data.manifests);
                }
                catch {
                    continue;
                }
            }
            if (data.config) {
                const config = JSON.parse(this.blob(root, data.config).toString()) as {
                    os: string;
                    architecture: string;
                };
                if (config.os === 'linux' && config.architecture === 'amd64')
                    return item;
            }
        }
        throw new Error('Missing native OCI fixture');
    }
    private exportImage(): ServiceRelease['images'][number] {
        const archive = join(this.root, 'runtime-image.tar'), root = join(this.root, 'docker-layout');
        ServiceRuntimeFixture.run('docker', ['image', 'save', '--output', archive, this.imageTag]);
        mkdirSync(root);
        ServiceRuntimeFixture.run('tar', ['--extract', '--file', archive, '--directory', root]);
        const index = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')) as {
            manifests: Descriptor[];
        }, selected = this.select(root, index.manifests), bytes = this.blob(root, selected), manifest = JSON.parse(bytes.toString()) as {
            config: Descriptor;
            layers: Descriptor[];
        };
        rmSync(join(this.bundle, 'oci'), { recursive: true });
        mkdirSync(join(this.bundle, 'oci/blobs/sha256'), { recursive: true });
        for (const descriptor of [selected, manifest.config, ...manifest.layers])
            writeFileSync(join(this.bundle, 'oci/blobs/sha256', descriptor.digest.slice(7)), this.blob(root, descriptor));
        this.write('oci/oci-layout', { imageLayoutVersion: '1.0.0' });
        const manifestDigest = selected.digest.slice(7), indexSha256 = this.write('oci/index.json', { schemaVersion: 2, manifests: [{ mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: selected.digest, size: bytes.length, platform: { os: 'linux', architecture: 'amd64' } }] });
        return { id: 'application', reference: 'fixture/runtime@sha256:' + manifestDigest, layout: 'oci', manifestDigest, indexSha256 };
    }
    override close(): void {
        if (!this.project && this.configuration)
            this.project = 'cordis-' + CanonicalJson.digest({ installationId: this.configuration.installationId, installationDirectory: this.installation }).slice(0, 16);
        if (this.project) {
            for (const kind of ['container', 'volume', 'network']) {
                const args = kind === 'container' ? ['container', 'ls', '--all', '--quiet', '--filter', 'label=com.docker.compose.project=' + this.project] : [kind, 'ls', '--quiet', '--filter', 'label=com.docker.compose.project=' + this.project];
                const result = spawnSync('docker', args, { encoding: 'utf8' });
                if (result.status === 0) {
                    const ids = result.stdout.trim().split('\n').filter(ServiceRuntimeFixture.nonempty);
                    if (ids.length)
                        ServiceRuntimeFixture.run('docker', [kind, 'rm', ...(kind === 'container' ? ['--force'] : []), ...ids]);
                }
            }
        }
        spawnSync('docker', ['image', 'rm', this.imageTag], { encoding: 'utf8' });
        super.close();
    }
    private static nonempty(value: string): boolean { return value.length > 0; }
}
