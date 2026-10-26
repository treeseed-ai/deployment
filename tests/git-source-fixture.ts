import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, realpathSync, chmodSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { create } from 'tar';
import { CanonicalJson, type SourceToolDefinition } from '@treeseed-cordis/sdk';
import type { ServiceReleaseFixture } from './release-fixture.js';
export interface GitFixtureIdentity { first: string; second: string; refsFirst: string; refsSecond: string; }
/** Actual Git/HTTPS bytes and commits; no fake source executable or credentials. */
export class GitFixtureTools {
    static command(program: string, args: string[], cwd?: string): string { const result=spawnSync(program,args,{cwd,encoding:'utf8',timeout:120000,env:{PATH:process.env.PATH,HOME:cwd??process.cwd(),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',LANG:'C.UTF-8'}});if(result.status!==0)throw new Error('Git fixture prerequisite failed: '+result.stderr.slice(-1000));return result.stdout.trim(); }
    static sha(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
    private static order(a: {path:string}, b:{path:string}):number {return a.path<b.path?-1:a.path>b.path?1:0;}
    static async helper(fixture: ServiceReleaseFixture): Promise<void> {
        const git=realpathSync(this.command('which',['git'])),exec=this.command(git,['--exec-path']),root=join(fixture.root,'git-helper');mkdirSync(root,{mode:0o700});for(const name of ['bin','libexec','lib'])mkdirSync(join(root,name),{mode:0o700});
        const binaries=new Map<string,string>([['bin/git',git],['libexec/git',git]]);for(const name of ['git-remote-https','git-index-pack','git-unpack-objects','git-upload-pack','git-http-backend'])binaries.set('libexec/'+name,realpathSync(join(exec,name)));
        const libraries=new Map<string,string>();for(const source of binaries.values())for(const line of this.command('ldd',[source]).split('\n')){const match=/=>\s+(\/\S+)/.exec(line)??/^\s*(\/\S+)/.exec(line);if(match)libraries.set('lib/'+basename(match[1]!),match[1]!);}
        const files:SourceToolDefinition['files']=[];for(const [path,source]of [...binaries,...libraries]){copyFileSync(source,join(root,path));const mode=binaries.has(path)?0o500:0o400;chmodSync(join(root,path),mode);files.push({path,sha256:this.sha(readFileSync(join(root,path))),mode});}files.sort(this.order);
        const archive=join(fixture.bundle,'git.tgz');await create({cwd:root,file:archive,gzip:true,portable:false},['bin','libexec','lib']);const bytes=readFileSync(archive),version=/^git version (\d+\.\d+\.\d+)/.exec(this.command(git,['--version']));if(!version||!fixture.release.helpers)throw new Error('Git helper prerequisite missing');
        fixture.release.helpers.helpers.push({id:'git',version:version[1]!,platform:'linux-amd64',path:'git.tgz',sha256:this.sha(bytes),size:bytes.length,entry:'bin/git',files,libraryDirectories:['lib'],executableDirectory:'libexec'});fixture.release.helpers.releaseIdentity=CanonicalJson.digest({formatVersion:1,helpers:fixture.release.helpers.helpers});
    }
    static repository(root:string):GitFixtureIdentity {
        const source=join(root,'git-work'),bare=join(root,'repository.git');mkdirSync(source);
        this.command('git',['init','--initial-branch=main','--template=',source]);
        writeFileSync(join(source,'package.json'),JSON.stringify({name:'@fixture/git-source',version:'1.0.0',scripts:{postinstall:'MUST_NOT_RUN'}}));writeFileSync(join(source,'provider.ts'),'export class GitFixtureProvider {static readonly revision=1;}\n');
        this.command('git',['add','.'],source);this.command('git',['-c','user.name=Cordis fixture','-c','user.email=fixture@example.invalid','commit','-m','Fixture one'],source);const first=this.command('git',['rev-parse','HEAD'],source);
        this.command('git',['-c','user.name=Cordis fixture','-c','user.email=fixture@example.invalid','tag','-a','release','-m','Fixture annotated release'],source);
        writeFileSync(join(source,'provider.ts'),'export class GitFixtureProvider {static readonly revision=2;}\n');this.command('git',['add','.'],source);this.command('git',['-c','user.name=Cordis fixture','-c','user.email=fixture@example.invalid','commit','-m','Fixture two'],source);const second=this.command('git',['rev-parse','HEAD'],source);
        this.command('git',['branch','future',second],source);this.command('git',['branch','twin',first],source);this.command('git',['tag','twin',first],source);this.command('git',['clone','--bare','--no-hardlinks',source,bare]);
        this.command('git',['--git-dir='+bare,'update-ref','refs/heads/main',first]);this.command('git',['--git-dir='+bare,'update-server-info']);const refsFirst=readFileSync(join(bare,'info/refs'),'utf8');
        this.command('git',['--git-dir='+bare,'update-ref','refs/heads/main',second]);this.command('git',['--git-dir='+bare,'update-server-info']);const refsSecond=readFileSync(join(bare,'info/refs'),'utf8');
        this.command('git',['init','--template=',root]);this.command('git',['config','url.https://never-inherit.invalid/.insteadOf','https://'],root);
        const identity={first,second,refsFirst,refsSecond};writeFileSync(join(root,'git-identity.json'),JSON.stringify(identity));return identity;
    }
}
/** A genuine bare repository over Git's static HTTPS transport, with deterministic ref movement. */
export class GitRegistryFixture {
    private readonly server:Server;
    private moved=false;
    private closed=false;
    requests=0;
    authorization=false;
    fail=false;
    tamperDirectory:string|null=null;
    constructor(private readonly root:string,private readonly identity:GitFixtureIdentity){this.server=createServer({key:readFileSync(join(root,'key.pem')),cert:readFileSync(join(root,'cert.pem'))},this.serve.bind(this));}
    private serve(request:IncomingMessage,response:ServerResponse):void {
        this.requests++;this.authorization||=request.headers.authorization!==undefined;
        if(this.tamperDirectory){const file=join(this.root,'installation/.cordis/artifacts','git-resolution-'+this.tamperDirectory,'source-ca.pem');if(existsSync(file)){const original=readFileSync(file);chmodSync(file,0o600);writeFileSync(file,'changed trust fixture');writeFileSync(file,original);chmodSync(file,0o400);this.tamperDirectory=null;}}
        if(this.fail){response.writeHead(503);response.end();return;}
        const path=new URL(request.url??'/',this.origin()).pathname;
        if(path==='/repository.git/info/refs'){response.setHeader('content-type','text/plain');response.end(this.moved?this.identity.refsSecond:this.identity.refsFirst);return;}
        if(path==='/repository.git/HEAD'){response.end('ref: refs/heads/main\n');return;}
        if(/^\/repository\.git\/objects\/(?:[a-f0-9]{2}\/[a-f0-9]{38}|info\/packs)$/.test(path)){const file=join(this.root,path.slice(1));if(existsSync(file)){response.end(readFileSync(file));return;}}
        response.writeHead(404);response.end();
    }
    move():void{this.moved=true;}
    origin():string{const address=this.server.address();if(!address||typeof address==='string')throw new Error('Git fixture not listening');return 'https://127.0.0.1:'+address.port;}
    locator():string{return this.origin()+'/repository.git';}
    listen():Promise<void>{return new Promise(this.start.bind(this));}
    private start(done:(value:void)=>void,reject:(error:Error)=>void):void{this.server.once('error',reject);this.server.listen(0,'127.0.0.1',done);}
    async close():Promise<void>{if(this.closed)return;this.closed=true;await new Promise<void>(this.stop.bind(this));}
    private stop(done:(value:void)=>void,reject:(error:Error)=>void):void{this.server.closeAllConnections();this.server.close(this.finished.bind(this,done,reject));}
    private finished(done:(value:void)=>void,reject:(error:Error)=>void,error?:Error):void{if(error)reject(error);else done();}
}
