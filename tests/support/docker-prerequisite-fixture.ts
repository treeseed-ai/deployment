import { DockerCommands } from '@treeseed-cordis/deployment';
import { SafeDirectory, StrictJson } from '../../src/filesystem.js';
import { dirname, basename, isAbsolute } from 'node:path';
/** Read-only fixture diagnostics after failure, never a retry or a production error surface. */
export class DockerPrerequisiteFixture {
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
