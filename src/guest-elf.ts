import { KataSandboxError } from './kata-command.js';
interface ElfSegment {
  type: number;
  flags: number;
  offset: number;
  address: number;
  size: number;
}
interface ElfRequirements {
  interpreter: string;
  requiredLibraries: string[];
}
/** Structural ELF admission only; never executes the file or resolves host libraries. */
export class GuestRuntimeElf {
  private static readonly tags = new Set([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 20, 21, 23, 25, 26, 27, 28, 0x6ffffef5, 0x6ffffff0,
    0x6ffffffc, 0x6ffffffd, 0x6ffffffe, 0x6fffffff,
  ]);
  private readonly segments: ElfSegment[] = [];
  static verify(bytes: Buffer, required: ElfRequirements): void {
    const image = new GuestRuntimeElf(bytes);
    KataSandboxError.require(
      image.interpreter() === required.interpreter,
      'KATA_GUEST_ARTIFACT_INVALID',
    );
    const actual = JSON.stringify(image.libraries().sort());
    KataSandboxError.require(
      actual === JSON.stringify([...required.requiredLibraries].sort()),
      'KATA_GUEST_ARTIFACT_INVALID',
    );
  }
  private constructor(private readonly bytes: Buffer) {
    this.header();
    const offset = this.number(bytes.readBigUInt64LE(32));
    const count = bytes.readUInt16LE(56);
    this.demand(count > 0 && count <= 128 && offset >= 64);
    this.range(offset, count * 56);
    for (let index = 0; index < count; index++)
      this.segments.push(this.segment(offset + index * 56));
    this.entrypoint();
  }
  private demand(value: unknown): asserts value {
    KataSandboxError.require(value, 'KATA_GUEST_ARTIFACT_INVALID');
  }
  private header(): void {
    this.demand(this.bytes.length >= 64 && this.bytes.length <= 128 * 1024 * 1024);
    this.demand(this.bytes.subarray(0, 7).equals(Buffer.from([127, 69, 76, 70, 2, 1, 1])));
    this.demand([2, 3].includes(this.bytes.readUInt16LE(16)));
    this.demand(this.bytes.readUInt16LE(18) === 62 && this.bytes.readUInt32LE(20) === 1);
    this.demand(this.bytes.readUInt16LE(52) === 64 && this.bytes.readUInt16LE(54) === 56);
  }
  private number(value: bigint): number {
    this.demand(value >= 0 && value <= BigInt(Number.MAX_SAFE_INTEGER));
    return Number(value);
  }
  private range(offset: number, size: number): Buffer {
    this.demand(Number.isSafeInteger(offset) && Number.isSafeInteger(size));
    this.demand(offset >= 0 && size >= 0 && offset <= this.bytes.length - size);
    return this.bytes.subarray(offset, offset + size);
  }
  private segment(offset: number): ElfSegment {
    const header = this.range(offset, 56);
    const value = {
      type: header.readUInt32LE(0),
      flags: header.readUInt32LE(4),
      offset: this.number(header.readBigUInt64LE(8)),
      address: this.number(header.readBigUInt64LE(16)),
      size: this.number(header.readBigUInt64LE(32)),
    };
    this.range(value.offset, value.size);
    if (value.type === 1) this.demand(BigInt(value.size) <= header.readBigUInt64LE(40));
    return value;
  }
  private entrypoint(): void {
    const entry = this.number(this.bytes.readBigUInt64LE(24));
    let matches = 0;
    for (const segment of this.segments)
      if (
        segment.type === 1 &&
        (segment.flags & 1) !== 0 &&
        entry >= segment.address &&
        entry - segment.address < segment.size
      )
        matches++;
    this.demand(matches === 1);
  }
  private selected(type: number): ElfSegment {
    let found: ElfSegment | null = null;
    for (const segment of this.segments) {
      if (segment.type !== type) continue;
      this.demand(found === null);
      found = segment;
    }
    this.demand(found !== null);
    return found;
  }
  private interpreter(): string {
    const segment = this.selected(3);
    this.demand(segment.size > 1 && segment.size <= 256);
    const bytes = this.range(segment.offset, segment.size);
    const end = bytes.indexOf(0);
    this.demand(end === bytes.length - 1);
    return bytes.subarray(0, end).toString('utf8');
  }
  private dynamic(): Map<number, number[]> {
    const segment = this.selected(2);
    this.demand(segment.size > 0 && segment.size <= 65536 && segment.size % 16 === 0);
    const bytes = this.range(segment.offset, segment.size);
    const values = new Map<number, number[]>();
    for (let offset = 0; offset < bytes.length; offset += 16) {
      const tag = this.number(bytes.readBigUInt64LE(offset));
      if (tag === 0) return values;
      this.demand(GuestRuntimeElf.tags.has(tag));
      const entries = values.get(tag) ?? [];
      entries.push(this.number(bytes.readBigUInt64LE(offset + 8)));
      values.set(tag, entries);
    }
    throw new KataSandboxError('KATA_GUEST_ARTIFACT_INVALID');
  }
  private mapped(address: number, size: number): Buffer {
    let offset: number | null = null;
    for (const segment of this.segments) {
      const delta = address - segment.address;
      if (segment.type !== 1 || delta < 0 || delta > segment.size - size) continue;
      this.demand(offset === null);
      offset = segment.offset + delta;
    }
    this.demand(offset !== null);
    return this.range(offset, size);
  }
  private libraries(): string[] {
    const values = this.dynamic();
    this.demand(values.get(5)?.length === 1 && values.get(10)?.length === 1);
    const size = values.get(10)![0]!;
    this.demand(size > 0 && size <= 1024 * 1024);
    const table = this.mapped(values.get(5)![0]!, size);
    const result = [];
    for (const offset of values.get(1) ?? []) result.push(this.library(table, offset));
    this.demand(result.length === 5 && new Set(result).size === result.length);
    return result;
  }
  private library(table: Buffer, offset: number): string {
    const end = table.indexOf(0, offset);
    this.demand(offset >= 0 && offset < table.length && end > offset && end - offset <= 256);
    const name = table.subarray(offset, end).toString('utf8');
    this.demand(/^[a-zA-Z0-9._+-]+$/.test(name));
    return name;
  }
}
