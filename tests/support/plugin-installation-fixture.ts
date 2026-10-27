import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync, realpathSync, lstatSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { create } from 'tar';
import { CanonicalJson, PackageDefinition } from '@treeseed-cordis/sdk';
import { ServiceReleaseFixture } from './release-fixture.js';
import { ServiceRuntimeFixture } from './service-runtime-fixture.js';
import { ServiceWorkerBuild } from '../../src/service-worker-build.js';
import { RegistryFixture, ExtensionContainerFixture, StatefulExtensionFixture, ExtensionProbeFixture } from './source-registry-fixture.js';
/** Genuine build-time fixtures only; never an installer/source acquisition implementation. */
export class PluginFixtureTools {
    static command(program: string, args: string[]): void {
        const result = spawnSync(program, args, { encoding: 'utf8', timeout: 120000 });
        if (result.status !== 0)
            throw new Error(result.stderr);
    }
    static sha(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
    static calibrate(fixture: ServiceReleaseFixture, helper: string, directory = join(fixture.root, 'pkg-1.0.0'), importCanary = true): void { const lifecycle = join(fixture.root, 'MUST_NOT_RUN'), imported = join(fixture.root, 'SCRIPT_CANARY'); const scripted = spawnSync(join(helper, 'bun'), ['--no-env-file', 'run', 'postinstall'], { cwd: directory, encoding: 'utf8', timeout: 15000, env: { PATH: helper, HOME: fixture.root, LANG: 'C.UTF-8' } }); if (scripted.status !== 0 || !existsSync(lifecycle) || readFileSync(lifecycle, 'utf8') !== 'executed')
        throw new Error('LIFECYCLE_CANARY_NOT_OBSERVABLE_AT_ABSOLUTE_PATH'); unlinkSync(lifecycle); if (!importCanary) return; const code = "import{pathToFileURL}from'node:url';class Calibration{static async run(){await import(pathToFileURL(process.argv[1]).href);}}await Calibration.run();", loaded = spawnSync('node', ['--input-type=module', '-e', code, join(directory, 'index.js')], { encoding: 'utf8', timeout: 15000, env: { PATH: process.env.PATH, HOME: fixture.root } }); if (loaded.status !== 0 || !existsSync(imported))
        throw new Error('IMPORT_CANARY_NOT_OBSERVABLE_AT_ABSOLUTE_PATH'); unlinkSync(imported); }
    static async tools(fixture: ServiceReleaseFixture): Promise<string> {
    const helper = join(fixture.root, 'helper');
    mkdirSync(helper, { mode: 0o700 });
    copyFileSync(realpathSync(process.execPath), join(helper, 'bun'));
    chmodSync(join(helper, 'bun'), 0o500);
    const archive = join(fixture.bundle, 'bun.tgz');
    await create({ cwd: helper, file: archive, gzip: true, portable: false }, ['bun']);
    const bytes = readFileSync(archive);
    fixture.release.helpers = { formatVersion: 1, releaseIdentity: 'a'.repeat(64), helpers: [{ id: 'bun', version: '1.4.4', platform: 'linux-amd64', path: 'bun.tgz', sha256: PluginFixtureTools.sha(bytes), size: bytes.length, entry: 'bun', files: [{ path: 'bun', sha256: PluginFixtureTools.sha(readFileSync(join(helper, 'bun'))), mode: 0o500 }], libraryDirectories: [] }] };
    fixture.release.helpers.releaseIdentity = CanonicalJson.digest({ formatVersion: 1, helpers: fixture.release.helpers.helpers });
        return helper;
    }
    static compiledWorker(fixture:ServiceReleaseFixture):void{const output=join(fixture.root,'fresh-worker');mkdirSync(output,{mode:0o700});const worker=ServiceWorkerBuild.produce(output);copyFileSync(join(output,worker.path),join(fixture.bundle,'fresh-compiled-worker'));fixture.release.composition.worker={...worker,path:'fresh-compiled-worker'};}
    static certificates(fixture: ServiceReleaseFixture): void {
    PluginFixtureTools.command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-days', '1', '-subj', '/CN=Cordis registry fixture', '-addext', 'basicConstraints=critical,CA:TRUE', '-keyout', join(fixture.root, 'ca-key.pem'), '-out', join(fixture.bundle, 'source-ca.pem')]);
    PluginFixtureTools.command('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-noenc', '-subj', '/CN=127.0.0.1', '-keyout', join(fixture.root, 'key.pem'), '-out', join(fixture.root, 'server.csr')]);
    writeFileSync(join(fixture.root, 'server.ext'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n');
    PluginFixtureTools.command('openssl', ['x509', '-req', '-in', join(fixture.root, 'server.csr'), '-CA', join(fixture.bundle, 'source-ca.pem'), '-CAkey', join(fixture.root, 'ca-key.pem'), '-CAcreateserial', '-days', '1', '-extfile', join(fixture.root, 'server.ext'), '-out', join(fixture.root, 'cert.pem')]);
    }
    static writable(path: string): void {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink())
            return;
        if (stat.isDirectory()) {
            chmodSync(path, 0o700);
            for (const name of readdirSync(path))
                this.writable(join(path, name));
        }
        else
            chmodSync(path, 0o600);
    }
}
export class PluginInstallationFixture {
    readonly runtime = new ServiceRuntimeFixture();
    private registry: RegistryFixture | undefined;
    private git: import('./git-source-fixture.js').InstallationSources | undefined;
    private gitSources:{first:string;second:string}|undefined;
    get root(): string { return this.runtime.root; }
    get installation(): string { return this.runtime.installation; }
    get bundle(): string { return this.runtime.bundle; }
    get configuration() { return this.runtime.configuration; }
    async prepare(): Promise<this> {
        const fixture = this.runtime;
            await fixture.running(false, true);
            const removed = fixture.release.composition.services.pop()!;
            fixture.release.composition.profile.requiredBindings = [];
            for (const service of fixture.release.composition.services) for (const binding of service.bindings) fixture.release.composition.profile.requiredBindings.push(binding.bindingId);
            delete fixture.recipe.services[removed.serviceId];
            for (const slot of removed.resources.volumes) delete fixture.recipe.volumes['r-' + CanonicalJson.digest({ serviceId: removed.serviceId, slot }).slice(0, 48)];
            for (const slot of Object.keys(removed.resources.slots)) delete fixture.recipe.secrets['r-' + CanonicalJson.digest({ serviceId: removed.serviceId, slot }).slice(0, 48)];
            const references: string[] = []; for (const reference of fixture.configuration.credentialReferences) if (!reference.startsWith('secret://' + removed.serviceId + '/')) references.push(reference); fixture.configuration.credentialReferences = references;
            const helper = await PluginFixtureTools.tools(fixture); PluginFixtureTools.certificates(fixture);
            const implementation = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './source-registry-fixture.ts' : './source-registry-fixture.js', import.meta.url)), image = fixture.release.images[0]!;
            for (const version of ['1.0.0', '2.0.0']) {
                const directory = join(fixture.root, 'pkg-' + version), state = version === '1.0.0' ? 1 : 2;
                mkdirSync(directory);
                const entry = join(directory, 'provider.ts');
                writeFileSync(entry, 'export{' + (state === 1 ? 'ExtensionContainerFixture' : 'StatefulExtensionFixture as ExtensionContainerFixture') + ',ExtensionProbeFixture}from' + JSON.stringify(implementation) + ';\n');
                PluginFixtureTools.command(process.execPath, ['build', entry, '--target=node', '--outfile', join(directory, 'index.js')]);
                const descriptor = PackageDefinition.define('@fixture/extension', version, 'extension', [PackageDefinition.export(state === 1 ? ExtensionContainerFixture : StatefulExtensionFixture, 'index.js', 'ExtensionContainerFixture'), PackageDefinition.export(ExtensionProbeFixture, 'index.js', 'ExtensionProbeFixture')], [], [{ id: image.id, reference: image.reference, indexSha256: image.indexSha256, manifestDigest: image.manifestDigest, source: { kind: 'prepared' } }]);
                writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: '@fixture/extension', version, type: 'module', exports: './index.js', cordisPackage: descriptor, scripts: { postinstall: 'bun postinstall.ts' } }));
                writeFileSync(join(directory, 'postinstall.ts'), "import{writeFileSync}from'node:fs';class LifecycleCanary{static run():void{writeFileSync(" + JSON.stringify(join(fixture.root, 'MUST_NOT_RUN')) + ",'executed');}}LifecycleCanary.run();\n");
                PluginFixtureTools.calibrate(fixture, helper, directory, false);
                await create({ cwd: directory, file: join(fixture.root, 'source-' + version + '.tgz'), gzip: true, portable: true, prefix: 'package/' }, ['package.json', 'index.js', 'postinstall.ts']);
            }
            PluginFixtureTools.compiledWorker(fixture);
            fixture.refreshService();
        return this;
    }
    source(version = '1.0.0'): string { if (!['1.0.0', '2.0.0'].includes(version)) throw new Error('UNKNOWN_FIXTURE_VERSION'); return this.gitSources?(version==='2.0.0'?this.gitSources.second:this.gitSources.first):'@fixture/extension@' + version; }
    async startRegistry(): Promise<string> {
        if (this.registry||this.git) throw new Error('FIXTURE_REGISTRY_ALREADY_CREATED');
        this.registry = new RegistryFixture(this.root, this.installation, '@fixture/extension', ['1.0.0', '2.0.0']);
        await this.registry.listen();
        this.runtime.release.acquisitionPolicy = { formatVersion: 1, helperReleaseIdentity: this.runtime.release.helpers!.releaseIdentity, npm: [{ registry: this.registry.origin(), packages: ['@fixture/extension'], targets: ['deployment'], certificateAuthority: { path: 'source-ca.pem', sha256: PluginFixtureTools.sha(readFileSync(join(this.bundle, 'source-ca.pem'))) } }], git: [], builds: [] };
        this.runtime.refreshService();
        return this.registry.origin();
    }
    async startGit(build=false):Promise<string>{if(this.registry||this.git)throw new Error('FIXTURE_REGISTRY_ALREADY_CREATED');const{GitFixtureTools,InstallationSources}=await import('./git-source-fixture.js');await GitFixtureTools.helper(this.runtime);const gitIdentity=GitFixtureTools.installationRepository(this.runtime),gitBuild=build?{...GitFixtureTools.buildRepository(this.runtime),image:ServiceRuntimeFixture.base}:undefined;this.git=new InstallationSources({root:this.root,gitIdentity,gitBuild},this.installation);await this.git.listen();this.gitSources={first:this.git.source(),second:this.git.source('2.0.0')};this.runtime.release.acquisitionPolicy=this.git.policy(this.runtime.release.helpers!.releaseIdentity,{path:'source-ca.pem',sha256:PluginFixtureTools.sha(readFileSync(join(this.bundle,'source-ca.pem')))});this.runtime.refreshService();return this.source();}
    async stopRegistry(): Promise<void> { await this.registry?.close(); await this.git?.close(); }
    async close(): Promise<void> { try { await this.stopRegistry(); } finally { PluginFixtureTools.writable(this.root); this.runtime.close(); } }
}
