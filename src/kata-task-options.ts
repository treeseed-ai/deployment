import { z } from 'zod';
import { KataSandboxError } from './kata-command.js';

/** Pure operator-selection invariant; no file access, lifecycle or tenant-controlled options. */
export class KataTaskOptions {
  private static readonly options = z.strictObject({
    type_url: z.literal('runtimeoptions.v1.Options'),
    value: z.string(),
  });
  constructor(
    private readonly mode: 'environment' | 'task-options',
    private readonly path: string,
  ) {}
  arguments(): string[] {
    return this.mode === 'task-options' ? ['--runtime-config-path', this.path] : [];
  }
  assertEnvironment(values: readonly string[]): void {
    const selected = values.filter(KataTaskOptions.override);
    const expected = this.mode === 'environment' ? ['KATA_CONF_FILE=' + this.path] : [];
    KataSandboxError.require(
      selected.length === expected.length && selected[0] === expected[0],
      'KATA_RUNTIME_CONFIGURATION',
    );
  }
  private static override(value: string): boolean {
    return value.startsWith('KATA_CONF_FILE=');
  }
  assertOptions(value: unknown): void {
    if (this.mode === 'environment') {
      KataSandboxError.require(value === null || value === undefined, 'KATA_RESOURCE_CHANGED');
      return;
    }
    const result = KataTaskOptions.options.safeParse(value);
    KataSandboxError.require(
      result.success && result.data.value === this.encoded(),
      'KATA_RESOURCE_CHANGED',
    );
  }
  private encoded(): string {
    const bytes = Buffer.from(this.path, 'utf8');
    return Buffer.concat([Buffer.from([0x12]), this.length(bytes.length), bytes]).toString(
      'base64',
    );
  }
  private length(value: number): Buffer {
    const bytes = [];
    do {
      const field = value & 0x7f;
      value = Math.floor(value / 128);
      bytes.push(value ? field | 0x80 : field);
    } while (value);
    return Buffer.from(bytes);
  }
}
