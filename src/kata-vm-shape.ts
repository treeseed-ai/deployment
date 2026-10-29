/** Observed QEMU startup configuration, not live hotplug or reserved host resources. */
export interface SandboxVmStartupShape {
  readonly vcpus: number;
  readonly maximumVcpus: number;
  readonly memoryMiB: number;
  readonly maximumMemoryMiB: number;
}
export class QemuStartupShape {
  parse(args: readonly string[]): SandboxVmStartupShape {
    try {
      const cpu = this.cpu(this.argument(args, '-smp'));
      const memory = this.fields(this.argument(args, '-m'), 'size', ['size', 'slots', 'maxmem']);
      if (memory.has('slots')) this.integer(memory.get('slots')!);
      const vcpus = this.integer(cpu.get('cpus')!);
      const maximumVcpus = this.integer(cpu.get('maxcpus') ?? cpu.get('cpus')!);
      const memoryMiB = this.memory(memory.get('size')!);
      const maximumMemoryMiB = this.memory(memory.get('maxmem') ?? memory.get('size')!);
      if (maximumVcpus < vcpus || maximumMemoryMiB < memoryMiB) throw new Error();
      return Object.freeze({ vcpus, maximumVcpus, memoryMiB, maximumMemoryMiB });
    } catch {
      throw new Error('SANDBOX_VM_SHAPE_UNVERIFIED');
    }
  }
  private cpu(argument: string): Map<string, string> {
    const allowed = [
      'cpus',
      'maxcpus',
      'sockets',
      'dies',
      'clusters',
      'modules',
      'cores',
      'threads',
    ];
    const fields = this.fields(argument, 'cpus', allowed);
    for (const value of fields.values()) this.integer(value);
    return fields;
  }
  private argument(args: readonly string[], flag: string): string {
    const position = args.indexOf(flag);
    if (position < 0 || args.lastIndexOf(flag) !== position) throw new Error();
    const value = args[position + 1];
    if (!value || value.length > 1024) throw new Error();
    return value;
  }
  private fields(value: string, primary: string, allowed: readonly string[]): Map<string, string> {
    const result = new Map<string, string>();
    for (const [index, entry] of value.split(',').entries()) {
      const parts = entry.split('=');
      const key = parts.length === 1 && index === 0 ? primary : parts[0]!;
      const field = parts.length === 1 && index === 0 ? parts[0]! : parts[1];
      if (parts.length > 2 || !field || !allowed.includes(key) || result.has(key))
        throw new Error();
      result.set(key, field);
    }
    if (!result.has(primary)) throw new Error();
    return result;
  }
  private integer(value: string): number {
    if (!/^[1-9][0-9]*$/.test(value)) throw new Error();
    const result = Number(value);
    if (!Number.isSafeInteger(result)) throw new Error();
    return result;
  }
  private memory(value: string): number {
    const match = /^([1-9][0-9]*)([KMGT]?)$/.exec(value);
    if (!match) throw new Error();
    const units: Record<string, number> = { '': 1, K: 1 / 1024, M: 1, G: 1024, T: 1048576 };
    const result = this.integer(match[1]!) * units[match[2]!]!;
    if (!Number.isSafeInteger(result) || result < 1) throw new Error();
    return result;
  }
}
