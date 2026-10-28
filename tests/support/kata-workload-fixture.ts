import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { CanonicalJson } from '@treeseed-cordis/sdk';
interface ArchiveReference {
  path: string;
  sha256: string;
  size: number;
}
export interface FixtureWorkloads {
  directory: string;
  environments: Array<{
    archive: ArchiveReference;
    definition: Record<string, unknown>;
  }>;
}
/** Genuine NPM data archives for guest-only scripts; no owner or live plugin implementation. */
export class KataWorkloadFixture {
  readonly hostCanary: string;
  readonly installCanary: string;
  private readonly source: string;
  private readonly archives: string;
  constructor(private readonly root: string) {
    this.source = join(root, 'environment-source');
    this.archives = join(root, 'environment-archives');
    this.hostCanary = join(root, 'host-script-ran');
    this.installCanary = join(root, 'ambient-script-ran');
  }
  prepare(image: string): FixtureWorkloads {
    this.write();
    const archive = this.pack();
    const identity = {
      reference: image,
      manifestDigest: image.split('@sha256:')[1],
      os: 'linux',
      architecture: 'amd64',
    };
    return {
      directory: this.archives,
      environments: [
        this.definition(identity, archive, 'environment:good', 'setup.sh', 10000),
        this.definition(identity, archive, 'environment:failed', 'failed.sh', 10000),
        this.definition(identity, archive, 'environment:slow', 'slow.sh', 20000),
        this.definition(identity, archive, 'environment:deadline', 'slow.sh', 3000),
        this.definition(identity, archive, 'environment:output', 'output.sh', 10000),
      ],
    };
  }
  private write(): void {
    mkdirSync(this.source, { mode: 0o700 });
    mkdirSync(this.archives, { mode: 0o700 });
    for (const [name, script] of Object.entries(this.scripts()))
      writeFileSync(join(this.source, name), script, { mode: 0o700 });
    writeFileSync(join(this.source, 'package.json'), JSON.stringify(this.metadata()), {
      mode: 0o600,
    });
  }
  private scripts(): Record<string, string> {
    return {
      'setup.sh': this.setup(),
      'verify.sh': this.verification(),
      'failed.sh': '#!/bin/sh\nprintf guest-output-canary\nexit 7\n',
      'slow.sh': '#!/bin/sh\nprintf started > /tmp/cordis-env-started\nsleep 30\n',
      'output.sh': '#!/bin/sh\ndd if=/dev/zero bs=2048 count=1 2>/dev/null\n',
    };
  }
  private setup(): string {
    return (
      '#!/bin/sh\nset -eu\nif [ -d "' +
      this.root +
      '" ]; then printf canary > "' +
      this.hostCanary +
      '"; fi\nprintf x >> /tmp/cordis-env-proof\nprintf guest-output-canary\n'
    );
  }
  private verification(): string {
    return '#!/bin/sh\nset -eu\ntest "$(wc -c < /tmp/cordis-env-proof)" = 1\nprintf verified\n';
  }
  private metadata(): object {
    return {
      name: '@fixture/kata-environment',
      version: '1.0.0',
      private: true,
      files: ['setup.sh', 'verify.sh', 'failed.sh', 'slow.sh', 'output.sh'],
      scripts: { postinstall: 'touch ' + this.installCanary },
    };
  }
  private pack(): ArchiveReference {
    const result = spawnSync(process.execPath, ['pm', 'pack', '--destination', this.archives], {
      cwd: this.source,
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(result.status, 0, result.stderr);
    const path = 'fixture-kata-environment-1.0.0.tgz';
    const file = join(this.archives, path);
    chmodSync(file, 0o600);
    return {
      path,
      sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
      size: statSync(file).size,
    };
  }
  private entry(file: string, deadlineMs: number): object {
    const bytes = readFileSync(join(this.source, file));
    return {
      file: {
        path: file,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
      },
      arguments: [],
      deadlineMs,
      outputLimitBytes: 1024,
    };
  }
  private definition(
    image: {
      reference: string;
      manifestDigest: string | undefined;
      os: string;
      architecture: string;
    },
    archive: ArchiveReference,
    id: string,
    setup: string,
    deadlineMs: number,
  ) {
    const value = {
      schemaVersion: 'treeseed.agent-environment/v1',
      id,
      image,
      setup: this.entry(setup, deadlineMs),
      verification: this.entry('verify.sh', 10000),
      network: { mode: 'offline', destinations: [] },
    };
    return {
      archive,
      definition: {
        ...value,
        revision: CanonicalJson.digest(value),
        artifact: {
          package: '@fixture/kata-environment',
          version: '1.0.0',
          integrity: archive.sha256,
        },
      },
    };
  }
  canaries(): void {
    assert.equal(existsSync(this.hostCanary), false);
    assert.equal(existsSync(this.installCanary), false);
  }
}
