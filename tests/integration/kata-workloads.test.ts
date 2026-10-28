import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  chmodSync,
  symlinkSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { KataEnvironmentArchive, KataWorkloadJournal } from '../../src/kata-workloads.js';
import { KataWorkloadFixture } from '../support/kata-workload-fixture.js';
import { SafeDirectory } from '../../src/filesystem.js';

class KataWorkloadBoundaries {
  private readonly root = mkdtempSync(join(tmpdir(), 'kata-workloads-'));
  private readonly fixture = new KataWorkloadFixture(this.root);
  private readonly image = 'busybox@sha256:' + 'a'.repeat(64);
  private readonly config = this.fixture.prepare(this.image);
  async archives(): Promise<void> {
    const archive = new KataEnvironmentArchive(this.config);
    const result = await archive.read('environment:good', this.image);
    assert.equal(result.definition.id, 'environment:good');
    assert.match(result.setup.toString(), /guest-output-canary/);
    assert.match(result.verification.toString(), /cordis-env-proof/);
    this.fixture.canaries();
    await assert.rejects(archive.read('environment:missing', this.image));
    await assert.rejects(archive.read('environment:good', 'busybox@sha256:' + 'b'.repeat(64)));
  }
  async tampering(): Promise<void> {
    const entry = this.config.environments[0]!;
    const path = join(this.config.directory, entry.archive.path);
    const bytes = readFileSync(path);
    writeFileSync(path, Buffer.concat([bytes, Buffer.from('tamper')]));
    await assert.rejects(
      new KataEnvironmentArchive(this.config).read('environment:good', this.image),
    );
    writeFileSync(path, bytes);
    chmodSync(path, 0o644);
    await assert.rejects(
      new KataEnvironmentArchive(this.config).read('environment:good', this.image),
    );
    chmodSync(path, 0o600);
    const alias = { ...entry, archive: { ...entry.archive, path: 'alias.tgz' } };
    symlinkSync(path, join(this.config.directory, 'alias.tgz'));
    await assert.rejects(
      new KataEnvironmentArchive({ ...this.config, environments: [alias] }).read(
        'environment:good',
        this.image,
      ),
    );
  }
  async declarations(): Promise<void> {
    const entry = this.config.environments[0]!;
    const definition = structuredClone(entry.definition);
    Reflect.set(definition, 'network', {
      mode: 'allow-list',
      destinations: [{ protocol: 'tcp', host: 'example.com', port: 443 }],
    });
    const network = new KataEnvironmentArchive({
      ...this.config,
      environments: [{ ...entry, definition }],
    });
    await assert.rejects(network.read('environment:good', this.image));
    Reflect.set(definition, 'network', { mode: 'offline', destinations: [] });
    Reflect.set(definition, 'setup', {
      ...Reflect.get(definition, 'setup'),
      file: { path: '../host', sha256: 'a'.repeat(64), size: 1 },
    });
    assert.throws(
      this.invalid.bind(this, { ...this.config, environments: [{ ...entry, definition }] }),
    );
    assert.throws(this.invalid.bind(this, { ...this.config, environments: [entry, entry] }));
  }
  private invalid(configuration: unknown): void {
    new KataEnvironmentArchive(configuration);
  }
  async journal(): Promise<void> {
    const path = join(this.root, 'journal');
    mkdirSync(path, { mode: 0o700 });
    const directory = SafeDirectory.open(path);
    try {
      await this.transitions(new KataWorkloadJournal(directory, 'c'.repeat(64)));
    } finally {
      directory.close();
    }
  }
  private async transitions(journal: KataWorkloadJournal): Promise<void> {
    const id = 'sandbox-' + randomUUID();
    const environment = (
      await new KataEnvironmentArchive(this.config).read('environment:good', this.image)
    ).definition;
    assert.equal(journal.assignment(id), null);
    const assignment = journal.assign(id, 'assignment:one', environment);
    assert.deepEqual(journal.assign(id, 'assignment:one', environment), assignment);
    assert.throws(journal.assign.bind(journal, id, 'assignment:two', environment));
    assert.throws(journal.begin.bind(journal, id, 'verification', 'd'.repeat(64)));
    assert.equal(journal.begin(id, 'setup', 'd'.repeat(64)), null);
    assert.throws(journal.begin.bind(journal, id, 'setup', 'd'.repeat(64)));
    journal.failed(id, 'setup', 'd'.repeat(64));
    assert.throws(journal.begin.bind(journal, id, 'verification', 'd'.repeat(64)));
    assert.throws(journal.begin.bind(journal, id, 'setup', 'd'.repeat(64)));
  }
}
const suite = new KataWorkloadBoundaries();
test(
  'integration: Kata environment archives bind exact private package and guest entrypoint bytes',
  suite.archives.bind(suite),
);
test(
  'integration: Kata environment custody rejects tampering permissions and symlink archives',
  suite.tampering.bind(suite),
);
test(
  'integration: Kata environment selection rejects unknown network path and duplicate declarations',
  suite.declarations.bind(suite),
);
test(
  'integration: Kata assignment and phase journals fence repeats interruptions and failed setup',
  suite.journal.bind(suite),
);
