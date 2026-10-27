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

  async bindings():Promise<void> {
    const fixture=await new PreparedReleaseFixture().prepare();
    try {
      fixture.recipe.services.application!.image='fixture/application:latest';fixture.refresh();await expect(new ArtifactResolver().resolve(fixture.configuration)).rejects.toBeInstanceOf(PlanningBlockedError);
      fixture.recipe.services.application!.image=fixture.inventory.images[0]!.reference;fixture.recipe.services.application!.volumes![0]!.target='/data/${UNSAFE}';fixture.refresh();await expect(new ArtifactResolver().resolve(fixture.configuration)).rejects.toBeInstanceOf(PlanningBlockedError);fixture.recipe.services.application!.volumes![0]!.target='/data';fixture.configuration.credentialReferences=['secret://missing'];fixture.refresh();await expect(new ArtifactResolver().resolve(fixture.configuration)).rejects.toBeInstanceOf(PlanningBlockedError);fixture.configuration.credentialReferences=['secret://password'];
      fixture.inventory.images[0]!.manifestDigest='f'.repeat(64);fixture.refresh();await expect(new ArtifactResolver().resolve(fixture.configuration)).rejects.toBeInstanceOf(PlanningBlockedError);
    }finally{fixture.close();}
  }

  async race():Promise<void> {
    const fixture=await new PreparedReleaseFixture().prepare(),directory=SafeDirectory.open(fixture.bundle),moved=join(fixture.root,'old-release');
    try {renameSync(fixture.bundle,moved);symlinkSync('/etc',fixture.bundle);expect(directory.file.bind(directory,'passwd')).toThrow(PlanningBlockedError);expect(directory.verify.bind(directory)).toThrow(PlanningBlockedError);expect(existsSync(fixture.installation)).toBe(false);}finally{directory.close();fixture.close();}
  }

  async archiveNames():Promise<void> {
    const fixture=await new PreparedReleaseFixture().prepare();
    try {writeFileSync(join(fixture.root,'plugin/package/reference with spaces Ω.md'),'fixture resource');await fixture.repack({...fixture.metadata});expect((await new ArtifactResolver().resolve(fixture.configuration)).artifacts.length).toBe(2);}
    finally{fixture.close();}
  }

  async path():Promise<void> {
    const fixture=await new PreparedReleaseFixture().prepare();
    try {symlinkSync('/etc/passwd',join(fixture.bundle,'escape'));fixture.inventory.packageJson.path='escape';fixture.configuration.release.manifestDigest=fixture.write('release.json',fixture.inventory);await expect(new ArtifactResolver().resolve(fixture.configuration)).rejects.toBeInstanceOf(PlanningBlockedError);}
    finally{fixture.close();}
  }
}
const suite=new ArtifactTestsIntegration();
test("integration: bundle symlinks cannot escape",suite.path.bind(suite));
test("integration: image reference and secret-slot bindings fail closed",suite.bindings.bind(suite));
test("integration: descriptor anchor rejects directory replacement without escape",suite.race.bind(suite));
test("integration: two selected providers cannot own one required service",suite.duplicateService.bind(suite));
test("integration: fully repinned ARM image is rejected by architecture",suite.architecture.bind(suite));
test("integration: repinned lockfile cannot lie about package archive integrity",suite.lockIntegrity.bind(suite));
test("integration: contained package resources allow spaces and Unicode",suite.archiveNames.bind(suite));
