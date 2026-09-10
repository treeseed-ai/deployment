import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { deploymentDigest, type ComponentRelease } from '@treeseed/sdk/deployment';
import { atomicJson } from '../core/files.js';
import { developmentBackupHoldPath } from '../core/development-backup-hold.js';
import { loadHostConfiguration } from '../core/configuration.js';
import { loadActiveComponents } from '../manager/current-state.js';
import { DevelopmentSessionStore, type ManagedDevelopmentSession } from '../manager/development-sessions.js';
import { backupConfiguration } from './backup-configuration.js';
import { requiredBackupState } from './backup-coverage.js';
import { drainCandidateRunner, drainReleasedRunner } from './development-runner.js';
import type { CommandRunner } from './compose-runtime.js';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const entrySchema = z.object({ sessionId: z.string().regex(/^dev-[a-z0-9-]{1,64}$/u),
  recordDigest: digest, specDigest: digest, runtimeReceiptDigest: digest,
  image: z.string().regex(/^sha256:[a-f0-9]{64}$/u), apiRuntimeDigest: digest }).strict();
const holdSchema = z.object({ schemaVersion: z.literal(1), generation: z.number().int().positive(),
  phase: z.enum(['holding', 'held', 'resuming', 'recovery-required', 'restored']), entries: z.array(entrySchema).max(128) }).strict();
type Entry = z.infer<typeof entrySchema>;
type Hold = z.infer<typeof holdSchema>;
const containerSchema = z.object({ Id: z.string().regex(/^[a-f0-9]{64}$/u), Name: z.string(),
  Image: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  Config: z.object({ Labels: z.record(z.string(), z.string()).nullable() }),
  State: z.object({ Running: z.boolean() }),
  Mounts: z.array(z.object({ Source: z.string(), RW: z.boolean() })) });

export interface DevelopmentBackupDependencies {
  command: CommandRunner;
  records: () => ManagedDevelopmentSession[];
  components: () => ComponentRelease[];
  members: () => string[];
  holdPath: string;
  runtimeRoot: string;
  ownerUid: number;
}
const hash = (value: string | Buffer) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const candidateName = (id: string) => `treeseed-${id}-api-operations-runner`;
const directory = (deps: DevelopmentBackupDependencies, id: string) => resolve(deps.runtimeRoot, id, 'operations-runner');
const compose = (deps: DevelopmentBackupDependencies, id: string) => ['compose', '--project-name', candidateName(id), '--file', resolve(directory(deps, id), 'compose.json')];

function ownedFile(path: string, owner: number) {
  const stat = lstatSync(path);
  if (!stat.isFile() || realpathSync(path) !== path || stat.uid !== owner || (stat.mode & 0o022) !== 0)
    throw new Error('Development backup snapshot custody is invalid.');
  return readFileSync(path);
}
function save(deps: DevelopmentBackupDependencies, hold: Hold) {
  atomicJson(deps.holdPath, holdSchema.parse(hold), 0o644);
  // Persist the interlock before stopping writers, including across power loss.
  for (const path of [deps.holdPath, resolve(deps.holdPath, '..')]) {
    const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}
function read(deps: DevelopmentBackupDependencies) {
  return holdSchema.parse(JSON.parse(ownedFile(deps.holdPath, deps.ownerUid).toString('utf8')));
}
function snapshot(deps: DevelopmentBackupDependencies, record: ManagedDevelopmentSession, image: string, apiRuntimeDigest: string): Entry {
  const root = directory(deps, record.session.sessionId);
  const spec = ownedFile(resolve(root, 'compose.json'), deps.ownerUid);
  const parsed = JSON.parse(spec.toString('utf8'));
  if (parsed.services?.runtime?.image !== image || parsed.services?.runtime?.container_name !== candidateName(record.session.sessionId))
    throw new Error('Development writer does not match its fixed runtime snapshot.');
  return entrySchema.parse({ sessionId: record.session.sessionId, recordDigest: deploymentDigest(record),
    specDigest: hash(spec), runtimeReceiptDigest: hash(ownedFile(resolve(root, 'runtime-receipt.json'), deps.ownerUid)), image, apiRuntimeDigest });
}
function validate(deps: DevelopmentBackupDependencies, entries: Entry[]) {
  const records = deps.records(), api = deps.components().find(item => item.componentId === 'api');
  for (const entry of entries) {
    const record = records.find(item => item.session.sessionId === entry.sessionId);
    if (!record || record.session.status !== 'active' || api?.runtimeDigest !== entry.apiRuntimeDigest
      || !record.session.targets.some(target => target.projectId === 'api' && target.targetId === 'operations-runner'
        && (target.mode === 'candidate' || target.mode === 'live'))
      || deploymentDigest(snapshot(deps, record, entry.image, api.runtimeDigest)) !== deploymentDigest(entry))
      throw new Error('Development selection or snapshot changed during backup; explicit recovery required.');
  }
}

/** Fixed registered live/candidate snapshot only. Labels alone never authorize a stop: the
 * active selection, root snapshot and immutable running image must all match.
 * Unrecognized writers are rejected before any released component is stopped.
 */
export function planDevelopmentBackup(deps: DevelopmentBackupDependencies, targetApiRuntimeDigest?: string) {
  const records = deps.records(), components = deps.components(), api = components.find(item => item.componentId === 'api');
  const roots = deps.members().map(member => resolve('/', member));
  const ids = String(deps.command('/usr/bin/docker', ['ps', '--quiet'])).trim().split(/\s+/u).filter(Boolean);
  const entries: Entry[] = [];
  for (const id of ids) {
    if (!/^[a-f0-9]{12,64}$/u.test(id)) throw new Error('Backup writer inventory is invalid.');
    const state = containerSchema.parse(JSON.parse(String(deps.command('/usr/bin/docker', ['inspect', '--format', '{"Id":{{json .Id}},"Name":{{json .Name}},"Image":{{json .Image}},"Config":{"Labels":{{json .Config.Labels}}},"State":{"Running":{{json .State.Running}}},"Mounts":{{json .Mounts}}}', id]))));
    if (!state.Id.startsWith(id)) throw new Error('Backup writer identity changed.');
    const writes = state.Mounts.some(mount => {
      if (!mount.RW) return false;
      if (!mount.Source.startsWith('/')) throw new Error('Unknown writable container mount.');
      const source = resolve(mount.Source);
      return roots.some(root => root === source || root.startsWith(`${source}/`) || source.startsWith(`${root}/`) || source === '/');
    });
    if (!state.State.Running || !writes) continue;
    const labels = state.Config.Labels ?? {}, sessionId = labels['org.treeseed.development.session'];
    if (sessionId !== undefined) {
      const record = records.find(item => item.session.sessionId === sessionId);
      if (!record || labels['org.treeseed.development.target'] !== 'api.operations-runner'
        || state.Name !== `/${candidateName(sessionId)}` || !api || api.runtimeDigest !== targetApiRuntimeDigest)
        throw new Error('Backup writer is not a compatible registered development candidate.');
      entries.push(snapshot(deps, record, state.Image, api.runtimeDigest));
    } else if (!components.some(component => component.runtime.compose.projectName === labels['com.docker.compose.project']
      && component.runtime.services.some(service => service.composeService === labels['com.docker.compose.service']))) {
      throw new Error('Backup blocked by an unmanaged writer; no services were stopped.');
    }
  }
  if (new Set(entries.map(entry => entry.sessionId)).size !== entries.length || entries.length > 1)
    throw new Error('Multiple candidate runner writers require recovery before backup.');
  validate(deps, entries);
  return entries;
}

function stop(deps: DevelopmentBackupDependencies, entries: Entry[]) {
  for (const entry of entries) {
    drainCandidateRunner(deps.command, entry.sessionId);
    // Retain the root-owned spec, runtime snapshot and handoff marker. Ordinary
    // development stop would delete these and restart the released runner.
    if (existsSync(resolve(directory(deps, entry.sessionId), 'compose.json')))
      deps.command('/usr/bin/docker', [...compose(deps, entry.sessionId), 'down', '--timeout', '30']);
    else {
      // /run disappears on reboot. Only remove the verified, drained container,
      // never volumes or source data. A missing container needs no cleanup.
      const name = candidateName(entry.sessionId);
      const found = String(deps.command('/usr/bin/docker', ['ps', '--all', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'])).trim();
      if (found) deps.command('/usr/bin/docker', ['rm', name]);
    }
  }
}
function resume(deps: DevelopmentBackupDependencies, entries: Entry[]) {
  validate(deps, entries);
  for (const entry of entries) {
    drainReleasedRunner(deps.command);
    deps.command('/usr/bin/docker', [...compose(deps, entry.sessionId), 'up', '--detach', '--wait', '--wait-timeout', '120', 'runtime']);
  }
}
export function beginDevelopmentBackup(generation: number, deps: DevelopmentBackupDependencies, targetApiRuntimeDigest?: string) {
  if (existsSync(deps.holdPath)) throw new Error('An interrupted development backup requires recovery before another update.');
  const hold = holdSchema.parse({ schemaVersion: 1, generation, phase: 'holding', entries: planDevelopmentBackup(deps, targetApiRuntimeDigest) });
  save(deps, hold);
  try {
    validate(deps, hold.entries);
    stop(deps, hold.entries);
    save(deps, { ...hold, phase: 'held' });
    return { held: true, generation, targets: hold.entries.length };
  } catch {
    // No released component/data mutation has begun. Restore only the captured
    // candidate, never a newer recipe, and retain the interlock on uncertainty.
    try { resume(deps, hold.entries); unlinkSync(deps.holdPath); }
    catch { save(deps, { ...hold, phase: 'recovery-required' }); }
    throw new Error('Development backup preparation failed; inspect hold and runner health before retrying.');
  }
}
export function finishDevelopmentBackup(generation: number, deps: DevelopmentBackupDependencies) {
  const hold = read(deps);
  if (hold.generation !== generation || !['held', 'restored'].includes(hold.phase)) throw new Error('Exact held backup generation required; interrupted resumption needs recovery.');
  if (hold.phase === 'restored' && hold.entries.some(entry => !existsSync(directory(deps, entry.sessionId)))) {
    // Only an explicit, authenticated whole-generation restore authorizes the
    // normal CLI boot worker to reconstruct a lost /run development snapshot.
    // Never silently do this for an interrupted update or ordinary retry.
    validateRestoredSelection(deps, hold);
    stop(deps, hold.entries);
    unlinkSync(deps.holdPath);
    return { resumed: false, generation, targets: hold.entries.length, bootResumeRequired: true };
  }
  validate(deps, hold.entries);
  save(deps, { ...hold, phase: 'resuming' });
  try {
    resume(deps, hold.entries);
    unlinkSync(deps.holdPath);
    return { resumed: true, generation, targets: hold.entries.length };
  } catch {
    try { stop(deps, hold.entries); } finally { save(deps, { ...hold, phase: 'recovery-required' }); }
    throw new Error('Development resumption failed; candidate retained and fenced for explicit recovery.');
  }
}
export function developmentBackupStatus(deps: DevelopmentBackupDependencies) {
  if (!existsSync(deps.holdPath)) return null;
  const hold = read(deps);
  return { generation: hold.generation, phase: hold.phase, targets: hold.entries.length };
}
function validateRestoredSelection(deps: DevelopmentBackupDependencies, hold: Hold) {
  const records = deps.records(), api = deps.components().find(item => item.componentId === 'api');
  if (hold.entries.some(entry => api?.runtimeDigest !== entry.apiRuntimeDigest
    || deploymentDigest(records.find(record => record.session.sessionId === entry.sessionId) ?? null) !== entry.recordDigest))
    throw new Error('Restored generation does not match the held development selection.');
}
export function fenceDevelopmentBackup(generation: number, deps: DevelopmentBackupDependencies, targetApiRuntimeDigest?: string) {
  const hold = read(deps);
  if (hold.generation !== generation || hold.entries.some(entry => entry.apiRuntimeDigest !== targetApiRuntimeDigest))
    throw new Error('Recovery target is incompatible with the held development selection.');
  stop(deps, hold.entries);
}
/** Called internally only after authenticated recovery.restore has succeeded. */
export function markDevelopmentBackupRestored(deps: DevelopmentBackupDependencies) {
  if (!existsSync(deps.holdPath)) return;
  const hold = read(deps);
  validateRestoredSelection(deps, hold);
  save(deps, { ...hold, phase: 'restored' });
}
export function developmentBackupDependencies(command: CommandRunner): DevelopmentBackupDependencies {
  return { command, records: () => new DevelopmentSessionStore().list(), components: loadActiveComponents,
    members: () => requiredBackupState(backupConfiguration(loadHostConfiguration()), loadActiveComponents()),
    holdPath: developmentBackupHoldPath, runtimeRoot: '/run/treeseed/development-containers', ownerUid: 0 };
}
