import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { CanonicalJson } from '@treeseed-cordis/sdk';
import {
  InstallationRecordFixture,
  type RecordCustody,
  type RecordScope,
} from '../support/installation-records-program.js';
class InstallationRecordBoundaries {
  async invalidScope(mode: string): Promise<void> {
    const fixture = new InstallationRecordFixture();
    try {
      const scope = await this.scope(fixture, mode);
      const Type = fixture.type(),
        signal = mode === 'cancelled' ? AbortSignal.abort() : fixture.signal;
      await assert.rejects(Type.acquire.bind(Type, scope, signal), {
        message:
          mode === 'cancelled' ? 'INSTALLATION_RECORDS_CANCELLED' : 'INSTALLATION_RECORDS_INVALID',
      });
      assert.equal(existsSync(fixture.directory), false);
    } finally {
      fixture.close();
    }
  }
  private async scope(fixture: InstallationRecordFixture, mode: string): Promise<RecordScope> {
    if (mode !== 'missing') await fixture.prepare();
    const scope =
      mode === 'missing'
        ? {
            installationId: 'missing',
            installationDirectory: join(fixture.release.root, 'absent'),
            namespace: 'seeds',
          }
        : { ...fixture.scope };
    this.invalidate(fixture, scope, mode);
    return scope;
  }
  private invalidate(fixture: InstallationRecordFixture, scope: RecordScope, mode: string): void {
    if (mode === 'foreign') scope.installationId = 'another-installation';
    if (mode === 'relative') scope.installationDirectory = 'relative/installation';
    if (mode === 'noncanonical') scope.installationDirectory += '/../installation';
    if (mode === 'namespace') scope.namespace = '../seeds';
    if (mode === 'unknown') Object.assign(scope, { activate: true });
    if (mode === 'permissions')
      chmodSync(join(fixture.release.installation, '.cordis/installation.json'), 0o644);
    if (mode === 'alias') {
      scope.installationDirectory = join(fixture.release.root, 'alias');
      symlinkSync(fixture.release.installation, scope.installationDirectory);
    }
  }
  async exclusive(): Promise<void> {
    const fixture = new InstallationRecordFixture();
    let writer: RecordCustody | null = null;
    try {
      await fixture.prepare();
      const Type = fixture.type();
      writer = await Type.acquire(fixture.scope, fixture.signal);
      await this.busy(fixture);
      writer.close();
      writer = null;
      const reopened = await Type.acquire(fixture.scope, fixture.signal);
      try {
        assert.deepEqual(await reopened.read(), []);
      } finally {
        reopened.close();
      }
    } finally {
      writer?.close();
      fixture.close();
    }
  }
  private async busy(fixture: InstallationRecordFixture): Promise<void> {
    const Type = fixture.type();
    await assert.rejects(Type.acquire.bind(Type, fixture.scope, fixture.signal), {
      message: 'INSTALLATION_RECORDS_BUSY',
    });
    await assert.rejects(Type.inspect.bind(Type, fixture.scope, fixture.signal), {
      message: 'INSTALLATION_RECORDS_BUSY',
    });
    this.otherProcess(fixture);
  }
  private otherProcess(fixture: InstallationRecordFixture): void {
    const file = join(fixture.release.root, 'scope.json');
    writeFileSync(file, JSON.stringify(fixture.scope), { mode: 0o600 });
    const result = spawnSync(
      'node',
      ['dist/tests/support/installation-records-program.js', 'attempt', file],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'installation-records-busy\n');
  }
  async parallel(): Promise<void> {
    const fixture = new InstallationRecordFixture();
    const writers: RecordCustody[] = [];
    try {
      await fixture.prepare();
      const Type = fixture.type();
      const outcomes = await Promise.allSettled([
        Type.acquire(fixture.scope, fixture.signal),
        Type.acquire(fixture.scope, fixture.signal),
      ]);
      for (const outcome of outcomes)
        if (outcome.status === 'fulfilled') writers.push(outcome.value);
      assert.equal(writers.length, 1);
      await this.independent(fixture, writers[0]!);
    } finally {
      for (const writer of writers) writer.close();
      fixture.close();
    }
  }
  private async independent(
    fixture: InstallationRecordFixture,
    writer: RecordCustody,
  ): Promise<void> {
    const Type = fixture.type();
    const other = await Type.acquire(
      { ...fixture.scope, namespace: 'another-owner' },
      fixture.signal,
    );
    try {
      await other.append(null, { owner: 'independent' });
      assert.deepEqual(await writer.read(), []);
    } finally {
      other.close();
    }
  }
  async snapshot(): Promise<void> {
    const fixture = new InstallationRecordFixture();
    let writer: RecordCustody | null = null;
    try {
      await fixture.prepare();
      writer = await fixture.type().acquire(fixture.scope, fixture.signal);
      const input = { value: 'accepted' };
      const pending = writer.append(null, input);
      input.value = 'changed';
      await assert.rejects(writer.read.bind(writer), { message: 'INSTALLATION_RECORDS_BUSY' });
      assert.throws(writer.close.bind(writer), { message: 'INSTALLATION_RECORDS_BUSY' });
      const record = await pending;
      assert.deepEqual(record.content, { value: 'accepted' });
      assert.deepEqual(await writer.read(), [record]);
    } finally {
      writer?.close();
      fixture.close();
    }
  }
  async cancelled(): Promise<void> {
    const fixture = new InstallationRecordFixture();
    let writer: RecordCustody | null = null;
    try {
      await fixture.prepare();
      const Type = fixture.type(),
        controller = new AbortController();
      writer = await Type.acquire(fixture.scope, controller.signal);
      controller.abort();
      await assert.rejects(writer.append.bind(writer, null, { value: 'PRIVATE_RECORD_CANARY' }), {
        message: 'INSTALLATION_RECORDS_CANCELLED',
      });
      writer.close();
      writer = null;
      assert.deepEqual(await Type.inspect(fixture.scope, fixture.signal), []);
    } finally {
      writer?.close();
      fixture.close();
    }
  }
  async interrupted(mode: string): Promise<void> {
    const fixture = new InstallationRecordFixture();
    try {
      await fixture.prepare();
      const Type = fixture.type();
      if (mode === 'initialization') mkdirSync(fixture.directory, { recursive: true, mode: 0o700 });
      else {
        const writer = await Type.acquire(fixture.scope, fixture.signal);
        writer.close();
        mkdirSync(join(fixture.directory, 'writer.lock'), { mode: 0o700 });
        writeFileSync(join(fixture.directory, 'writer.lock/owner.json'), '{}', { mode: 0o600 });
      }
      const before = readdirSync(fixture.directory);
      await assert.rejects(Type.acquire.bind(Type, fixture.scope, fixture.signal));
      await assert.rejects(Type.inspect.bind(Type, fixture.scope, fixture.signal));
      assert.deepEqual(readdirSync(fixture.directory), before);
    } finally {
      fixture.close();
    }
  }
  async stored(mode: string): Promise<void> {
    const fixture = new InstallationRecordFixture();
    try {
      await fixture.prepare();
      const Type = fixture.type();
      const writer = await Type.acquire(fixture.scope, fixture.signal);
      try {
        await writer.append(null, { value: 'verified' });
      } finally {
        writer.close();
      }
      this.corrupt(fixture, mode);
      await assert.rejects(Type.inspect.bind(Type, fixture.scope, fixture.signal));
    } finally {
      fixture.close();
    }
  }
  private record(fixture: InstallationRecordFixture): string {
    const name = readdirSync(fixture.directory).find(InstallationRecordBoundaries.recordName);
    assert(name);
    return join(fixture.directory, name);
  }
  private static recordName(name: string): boolean {
    return /^00000001-[a-f0-9]{64}\.json$/.test(name);
  }
  private corrupt(fixture: InstallationRecordFixture, mode: string): void {
    const file = this.record(fixture);
    if (mode === 'bytes') appendFileSync(file, 'PRIVATE_RECORD_CANARY');
    else if (mode === 'mode') chmodSync(file, 0o644);
    else if (mode === 'symlink') {
      const copy = join(fixture.release.root, 'copy');
      copyFileSync(file, copy);
      unlinkSync(file);
      symlinkSync(copy, file);
    } else this.envelope(file, mode);
  }
  private envelope(file: string, mode: string): void {
    const record = JSON.parse(readFileSync(file, 'utf8'));
    delete record.digest;
    if (mode === 'scope') record.scopeDigest = 'a'.repeat(64);
    if (mode === 'sequence') record.sequence = 2;
    if (mode === 'previous') record.previousDigest = 'a'.repeat(64);
    if (mode === 'format') record.formatVersion = 2;
    if (mode === 'extra') record.execute = true;
    const changed = { ...record, digest: CanonicalJson.digest(record) };
    unlinkSync(file);
    const name = String(changed.sequence).padStart(8, '0') + '-' + changed.digest + '.json';
    writeFileSync(join(file, '..', name), CanonicalJson.stringify(changed) + '\n', { mode: 0o600 });
  }
  async retained(mode: string): Promise<void> {
    const fixture = new InstallationRecordFixture();
    let writer: RecordCustody | null = null;
    try {
      await fixture.prepare();
      writer = await fixture.type().acquire(fixture.scope, fixture.signal);
      await writer.append(null, { value: 'verified' });
      this.changeScope(fixture, mode);
      await assert.rejects(writer.read.bind(writer));
      assert.throws(writer.close.bind(writer), { message: 'INSTALLATION_RECORDS_CLOSE_FAILED' });
      assert.throws(writer.close.bind(writer), { message: 'INSTALLATION_RECORDS_CLOSE_FAILED' });
      writer = null;
    } finally {
      if (writer) {
        try {
          writer.close();
        } catch {}
      }
      fixture.close();
    }
  }
  private changeScope(fixture: InstallationRecordFixture, mode: string): void {
    if (mode === 'receipt')
      appendFileSync(join(fixture.release.installation, '.cordis/installation.json'), ' ');
    if (mode === 'marker') appendFileSync(join(fixture.directory, 'scope.json'), ' ');
    if (mode === 'directory') {
      const moved = fixture.directory + '-moved';
      renameSync(fixture.directory, moved);
      symlinkSync(moved, fixture.directory);
    }
  }
}
const suite = new InstallationRecordBoundaries();
for (const mode of [
  'missing',
  'foreign',
  'relative',
  'noncanonical',
  'namespace',
  'unknown',
  'permissions',
  'alias',
  'cancelled',
])
  test(
    'integration: installation record acquisition rejects ' + mode + ' without initializing state',
    suite.invalidScope.bind(suite, mode),
    15000,
  );
test(
  'integration: installation record writer excludes another real process and reopens after clean release',
  suite.exclusive.bind(suite),
  15000,
);
test(
  'integration: concurrent namespace acquisition admits one writer and preserves independent owners',
  suite.parallel.bind(suite),
  15000,
);
test(
  'integration: record append snapshots content and fences overlapping operations and early close',
  suite.snapshot.bind(suite),
  15000,
);
test(
  'integration: cancelled record append publishes no receipt and releases only its own writer',
  suite.cancelled.bind(suite),
  15000,
);
for (const mode of ['initialization', 'writer'])
  test(
    'integration: interrupted record ' + mode + ' is never silently adopted',
    suite.interrupted.bind(suite, mode),
    15000,
  );
for (const mode of ['bytes', 'mode', 'symlink', 'scope', 'sequence', 'previous', 'format', 'extra'])
  test(
    'integration: stored installation records reject ' +
      mode +
      ' without reopening original bundles',
    suite.stored.bind(suite, mode),
    15000,
  );
for (const mode of ['receipt', 'marker', 'directory'])
  test(
    'integration: retained record custody fences changed ' +
      mode +
      ' and preserves failed close status',
    suite.retained.bind(suite, mode),
    15000,
  );
