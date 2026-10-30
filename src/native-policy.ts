import { resolve } from 'node:path';
import { z } from 'zod';
import type { PoolResourceShape } from '@treeseed-cordis/sdk';
import { RuntimeComponentCustody, type RuntimeComponentBinding } from './runtime-components.js';
import { KataSandboxError } from './kata-command.js';
import { RuntimeArchiveCustody } from './runtime-archive.js';
import { RuntimeAliasCustody } from './runtime-aliases.js';
import { EffectiveRuntimePolicy, type EffectiveRuntimePolicyInput } from './runtime-policy.js';
import { KataLaunchAttestation } from './kata-hypervisor.js';
import { NativeRuntimeAttestation } from './native-shim.js';

interface NativePolicyConfiguration {
  runtime: {
    configurationMode?: 'environment' | 'task-options';
    policy?: { components: RuntimeComponentBinding[] };
    archive?: unknown;
    configuration?: { path: string; sha256: string };
    shim: { path: string; sha256?: string };
    hypervisor: { path: string; sha256?: string };
  };
  resources?: PoolResourceShape;
}
/** Host-owned descriptor admission; native Cordis owns provider selection and lifecycle. */
export class NativePolicyCustody {
  private static readonly roles = [
    'configuration',
    'hypervisor',
    'kernel',
    'rootfs',
    'shim',
    'virtiofs',
  ] as const;
  static readonly Config = z.strictObject({
    components: z
      .array(RuntimeComponentCustody.Config.element.extend({ role: z.enum(this.roles) }))
      .length(this.roles.length),
  });
  private components: RuntimeComponentCustody | null = null;
  private aliases: RuntimeAliasCustody | null = null;
  private policy: EffectiveRuntimePolicy | null = null;
  private closed = false;
  private closeFailed = false;
  private constructor(
    private readonly archive: RuntimeArchiveCustody,
    private readonly input: NativePolicyConfiguration,
    private readonly selected: RuntimeComponentBinding[],
    private readonly policyInput: EffectiveRuntimePolicyInput,
  ) {}
  static assertConfiguration(input: NativePolicyConfiguration): void {
    try {
      if (!input.runtime.policy) return;
      if (
        !input.runtime.archive ||
        !input.resources ||
        input.runtime.configurationMode !== 'task-options'
      )
        throw new Error();
      const selected = this.Config.parse(input.runtime.policy).components;
      this.components(selected);
      this.files(selected, input.runtime);
    } catch {
      throw new KataSandboxError('KATA_CONFIGURATION_INVALID');
    }
  }
  private static components(selected: RuntimeComponentBinding[]): void {
    const roles = [],
      members = new Set<string>(),
      paths = new Set<string>();
    for (const binding of selected) {
      if (
        resolve(binding.path) !== binding.path ||
        members.has(binding.member) ||
        paths.has(binding.path)
      )
        throw new Error();
      roles.push(binding.role);
      members.add(binding.member);
      paths.add(binding.path);
    }
    if (roles.sort().join(',') !== this.roles.join(',')) throw new Error();
  }
  private static files(
    selected: RuntimeComponentBinding[],
    runtime: NativePolicyConfiguration['runtime'],
  ): void {
    for (const binding of selected)
      if (
        (binding.role === 'shim' || binding.role === 'hypervisor') &&
        binding.path !== runtime[binding.role].path
      )
        throw new Error();
  }
  static async open(
    input: NativePolicyConfiguration,
    archive: RuntimeArchiveCustody | null,
    signal: AbortSignal,
  ): Promise<NativePolicyCustody | null> {
    let custody: NativePolicyCustody | null = null;
    try {
      this.assertConfiguration(input);
      if (!input.runtime.policy) return null;
      signal.throwIfAborted();
      custody = this.selected(input, archive);
      await custody.capture(signal);
      return custody;
    } catch {
      custody?.close();
      throw new KataSandboxError(signal.aborted ? 'KATA_CANCELLED' : 'KATA_NATIVE_POLICY_INVALID');
    }
  }
  private static selected(
    input: NativePolicyConfiguration,
    archive: RuntimeArchiveCustody | null,
  ): NativePolicyCustody {
    const declared = RuntimeArchiveCustody.Config.parse(input.runtime.archive);
    if (
      !(archive instanceof RuntimeArchiveCustody) ||
      archive.proof.sha256 !== declared.sha256 ||
      archive.proof.size !== declared.size
    )
      throw new Error();
    archive.verify();
    const selected = this.Config.parse(input.runtime.policy).components;
    const policyInput = EffectiveRuntimePolicy.Config.parse({
      configuration: input.runtime.configuration,
      resources: input.resources,
    });
    return new NativePolicyCustody(archive, input, selected, policyInput);
  }
  private async capture(signal: AbortSignal): Promise<void> {
    this.components = await RuntimeComponentCustody.open(this.archive, this.selected, signal);
    this.executables();
    this.aliases = await RuntimeAliasCustody.open(this.components, '/', signal);
    this.policy = await EffectiveRuntimePolicy.open(
      this.policyInput,
      this.components,
      this.aliases,
      signal,
    );
    this.verify();
    signal.throwIfAborted();
  }
  private executables(): void {
    for (const component of this.components!.proof.components) {
      const role = component.role;
      if (
        (role === 'shim' || role === 'hypervisor') &&
        component.member.sha256 !== this.input.runtime[role].sha256
      )
        throw new Error();
    }
  }
  verify(): void {
    KataSandboxError.require(!this.closed && this.policy, 'KATA_NATIVE_POLICY_CLOSED');
    this.policy.verify();
  }
  async launch(name: string, signal: AbortSignal): Promise<KataLaunchAttestation> {
    this.verify();
    return KataLaunchAttestation.open(this.policy!, name, signal);
  }
  async runtimeLaunch(name: string, signal: AbortSignal): Promise<NativeRuntimeAttestation> {
    this.verify();
    return NativeRuntimeAttestation.open(this.policy!, name, signal);
  }
  close(): void {
    if (!this.closed) {
      this.closed = true;
      for (const owned of [this.policy, this.aliases, this.components])
        try {
          owned?.close();
        } catch {
          this.closeFailed = true;
        }
    }
    KataSandboxError.require(!this.closeFailed, 'KATA_NATIVE_POLICY_CLOSE_FAILED');
  }
}
