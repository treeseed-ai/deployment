import { PlanningBlockedError } from '@treeseed-cordis/sdk';
import { DockerCommands } from '@treeseed-cordis/deployment';
import { SafeDirectory, StrictJson } from '../../src/filesystem.js';
import { dirname, basename, isAbsolute } from 'node:path';
/** Read-only fixture diagnostics after failure, never a retry or a production error surface. */
export class DockerPrerequisiteFixture {
  static failed(error: unknown, inputFile?: string): never {
    if (!(error instanceof PlanningBlockedError)) throw error;
    const codes = error.blockers.map(this.code).join(',');
    const readback = inputFile === undefined ? '' : ' ' + this.report(inputFile);
    throw new Error(codes + readback + ' ' + this.invocation(error));
  }
  private static code(blocker: { code: string }): string {
    return /^[A-Z][A-Z0-9_]{0,62}$/.test(blocker.code) ? blocker.code : 'INVALID_SOURCE_BLOCKER';
  }
  private static readonly failureCategories = ['context', 'engine', 'compose', 'other'];
  private static readonly failureKinds = [
    'missing-executable',
    'timeout',
    'output-limit',
    'spawn-failed',
    'nonzero-exit',
  ];
  private static invocation(error: Error): string {
    try {
      const cause = Object.getOwnPropertyDescriptor(error, 'cause')?.value;
      if (!cause || typeof cause !== 'object') return 'docker-invocation(unavailable)';
      const category = Object.getOwnPropertyDescriptor(cause, 'category')?.value;
      const kind = Object.getOwnPropertyDescriptor(cause, 'kind')?.value;
      if (typeof category !== 'string' || !this.failureCategories.includes(category))
        return 'docker-invocation(unavailable)';
      if (typeof kind !== 'string' || !this.failureKinds.includes(kind))
        return 'docker-invocation(unavailable)';
      return 'docker-invocation(' + category + ':' + kind + ')';
    } catch {
      return 'docker-invocation(unavailable)';
    }
  }
  static report(file: string): string {
    const context = this.context(file);
    if (context === null) return 'docker-readback(context:unavailable)';
    const commands = new DockerCommands();
    const queries: [string, string[]][] = [
      ['context', ['context', 'inspect', context, '--format', '{{json .Endpoints.docker.Host}}']],
      ['engine', ['--context', context, 'info', '--format', '{{json .}}']],
      ['compose', ['--context', context, 'compose', 'version', '--format', 'json']],
    ];
    const results = [];
    for (const [category, args] of queries) results.push(this.sample(commands, category, args));
    return 'docker-readback(' + results.join(',') + ')';
  }
  private static context(file: string): string | null {
    let directory: SafeDirectory | null = null;
    try {
      if (!isAbsolute(file)) return null;
      directory = SafeDirectory.open(dirname(file));
      const input = StrictJson.object(
        StrictJson.parse(directory.file(basename(file), undefined, 1024 * 1024)),
      );
      const value = StrictJson.object(input.configuration).engineContext;
      return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)
        ? value
        : null;
    } catch {
      return null;
    } finally {
      directory?.close();
    }
  }
  private static sample(commands: DockerCommands, category: string, args: string[]): string {
    const started = performance.now();
    let status = 'unavailable';
    try {
      if (commands.execute(args) !== null) status = 'available';
    } catch {}
    return category + ':' + status + ':' + Math.round(performance.now() - started) + 'ms';
  }
}
