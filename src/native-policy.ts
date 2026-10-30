import { resolve } from 'node:path';
import { z } from 'zod';
import type { PoolResourceShape } from '@treeseed-cordis/sdk';
import { RuntimeComponentCustody, type RuntimeComponentBinding } from './runtime-components.js';
import { KataSandboxError } from './kata-command.js';

interface NativePolicyConfiguration {
  runtime: {
    configurationMode?: 'environment' | 'task-options';
    policy?: { components: RuntimeComponentBinding[] };
    archive?: unknown;
    shim: { path: string };
    hypervisor: { path: string };
  };
  resources?: PoolResourceShape;
}
/** Host-owned descriptor admission; native Cordis owns provider selection and lifecycle. */
export class NativePolicyCustody {
  static readonly Config = z.strictObject({ components: RuntimeComponentCustody.Config });
  private static readonly roles = 'configuration,hypervisor,kernel,rootfs,shim,virtiofs';
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
    if (roles.sort().join(',') !== this.roles) throw new Error();
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
}
