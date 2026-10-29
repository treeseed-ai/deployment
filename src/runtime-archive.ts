import { z } from 'zod';
import { dirname, basename, resolve } from 'node:path';
import { PlatformSchemas } from '@treeseed-cordis/sdk';
import { SafeDirectory, VerifiedDescriptor } from './filesystem.js';
import { KataSandboxError } from './kata-command.js';
/** Artifact identity only; no extraction, binary compatibility assertion or host activation. */
export class RuntimeArchiveCustody {
  static readonly Config = z.strictObject({
    path: PlatformSchemas.absolute,
    sha256: PlatformSchemas.digest,
    size: z
      .number()
      .int()
      .min(4)
      .max(2 * 1024 * 1024 * 1024),
  });
  readonly proof: Readonly<{ sha256: string; size: number }>;
  private closed = false;
  private constructor(
    private readonly file: VerifiedDescriptor,
    private readonly directory: SafeDirectory,
    input: z.infer<typeof RuntimeArchiveCustody.Config>,
  ) {
    this.proof = Object.freeze({ sha256: input.sha256, size: input.size });
  }
  static async open(input: unknown, signal: AbortSignal): Promise<RuntimeArchiveCustody> {
    let custody: RuntimeArchiveCustody | null = null;
    try {
      signal.throwIfAborted();
      const value = this.Config.parse(input);
      KataSandboxError.require(resolve(value.path) === value.path, 'KATA_RUNTIME_ARCHIVE_INVALID');
      custody = this.capture(value);
      await custody.file.hashAsync(value.sha256, value.size, signal);
      custody.verify();
      signal.throwIfAborted();
      return custody;
    } catch {
      custody?.close();
      throw new KataSandboxError(
        signal.aborted ? 'KATA_CANCELLED' : 'KATA_RUNTIME_ARCHIVE_INVALID',
      );
    }
  }
  private static capture(input: z.infer<typeof this.Config>): RuntimeArchiveCustody {
    const directory = SafeDirectory.open(dirname(input.path));
    let file: VerifiedDescriptor | null = null;
    try {
      file = VerifiedDescriptor.open(directory, basename(input.path), true);
      KataSandboxError.require(
        file.prefix(4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd])),
        'KATA_RUNTIME_ARCHIVE_INVALID',
      );
      return new RuntimeArchiveCustody(file, directory, input);
    } catch (error) {
      file?.close();
      directory.close();
      throw error;
    }
  }
  verify(): void {
    KataSandboxError.require(!this.closed, 'KATA_RUNTIME_ARCHIVE_CLOSED');
    try {
      this.file.verify();
    } catch {
      throw new KataSandboxError('KATA_RUNTIME_ARCHIVE_CHANGED');
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.file.close();
    } finally {
      this.directory.close();
    }
  }
}
