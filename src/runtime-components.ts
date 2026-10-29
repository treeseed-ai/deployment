import { z } from 'zod';
import { basename, dirname, resolve } from 'node:path';
import { PlatformSchemas } from '@treeseed-cordis/sdk';
import { RuntimeArchiveCustody } from './runtime-archive.js';
import type { RuntimeKitMember, RuntimeKitMembers } from './runtime-kit.js';
import { SafeDirectory, VerifiedDescriptor } from './filesystem.js';
import { KataSandboxError } from './kata-command.js';
export interface RuntimeComponentBinding {
  readonly role: string;
  readonly member: string;
  readonly path: string;
}
interface ComponentFile {
  file: VerifiedDescriptor;
  directory: SafeDirectory;
}
export interface RuntimeComponentProof {
  readonly formatVersion: 1;
  readonly archive: Readonly<{ sha256: string; size: number }>;
  readonly components: readonly Readonly<{
    role: string;
    member: RuntimeKitMember;
  }>[];
}
/** Borrowed kit, owned installed descriptors. This admits bytes; it never activates a runtime. */
export class RuntimeComponentCustody {
  static readonly Config = z
    .array(
      z.strictObject({
        role: PlatformSchemas.slot,
        member: z.string().min(1).max(4096),
        path: PlatformSchemas.absolute,
      }),
    )
    .min(1)
    .max(16);
  private readonly files: ComponentFile[] = [];
  private closed = false;
  private closeFailed = false;
  readonly proof: RuntimeComponentProof;
  private readonly selectedBindings: readonly RuntimeComponentBinding[];
  private constructor(
    private readonly archive: RuntimeArchiveCustody,
    selected: RuntimeComponentBinding[],
    inspected: RuntimeKitMembers,
  ) {
    this.proof = RuntimeComponentCustody.projection(selected, inspected);
    this.selectedBindings = RuntimeComponentCustody.snapshot(selected);
  }
  static async open(
    archive: RuntimeArchiveCustody,
    input: unknown,
    signal: AbortSignal,
  ): Promise<RuntimeComponentCustody> {
    let custody: RuntimeComponentCustody | null = null;
    try {
      signal.throwIfAborted();
      const selected = this.selections(input);
      const paths: string[] = [];
      for (const binding of selected) paths.push(binding.member);
      const inspected = await archive.inspect(paths, signal);
      custody = new RuntimeComponentCustody(archive, selected, inspected);
      await custody.capture(selected, signal);
      custody.verify();
      return custody;
    } catch {
      try {
        custody?.close();
      } catch {}
      throw new KataSandboxError(signal.aborted ? 'KATA_CANCELLED' : 'KATA_COMPONENTS_INVALID');
    }
  }
  get bindings(): readonly RuntimeComponentBinding[] {
    return this.selectedBindings;
  }
  private static snapshot(selected: RuntimeComponentBinding[]): readonly RuntimeComponentBinding[] {
    const bindings: RuntimeComponentBinding[] = [];
    for (const binding of selected) bindings.push(Object.freeze({ ...binding }));
    return Object.freeze(bindings);
  }
  private static selections(input: unknown): RuntimeComponentBinding[] {
    const selected = this.Config.parse(input);
    const roles = new Set<string>(),
      members = new Set<string>(),
      paths = new Set<string>();
    for (const binding of selected) {
      if (
        resolve(binding.path) !== binding.path ||
        roles.has(binding.role) ||
        members.has(binding.member) ||
        paths.has(binding.path)
      )
        throw new Error();
      roles.add(binding.role);
      members.add(binding.member);
      paths.add(binding.path);
    }
    return selected.sort(this.compare);
  }
  private static compare(left: RuntimeComponentBinding, right: RuntimeComponentBinding): number {
    return left.role < right.role ? -1 : left.role > right.role ? 1 : 0;
  }
  private static projection(
    selected: RuntimeComponentBinding[],
    inspected: RuntimeKitMembers,
  ): RuntimeComponentProof {
    const members = new Map<string, RuntimeKitMember>();
    for (const member of inspected.members) members.set(member.requestedPath, member);
    const components: Array<Readonly<{ role: string; member: RuntimeKitMember }>> = [];
    for (const binding of selected) {
      const member = members.get(binding.member);
      if (!member) throw new Error();
      components.push(Object.freeze({ role: binding.role, member }));
    }
    return Object.freeze({
      formatVersion: 1,
      archive: inspected.archive,
      components: Object.freeze(components),
    });
  }
  private retain(binding: RuntimeComponentBinding): VerifiedDescriptor {
    const directory = SafeDirectory.open(dirname(binding.path));
    try {
      const file = VerifiedDescriptor.open(directory, basename(binding.path));
      this.files.push({ file, directory });
      return file;
    } catch (error) {
      directory.close();
      throw error;
    }
  }
  private async capture(selected: RuntimeComponentBinding[], signal: AbortSignal): Promise<void> {
    for (const [index, binding] of selected.entries()) {
      signal.throwIfAborted();
      const member = this.proof.components[index]!.member;
      const file = this.retain(binding);
      await file.hashAsync(member.sha256, member.size, signal);
      const metadata = file.metadata();
      if (metadata.mode !== member.mode || metadata.size !== member.size) throw new Error();
    }
    signal.throwIfAborted();
  }
  verify(): void {
    KataSandboxError.require(!this.closed, 'KATA_COMPONENTS_CLOSED');
    try {
      this.archive.verify();
      for (const entry of this.files) entry.file.verify();
    } catch {
      throw new KataSandboxError('KATA_COMPONENTS_CHANGED');
    }
  }
  private release(entry: ComponentFile): boolean {
    let success = true;
    try {
      entry.file.close();
    } catch {
      success = false;
    }
    try {
      entry.directory.close();
    } catch {
      success = false;
    }
    return success;
  }
  close(): void {
    if (!this.closed) {
      this.closed = true;
      for (const entry of this.files) if (!this.release(entry)) this.closeFailed = true;
    }
    KataSandboxError.require(!this.closeFailed, 'KATA_COMPONENTS_CLOSE_FAILED');
  }
}
