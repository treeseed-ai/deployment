import { appendFileSync, readFileSync, existsSync } from 'node:fs';
/** External command peer; no daemon, container or owner adapter substitution. */
class DockerReadinessPeer {
  static async main(): Promise<void> {
    const file = process.env.CORDIS_READINESS_RECORD!;
    const previous = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').length : 0;
    appendFileSync(file, JSON.stringify(process.argv.slice(2)) + '\n', { mode: 0o600 });
    process.stdout.write('PRIVATE_DOCKER_STDOUT_CANARY\n');
    process.stderr.write('PRIVATE_DOCKER_STDERR_CANARY\n');
    const mode = process.env.CORDIS_READINESS_MODE;
    if (mode === 'failure') process.exitCode = 7;
    if ((mode === 'preparation' && previous === 0) || (mode === 'unresponsive' && previous === 1))
      await new Promise<void>(this.delay.bind(this));
  }
  private static delay(resolve: () => void): void {
    setTimeout(resolve, 6000);
  }
}
await DockerReadinessPeer.main();
