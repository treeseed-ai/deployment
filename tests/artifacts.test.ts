import { test, expect } from 'bun:test';
import { existsSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PreparedReleaseFixture } from './release-fixture.js';
import { ArtifactResolver } from '../src/artifacts.js';
import { PlanningBlockedError } from '@treeseed-cordis/sdk';
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
  async bindings():Promise<void> {
    const fixture=await new PreparedReleaseFixture().prepare();
    try {
      fixture.recipe.services.application!.image='fixture/application:latest';fixture.refresh();await expect(new ArtifactResolver().resolve(fixture.configuration)).rejects.toBeInstanceOf(PlanningBlockedError);
      fixture.recipe.services.application!.image=fixture.inventory.images[0]!.reference;fixture.configuration.credentialReferences=['secret://missing'];fixture.refresh();await expect(new ArtifactResolver().resolve(fixture.configuration)).rejects.toBeInstanceOf(PlanningBlockedError);fixture.configuration.credentialReferences=['secret://password'];
      fixture.inventory.images[0]!.manifestDigest='f'.repeat(64);fixture.refresh();await expect(new ArtifactResolver().resolve(fixture.configuration)).rejects.toBeInstanceOf(PlanningBlockedError);
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
