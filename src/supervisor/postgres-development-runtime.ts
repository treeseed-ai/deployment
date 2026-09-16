import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { DevelopmentSessionStore } from '../manager/development-sessions.js';
import { developmentBackupDependencies, developmentBackupRuntimeHeld } from './development-backup.js';
import { postgresDocker } from './postgres-process.js';

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

export async function postgresDevelopmentRuntimeHealthy(replacement: ReturnType<typeof postgresDevelopmentReplacements>[number]) {
  const path = `/run/treeseed/development-containers/${replacement.sessionId}/${replacement.targetId}/compose.json`;
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022) || realpathSync(path) !== path)
    throw new Error('PostgreSQL development runtime lacks exact root custody');
  const spec = JSON.parse(readFileSync(path, 'utf8'));
  if (!/^sha256:[a-f0-9]{64}$/u.test(spec.services?.runtime?.image ?? '') || spec.services.runtime.container_name !== replacement.name)
    throw new Error('PostgreSQL development runtime snapshot is invalid');
  const observed = JSON.parse(await postgresDocker(['inspect', '--format',
    '{"image":{{json .Image}},"state":{{json .State.Status}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}"none"{{end}}}', replacement.name], 10, true));
  if (observed.image !== spec.services.runtime.image) return false;
  if (observed.state === 'running' && observed.health === 'healthy') return true;
  if (replacement.targetId !== 'operations-runner' || observed.state === 'running') return false;
  return developmentBackupRuntimeHeld(developmentBackupDependencies((executable, args) => execFileSync(executable, [...args],
    { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] })), replacement.sessionId);
}
