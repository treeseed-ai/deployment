import { spawn } from 'node:child_process';

/** Bounded Docker invocation. Never relay container logs or rendered secrets. */
export function postgresDocker(arguments_: string[], timeoutSeconds: number, capture = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/docker', arguments_, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } });
    let output = '', bytes = 0, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutSeconds * 1000);
    child.stdout.on('data', (chunk: Buffer) => {
      if (!capture) return;
      bytes += chunk.length;
      if (bytes > 1_048_576) { timedOut = true; child.kill('SIGKILL'); return; }
      output += chunk.toString('utf8');
    });
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); reject(new Error('PostgreSQL container operation could not start')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut || code !== 0) reject(new Error('PostgreSQL container operation failed or exceeded its bound'));
      else resolve(output);
    });
  });
}
