import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { statSync, accessSync, constants } from 'node:fs';
import { resolve } from 'node:path';
import type { DiagnosticCommands } from './diagnose.js';
export interface DockerCommandFailure {
  readonly category: 'context' | 'engine' | 'compose' | 'other';
  readonly kind:
    | 'missing-executable'
    | 'timeout'
    | 'output-limit'
    | 'spawn-failed'
    | 'nonzero-exit';
  readonly elapsedMs: number;
  readonly status: number | null;
  readonly signal: 'SIGTERM' | 'SIGKILL' | null;
}
export class DockerCommands implements DiagnosticCommands {
  private latest: Readonly<DockerCommandFailure> | null = null;
  get failure(): Readonly<DockerCommandFailure> | null {
    return this.latest;
  }
  execute(args: string[]): string | null {
    this.latest = null;
    const started = performance.now();
    const executable = this.executable();
    if (!executable) {
      this.latest = this.evidence(args, null, performance.now() - started);
      return null;
    }
    const result = this.invoke(executable, args);
    if (result.error || result.status !== 0) {
      this.latest = this.evidence(args, result, performance.now() - started);
      return null;
    }
    return result.stdout.trim();
  }
  private invoke(executable: string, args: string[]): SpawnSyncReturns<string> {
    return spawnSync(executable, args, {
      env: { ...process.env },
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  private evidence(
    args: string[],
    result: SpawnSyncReturns<string> | null,
    elapsed: number,
  ): Readonly<DockerCommandFailure> {
    const status = result?.status;
    const signal = result?.signal;
    return Object.freeze({
      category: this.category(args),
      kind: this.kind(result),
      elapsedMs: Math.max(0, Math.round(elapsed)),
      status:
        typeof status === 'number' && Number.isInteger(status) && status >= 0 && status <= 255
          ? status
          : null,
      signal: signal === 'SIGTERM' || signal === 'SIGKILL' ? signal : null,
    });
  }
  private category(args: string[]): DockerCommandFailure['category'] {
    if (args[0] === 'context' && args[1] === 'inspect') return 'context';
    if (args[0] === '--context' && args[2] === 'info') return 'engine';
    if (args[0] === '--context' && args[2] === 'compose' && args[3] === 'version') return 'compose';
    return 'other';
  }
  private kind(result: SpawnSyncReturns<string> | null): DockerCommandFailure['kind'] {
    if (!result) return 'missing-executable';
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ETIMEDOUT') return 'timeout';
    if (code === 'ENOBUFS') return 'output-limit';
    return result.error ? 'spawn-failed' : 'nonzero-exit';
  }
  private executable(): string | null {
    for (const directory of (process.env.PATH ?? '').split(':')) {
      if (!directory) continue;
      const file = resolve(directory, 'docker');
      try {
        if (statSync(file).isFile()) {
          accessSync(file, constants.X_OK);
          return file;
        }
      } catch {}
    }
    return null;
  }
}
