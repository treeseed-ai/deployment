import type { CommandRunner } from './compose-runtime.js';

const name = 'treeseed-api-operations-runner-1';

/** Preserve the installed runner's state identity without changing host permissions. */
export function releasedRunnerIdentity(command: CommandRunner): { uid: number; gid: number } {
  const state = JSON.parse(String(command('/usr/bin/docker', ['inspect', name, '--format', '{"Config":{"User":{{json .Config.User}},"Labels":{{json .Config.Labels}}},"State":{"Running":{{json .State.Running}}}}'])));
  if (state.Config?.Labels?.['com.docker.compose.project'] !== 'treeseed-api' || state.Config?.Labels?.['com.docker.compose.service'] !== 'operations-runner')
    throw new Error('Released runner ownership does not match the managed API.');
  const user = state.Config.User || '0:0';
  if (!/^\d+:\d+$/.test(user)) throw new Error('Released runner must declare an exact numeric UID:GID for candidate state custody.');
  const [uid, gid] = user.split(':').map(Number);
  if (![uid, gid].every(value => Number.isSafeInteger(value) && value >= 0 && value < 4_294_967_295))
    throw new Error('Released runner identity is out of range.');
  return { uid, gid };
}

/** Fixed managed runner only; never force-kill work to enter development. */
export function drainReleasedRunner(command: CommandRunner): boolean {
  const found = String(command('/usr/bin/docker', ['ps', '--all', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'])).trim();
  if (!found) return false;
  const state = JSON.parse(String(command('/usr/bin/docker', ['inspect', name, '--format', '{"Config":{"Labels":{{json .Config.Labels}}},"State":{"Running":{{json .State.Running}}}}'])));
  if (state.Config?.Labels?.['com.docker.compose.project'] !== 'treeseed-api' || state.Config?.Labels?.['com.docker.compose.service'] !== 'operations-runner')
    throw new Error('Released runner ownership does not match the managed API.');
  if (!state.State?.Running) return false;
  command('/usr/bin/docker', ['kill', '--signal', 'SIGTERM', name]);
  try {
    const exitCode = String(command('/usr/bin/docker', ['wait', name])).trim();
    if (exitCode !== '0') throw new Error('Released runner did not drain cleanly.');
  } catch {
    // A rejected handoff must not leave the released service stopped. Docker
    // start is idempotent for a still-running container; it never interrupts it.
    // The exact identity was validated before signalling and no candidate exists.
    try { restoreReleasedRunner(command); }
    catch { throw new Error('Released runner drain failed and restoration failed; candidate was not started. Restore managed runner health before retrying.'); }
    throw new Error('Released runner drain is incomplete; candidate was not started. Inspect runner health before retrying.');
  }
  return true;
}

export function restoreReleasedRunner(command: CommandRunner) {
  command('/usr/bin/docker', ['start', name]);
}

export function drainCandidateRunner(command: CommandRunner, sessionId: string) {
  if (!/^dev-[a-z0-9-]{1,64}$/.test(sessionId)) throw new Error('Invalid runner session.');
  const candidate = `treeseed-${sessionId}-api-operations-runner`;
  const found = String(command('/usr/bin/docker', ['ps', '--all', '--filter', `name=^/${candidate}$`, '--format', '{{.Names}}'])).trim();
  if (!found) return;
  const state = JSON.parse(String(command('/usr/bin/docker', ['inspect', candidate, '--format', '{{json .}}'])));
  if (state.Config?.Labels?.['org.treeseed.development.session'] !== sessionId || state.Config?.Labels?.['org.treeseed.development.target'] !== 'api.operations-runner')
    throw new Error('Candidate runner ownership does not match the session.');
  if (!state.State?.Running) return;
  command('/usr/bin/docker', ['kill', '--signal', 'SIGTERM', candidate]);
  if (String(command('/usr/bin/docker', ['wait', candidate])).trim() !== '0')
    throw new Error('Candidate runner did not drain cleanly; retain its state for recovery.');
}
