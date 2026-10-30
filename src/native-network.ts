import { z } from 'zod';
import { CanonicalJson, PlatformSchemas } from '@treeseed-cordis/sdk';
import { KataSandboxError } from './kata-command.js';

export interface NativeNetworkEvidence {
  readonly kind: 'kata-offline-network';
  readonly formatVersion: 1;
  readonly mode: 'offline';
  readonly namespace: 'private';
  readonly bootDigest: string;
  readonly digest: string;
}
/** Pure observed-input projection; the selected native host owns actual reads and generation fencing. */
export class NativeNetworkProjection {
  private static readonly spec = z.object({
    linux: z.object({
      namespaces: z
        .array(
          z.object({
            type: z.string().min(1).max(32),
            path: z.string().max(4096).optional(),
          }),
        )
        .max(64),
    }),
  });
  assertSpec(input: unknown): void {
    try {
      const spec = NativeNetworkProjection.spec.parse(input);
      const rows = spec.linux.namespaces.filter(NativeNetworkProjection.network);
      if (rows.length !== 1 || rows[0]!.path !== undefined) throw new Error();
    } catch {
      throw new KataSandboxError('KATA_NATIVE_NETWORK_INVALID');
    }
  }
  private static network(row: { type: string }): boolean {
    return row.type === 'network';
  }
  read(input: unknown, boot: unknown, interfaces: unknown): NativeNetworkEvidence {
    try {
      this.assertSpec(input);
      const bootDigest = PlatformSchemas.digest.parse(boot);
      if (interfaces !== '/sys/class/net/lo\n') throw new Error();
      const content = {
        kind: 'kata-offline-network' as const,
        formatVersion: 1 as const,
        mode: 'offline' as const,
        namespace: 'private' as const,
        bootDigest,
      };
      return Object.freeze({ ...content, digest: CanonicalJson.digest(content) });
    } catch {
      throw new KataSandboxError('KATA_NATIVE_NETWORK_INVALID');
    }
  }
}
