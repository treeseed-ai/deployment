import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { DevelopmentSessionStore } from '../manager/development-sessions.js';
import { developmentBackupDependencies, developmentBackupRuntimeHeld, developmentBackupStatus } from './development-backup.js';
import { postgresDocker } from './postgres-process.js';
import { recordEvent } from '../core/events.js';

/** Existing API development custody replaces its released writer, including during recovery. */
export function postgresDevelopmentReplacements(componentId: string) {
  if (componentId !== 'api') return [];
  return new DevelopmentSessionStore().list().filter(record => record.session.status === 'active').flatMap(record =>
    record.session.targets.filter(target => target.projectId === 'api' && target.mode !== 'released'
      && ['service', 'operations-runner'].includes(target.targetId)).map(target => ({
      service: target.targetId === 'service' ? 'api' : 'operations-runner', sessionId: record.session.sessionId,
      targetId: target.targetId, name: `treeseed-${record.session.sessionId}-api-${target.targetId}`,
    })));
}

type Replacement = ReturnType<typeof postgresDevelopmentReplacements>[number];
function runtimeSnapshot(replacement: Replacement) {
  const path = `/run/treeseed/development-containers/${replacement.sessionId}/${replacement.targetId}/compose.json`;
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022) || realpathSync(path) !== path)
    throw new Error('PostgreSQL development runtime lacks exact root custody');
  const spec = JSON.parse(readFileSync(path, 'utf8'));
  if (!/^sha256:[a-f0-9]{64}$/u.test(spec.services?.runtime?.image ?? '') || spec.services.runtime.container_name !== replacement.name)
    throw new Error('PostgreSQL development runtime snapshot is invalid');
  return { path, spec };
}

/** Recovery rematerializes credential mounts; recreate only the API, never the held writer. */
export async function startPostgresDevelopmentRuntime(replacement: Replacement) {
  if (replacement.targetId === 'operations-runner') {
    const deps = developmentBackupDependencies((executable, args) => execFileSync(executable, [...args],
      { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }));
    const hold = developmentBackupStatus(deps);
    if (hold && hold.phase !== 'restored') throw new Error('PostgreSQL development writer recovery is not ready');
    if (hold?.targets) {
      if (!developmentBackupRuntimeHeld(deps, replacement.sessionId)) throw new Error('PostgreSQL development writer is not covered by the held backup');
      return;
    }
  }
  const { path } = runtimeSnapshot(replacement);
  await postgresDocker(['compose', '--project-name', replacement.name, '--file', path,
    'up', '--detach', '--force-recreate', '--no-deps', '--wait', '--wait-timeout', '120', 'runtime'], 130);
}

export async function postgresDevelopmentRuntimeHealthy(replacement: Replacement) {
  const { spec } = runtimeSnapshot(replacement);
  const held = replacement.targetId === 'operations-runner' && developmentBackupRuntimeHeld(
    developmentBackupDependencies((executable, args) => execFileSync(executable, [...args],
      { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] })), replacement.sessionId);
  if (held) {
    const inventory = (await postgresDocker(['ps', '--all', '--filter', `name=^/${replacement.name}$`, '--format', '{{.ID}}'], 10, true)).trim();
    if (!inventory) return true; // Exact restored custody can recreate the fenced writer at finish.
    if (!/^[a-f0-9]{12,64}$/u.test(inventory)) throw new Error('PostgreSQL development writer inventory is invalid');
  }
  const observed = JSON.parse(await postgresDocker(['inspect', '--format',
    '{"image":{{json .Image}},"state":{{json .State.Status}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}"none"{{end}}}', replacement.name], 10, true));
  recordEvent('postgres.development.runtime-status', { sessionId: replacement.sessionId, targetId: replacement.targetId,
    imageMatches: observed.image === spec.services.runtime.image,
    state: ['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead'].includes(observed.state) ? observed.state : 'unknown',
    health: ['healthy', 'unhealthy', 'starting', 'none'].includes(observed.health) ? observed.health : 'unknown' });
  if (observed.image !== spec.services.runtime.image) return false;
  if (observed.state === 'running' && observed.health === 'healthy') return true;
  if (replacement.targetId !== 'operations-runner' || observed.state === 'running') return false;
  return held;
}
