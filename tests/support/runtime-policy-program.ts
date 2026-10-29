import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parse, stringify } from 'smol-toml';
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  lstatSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CanonicalJson, type PoolResourceShape } from '@treeseed-cordis/sdk';
import * as Sandbox from '@treeseed-cordis/deployment/sandbox';
export interface EffectivePolicyProof {
  readonly kind: 'kata-effective-runtime-policy';
  readonly formatVersion: 1;
  readonly archive: { sha256: string; size: number };
  readonly configuration: { sha256: string; size: number };
  readonly resources: PoolResourceShape;
  readonly vmResources: {
    vcpus: number;
    maximumVcpus: number;
    memoryMiB: number;
    maximumMemoryMiB: number;
  };
  readonly digest: string;
}
export interface EffectivePolicy {
  readonly proof: EffectivePolicyProof;
  verify(): void;
  close(): void;
}
interface EffectivePolicyConstructor {
  open(
    input: unknown,
    components: Sandbox.RuntimeComponentCustody,
    aliases: Sandbox.RuntimeAliasCustody,
    signal: AbortSignal,
  ): Promise<EffectivePolicy>;
}
/** Test-only fixed official data acquisition, never execution or installation of its binaries. */
class PolicyKitFixture {
  static readonly sha256 = '3dc6b69c4acb787b967b04b64599a20d02a8beb1a8eaab3084110df9d0b08c96';
  static readonly size = 969565384;
  static readonly url =
    'https://github.com/kata-containers/kata-containers/releases/download/4.1.0/kata-static-4.1.0-amd64.tar.zst';
  private static readonly downloadFlags = [
    '--disable',
    '--proto',
    '=https',
    '--fail',
    '--location',
    '--retry',
    '2',
    '--max-time',
    '180',
  ];
  private static readonly extractFlags = [
    '--no-same-owner',
    '--same-permissions',
    '--keep-old-files',
    '--',
  ];
  static acquire(destination: string, explicit?: string): void {
    const prepared = process.env.RUNNER_TEMP
      ? join(process.env.RUNNER_TEMP, 'kata.tar.zst')
      : undefined;
    const source =
      explicit ??
      process.env.CORDIS_TEST_KATA_KIT ??
      (prepared && existsSync(prepared) ? prepared : undefined);
    if (source) this.copy(source, destination);
    else this.download(destination);
    chmodSync(destination, 0o600);
  }
  private static copy(source: string, destination: string): void {
    const stat = lstatSync(source);
    assert(stat.isFile() && !stat.isSymbolicLink(), 'Pinned fixture kit must be a regular file');
    copyFileSync(source, destination);
  }
  private static download(destination: string): void {
    const result = spawnSync('curl', [...this.downloadFlags, '--output', destination, this.url], {
      encoding: 'utf8',
      timeout: 185000,
    });
    assert.equal(result.status, 0, 'Pinned official fixture kit download failed');
  }
  static extract(archive: string, root: string, inspected: Sandbox.RuntimeKitMembers): void {
    const result = spawnSync(
      'tar',
      [
        '--zstd',
        '--extract',
        '--file',
        archive,
        '--directory',
        root,
        ...this.extractFlags,
        ...this.selected(inspected),
      ],
      { encoding: 'utf8', timeout: 180000, maxBuffer: 1048576 },
    );
    assert.equal(
      result.status,
      0,
      result.stderr || 'Pinned selected runtime fixture members could not be prepared',
    );
  }
  private static selected(inspected: Sandbox.RuntimeKitMembers): string[] {
    const selected = new Set<string>();
    for (const member of inspected.members) {
      selected.add('./' + member.path);
      for (const link of member.links) selected.add('./' + link.path);
    }
    return [...selected];
  }
}
/** Real official kit descriptors and private effective TOML; no runtime, scripts or managed effects. */
export class RuntimePolicyFixture {
  readonly directory = realpathSync(mkdtempSync(join(tmpdir(), 'PRIVATE_RUNTIME_POLICY_')));
  readonly root = join(this.directory, 'installed');
  readonly configuration = {
    path: join(this.directory, 'PRIVATE_EFFECTIVE_POLICY.toml'),
    sha256: '',
  };
  readonly resources = { vcpus: 2, memoryMiB: 1024, scratchMiB: 64 };
  readonly signal = new AbortController().signal;
  readonly held: EffectivePolicy[] = [];
  archive: Sandbox.RuntimeArchiveCustody | null = null;
  components: Sandbox.RuntimeComponentCustody | null = null;
  aliases: Sandbox.RuntimeAliasCustody | null = null;
  text = '';
  static readonly selections = [
    [
      'configuration',
      'opt/kata/share/defaults/kata-containers/runtime-rs/configuration-qemu-runtime-rs.toml',
    ],
    ['shim', 'opt/kata/runtime-rs/bin/containerd-shim-kata-v2'],
    ['hypervisor', 'opt/kata/bin/qemu-system-x86_64'],
    ['kernel', 'opt/kata/share/kata-containers/vmlinux.container'],
    ['rootfs', 'opt/kata/share/kata-containers/kata-containers.img'],
    ['virtiofs', 'opt/kata/libexec/virtiofsd'],
  ] as const;
  static type(): EffectivePolicyConstructor {
    const Constructor = Reflect.get(Sandbox, 'EffectiveRuntimePolicy') as
      | EffectivePolicyConstructor
      | undefined;
    assert(
      Constructor && typeof Constructor.open === 'function',
      'Public effective runtime policy missing',
    );
    return Constructor;
  }
  async prepare(source?: string): Promise<void> {
    const path = join(this.directory, 'kit.tar.zst');
    PolicyKitFixture.acquire(path, source);
    this.archive = await Sandbox.RuntimeArchiveCustody.open(
      { path, sha256: PolicyKitFixture.sha256, size: PolicyKitFixture.size },
      this.signal,
    );
    const members = [];
    for (const [, member] of RuntimePolicyFixture.selections) members.push(member);
    const inspected = await this.archive.inspect(members, this.signal);
    mkdirSync(this.root, { mode: 0o700 });
    PolicyKitFixture.extract(path, this.root, inspected);
    this.components = await Sandbox.RuntimeComponentCustody.open(
      this.archive,
      this.bindings(inspected),
      this.signal,
    );
    this.write(this.effective());
    this.aliases = await Sandbox.RuntimeAliasCustody.open(this.components, this.root, this.signal);
  }
  private bindings(inspected: Sandbox.RuntimeKitMembers): Sandbox.RuntimeComponentBinding[] {
    const bindings = [];
    for (const [role, requested] of RuntimePolicyFixture.selections) {
      const member = inspected.members.find(RuntimePolicyFixture.requested.bind(null, requested));
      assert(member);
      bindings.push({ role, member: requested, path: join(this.root, member.path) });
    }
    return bindings;
  }
  private static requested(path: string, member: Sandbox.RuntimeKitMember): boolean {
    return member.requestedPath === path;
  }
  private effective(): string {
    const template = join(this.root, RuntimePolicyFixture.selections[0][1]);
    const document = parse(readFileSync(template, 'utf8'), { integersAsBigInt: true });
    const hypervisor = document.hypervisor as Record<string, unknown>;
    const qemu = hypervisor.qemu as Record<string, unknown>;
    qemu.default_vcpus = 3n;
    qemu.default_maxvcpus = 3n;
    qemu.default_memory = 1056n;
    qemu.default_maxmemory = 1056n;
    qemu.memory_slots = 1n;
    qemu.enable_annotations = [];
    return stringify(document);
  }
  write(text: string): void {
    this.text = text;
    writeFileSync(this.configuration.path, text, { mode: 0o600 });
    chmodSync(this.configuration.path, 0o600);
    this.configuration.sha256 = createHash('sha256').update(text).digest('hex');
  }
  get input(): object {
    return { configuration: { ...this.configuration }, resources: { ...this.resources } };
  }
  async open(input: unknown = this.input, signal = this.signal): Promise<EffectivePolicy> {
    assert(this.components && this.aliases);
    const policy = await RuntimePolicyFixture.type().open(
      input,
      this.components,
      this.aliases,
      signal,
    );
    this.held.push(policy);
    return policy;
  }
  close(): void {
    try {
      for (const policy of this.held) policy.close();
    } finally {
      this.borrowed();
    }
  }
  private borrowed(): void {
    try {
      this.aliases?.close();
    } finally {
      try {
        this.components?.close();
      } finally {
        this.archive?.close();
        rmSync(this.directory, { recursive: true, force: true });
      }
    }
  }
}
class EffectivePolicyProgram {
  static async run(source?: string): Promise<void> {
    RuntimePolicyFixture.type();
    const fixture = new RuntimePolicyFixture();
    try {
      await fixture.prepare(source);
      await this.verify(fixture);
    } finally {
      fixture.close();
    }
    process.stdout.write('effective-runtime-policy-public-ok\n');
  }
  private static async verify(fixture: RuntimePolicyFixture): Promise<void> {
    const before = readdirSync(fixture.directory).sort(),
      path = process.env.PATH;
    process.env.PATH = '/missing-runtime-policy-tools';
    try {
      const first = await fixture.open();
      first.verify();
      this.assertProof(first.proof, fixture);
      assert.deepEqual((await fixture.open()).proof, first.proof);
      assert.deepEqual(readdirSync(fixture.directory).sort(), before);
    } finally {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
    }
  }
  private static assertProof(proof: EffectivePolicyProof, fixture: RuntimePolicyFixture): void {
    const { digest, ...payload } = proof;
    assert.equal(payload.kind, 'kata-effective-runtime-policy');
    assert.equal(payload.configuration.sha256, fixture.configuration.sha256);
    assert.deepEqual(payload.resources, fixture.resources);
    assert.deepEqual(payload.vmResources, {
      vcpus: 3,
      maximumVcpus: 3,
      memoryMiB: 1056,
      maximumMemoryMiB: 1056,
    });
    assert.equal(digest, CanonicalJson.digest(payload));
    assert(Object.isFrozen(proof) && Object.isFrozen(payload.vmResources));
  }
}
class RuntimePolicyEntry {
  static async run(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.length === 0) await EffectivePolicyProgram.run();
    else if (args.length === 2 && args[0] === '--kit') await EffectivePolicyProgram.run(args[1]!);
    else throw new Error('Invalid runtime policy fixture arguments');
  }
}
if (import.meta.main) await RuntimePolicyEntry.run();
