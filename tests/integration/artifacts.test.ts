import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { test, expect } from 'bun:test';
import { existsSync, readFileSync, writeFileSync, symlinkSync, mkdirSync, readdirSync, chmodSync, statSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PreparedReleaseFixture } from '../support/release-fixture.js';
import { ArtifactResolver } from '../../src/artifacts.js';
import { ComposeDeploymentHost, HostSystem, DockerCommands } from '../../src/diagnose.js';
import { PlanStore, SafeDirectory, StrictJson } from '../../src/filesystem.js';
import { PlatformSchemas, PlanningBlockedError, CanonicalJson, type DeploymentPlan } from '@treeseed-cordis/sdk';
import {ConcurrentWriter,CollisionCommands,ArtifactTests} from '../support/artifacts-test-support.js';
class ArtifactTestsIntegration extends ArtifactTests {

  async files():Promise<void> {
    const fixture=await new PreparedReleaseFixture().prepare();
    try {
      const result=await new ArtifactResolver().resolve(fixture.configuration);
      expect(result.artifacts.length).toBe(2);expect(result.artifacts[0]!.kind).toBe('package');expect(result.recipe).toEqual(fixture.recipe);
      expect(existsSync(join(fixture.root,'SCRIPT_CANARY'))).toBe(false);expect(existsSync(fixture.installation)).toBe(false);
      const calibration=spawnSync('node',[join(fixture.root,'plugin/package/index.js')],{encoding:'utf8'});expect(calibration.status).toBe(0);expect(existsSync(join(fixture.root,'SCRIPT_CANARY'))).toBe(true);
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

  async exactOverrides():Promise<void>{const fixture=await new PreparedReleaseFixture().prepare();try{const file=join(fixture.bundle,'package.json'),root=JSON.parse(readFileSync(file,'utf8'));root.overrides={...root.dependencies};writeFileSync(file,JSON.stringify(root));const generated=spawnSync('bun',['install','--lockfile-only','--offline','--ignore-scripts','--no-env-file'],{cwd:fixture.bundle,encoding:'utf8'});expect(generated.status).toBe(0);fixture.inventory.packageJson.sha256=PreparedReleaseFixture.sha(readFileSync(file));fixture.inventory.lockfile.sha256=PreparedReleaseFixture.sha(readFileSync(join(fixture.bundle,'bun.lock')));fixture.refresh();expect((await new ArtifactResolver().resolve(fixture.configuration)).artifacts).toHaveLength(2);const valid=JSON.stringify(root);root.overrides={'@fixture/plugin':'file:archives/unknown.tgz'};writeFileSync(file,JSON.stringify(root));fixture.inventory.packageJson.sha256=PreparedReleaseFixture.sha(readFileSync(file));fixture.refresh();await expect(new ArtifactResolver().resolve(fixture.configuration)).rejects.toBeInstanceOf(PlanningBlockedError);writeFileSync(file,valid);fixture.inventory.packageJson.sha256=PreparedReleaseFixture.sha(readFileSync(file));const path=join(fixture.bundle,'bun.lock'),lock=StrictJson.object(StrictJson.parse(readFileSync(path),true));lock.overrides={'@fixture/plugin':'file:archives/unknown.tgz'};writeFileSync(path,JSON.stringify(lock));fixture.inventory.lockfile.sha256=PreparedReleaseFixture.sha(readFileSync(path));fixture.refresh();await expect(new ArtifactResolver().resolve(fixture.configuration)).rejects.toBeInstanceOf(PlanningBlockedError);expect(existsSync(fixture.installation)).toBe(false);expect(existsSync(join(fixture.root,'SCRIPT_CANARY'))).toBe(false);}finally{fixture.close();}}

  async collision():Promise<void> {
    if(!this.qualified())return;const fixture=await new PreparedReleaseFixture().prepare();
    try {const project='cordis-'+CanonicalJson.digest({installationId:fixture.configuration.installationId,installationDirectory:fixture.installation}).slice(0,16);try{await new ComposeDeploymentHost(new CollisionCommands(project)).plan(fixture.configuration);throw new Error('foreign resource accepted');}catch(error){expect(error).toBeInstanceOf(PlanningBlockedError);expect(JSON.stringify(error)).toContain('FOREIGN_RUNTIME');}expect(existsSync(fixture.installation)).toBe(false);}
    finally{fixture.close();}
  }

  async plans():Promise<void> {
    const fixture=await new PreparedReleaseFixture().prepare();
    try {
      if(!this.qualified()){await expect(new ComposeDeploymentHost().plan(fixture.configuration)).rejects.toBeInstanceOf(PlanningBlockedError);expect(existsSync(fixture.installation)).toBe(false);return;}
      const host=new ComposeDeploymentHost(),plan=PlatformSchemas.plan.parse(await host.plan(fixture.configuration));expect(plan.expectedComposition).toBeNull();expect(plan.expectedEngine.daemonId.length).toBeGreaterThan(0);expect(plan.artifacts.length).toBe(2);expect(plan.blockers).toEqual([]);expect(plan.recipe).toEqual(fixture.recipe);expect(plan.pluginBindings).toEqual([fixture.metadata]);
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

  async hostPaths():Promise<void> {
    const fixture=await new PreparedReleaseFixture().prepare();
    const installation=join(fixture.root,'installation with spaces Ω');
    try {
      const configuration={...fixture.configuration,installationDirectory:installation};
      if(!this.qualified()){await expect(new ComposeDeploymentHost().plan(configuration)).rejects.toBeInstanceOf(PlanningBlockedError);expect(existsSync(installation)).toBe(false);return;}
      const plan=PlatformSchemas.plan.parse(await new ComposeDeploymentHost().plan(configuration));expect(plan.configuration.installationDirectory).toBe(installation);expect(new PlanStore(installation).read(plan.id,plan.digest)).toEqual(plan);expect(readdirSync(installation)).toEqual(['.cordis']);
    }finally{fixture.close();}
  }
}
const suite=new ArtifactTestsIntegration();
const exactOverrides=new ArtifactTestsIntegration();
test('integration: exact real tar/lock/OCI files without scripts or writes',suite.files.bind(suite));
test('integration: reject unsafe recipe and changed OCI bytes without plaintext output',suite.recipe.bind(suite));
test('integration: missing, duplicate and cyclic plugin declarations block',suite.graph.bind(suite));
test('integration: default real plan persists deterministic bytes and independent read-back',suite.plans.bind(suite));
test('integration: malformed and incomplete journals block without writes',suite.journals.bind(suite),60000);
test('integration: private modes, tampered plans and active/foreign receipts block',suite.privateState.bind(suite));
test('integration: a preexisting project namespace blocks without adoption',suite.collision.bind(suite));
test('integration: concurrent no-overwrite publication and interrupted records fail safely',suite.concurrent.bind(suite));
test('integration: new owned installation paths allow spaces and Unicode',suite.hostPaths.bind(suite));
test('integration: exact-file root overrides preserve archive closure and reject divergent root or lock mappings',exactOverrides.exactOverrides.bind(exactOverrides));
