import { constants, fstatSync, lstatSync } from 'node:fs';
import { open, link, unlink, type FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { SafeDirectory, PlanningFailure as Check } from './filesystem.js';

/** One immutable member; its caller retains the anchored directory until settlement. */
class ArchiveMemberPublication {
  private readonly temporary = '.tmp-' + randomUUID();
  private file: FileHandle | null = null;
  private parent: FileHandle | null = null;
  private created = false;
  constructor(
    private readonly directory: SafeDirectory,
    private readonly name: string,
    private readonly bytes: Buffer,
    private readonly admitted: () => void,
  ) {}
  async run(): Promise<void> {
    try {
      this.verify();
      await this.open();
      await this.write();
      await this.publish();
      this.verify();
      Check.require(
        this.directory.file(this.name, undefined, 8 * 1024 * 1024, true).equals(this.bytes),
        'ARTIFACT_INTEGRITY',
      );
    } finally {
      await this.close();
    }
  }
  private verify(): void {
    this.admitted();
    this.directory.verify();
    SafeDirectory.owner(fstatSync(this.directory.fd), true);
  }
  private async open(): Promise<void> {
    this.parent = await open(
      '/proc/self/fd/' + this.directory.fd,
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    this.verify();
    this.file = await open(
      this.directory.childPath(this.temporary),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    this.created = true;
    this.verify();
    this.identity(1);
  }
  private async write(): Promise<void> {
    await this.file!.writeFile(this.bytes);
    this.verify();
    await this.file!.sync();
    this.verify();
    this.identity(1, this.bytes.length);
  }
  private identity(links: number, size?: number): void {
    const actual = fstatSync(this.file!.fd),
      linked = lstatSync(this.directory.childPath(this.temporary));
    SafeDirectory.owner(actual, true);
    Check.require(
      actual.isFile() &&
        actual.nlink === links &&
        linked.isFile() &&
        actual.dev === linked.dev &&
        actual.ino === linked.ino,
      'FILE_CHANGED',
    );
    if (size !== undefined) Check.require(actual.size === size, 'FILE_CHANGED');
  }
  private async publish(): Promise<void> {
    this.verify();
    await link(this.directory.childPath(this.temporary), this.directory.childPath(this.name));
    this.verify();
    this.identity(2, this.bytes.length);
    await this.parent!.sync();
    this.verify();
    this.identity(2, this.bytes.length);
    await unlink(this.directory.childPath(this.temporary));
    this.created = false;
    const actual = fstatSync(this.file!.fd),
      linked = lstatSync(this.directory.childPath(this.name));
    Check.require(
      actual.nlink === 1 &&
        linked.isFile() &&
        linked.dev === actual.dev &&
        linked.ino === actual.ino,
      'FILE_CHANGED',
    );
  }
  private async close(): Promise<void> {
    try {
      if (this.created) {
        const actual = fstatSync(this.file!.fd),
          linked = lstatSync(this.directory.childPath(this.temporary));
        Check.require(
          linked.isFile() && linked.dev === actual.dev && linked.ino === actual.ino,
          'FILE_CHANGED',
        );
        await unlink(this.directory.childPath(this.temporary));
      }
    } finally {
      try {
        await this.file?.close();
      } finally {
        await this.parent?.close();
      }
    }
  }
}

/** Bounded distinct-member I/O; stopped jobs settle before their caller releases custody. */
export class ArchivePublicationQueue {
  private readonly jobs = new Set<Promise<void>>();
  private reserved = 0;
  private stopped = false;
  constructor(private readonly failure: () => void) {}
  check(): void {
    Check.require(!this.stopped, 'INVALID_ARCHIVE');
  }
  async available(): Promise<void> {
    while (this.reserved >= 8) await Promise.race(this.jobs);
    this.check();
    this.reserved++;
  }
  release(): void {
    this.reserved--;
  }
  publish(directory: SafeDirectory, name: string, bytes: Buffer, release: boolean): Promise<void> {
    this.check();
    Check.require(this.jobs.size < 8, 'PROVIDER_CLOSURE');
    const job = this.member(directory, name, bytes, release).catch(this.failed.bind(this));
    this.jobs.add(job);
    return this.retain(job);
  }
  private async member(
    directory: SafeDirectory,
    name: string,
    bytes: Buffer,
    release: boolean,
  ): Promise<void> {
    try {
      await new ArchiveMemberPublication(directory, name, bytes, this.check.bind(this)).run();
    } finally {
      if (release) directory.close();
    }
  }
  private async retain(job: Promise<void>): Promise<void> {
    try {
      await job;
    } finally {
      this.jobs.delete(job);
      this.release();
    }
  }
  private failed(): void {
    this.stop();
    this.failure();
  }
  stop(): void {
    this.stopped = true;
  }
  async drain(): Promise<void> {
    while (this.jobs.size) await Promise.all(this.jobs);
  }
}
