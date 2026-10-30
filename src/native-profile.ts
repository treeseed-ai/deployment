import { z } from 'zod';
import {
  CanonicalJson,
  SandboxProfileBinding,
  type SandboxResourceProfile,
} from '@treeseed-cordis/sdk';
import { KataSandboxError } from './kata-command.js';
import type { EffectiveRuntimePolicyProof } from './runtime-policy.js';
import type { KataBackendConfiguration, KataSandboxEvidence } from './kata-backend.js';

interface ImageTarget {
  readonly reference: string;
  readonly manifestDigest: string;
  readonly mediaType: string;
}
/** Pure image-store syntax; authority remains with the verified owner client. */
export class NativeImageTargetProjection {
  private static readonly reference = z
    .string()
    .max(4096)
    .regex(
      /^(?:[a-zA-Z0-9][a-zA-Z0-9.-]*(?::[0-9]+)?\/)?(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*@sha256:[a-f0-9]{64}$/,
    );
  private static readonly media = new Set([
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json',
  ]);
  parse(table: unknown, reference: unknown): ImageTarget {
    try {
      const selected = NativeImageTargetProjection.reference.parse(reference);
      const matches = this.matches(table, selected);
      if (matches.length !== 1) throw new Error();
      const fields = matches[0]!;
      const digest = selected.slice(selected.lastIndexOf('@') + 1);
      if (
        fields.length < 6 ||
        !NativeImageTargetProjection.media.has(fields[1]!) ||
        fields[2] !== digest
      )
        throw new Error();
      return Object.freeze({
        reference: selected,
        manifestDigest: digest.slice(7),
        mediaType: fields[1]!,
      });
    } catch {
      throw new KataSandboxError('KATA_IMAGE_TARGET_INVALID');
    }
  }
  private matches(input: unknown, reference: string): string[][] {
    const text = z.string().min(1).max(1048576).parse(input);
    if (text.includes('\0') || Buffer.byteLength(text) > 1048576) throw new Error();
    const lines = text.trim().split('\n');
    if (
      lines.length > 16384 ||
      lines.shift()!.trim().replace(/\s+/g, ' ') !== 'REF TYPE DIGEST SIZE PLATFORMS LABELS'
    )
      throw new Error();
    const matches = [];
    for (const line of lines) {
      const fields = line.trim().split(/\s+/);
      if (fields[0] === reference) matches.push(fields);
    }
    return matches;
  }
}

/** Private owner metadata witness; it holds no live attestation or service instances. */
export class NativeSandboxProfile {
  private constructor(
    private readonly value: SandboxResourceProfile,
    private readonly generation: string,
  ) {}
  static async qualified(
    configuration: KataBackendConfiguration,
    policy: EffectiveRuntimePolicyProof,
    evidence: KataSandboxEvidence,
    generation: string,
  ): Promise<NativeSandboxProfile> {
    this.physical(policy, evidence);
    const value = await SandboxProfileBinding.create(
      this.content(configuration, policy, generation),
    );
    return new NativeSandboxProfile(value, generation);
  }
  private static physical(
    policy: EffectiveRuntimePolicyProof,
    evidence: KataSandboxEvidence,
  ): void {
    KataSandboxError.require(
      evidence.assignment === null &&
        evidence.filesystem &&
        evidence.runtime &&
        evidence.network &&
        evidence.filesystem.policyDigest === policy.digest &&
        evidence.runtime.policyDigest === policy.digest &&
        evidence.filesystem.runtimeDigest === evidence.runtime.digest &&
        evidence.filesystem.bootDigest === evidence.boot.digest &&
        evidence.runtime.bootDigest === evidence.boot.digest &&
        evidence.network.bootDigest === evidence.boot.digest &&
        evidence.network.mode === 'offline' &&
        CanonicalJson.stringify(evidence.resources) === CanonicalJson.stringify(policy.resources),
      'KATA_PROFILE_INVALID',
    );
  }
  private static content(
    configuration: KataBackendConfiguration,
    policy: EffectiveRuntimePolicyProof,
    generation: string,
  ): unknown {
    return {
      schemaVersion: 'treeseed.sandbox-profile/v1',
      id: 'native-' + CanonicalJson.digest(configuration.scope).slice(0, 24),
      runtime: {
        name: 'kata',
        version: configuration.runtime.version,
        archiveDigest: policy.archive.sha256,
      },
      image: {
        reference: configuration.image,
        manifestDigest: configuration.image.slice(configuration.image.lastIndexOf(':') + 1),
        os: 'linux',
        architecture: 'amd64',
      },
      resources: structuredClone(policy.resources),
      network: { mode: 'offline', destinations: [] },
      isolationPolicyDigest: generation,
    };
  }
  async read(generation: string): Promise<SandboxResourceProfile> {
    KataSandboxError.require(generation === this.generation, 'KATA_PROFILE_CHANGED');
    return SandboxProfileBinding.assert(this.value);
  }
}
