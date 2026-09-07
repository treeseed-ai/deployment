import type { CommandRunner } from './compose-runtime.js';

const name = 'treeseed-api-operations-runner-1';

/** Fixed managed runner only; never force-kill work to enter development. */
export function drainReleasedRunner(command: CommandRunner): boolean {
  const found = String(command('/usr/bin/docker', ['ps', '--all', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'])).trim();
  if (!found) return false;
  const state = JSON.parse(String(command('/usr/bin/docker', ['inspect', name, '--format', '{{json .}}'])));
  if (state.Config?.Labels?.['com.docker.compose.project'] !== 'treeseed-api' || state.Config?.Labels?.['com.docker.compose.service'] !== 'operations-runner')
    throw new Error('Released runner ownership does not match the managed API.');
  if (!state.State?.Running) return false;
  command('/usr/bin/docker', ['kill', '--signal', 'SIGTERM', name]);
  try {
    const exitCode = String(command('/usr/bin/docker', ['wait', name])).trim();
    if (exitCode !== '0') throw new Error('Released runner did not drain cleanly.');
  } catch {
    throw new Error('Released runner drain is incomplete; candidate was not started. Inspect runner health before retrying.');
  }
  return true;
}

export function restoreReleasedRunner(command: CommandRunner) {
  command('/usr/bin/docker', ['start', name]);
}
