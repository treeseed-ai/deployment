import assert from 'node:assert/strict';
import { test } from 'bun:test';
import * as Hypervisor from '../../src/kata-hypervisor.js';
interface MachineProjection {
  parse(args: readonly string[]): object;
}
class NativeMachineCases {
  private parser(): MachineProjection {
    const Constructor = Reflect.get(Hypervisor, 'NativeLaunchMachine');
    assert.equal(typeof Constructor, 'function', 'Native launch machine projection missing');
    return new Constructor() as MachineProjection;
  }
  accepted(value: string): void {
    const machine = this.parser().parse(['-machine', value]);
    assert.deepEqual(machine, { type: 'q35', accelerator: 'kvm' });
    assert(Object.isFrozen(machine));
  }
  rejected(args: string[]): void {
    const parser = this.parser();
    assert.throws(parser.parse.bind(parser, args), { message: 'KATA_LAUNCH_MACHINE_INVALID' });
  }
}
const suite = new NativeMachineCases();
for (const value of [
  'q35,accel=kvm,nvdimm=on,kernel_irqchip=on',
  'q35,nvdimm=on,memory-backend=entire-guest-memory,kernel_irqchip=on,accel=kvm',
])
  test(
    'unit: native launch machine accepts exact unambiguous KVM selection ' + value,
    suite.accepted.bind(suite, value),
  );
for (const args of [
  [],
  ['-machine'],
  ['-machine', 'q35'],
  ['-machine', 'q35,accel=tcg,nvdimm=on,kernel_irqchip=on'],
  ['-machine', 'q35,accel=kvm:tcg,nvdimm=on,kernel_irqchip=on'],
  ['-machine', 'q35,accel=kvm,nvdimm=off,kernel_irqchip=on'],
  ['-machine', 'q35,accel=kvm,nvdimm=on,kernel_irqchip=off'],
  ['-machine', 'pc,accel=kvm,nvdimm=on,kernel_irqchip=on'],
  ['-machine', 'q35,accel=kvm,accel=tcg,nvdimm=on,kernel_irqchip=on'],
  ['-machine', 'q35,accel=kvm,nvdimm=on,kernel_irqchip=on,unexpected=on'],
  ['-machine', 'q35,accel=kvm,nvdimm=on,kernel_irqchip=on', '-accel', 'tcg'],
  ['-machine', 'q35,accel=kvm,nvdimm=on,kernel_irqchip=on', '-M', 'q35'],
  ['-machine', 'q35,accel=kvm,nvdimm=on,kernel_irqchip=on', '-machine', 'q35'],
  ['-machine', 'q35,accel=kvm,nvdimm=on,kernel_irqchip=on', '--machine', 'q35,accel=tcg'],
  ['-machine', 'q35,accel=kvm,nvdimm=on,kernel_irqchip=on', '--M', 'q35,accel=tcg'],
  ['-machine', 'q35,accel=kvm,nvdimm=on,kernel_irqchip=on', '--accel', 'tcg'],
  ['-machine', 'q35,accel=kvm,nvdimm=on,kernel_irqchip=on', '--kernel', '/OTHER_KERNEL'],
  ['-machine', 'q35,accel=kvm,nvdimm=on,kernel_irqchip=on', '--m', '4096'],
  ['-machine', 'q35,accel=kvm,nvdimm=on,kernel_irqchip=on', '--smp', '8'],
])
  test(
    'unit: native launch machine rejects ambiguous or unsupported selection ' +
      JSON.stringify(args),
    suite.rejected.bind(suite, args),
  );
