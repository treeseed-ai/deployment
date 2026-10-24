import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { test, expect } from 'bun:test';
import { existsSync, readFileSync, writeFileSync, symlinkSync, mkdirSync, readdirSync, chmodSync, statSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PreparedReleaseFixture } from './release-fixture.js';
import { ArtifactResolver } from '../src/artifacts.js';
import { ComposeDeploymentHost, HostSystem, DockerCommands } from '../src/diagnose.js';
import { PlanStore, SafeDirectory } from '../src/filesystem.js';
import { PlanningBlockedError, CanonicalJson, type DeploymentPlan } from '@treeseed-cordis/sdk';
class ConcurrentWriter {
  readonly child:ChildProcess;
  completion:((code:number)=>void)|null=null;
  constructor(readonly installation:string,readonly planFile:string) {
    const module=JSON.stringify(resolve('dist/src/filesystem.js'));
    const source=`import {PlanStore} from ${module};import{readFileSync}from'node:fs';class Writer{static run(){try{const plan=JSON.parse(readFileSync(process.argv[2],'utf8'));new PlanStore(process.argv[1]).publish(plan);}catch{process.exitCode=3;}}}Writer.run();`;
    this.child=spawn('node',['--input-type=module','-e',source,installation,planFile],{stdio:['ignore','ignore','ignore']});
  }
  wait():Promise<number> {return new Promise(this.start.bind(this));}
  start(completion:(code:number)=>void):void {this.completion=completion;this.child.once('exit',this.exit.bind(this));this.child.once('error',this.error.bind(this));}
  exit(code:number|null):void {this.completion!(code??1);}
  error():void {this.completion!(1);}
}
class CollisionCommands extends DockerCommands {
  constructor(readonly project:string) {super();}
  override execute(args:string[]):string|null {if(args.includes('ps'))return JSON.stringify({Names:this.project+'-application',Labels:''});return super.execute(args);}
}
class ArtifactTests {
  async files():Promise<void> {
    const fixture=await new PreparedReleaseFixture().prepare();
    try {
      const result=await new ArtifactResolver().resolve(fixture.configuration);
      expect(result.artifacts.length).toBe(2);expect(result.artifacts[0]!.kind).toBe('package');expect(result.recipe).toEqual(fixture.recipe);
      expect(existsSync(join(fixture.root,'SCRIPT_CANARY'))).toBe(false);expect(existsSync(fixture.installation)).toBe(false);
      writeFileSync(join(fixture.bundle,'archives/plugin.tgz'),'tampered');
      await expect(new ArtifactResolver().resolve(fixture.configuration)).rejects.toBeInstanceOf(PlanningBlockedError);
    }finally{fixture.close();}
  }
  async recipe():Promise<void> {
    const fixture=await new PreparedReleaseFixture().prepare();
    try {
      (fixture.recipe.services.application as unknown as Record<string,unknown>).environment={PASSWORD:'plaintext-secret-canary'};fixture.refresh();
      try {await new ArtifactResolver().resolve(fixture.configuration);throw new Error('accepted invalid recipe');}catch(error){expect(error).toBeInstanceOf(PlanningBlockedError);expect(JSON.stringify(error)).not.toContain('plaintext-secret-canary');}
      delete (fixture.recipe.services.application as unknown as Record<string,unknown>).environment;fixture.refresh();
      const image=fixture.inventory.images[0]!;const original=readFileSync(join(fixture.bundle,'oci/blobs/sha256',image.manifestDigest));
      writeFileSync(join(fixture.bundle,'oci/blobs/sha256',image.manifestDigest),original.toString().replace('layers','tampered'));
      await expect(new ArtifactResolver().resolve(fixture.configuration)).rejects.toBeInstanceOf(PlanningBlockedError);
    }finally{fixture.close();}
  }
  async graph():Promise<void> {
    const fixture=await new PreparedReleaseFixture().prepare();
    try {
      fixture.configuration.plugins.push({...fixture.configuration.plugins[0]!});await expect(new ArtifactResolver().resolve(fixture.configuration)).rejects.toBeInstanceOf(PlanningBlockedError);fixture.configuration.plugins.pop();
      await fixture.repack({...fixture.metadata,inject:['missing']});await expect(new ArtifactResolver().resolve(fixture.configuration)).rejects.toBeInstanceOf(PlanningBlockedError);
      await fixture.repack({...fixture.metadata,inject:['fixture']});await expect(new ArtifactResolver().resolve(fixture.configuration)).rejects.toBeInstanceOf(PlanningBlockedError);
      await fixture.repack({...fixture.metadata,inject:[]});fixture.inventory.requiredPluginIds=['missing'];fixture.refresh();await expect(new ArtifactResolver().resolve(fixture.configuration)).rejects.toBeInstanceOf(PlanningBlockedError);
    }finally{fixture.close();}
  }
  async duplicateService():Promise<void> {
    const fixture=await new PreparedReleaseFixture().prepare();
    try {await fixture.addPlugin({id:'additional',contractVersion:'0.2.0-cordis.1',provide:['fixture'],inject:[]});await expect(new ArtifactResolver().resolve(fixture.configuration)).rejects.toBeInstanceOf(PlanningBlockedError);}
    finally{fixture.close();}
  }
  async lockIntegrity():Promise<void> {
    const fixture=await new PreparedReleaseFixture().prepare();
    try {const path=join(fixture.bundle,'bun.lock'),text=readFileSync(path,'utf8');writeFileSync(path,text.replace(/sha512-[a-zA-Z0-9+/]+=*/, 'sha512-'+Buffer.alloc(64).toString('base64')));fixture.inventory.lockfile.sha256=PreparedReleaseFixture.sha(readFileSync(path));fixture.refresh();try{await new ArtifactResolver().resolve(fixture.configuration);throw new Error('bad SRI accepted');}catch(error){expect(error).toBeInstanceOf(PlanningBlockedError);expect(JSON.stringify(error)).toContain('LOCK_INTEGRITY');}}
    finally{fixture.close();}
  }
  async architecture():Promise<void> {
    const fixture=await new PreparedReleaseFixture().prepare();
    try {fixture.imageArchitecture('arm64');try{await new ArtifactResolver().resolve(fixture.configuration);throw new Error('wrong architecture accepted');}catch(error){expect(error).toBeInstanceOf(PlanningBlockedError);expect(JSON.stringify(error)).toContain('IMAGE_ARCHITECTURE');}}
    finally{fixture.close();}
  }
  async collision():Promise<void> {
    if(!this.qualified())return;const fixture=await new PreparedReleaseFixture().prepare();
    try {const project='cordis-'+CanonicalJson.digest({installationId:fixture.configuration.installationId,installationDirectory:fixture.installation}).slice(0,16);try{await new ComposeDeploymentHost(new CollisionCommands(project)).plan(fixture.configuration);throw new Error('foreign resource accepted');}catch(error){expect(error).toBeInstanceOf(PlanningBlockedError);expect(JSON.stringify(error)).toContain('FOREIGN_RUNTIME');}expect(existsSync(fixture.installation)).toBe(false);}
    finally{fixture.close();}
  }
  async bindings():Promise<void> {
    const fixture=await new PreparedReleaseFixture().prepare();
    try {
      fixture.recipe.services.application!.image='fixture/application:latest';fixture.refresh();await expect(new ArtifactResolver().resolve(fixture.configuration)).rejects.toBeInstanceOf(PlanningBlockedError);
      fixture.recipe.services.application!.image=fixture.inventory.images[0]!.reference;fixture.recipe.services.application!.volumes![0]!.target='/data/${UNSAFE}';fixture.refresh();await expect(new ArtifactResolver().resolve(fixture.configuration)).rejects.toBeInstanceOf(PlanningBlockedError);fixture.recipe.services.application!.volumes![0]!.target='/data';fixture.configuration.credentialReferences=['secret://missing'];fixture.refresh();await expect(new ArtifactResolver().resolve(fixture.configuration)).rejects.toBeInstanceOf(PlanningBlockedError);fixture.configuration.credentialReferences=['secret://password'];
      fixture.inventory.images[0]!.manifestDigest='f'.repeat(64);fixture.refresh();await expect(new ArtifactResolver().resolve(fixture.configuration)).rejects.toBeInstanceOf(PlanningBlockedError);
    }finally{fixture.close();}
  }
  qualified():boolean {const host=new HostSystem().host();return host.distribution==='ubuntu'&&host.release==='26.04'&&host.architecture==='x64';}
  async plans():Promise<void> {
    const fixture=await new PreparedReleaseFixture().prepare();
    try {
      if(!this.qualified()){await expect(new ComposeDeploymentHost().plan(fixture.configuration)).rejects.toBeInstanceOf(PlanningBlockedError);expect(existsSync(fixture.installation)).toBe(false);return;}
      const host=new ComposeDeploymentHost(),plan=await host.plan(fixture.configuration);expect(plan.expectedComposition).toBeNull();expect(plan.expectedEngine.daemonId.length).toBeGreaterThan(0);expect(plan.artifacts.length).toBe(2);expect(plan.blockers).toEqual([]);expect(plan.recipe).toEqual(fixture.recipe);expect(plan.pluginBindings).toEqual([fixture.metadata]);
      const repeated=await host.plan({...fixture.configuration,origin:fixture.configuration.origin+'/'});expect(repeated).toEqual(plan);
      const stopped=await host.plan({...fixture.configuration,runtimeState:'stopped'});expect(stopped.digest).not.toBe(plan.digest);for(const effect of stopped.effects)expect(effect.kind).not.toBe('start-service');
      const store=new PlanStore(fixture.installation);expect(store.read(plan.id,plan.digest)).toEqual(plan);expect(statSync(join(fixture.installation,'.cordis/plans',plan.id+'.json')).mode&0o777).toBe(0o600);
      rmSync(fixture.bundle,{recursive:true});expect(store.read(plan.id,plan.digest)).toEqual(plan);await expect(host.plan(fixture.configuration)).rejects.toBeInstanceOf(PlanningBlockedError);
      expect(readdirSync(fixture.installation)).toEqual(['.cordis']);expect(existsSync(join(fixture.installation,'.cordis/credentials'))).toBe(false);
    }finally{fixture.close();}
  }
  async journals():Promise<void> {
    const fixture=await new PreparedReleaseFixture().prepare();
    try {
      mkdirSync(fixture.installation);mkdirSync(join(fixture.installation,'.cordis'),{mode:0o700});writeFileSync(join(fixture.installation,'.cordis/receipt.json'),'plaintext-secret-canary');
      const before=readdirSync(join(fixture.installation,'.cordis'));await expect(new ComposeDeploymentHost().plan(fixture.configuration)).rejects.toBeInstanceOf(PlanningBlockedError);expect(readdirSync(join(fixture.installation,'.cordis'))).toEqual(before);
      expect(new PlanStore(fixture.installation).inspect.bind(new PlanStore(fixture.installation))).toThrow(PlanningBlockedError);
    }finally{fixture.close();}
  }
  async privateState():Promise<void> {
    if(!this.qualified())return;
    const fixture=await new PreparedReleaseFixture().prepare();
    try {
      const host=new ComposeDeploymentHost(),plan=await host.plan(fixture.configuration),store=new PlanStore(fixture.installation),file=join(fixture.installation,'.cordis/plans',plan.id+'.json');
      chmodSync(file,0o644);expect(store.read.bind(store,plan.id,plan.digest)).toThrow(PlanningBlockedError);chmodSync(file,0o600);
      const saved=readFileSync(file);const changed={...plan,projectName:'cordis-'+'f'.repeat(16)};writeFileSync(file,JSON.stringify(changed));await expect(host.plan(fixture.configuration)).rejects.toBeInstanceOf(PlanningBlockedError);writeFileSync(file,saved);
      const receiptFile=join(fixture.installation,'.cordis/receipt.json'),receipt=JSON.parse(readFileSync(receiptFile,'utf8')) as Record<string,unknown>;receipt.activeComposition='f'.repeat(64);writeFileSync(receiptFile,CanonicalJson.stringify(receipt));await expect(host.plan(fixture.configuration)).rejects.toBeInstanceOf(PlanningBlockedError);
    }finally{fixture.close();}
  }
  async race():Promise<void> {
    const fixture=await new PreparedReleaseFixture().prepare(),directory=SafeDirectory.open(fixture.bundle),moved=join(fixture.root,'old-release');
    try {renameSync(fixture.bundle,moved);symlinkSync('/etc',fixture.bundle);expect(directory.file.bind(directory,'passwd')).toThrow(PlanningBlockedError);expect(directory.verify.bind(directory)).toThrow(PlanningBlockedError);expect(existsSync(fixture.installation)).toBe(false);}finally{directory.close();fixture.close();}
  }
  async concurrent():Promise<void> {
    const fixture=await new PreparedReleaseFixture().prepare();
    try {
      const resolution=await new ArtifactResolver().resolve(fixture.configuration),projectName='cordis-'+CanonicalJson.digest({installationId:fixture.configuration.installationId,installationDirectory:fixture.installation}).slice(0,16);
      const payload={formatVersion:1 as const,configuration:fixture.configuration,recipe:resolution.recipe,pluginBindings:resolution.pluginBindings,configurationDigest:CanonicalJson.digest(fixture.configuration),releaseDigest:resolution.releaseDigest,recipeDigest:resolution.recipeDigest,lockDigest:resolution.lockDigest,expectedEngine:{context:'default',endpoint:'unix:///var/run/docker.sock',daemonId:'offline-store-fixture',os:'linux' as const,architecture:'amd64' as const},expectedComposition:null,projectName,artifacts:resolution.artifacts,effects:[],blockers:[]};
      const digest=CanonicalJson.digest(payload),plan:DeploymentPlan={...payload,id:'plan-'+digest,digest},planFile=join(fixture.root,'request.json');writeFileSync(planFile,JSON.stringify(plan));
      const writers=[new ConcurrentWriter(fixture.installation,planFile),new ConcurrentWriter(fixture.installation,planFile)],pending:Promise<number>[]=[];for(const writer of writers)pending.push(writer.wait());const codes=await Promise.all(pending);expect(codes).toContain(0);for(const code of codes)expect([0,3]).toContain(code);
      const store=new PlanStore(fixture.installation);expect(store.read(plan.id,plan.digest)).toEqual(plan);const file=join(fixture.installation,'.cordis/plans',plan.id+'.json'),inode=statSync(file).ino;expect(store.publish(plan)).toEqual(plan);expect(statSync(file).ino).toBe(inode);
      writeFileSync(join(fixture.installation,'.cordis/plans/.tmp-interrupted'),'partial',{mode:0o600});expect(store.inspect.bind(store)).toThrow(PlanningBlockedError);
    }finally{fixture.close();}
  }
  async path():Promise<void> {
    const fixture=await new PreparedReleaseFixture().prepare();
    try {symlinkSync('/etc/passwd',join(fixture.bundle,'escape'));fixture.inventory.packageJson.path='escape';fixture.configuration.release.manifestDigest=fixture.write('release.json',fixture.inventory);await expect(new ArtifactResolver().resolve(fixture.configuration)).rejects.toBeInstanceOf(PlanningBlockedError);}
    finally{fixture.close();}
  }
}
const suite=new ArtifactTests();
test('integration: exact real tar/lock/OCI files without scripts or writes',suite.files.bind(suite));
test('integration: reject unsafe recipe and changed OCI bytes without plaintext output',suite.recipe.bind(suite));
test('unit: bundle symlinks cannot escape',suite.path.bind(suite));

test('integration: missing, duplicate and cyclic plugin declarations block',suite.graph.bind(suite));
test('unit: image reference and secret-slot bindings fail closed',suite.bindings.bind(suite));

test('integration: default real plan persists deterministic bytes and independent read-back',suite.plans.bind(suite));
test('unit: malformed and incomplete journals block without writes',suite.journals.bind(suite));
test('integration: private modes, tampered plans and active/foreign receipts block',suite.privateState.bind(suite));
test('unit: descriptor anchor rejects directory replacement without escape',suite.race.bind(suite));

test('unit: two selected providers cannot own one required service',suite.duplicateService.bind(suite));
test('unit: fully repinned ARM image is rejected by architecture',suite.architecture.bind(suite));
test('integration: a preexisting project namespace blocks without adoption',suite.collision.bind(suite));

test('integration: concurrent no-overwrite publication and interrupted records fail safely',suite.concurrent.bind(suite));

test('unit: repinned lockfile cannot lie about package archive integrity',suite.lockIntegrity.bind(suite));
