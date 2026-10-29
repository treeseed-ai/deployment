import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as Deployment from '@treeseed-cordis/deployment';
import { ServiceReleaseFixture } from '@treeseed-cordis/deployment/testing';
export interface StoredRecord {
  readonly formatVersion: 1;
  readonly scopeDigest: string;
  readonly sequence: number;
  readonly previousDigest: string | null;
  readonly digest: string;
  readonly content: unknown;
}
export interface RecordScope {
  installationId: string;
  installationDirectory: string;
  namespace: string;
}
export interface RecordCustody {
  read(): Promise<readonly StoredRecord[]>;
  append(expectedHead: string | null, content: unknown): Promise<StoredRecord>;
  close(): void;
}
export interface RecordConstructor {
  acquire(scope: unknown, signal: AbortSignal): Promise<RecordCustody>;
  inspect(scope: unknown, signal: AbortSignal): Promise<readonly StoredRecord[]>;
}
/** Real plan-only installation and genuine package/OCI fixtures. No service activation. */
export class InstallationRecordFixture {
  readonly release = new ServiceReleaseFixture();
  readonly signal = new AbortController().signal;
  scope!: RecordScope;
  async prepare(): Promise<void> {
    await this.release.services();
    const plan = await new Deployment.ComposeDeploymentHost().plan(this.release.configuration);
    assert.equal(plan.formatVersion, 3);
    assert.equal(new Deployment.ServicePlanStore(this.release.installation).inspect(), true);
    this.scope = {
      installationId: plan.configuration.installationId,
      installationDirectory: this.release.installation,
      namespace: 'seeds',
    };
  }
  type(): RecordConstructor {
    const Type = Reflect.get(Deployment, 'InstallationRecords') as RecordConstructor | undefined;
    assert(
      Type && typeof Type.acquire === 'function' && typeof Type.inspect === 'function',
      'Public installation record custody missing',
    );
    return Type;
  }
  get directory(): string {
    return join(this.release.installation, '.cordis/artifacts/records/seeds');
  }
  close(): void {
    this.release.close();
  }
}
class InstallationRecordsProgram {
  async run(): Promise<void> {
    const fixture = new InstallationRecordFixture();
    let writer: RecordCustody | null = null;
    try {
      await fixture.prepare();
      const Type = fixture.type();
      await assert.rejects(Type.inspect.bind(Type, fixture.scope, fixture.signal));
      assert.equal(existsSync(fixture.directory), false);
      writer = await Type.acquire(fixture.scope, fixture.signal);
      const records = await this.records(writer);
      writer.close();
      writer = null;
      rmSync(fixture.release.bundle, { recursive: true });
      assert.deepEqual(await Type.inspect(fixture.scope, fixture.signal), records);
      this.permissions(fixture);
    } finally {
      writer?.close();
      fixture.close();
    }
    process.stdout.write('installation-records-public-ok\n');
  }
  private async records(writer: RecordCustody): Promise<readonly StoredRecord[]> {
    assert.deepEqual(await writer.read(), []);
    const first = await writer.append(null, { request: 'seed-fixture', state: 'pending' });
    const second = await writer.append(first.digest, { request: 'seed-fixture', state: 'partial' });
    assert.equal(first.sequence, 1);
    assert.equal(first.previousDigest, null);
    assert.equal(second.sequence, 2);
    assert.equal(second.previousDigest, first.digest);
    assert.equal(first.scopeDigest, second.scopeDigest);
    assert(Object.isFrozen(second));
    assert(Object.isFrozen(second.content));
    const records = await writer.read();
    assert.deepEqual(records, [first, second]);
    await assert.rejects(
      writer.append.bind(writer, first.digest, { state: 'PRIVATE_RECORD_CANARY' }),
    );
    assert.deepEqual(await writer.read(), records);
    return records;
  }
  private permissions(fixture: InstallationRecordFixture): void {
    assert.equal(statSync(fixture.directory).mode & 0o777, 0o700);
    assert.equal(existsSync(join(fixture.release.root, 'SCRIPT_CANARY')), false);
    assert.equal(new Deployment.ServicePlanStore(fixture.release.installation).inspect(), true);
    const receipt = JSON.parse(
      readFileSync(join(fixture.release.installation, '.cordis/installation.json'), 'utf8'),
    );
    assert.equal(receipt.installationId, fixture.scope.installationId);
  }
}
class RecordConcurrencyAttempt {
  static async run(file: string): Promise<void> {
    const scope = JSON.parse(readFileSync(file, 'utf8'));
    const Type = Reflect.get(Deployment, 'InstallationRecords') as RecordConstructor;
    let writer: RecordCustody | null = null;
    try {
      writer = await Type.acquire(scope, new AbortController().signal);
      throw new Error('Unexpected second writer');
    } catch (error) {
      assert(error instanceof Error);
      assert.equal(error.message, 'INSTALLATION_RECORDS_BUSY');
    } finally {
      writer?.close();
    }
    process.stdout.write('installation-records-busy\n');
  }
}
if (import.meta.main) {
  if (process.argv[2] === 'attempt') await RecordConcurrencyAttempt.run(process.argv[3]!);
  else await new InstallationRecordsProgram().run();
}
