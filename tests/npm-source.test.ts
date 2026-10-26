import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync, realpathSync, symlinkSync, lstatSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { create } from 'tar';
import { CanonicalJson } from '@treeseed-cordis/sdk';
import { ServiceReleaseFixture } from './release-fixture.js';
class NpmSourceTests {
    private static command(program: string, args: string[]): void {
        const result = spawnSync(program, args, { encoding: 'utf8', timeout: 120000 });
        if (result.status !== 0)
            throw new Error(result.stderr);
    }
    private static sha(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
    private calibrate(fixture:ServiceReleaseFixture,helper:string,directory=join(fixture.root,'pkg-1.0.0')):void {const lifecycle=join(fixture.root,'MUST_NOT_RUN'),imported=join(fixture.root,'SCRIPT_CANARY');const scripted=spawnSync(join(helper,'bun'),['--no-env-file','run','postinstall'],{cwd:directory,encoding:'utf8',timeout:15000,env:{PATH:helper,HOME:fixture.root,LANG:'C.UTF-8'}});if(scripted.status!==0||!existsSync(lifecycle)||readFileSync(lifecycle,'utf8')!=='executed')throw new Error('LIFECYCLE_CANARY_NOT_OBSERVABLE_AT_ABSOLUTE_PATH');unlinkSync(lifecycle);const code="import{pathToFileURL}from'node:url';class Calibration{static async run(){await import(pathToFileURL(process.argv[1]).href);}}await Calibration.run();",loaded=spawnSync('node',['--input-type=module','-e',code,join(directory,'index.js')],{encoding:'utf8',timeout:15000,env:{PATH:process.env.PATH,HOME:fixture.root}});if(loaded.status!==0||!existsSync(imported))throw new Error('IMPORT_CANARY_NOT_OBSERVABLE_AT_ABSOLUTE_PATH');unlinkSync(imported);}
    async program(): Promise<void> {
        const fixture = await new ServiceReleaseFixture().services();
        try {
            fixture.configuration.origin = 'https://127.0.0.1:59443';
            fixture.release.composition.services[0]!.definition.ports[0]!.publication!.port = 59443;
            fixture.recipe.services['instance-0']!.ports = [{ target: 8080, published: 59443, host_ip: '127.0.0.1', protocol: 'tcp' }];
            const helper = join(fixture.root, 'helper');
            mkdirSync(helper, { mode: 0o700 });
            copyFileSync(realpathSync(process.execPath), join(helper, 'bun'));
            chmodSync(join(helper, 'bun'), 0o500);
            const archive = join(fixture.bundle, 'bun.tgz');
            await create({ cwd: helper, file: archive, gzip: true, portable: false }, ['bun']);
            const bytes = readFileSync(archive);
            fixture.release.helpers = { formatVersion: 1, releaseIdentity: 'a'.repeat(64), helpers: [{ id: 'bun', version: '1.4.4', platform: 'linux-amd64', path: 'bun.tgz', sha256: NpmSourceTests.sha(bytes), size: bytes.length, entry: 'bun', files: [{ path: 'bun', sha256: NpmSourceTests.sha(readFileSync(join(helper, 'bun'))), mode: 0o500 }], libraryDirectories: [] }] };
            fixture.release.helpers.releaseIdentity = CanonicalJson.digest({ formatVersion: 1, helpers: fixture.release.helpers.helpers });
            for (const version of ['1.0.0', '2.0.0', '3.0.0','4.0.0']) {
                const directory = join(fixture.root, 'pkg-' + version);
                mkdirSync(directory);
                const metadata = JSON.parse(readFileSync(join(fixture.root, 'plugin/package/package.json'), 'utf8'));
                metadata.name = '@fixture/npm-source';
                metadata.version = version;
                metadata.dependencies={[version==='4.0.0'?'@fixture/forbidden':'@fixture/runtime']:'^1.0.0'};
                metadata.scripts = { postinstall: 'bun postinstall.ts' };
                writeFileSync(join(directory,'postinstall.ts'),"import{writeFileSync}from'node:fs';class LifecycleCanary{static run():void{writeFileSync("+JSON.stringify(join(fixture.root,'MUST_NOT_RUN'))+",'executed');}}LifecycleCanary.run();\n");
                metadata.cordisPackage.package = { name: metadata.name, version };
                if (version === '3.0.0')
                    delete metadata.cordisPackage;
                writeFileSync(join(directory, 'package.json'), JSON.stringify(metadata));
                copyFileSync(join(fixture.root, 'plugin/package/index.js'), join(directory, 'index.js'));
                await create({ cwd: directory, file: join(fixture.root, 'source-' + version + '.tgz'), gzip: true, portable: true, prefix: 'package/' }, ['package.json', 'index.js','postinstall.ts']);
            }
            const runtime=join(fixture.root,'runtime-package');mkdirSync(runtime);writeFileSync(join(runtime,'package.json'),JSON.stringify({name:'@fixture/runtime',version:'1.0.0',type:'module',exports:'./index.js',scripts:{postinstall:'bun postinstall.ts'}}));writeFileSync(join(runtime,'source.ts'),"import{writeFileSync}from'node:fs';export class RuntimeFixture{static mark():void{writeFileSync("+JSON.stringify(join(fixture.root,'SCRIPT_CANARY'))+",'imported');}}RuntimeFixture.mark();\n");NpmSourceTests.command(process.execPath,['build',join(runtime,'source.ts'),'--target=node','--outfile',join(runtime,'index.js')]);copyFileSync(join(fixture.root,'pkg-1.0.0/postinstall.ts'),join(runtime,'postinstall.ts'));await create({cwd:runtime,file:join(fixture.root,'runtime-1.0.0.tgz'),gzip:true,portable:true,prefix:'package/'},['package.json','index.js','postinstall.ts']);
            this.calibrate(fixture,helper);
            this.calibrate(fixture,helper,runtime);
            NpmSourceTests.command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-days', '1', '-subj', '/CN=Cordis registry fixture', '-addext', 'basicConstraints=critical,CA:TRUE', '-keyout', join(fixture.root, 'ca-key.pem'), '-out', join(fixture.bundle, 'source-ca.pem')]);
            NpmSourceTests.command('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-noenc', '-subj', '/CN=127.0.0.1', '-keyout', join(fixture.root, 'key.pem'), '-out', join(fixture.root, 'server.csr')]);
            writeFileSync(join(fixture.root, 'server.ext'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n');
            NpmSourceTests.command('openssl', ['x509', '-req', '-in', join(fixture.root, 'server.csr'), '-CA', join(fixture.bundle, 'source-ca.pem'), '-CAkey', join(fixture.root, 'ca-key.pem'), '-CAcreateserial', '-days', '1', '-extfile', join(fixture.root, 'server.ext'), '-out', join(fixture.root, 'cert.pem')]);
            fixture.refreshService();
            const input = join(fixture.root, 'npm-source.json');
            writeFileSync(input, JSON.stringify({ root: fixture.root, configuration: fixture.configuration }));
            const executable = join(fixture.root, 'npm-source-program');
            NpmSourceTests.command(process.execPath, ['build', 'dist/tests/npm-source-program.js', '--compile', '--target=bun-linux-x64', '--outfile', executable]);
            const docker = spawnSync('which', ['docker'], { encoding: 'utf8' });
            if (docker.status !== 0)
                throw new Error('Docker missing');
            const path = join(fixture.root, 'docker-only');
            mkdirSync(path);
            symlinkSync(docker.stdout.trim(), join(path, 'docker'));
            const result = spawnSync(executable, [input], { encoding: 'utf8', timeout: 120000, env: { PATH: path, HOME: process.env.HOME, DOCKER_CONFIG: process.env.DOCKER_CONFIG, NPM_TOKEN: 'NEVER_INHERIT', HTTPS_PROXY: 'http://127.0.0.1:1' } });
            if (result.status !== 0)
                throw new Error(result.stderr);
            expect(JSON.parse(result.stdout)).toEqual({ fixture: true, native: true, exact: true, pinnedRetry: true, movedNewKey: true, sourceFree: true, grantRefused: true, noCredentialsOrScripts: true, exactArchive: true, offlineArchive: true, tamperRefused: true,closure:true,joined:true,closureSourceFree:true,unapprovedDependencyRefused:true });
        }
        finally {
            this.writable(fixture.root);
            fixture.close();
        }
    }
    private writable(path: string): void {
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
const suite = new NpmSourceTests();
test('smoke: native managed Bun resolves approved HTTPS npm identity once and replays source-free after tag movement', suite.program.bind(suite), 240000);
