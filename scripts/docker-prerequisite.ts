import { spawnSync } from 'node:child_process';
/** CI preparation only; production commands retain their existing five-second bound. */
export class DockerPrerequisite {
  private static readonly arguments = ['--context', 'default', 'info', '--format', '{{json .}}'];
  static main(): void {
    if (!this.observe(30000) || !this.observe(5000)) {
      process.stderr.write('DOCKER_PREREQUISITE_UNREADY\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write('DOCKER_PREREQUISITE_QUALIFIED\n');
  }
  private static observe(timeout: number): boolean {
    const result = spawnSync('docker', this.arguments, {
      timeout,
      killSignal: 'SIGKILL',
      stdio: 'ignore',
    });
    return result.status === 0 && result.signal === null && result.error === undefined;
  }
}
if (import.meta.main) DockerPrerequisite.main();
