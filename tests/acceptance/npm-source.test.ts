import { PluginFixtureTools } from '../support/plugin-installation-fixture.js';
import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync, realpathSync, symlinkSync, lstatSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { create } from 'tar';
import { CanonicalJson, PackageDefinition } from '@treeseed-cordis/sdk';
import { ServiceReleaseFixture } from '../support/release-fixture.js';
import { ServiceRuntimeFixture } from '../support/service-runtime-fixture.js';
import { ServiceWorkerBuild } from '@treeseed-cordis/deployment';
import { ExtensionContainerFixture, StatefulExtensionFixture, ExtensionProbeFixture } from '../support/source-registry-fixture.js';
class NpmSourceTests {
    async program(): Promise<void> {
        const fixture = await new ServiceReleaseFixture().services();
        try {
            fixture.configuration.origin = 'https://127.0.0.1:59443';
            fixture.release.composition.services[0]!.definition.ports[0]!.publication!.port = 59443;
            fixture.recipe.services['instance-0']!.ports = [{ target: 8080, published: 59443, host_ip: '127.0.0.1', protocol: 'tcp' }];
            const helper = await PluginFixtureTools.tools(fixture);
            for (const version of ['1.0.0', '2.0.0', '3.0.0', '4.0.0']) {
                const directory = join(fixture.root, 'pkg-' + version);
                mkdirSync(directory);
                const metadata = JSON.parse(readFileSync(join(fixture.root, 'plugin/package/package.json'), 'utf8'));
                metadata.name = '@fixture/npm-source';
                metadata.version = version;
                metadata.dependencies = { [version === '4.0.0' ? '@fixture/forbidden' : '@fixture/runtime']: '^1.0.0' };
                metadata.scripts = { postinstall: 'bun postinstall.ts' };
                writeFileSync(join(directory, 'postinstall.ts'), "import{writeFileSync}from'node:fs';class LifecycleCanary{static run():void{writeFileSync(" + JSON.stringify(join(fixture.root, 'MUST_NOT_RUN')) + ",'executed');}}LifecycleCanary.run();\n");
                metadata.cordisPackage.package = { name: metadata.name, version };
                if (version === '3.0.0')
                    delete metadata.cordisPackage;
                writeFileSync(join(directory, 'package.json'), JSON.stringify(metadata));
                copyFileSync(join(fixture.root, 'plugin/package/index.js'), join(directory, 'index.js'));
                await create({ cwd: directory, file: join(fixture.root, 'source-' + version + '.tgz'), gzip: true, portable: true, prefix: 'package/' }, ['package.json', 'index.js', 'postinstall.ts']);
            }
            const runtime = join(fixture.root, 'runtime-package');
            mkdirSync(runtime);
            writeFileSync(join(runtime, 'package.json'), JSON.stringify({ name: '@fixture/runtime', version: '1.0.0', type: 'module', exports: './index.js', scripts: { postinstall: 'bun postinstall.ts' } }));
            writeFileSync(join(runtime, 'source.ts'), "import{writeFileSync}from'node:fs';export class RuntimeFixture{static mark():void{writeFileSync(" + JSON.stringify(join(fixture.root, 'SCRIPT_CANARY')) + ",'imported');}}RuntimeFixture.mark();\n");
            PluginFixtureTools.command(process.execPath, ['build', join(runtime, 'source.ts'), '--target=node', '--outfile', join(runtime, 'index.js')]);
            copyFileSync(join(fixture.root, 'pkg-1.0.0/postinstall.ts'), join(runtime, 'postinstall.ts'));
            await create({ cwd: runtime, file: join(fixture.root, 'runtime-1.0.0.tgz'), gzip: true, portable: true, prefix: 'package/' }, ['package.json', 'index.js', 'postinstall.ts']);
            PluginFixtureTools.calibrate(fixture, helper);
            PluginFixtureTools.calibrate(fixture, helper, runtime);
            PluginFixtureTools.certificates(fixture);
            fixture.refreshService();
            const input = join(fixture.root, 'npm-source.json');
            writeFileSync(input, JSON.stringify({ root: fixture.root, configuration: fixture.configuration }));
            const executable = join(fixture.root, 'npm-source-program');
            PluginFixtureTools.command(process.execPath, ['build', 'dist/tests/support/npm-source-program.js', '--compile', '--target=bun-linux-x64', '--outfile', executable]);
            const docker = spawnSync('which', ['docker'], { encoding: 'utf8' });
            if (docker.status !== 0)
                throw new Error('Docker missing');
            const path = join(fixture.root, 'docker-only');
            mkdirSync(path);
            symlinkSync(docker.stdout.trim(), join(path, 'docker'));
            const result = spawnSync(executable, [input], { encoding: 'utf8', timeout: 120000, env: { PATH: path, HOME: process.env.HOME, DOCKER_CONFIG: process.env.DOCKER_CONFIG, NPM_TOKEN: 'NEVER_INHERIT', HTTPS_PROXY: 'http://127.0.0.1:1' } });
            if (result.status !== 0)
                throw new Error(result.stderr);
            expect(JSON.parse(result.stdout)).toEqual({ fixture: true, native: true, exact: true, pinnedRetry: true, movedNewKey: true, sourceFree: true, grantRefused: true, noCredentialsOrScripts: true, exactArchive: true, offlineArchive: true, tamperRefused: true, closure: true, joined: true, closureSourceFree: true, unapprovedDependencyRefused: true });
        }
        finally {
            PluginFixtureTools.writable(fixture.root);
            fixture.close();
        }
    }
    async activation(): Promise<void> { return this.runActivation(false); }
    async freshActivation(): Promise<void> { return this.runActivation(true); }
    private async runActivation(fresh: boolean): Promise<void> {
        const fixture = new ServiceRuntimeFixture();
        try {
            await fixture.running(false, true);
            const removed = fixture.release.composition.services.pop()!;
            fixture.release.composition.profile.requiredBindings = [];
            for (const service of fixture.release.composition.services) for (const binding of service.bindings) fixture.release.composition.profile.requiredBindings.push(binding.bindingId);
            delete fixture.recipe.services[removed.serviceId];
            for (const slot of removed.resources.volumes) delete fixture.recipe.volumes['r-' + CanonicalJson.digest({ serviceId: removed.serviceId, slot }).slice(0, 48)];
            for (const slot of Object.keys(removed.resources.slots)) delete fixture.recipe.secrets['r-' + CanonicalJson.digest({ serviceId: removed.serviceId, slot }).slice(0, 48)];
            const references: string[] = []; for (const reference of fixture.configuration.credentialReferences) if (!reference.startsWith('secret://' + removed.serviceId + '/')) references.push(reference); fixture.configuration.credentialReferences = references;
            const helper = await PluginFixtureTools.tools(fixture); PluginFixtureTools.certificates(fixture);
            const implementation = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../support/source-registry-fixture.ts' : '../support/source-registry-fixture.js', import.meta.url)), image = fixture.release.images[0]!;
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
            if (fresh) { const output = join(fixture.root, 'fresh-worker'); mkdirSync(output, { mode: 0o700 }); const worker = ServiceWorkerBuild.produce(output); copyFileSync(join(output, worker.path), join(fixture.bundle, 'fresh-compiled-worker')); fixture.release.composition.worker = { ...worker, path: 'fresh-compiled-worker' }; }
            fixture.refreshService();
            const program = fresh ? 'installed-plugin-program' : 'plugin-install-program', input = join(fixture.root, 'plugin-install.json'), executable = join(fixture.root, program);
            writeFileSync(input, JSON.stringify({ root: fixture.root, configuration: fixture.configuration }));
            PluginFixtureTools.command(process.execPath, ['build', 'dist/tests/' + program + '.js', '--compile', '--target=bun-linux-x64', '--outfile', executable]);
            const docker = spawnSync('which', ['docker'], { encoding: 'utf8' }); if (docker.status !== 0) throw new Error('Docker missing');
            const path = join(fixture.root, 'docker-only'); mkdirSync(path); symlinkSync(docker.stdout.trim(), join(path, 'docker'));
            const result = spawnSync(executable, [input], { encoding: 'utf8', timeout: 360000, env: { PATH: path, HOME: process.env.HOME, DOCKER_CONFIG: process.env.DOCKER_CONFIG, NPM_TOKEN: 'NEVER_INHERIT', HTTPS_PROXY: 'http://127.0.0.1:1' } });
            if (result.status !== 0) throw new Error(result.stderr);
            expect(JSON.parse(result.stdout)).toEqual(fresh ? { fixtureOnly: true, freshOwner: true, active: true, sourceFree: true, noScripts: true } : { fixtureOnly: true, services: 6, active: true, alreadyActive: true, unsafePrepared: true, retained: true, sourceFree: true, noScripts: true });
        } finally { PluginFixtureTools.writable(fixture.root); fixture.close(); }
    }

}
const suite = new NpmSourceTests();
test("acceptance: native managed Bun resolves approved HTTPS npm identity once and replays source-free after tag movement", suite.program.bind(suite), 240000);
test("acceptance: built native plugin install adds two private instances while retaining original resources and prepares unsafe state changes", suite.activation.bind(suite), 420000);

test("acceptance: default installed plugin manager launches an exact fresh durable worker and reads cold records without activation", suite.freshActivation.bind(suite), 420000);
