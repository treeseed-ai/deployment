import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawnSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, realpathSync, chmodSync, existsSync, symlinkSync, unlinkSync, renameSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { create } from 'tar';
import { CanonicalJson, PackageDefinition, type SourceAcquisitionPolicy, type SourceToolDefinition } from '@treeseed-cordis/sdk';
import type { ServiceReleaseFixture } from './release-fixture.js';
import { PluginFixtureTools } from './plugin-installation-fixture.js';
import { RegistryFixture, ExtensionContainerFixture, ExtensionProbeFixture } from './source-registry-fixture.js';
import { fileURLToPath } from 'node:url';
export interface GitRepositoryIdentity {first:string;second:string;refsFirst:string;refsSecond:string;}
export interface GitFixtureIdentity extends GitRepositoryIdentity {symlink:string;attributes:string;oversized:string;}
/** Actual Git/HTTPS bytes and commits; no fake source executable or credentials. */
export class GitFixtureTools {
    static command(program: string, args: string[], cwd?: string): string { const result = spawnSync(program, args, { cwd, encoding: 'utf8', timeout: 120000, env: { PATH: process.env.PATH, HOME: cwd ?? process.cwd(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', LANG: 'C.UTF-8' } }); if (result.status !== 0)
        throw new Error('Git fixture prerequisite failed: ' + result.stderr.slice(-1000)); return result.stdout.trim(); }
    static sha(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
    private static order(a: {
        path: string;
    }, b: {
        path: string;
    }): number { return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; }
    static async helper(fixture: ServiceReleaseFixture): Promise<void> {
        const git = realpathSync(this.command('which', ['git'])), exec = this.command(git, ['--exec-path']), root = join(fixture.root, 'git-helper');
        mkdirSync(root, { mode: 0o700 });
        for (const name of ['bin', 'libexec', 'lib'])
            mkdirSync(join(root, name), { mode: 0o700 });
        const binaries = new Map<string, string>([['bin/git', git], ['libexec/git', git]]);
        for (const name of ['git-remote-https', 'git-index-pack', 'git-unpack-objects', 'git-upload-pack', 'git-http-backend'])
            binaries.set('libexec/' + name, realpathSync(join(exec, name)));
        const libraries = new Map<string, string>();
        for (const source of binaries.values())
            for (const line of this.command('ldd', [source]).split('\n')) {
                const match = /=>\s+(\/\S+)/.exec(line) ?? /^\s*(\/\S+)/.exec(line);
                if (match)
                    libraries.set('lib/' + basename(match[1]!), match[1]!);
            }
        const files: SourceToolDefinition['files'] = [];
        for (const [path, source] of [...binaries, ...libraries]) {
            copyFileSync(source, join(root, path));
            const mode = binaries.has(path) ? 0o500 : 0o400;
            chmodSync(join(root, path), mode);
            files.push({ path, sha256: this.sha(readFileSync(join(root, path))), mode });
        }
        files.sort(this.order);
        const archive = join(fixture.bundle, 'git.tgz');
        await create({ cwd: root, file: archive, gzip: true, portable: false }, ['bin', 'libexec', 'lib']);
        const bytes = readFileSync(archive), version = /^git version (\d+\.\d+\.\d+)/.exec(this.command(git, ['--version']));
        if (!version || !fixture.release.helpers)
            throw new Error('Git helper prerequisite missing');
        fixture.release.helpers.helpers.push({ id: 'git', version: version[1]!, platform: 'linux-amd64', path: 'git.tgz', sha256: this.sha(bytes), size: bytes.length, entry: 'bin/git', files, libraryDirectories: ['lib'], executableDirectory: 'libexec' });
        fixture.release.helpers.releaseIdentity = CanonicalJson.digest({ formatVersion: 1, helpers: fixture.release.helpers.helpers });
    }
    static async runtime(fixture:ServiceReleaseFixture):Promise<void>{const directory=join(fixture.root,'git-runtime');mkdirSync(directory);writeFileSync(join(directory,'runtime.ts'),'export class GitRuntimeDependency {static readonly value=1;}\n');PluginFixtureTools.command(process.execPath,['build',join(directory,'runtime.ts'),'--target=node','--outfile',join(directory,'index.js')]);writeFileSync(join(directory,'package.json'),JSON.stringify({name:'@fixture/runtime',version:'1.0.0',type:'module',exports:'./index.js',scripts:{postinstall:'bun postinstall.ts'}}));writeFileSync(join(directory,'postinstall.ts'),"import{writeFileSync}from'node:fs';class Canary{static run():void{writeFileSync("+JSON.stringify(join(fixture.root,'MUST_NOT_RUN'))+",'executed');}}Canary.run();\n");PluginFixtureTools.calibrate(fixture,join(fixture.root,'helper'),directory,false);await create({cwd:directory,file:join(fixture.root,'runtime-1.0.0.tgz'),gzip:true,portable:true,prefix:'package/'},['package.json','index.js','postinstall.ts']);}
    static installationRepository(fixture:ServiceReleaseFixture):GitRepositoryIdentity{const root=fixture.root,source=join(root,'git-work'),bare=join(root,'repository.git');mkdirSync(source);this.command('git',['init','--initial-branch=main','--template=',source]);const commits:string[]=[];for(const version of ['1.0.0','2.0.0']){for(const name of ['package.json','index.js','postinstall.ts'])copyFileSync(join(root,'pkg-'+version,name),join(source,name));this.command('git',['add','.'],source);this.command('git',['-c','user.name=Cordis fixture','-c','user.email=fixture@example.invalid','commit','-m','Native installation fixture '+version],source);commits.push(this.command('git',['rev-parse','HEAD'],source));if(version==='1.0.0')this.command('git',['-c','user.name=Cordis fixture','-c','user.email=fixture@example.invalid','tag','-a','release','-m','Native fixture release'],source);}const first=commits[0]!,second=commits[1]!;this.command('git',['clone','--bare','--no-hardlinks',source,bare]);this.command('git',['--git-dir='+bare,'update-ref','refs/heads/main',first]);this.command('git',['--git-dir='+bare,'update-server-info']);const refsFirst=readFileSync(join(bare,'info/refs'),'utf8');this.command('git',['--git-dir='+bare,'update-ref','refs/heads/main',second]);this.command('git',['--git-dir='+bare,'update-server-info']);const refsSecond=readFileSync(join(bare,'info/refs'),'utf8');writeFileSync(join(bare,'refs/heads/main'),first+'\n');this.command('git',['init','--template=',root]);this.command('git',['config','url.https://never-inherit.invalid/.insteadOf','https://'],root);return{first,second,refsFirst,refsSecond};}
    static buildRepository(fixture:ServiceReleaseFixture):{commit:string;entryDigest:string}{const root=fixture.root,source=join(root,'git-work');this.command('git',['switch','--detach',this.command('git',['rev-parse','release^{commit}'],source)],source);renameSync(join(source,'index.js'),join(source,'provider-source.ts'));writeFileSync(join(source,'provider-source.ts'),readFileSync(join(source,'provider-source.ts'),'utf8')+'\nexport class GitBuildProof {static readonly value:number=42;}\n');const metadata=JSON.parse(readFileSync(join(source,'package.json'),'utf8')) as {scripts:Record<string,string>;dependencies?:unknown};delete metadata.dependencies;metadata.scripts.prepack=metadata.scripts.postinstall!;writeFileSync(join(source,'package.json'),JSON.stringify(metadata));
        const code="import{mkdirSync,readFileSync,writeFileSync,copyFileSync,existsSync}from'node:fs';class ApprovedBuild {static async run():Promise<void>{if(process.env.BUILD_SECRET_CANARY||process.env.NPM_TOKEN||existsSync("+JSON.stringify(join(root,'MUST_NOT_RUN'))+"))throw new Error('build isolation leaked');let reached=false;try{await fetch('https://1.1.1.1',{signal:AbortSignal.timeout(250)});reached=true;}catch{}if(reached)throw new Error('build network enabled');const output='/work/out/package';mkdirSync(output,{recursive:true});const result=await Bun.build({entrypoints:['/input/provider-source.ts'],target:'node',outdir:output,naming:'index.js'});if(!result.success)throw new Error('fixture compilation failed');copyFileSync('/input/package.json',output+'/package.json');copyFileSync('/input/postinstall.ts',output+'/postinstall.ts');writeFileSync(output+'/built.txt','genuine isolated TypeScript build');}}await ApprovedBuild.run();\n";writeFileSync(join(source,'build.ts'),code);this.command('git',['add','-A'],source);this.command('git',['-c','user.name=Cordis fixture','-c','user.email=fixture@example.invalid','commit','-m','Source-only build fixture'],source);const commit=this.command('git',['rev-parse','HEAD'],source);this.command('git',['push',join(root,'repository.git'),'HEAD:refs/heads/source-only'],source);return{commit,entryDigest:this.sha(Buffer.from(code))};}
    static repository(fixture: ServiceReleaseFixture): GitFixtureIdentity {
        const root = fixture.root;
        const source = join(root, 'git-work'), bare = join(root, 'repository.git');
        mkdirSync(source);
        this.command('git', ['init', '--initial-branch=main', '--template=', source]);
        const implementation = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './source-registry-fixture.ts' : './source-registry-fixture.js', import.meta.url)), image = fixture.release.images[0]!;
        writeFileSync(join(source, 'provider.ts'), 'export{ExtensionContainerFixture,ExtensionProbeFixture}from' + JSON.stringify(implementation) + ';\n');
        writeFileSync(join(source, 'provider.ts'), readFileSync(join(source, 'provider.ts'), 'utf8') + "\nimport{writeFileSync as canaryWrite}from'node:fs';class ImportCanary{static readonly value=canaryWrite(" + JSON.stringify(join(root, 'SCRIPT_CANARY')) + ",'executed');}\n");
        PluginFixtureTools.command(process.execPath, ['build', join(source, 'provider.ts'), '--target=node', '--outfile', join(source, 'index.js')]);
        const descriptor = PackageDefinition.define('@fixture/git-source', '1.0.0', 'extension', [PackageDefinition.export(ExtensionContainerFixture, 'index.js', 'ExtensionContainerFixture'), PackageDefinition.export(ExtensionProbeFixture, 'index.js', 'ExtensionProbeFixture')], [], [{ id: image.id, reference: image.reference, indexSha256: image.indexSha256, manifestDigest: image.manifestDigest, source: { kind: 'prepared' } }]);
        writeFileSync(join(source, 'package.json'), JSON.stringify({ name: '@fixture/git-source', version: '1.0.0', type: 'module', exports: './index.js', cordisPackage: descriptor, dependencies:{'@fixture/runtime':'^1.0.0'},scripts: { postinstall: 'bun postinstall.ts' } }));
        writeFileSync(join(source, 'postinstall.ts'), "import{writeFileSync}from'node:fs';class Canary{static run():void{writeFileSync(" + JSON.stringify(join(root, 'MUST_NOT_RUN')) + ",'executed');}}Canary.run();\n");
        PluginFixtureTools.calibrate(fixture, join(root, 'helper'), source, true);
        writeFileSync(join(source, 'revision.txt'), 'first exact commit\n');
        this.command('git', ['add', '.'], source);
        this.command('git', ['-c', 'user.name=Cordis fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture one'], source);
        const first = this.command('git', ['rev-parse', 'HEAD'], source);
        this.command('git', ['-c', 'user.name=Cordis fixture', '-c', 'user.email=fixture@example.invalid', 'tag', '-a', 'release', '-m', 'Fixture annotated release'], source);
        writeFileSync(join(source, 'revision.txt'), 'second exact commit\n');
        this.command('git', ['add', '.'], source);
        this.command('git', ['-c', 'user.name=Cordis fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture two'], source);
        const second = this.command('git', ['rev-parse', 'HEAD'], source);
        this.command('git', ['branch', 'future', second], source);
        this.command('git', ['branch', 'twin', first], source);
        this.command('git', ['tag', 'twin', first], source);
        symlinkSync('/etc/passwd', join(source, 'unsafe-link'));
        this.command('git', ['add', '.'], source);
        this.command('git', ['-c', 'user.name=Cordis fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Unsafe symlink fixture'], source);
        const symlink = this.command('git', ['rev-parse', 'HEAD'], source);
        this.command('git', ['branch', 'unsafe-symlink', symlink], source);
        unlinkSync(join(source, 'unsafe-link'));
        writeFileSync(join(source, '.gitattributes'), 'revision.txt export-subst\n');
        this.command('git', ['add', '-A'], source);
        this.command('git', ['-c', 'user.name=Cordis fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Unsupported attributes fixture'], source);
        const attributes = this.command('git', ['rev-parse', 'HEAD'], source);
        this.command('git', ['branch', 'unsafe-attributes', attributes], source);
        unlinkSync(join(source, '.gitattributes'));
        writeFileSync(join(source, 'oversized.bin'), Buffer.alloc(8 * 1024 * 1024 + 1, 65));
        this.command('git', ['add', '-A'], source);
        this.command('git', ['-c', 'user.name=Cordis fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Oversized source fixture'], source);
        const oversized = this.command('git', ['rev-parse', 'HEAD'], source);
        this.command('git', ['branch', 'unsafe-size', oversized], source);
        this.command('git', ['clone', '--bare', '--no-hardlinks', source, bare]);
        this.command('git', ['--git-dir=' + bare, 'update-ref', 'refs/heads/main', first]);
        this.command('git', ['--git-dir=' + bare, 'update-server-info']);
        const refsFirst = readFileSync(join(bare, 'info/refs'), 'utf8');
        this.command('git', ['--git-dir=' + bare, 'update-ref', 'refs/heads/main', second]);
        this.command('git', ['--git-dir=' + bare, 'update-server-info']);
        const refsSecond = readFileSync(join(bare, 'info/refs'), 'utf8');
        writeFileSync(join(bare, 'refs/heads/main'), first + '\n');
        this.command('git', ['init', '--template=', root]);
        this.command('git', ['config', 'url.https://never-inherit.invalid/.insteadOf', 'https://'], root);
        const identity = { first, second, refsFirst, refsSecond, symlink, attributes, oversized };
        writeFileSync(join(root, 'git-identity.json'), JSON.stringify(identity));
        return identity;
    }
}
/** Genuine smart and static HTTPS Git transports; the source never runs provider code. */
class GitHttpExchange {
    private readonly child: ChildProcess;
    private readonly timer: ReturnType<typeof setTimeout>;
    private headers = Buffer.alloc(0);
    private started = false;
    constructor(root: string, request: IncomingMessage, private readonly response: ServerResponse) {
        const url = new URL(request.url ?? '/', 'https://fixture.invalid');
        this.child = spawn(join(root, 'git-helper/libexec/git-http-backend'), [], { env: { PATH: join(root, 'git-helper/libexec'), LD_LIBRARY_PATH: join(root, 'git-helper/lib'), GIT_EXEC_PATH: join(root, 'git-helper/libexec'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method ?? 'GET', CONTENT_TYPE: request.headers['content-type'] ?? '', HTTP_GIT_PROTOCOL: String(request.headers['git-protocol'] ?? ''), REMOTE_ADDR: '127.0.0.1' }, stdio: ['pipe', 'pipe', 'ignore'] });
        this.timer = setTimeout(this.abort.bind(this), 30000);
        this.child.stdout!.on('data', this.data.bind(this));
        this.child.once('error', this.abort.bind(this));
        this.child.once('close', this.end.bind(this));
        this.child.stdin!.on('error', this.abort.bind(this));
        request.pipe(this.child.stdin!);
        response.once('close', this.abort.bind(this));
    }
    private data(bytes: Buffer): void { if (this.started) {
        this.response.write(bytes);
        return;
    } this.headers = Buffer.concat([this.headers, bytes]); const offset = this.headers.indexOf('\r\n\r\n'); if (offset < 0) {
        if (this.headers.length > 16384)
            this.abort();
        return;
    } for (const line of this.headers.subarray(0, offset).toString('utf8').split('\r\n')) {
        const split = line.indexOf(':');
        if (split < 0) {
            this.abort();
            return;
        }
        const name = line.slice(0, split), value = line.slice(split + 1).trim();
        if (name.toLowerCase() === 'status')
            this.response.statusCode = Number(value.slice(0, 3));
        else
            this.response.setHeader(name, value);
    } this.started = true; this.response.write(this.headers.subarray(offset + 4)); this.headers = Buffer.alloc(0); }
    private end(code: number | null): void { clearTimeout(this.timer); if (code !== 0 || !this.started) {
        if (!this.response.headersSent)
            this.response.statusCode = 502;
    } this.response.end(); }
    private abort(): void { clearTimeout(this.timer); this.child.kill('SIGKILL'); if (!this.response.writableEnded)
        this.response.destroy(); }
}
/** A genuine bare repository over HTTPS, with deterministic ref movement. */
export class GitRegistryFixture {
    private readonly server: Server;
    private moved = false;
    private closed = false;
    requests = 0;
    authorization = false;
    fail = false;
    tamperDirectory: string | null = null;
    constructor(private readonly root: string, private readonly identity: GitRepositoryIdentity) { this.server = createServer({ key: readFileSync(join(root, 'key.pem')), cert: readFileSync(join(root, 'cert.pem')) }, this.serve.bind(this)); }
    private serve(request: IncomingMessage, response: ServerResponse): void {
        this.requests++;
        this.authorization ||= request.headers.authorization !== undefined;
        if (this.tamperDirectory) {
            const file = join(this.root, 'installation/.cordis/artifacts', 'git-resolution-' + this.tamperDirectory, 'source-ca.pem');
            if (existsSync(file)) {
                const original = readFileSync(file);
                chmodSync(file, 0o600);
                writeFileSync(file, 'changed trust fixture');
                writeFileSync(file, original);
                chmodSync(file, 0o400);
                this.tamperDirectory = null;
            }
        }
        if (this.fail) {
            response.writeHead(503);
            response.end();
            return;
        }
        const path = new URL(request.url ?? '/', this.origin()).pathname;
        if ((path === '/repository.git/info/refs' && new URL(request.url ?? '/', this.origin()).searchParams.get('service') === 'git-upload-pack') || (path === '/repository.git/git-upload-pack' && request.method === 'POST')) {
            new GitHttpExchange(this.root, request, response);
            return;
        }
        if (path === '/repository.git/info/refs') {
            response.setHeader('content-type', 'text/plain');
            response.end(this.moved ? this.identity.refsSecond : this.identity.refsFirst);
            return;
        }
        if (path === '/repository.git/HEAD') {
            response.end('ref: refs/heads/main\n');
            return;
        }
        if (/^\/repository\.git\/objects\/(?:[a-f0-9]{2}\/[a-f0-9]{38}|info\/packs)$/.test(path)) {
            const file = join(this.root, path.slice(1));
            if (existsSync(file)) {
                response.end(readFileSync(file));
                return;
            }
        }
        response.writeHead(404);
        response.end();
    }
    move(): void { this.moved = true; writeFileSync(join(this.root, 'repository.git/refs/heads/main'), this.identity.second + '\n'); }
    origin(): string { const address = this.server.address(); if (!address || typeof address === 'string')
        throw new Error('Git fixture not listening'); return 'https://127.0.0.1:' + address.port; }
    locator(): string { return this.origin() + '/repository.git'; }
    listen(): Promise<void> { return new Promise(this.start.bind(this)); }
    private start(done: (value: void) => void, reject: (error: Error) => void): void { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', done); }
    async close(): Promise<void> { if (this.closed)
        return; this.closed = true; await new Promise<void>(this.stop.bind(this)); }
    private stop(done: (value: void) => void, reject: (error: Error) => void): void { this.server.closeAllConnections(); this.server.close(this.finished.bind(this, done, reject)); }
    private finished(done: (value: void) => void, reject: (error: Error) => void, error?: Error): void { if (error)
        reject(error);
    else
        done(); }
}

export interface InstallationSourceInput {root:string;gitIdentity?:GitRepositoryIdentity;gitBuild?:{commit:string;entryDigest:string;image:string};}
/** One outside-in installation contract runs against both genuine source transports. */
export class InstallationSources {
    private readonly registry:RegistryFixture|GitRegistryFixture;
    constructor(private readonly input:InstallationSourceInput,installation:string){this.registry=input.gitIdentity?new GitRegistryFixture(input.root,input.gitIdentity):new RegistryFixture(input.root,installation,'@fixture/extension',['1.0.0','2.0.0']);}
    get requests():number{return this.registry.requests;}
    get authorization():boolean{return this.registry.authorization;}
    listen():Promise<void>{return this.registry.listen();}
    close():Promise<void>{return this.registry.close();}
    source(version='1.0.0'):string{if(!this.input.gitIdentity)return'@fixture/extension@'+version;return(this.registry as GitRegistryFixture).locator()+'#'+(version==='2.0.0'?this.input.gitIdentity.second:this.input.gitBuild?.commit??'main');}
    policy(helperReleaseIdentity:string,certificate:NonNullable<SourceAcquisitionPolicy['git'][number]['certificateAuthority']>):SourceAcquisitionPolicy{if(!this.input.gitIdentity)return{formatVersion:1,helperReleaseIdentity,npm:[{registry:(this.registry as RegistryFixture).origin(),packages:['@fixture/extension'],targets:['deployment'],certificateAuthority:certificate}],git:[],builds:[]};const origin=(this.registry as GitRegistryFixture).locator(),recipe=this.input.gitBuild?{origin,commit:this.input.gitBuild.commit,entry:'build.ts',entryDigest:this.input.gitBuild.entryDigest,packageDirectory:'out/package',image:this.input.gitBuild.image,helperReleaseIdentity,network:'none' as const,timeoutMs:30000}:null,build=recipe?{id:CanonicalJson.digest(recipe),...recipe}:null;return{formatVersion:1,helperReleaseIdentity,npm:[],git:[{origin,packages:['@fixture/extension'],targets:['deployment'],certificateAuthority:certificate,...(build?{buildPolicyDigest:build.id}:{})}],builds:build?[build]:[]};}
}
