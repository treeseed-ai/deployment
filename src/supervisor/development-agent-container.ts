import { chmodSync, chownSync, closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { parseDocument } from 'yaml';
import { dirname, resolve, sep } from 'node:path';
import { atomicJson } from '../core/files.js';
import { loadHostConfiguration } from '../core/configuration.js';
import { DevelopmentSessionStore, type ManagedDevelopmentSession } from '../manager/development-sessions.js';
import { loadActiveComponents } from '../manager/current-state.js';
import { composeFiles, managedContainerDevelopmentConnectionEnvironment } from '../manager/reconcile.js';
import { componentStateRoot } from './component.js';
import { componentComposeArguments, type CommandRunner } from './compose-runtime.js';
import { copyDevelopmentRuntime, developmentRuntimeStatus, assertDevelopmentRuntimeMounts } from './development-runtime-copy.js';
import { bindExistingSandboxGuestTrust, configuredSandboxGuestDigest, importSandboxGuestArchive } from './sandbox-guest-import.js';
import { recordHostDevelopmentGuestImage } from './host-development.js';
import { loadSandboxBrokerConfiguration } from '../sandbox/configuration.js';
import { inspectVmProcesses } from '../sandbox/doctor.js';

const root = '/run/treeseed/development-containers';
const projectName = 'treeseed-agent';
const services = ['manager', 'runner'] as const;
export const runtimeRoots=Object.freeze([{source:'dist',target:'dist'},
	{source:'.treeseed/docker/runtime/shared/package.json',target:'package.json'},
	{source:'.treeseed/docker/runtime/shared/node_modules',target:'node_modules'}].map(root=>Object.freeze(root)));

interface AgentDevelopmentInput {
	sessionId: string;
	projectId: 'agent';
	targetId: 'provider' | 'sandbox';
	action: 'start' | 'stop' | 'status' | 'logs';
	guestReplacement?: boolean;
}

function sourceFor(record: ManagedDevelopmentSession) {
	const repository = record.session.repositories.find((entry) => entry.projectId === 'agent');
	if (!repository) throw new Error('Agent source is not registered in this development session.');
	const worktree = realpathSync(repository.worktree);
	const stat = lstatSync(worktree);
	if (stat.uid === 0 || !existsSync(resolve(worktree, 'treeseed.package.yaml')) || !existsSync(resolve(worktree, '.git')))
		throw new Error('Development requires an operator-owned Agent checkout.');
	const roots = record.session.repositories.map((entry) => realpathSync(entry.worktree));
	let workspace = worktree;
	while (!roots.every((path) => path === workspace || path.startsWith(`${workspace}${sep}`))) workspace = dirname(workspace);
	if (workspace.split(sep).filter(Boolean).length < 3) throw new Error('Development workspace mount is too broad.');
	return { worktree, workspace, uid: stat.uid };
}

export function renderAgentDevelopmentOverride(input: { sessionId: string; runtimeRoot: string; sourceClosureDigest: string; environment?: Record<string, string>; sandboxGuestDigest?: string; manifestPath?: string }) {
	if (!/^dev-[a-z0-9-]{1,64}$/u.test(input.sessionId)) throw new Error('Invalid Agent development session.');
	if (!/^sha256:[a-f0-9]{64}$/u.test(input.sourceClosureDigest)) throw new Error('Invalid Agent development source closure digest.');
	const labels = {
		'org.treeseed.development.session': input.sessionId,
		'org.treeseed.development.target': 'agent.provider',
	};
	const volumes = [
		{ type: 'bind', source: resolve(input.runtimeRoot, 'dist'), target: '/app/dist', read_only: true },
		{ type: 'bind', source: resolve(input.runtimeRoot, 'package.json'), target: '/app/package.json', read_only: true },
		{ type: 'bind', source: resolve(input.runtimeRoot, 'node_modules'), target: '/app/node_modules', read_only: true },
		...(input.manifestPath ? [{ type: 'bind', source: input.manifestPath, target: '/config/treeseed.capacity-provider.yaml', read_only: true }] : []),
	];
	const environment: Record<string, string> = { ...input.environment,
		...(input.sandboxGuestDigest ? { TREESEED_DEVELOPMENT_SANDBOX_GUEST_DIGEST: input.sandboxGuestDigest } : {}),
		TREESEED_PROVIDER_RUNTIME_BUILD: input.sourceClosureDigest,
		TREESEED_DEVELOPMENT_SESSION_ID: input.sessionId, TREESEED_DEVELOPMENT_MODE: 'candidate' };
	const service = {
		restart: 'no',
		labels,
		environment,
		volumes,
	};
	return { services: { manager: service, runner: service } };
}

/** Enrollment consumes the same registered root-owned provider snapshot as execution. */
export function agentEnrollmentDevelopmentOverride(records = new DevelopmentSessionStore().list(), available = existsSync) {
	const selected = records.filter(record => record.session.status === 'active' && record.session.targets.some(target => target.projectId === 'agent' && target.targetId === 'provider' && target.mode !== 'released'));
	if (selected.length > 1) throw new Error('Provider development enrollment selection is ambiguous.');
	if (!selected.length) return undefined;
	const sessionId = selected[0]!.session.sessionId;
	if (!/^dev-[a-z0-9-]{1,64}$/u.test(sessionId)) throw new Error('Invalid Agent development session.');
	const override = resolve(root, sessionId, 'agent', 'provider', 'compose.json');
	if (!available(override)) throw new Error('Registered provider development snapshot is unavailable.');
	return override;
}

export function writeAgentDevelopmentManifest(path: string, manifest: string, ownership = chownSync) {
	writeFileSync(path, manifest, { mode: 0o600 });
	ownership(path, 0, 65_532);
	chmodSync(path, 0o640);
}

export function activeAgentClaims(stateRoot: string, providerHandoff = false) {
	const path = resolve(stateRoot, 'runtime', 'capacity-state.json');
	if (!existsSync(path)) return [];
	const state = JSON.parse(readFileSync(path, 'utf8')) as { schemaVersion?: unknown; claims?: unknown };
	if (state.schemaVersion !== 1 || !Array.isArray(state.claims)) throw new Error('Provider-local capacity state is invalid.');
	return state.claims.filter((claim): claim is { id: string; status: string } => {
		if (!claim || typeof claim !== 'object') throw new Error('Provider-local capacity claim is invalid.');
		const value = claim as Record<string, unknown>;
		if (typeof value.id !== 'string' || !['polling', 'ready', 'running', 'recovery', 'unresolved'].includes(String(value.status)))
			throw new Error('Provider-local capacity claim is invalid.');
		// The owning provider retains unresolved usage custody and period holds;
		// this reader only observes whether a live execution slot blocks handoff.
		if (providerHandoff && value.status === 'recovery') {
			// Replace only provider code after its trusted executor physically closed.
			// The complete recovery journal and accounting holds remain untouched.
			const output = value.closeoutOutput as Record<string, unknown> | undefined;
			const teardown = output?.teardown as Record<string, unknown> | undefined;
			const completed = typeof teardown?.completedAt === 'string' ? Date.parse(teardown.completedAt) : NaN;
			const started = typeof value.activeStartedAt === 'string' ? Date.parse(value.activeStartedAt) : NaN;
			const finished = typeof value.activeFinishedAt === 'string' ? Date.parse(value.activeFinishedAt) : NaN;
			const frozen = (value.dispatchEnvelope as { assignment?: { assignmentAttempt?: Record<string, unknown> } } | undefined)?.assignment?.assignmentAttempt;
			const workspace = frozen?.workspace as Record<string, unknown> | undefined;
			const result = output?.assignmentResult as Record<string, unknown> | undefined;
			// Native Kernel work may close an empty resource scope before the enclosing
			// provider stops accounting. This permits code handoff only: the new
			// provider must still verify original authority, results and settlement.
			const nativeClosed = output && !Object.hasOwn(output, 'sandboxId')
				&& Object.keys(output).every(key => ['assignmentResult', 'teardown', 'artifacts'].includes(key))
				&& Array.isArray(output.artifacts) && output.artifacts.length === 0
				&& typeof value.assignmentId === 'string' && frozen?.id === value.assignmentId && result?.assignmentId === value.assignmentId
				&& workspace?.mode === 'treedx' && result?.status === 'completed'
				&& typeof result.completedAt === 'string' && Number.isFinite(Date.parse(result.completedAt))
				&& started <= Date.parse(result.completedAt) && Date.parse(result.completedAt) <= completed && completed <= finished
				&& value.accountedThrough === value.activeFinishedAt;
			if (nativeClosed && teardown?.verified === true && Number.isFinite(completed) && completed <= Date.now()
				&& Number.isFinite(started) && Number.isFinite(finished) && started <= finished && finished <= Date.now()) return false;
			if (typeof output?.sandboxId === 'string' && output.sandboxId && teardown?.verified === true
				&& Number.isFinite(completed) && completed <= Date.now()
				&& Number.isFinite(started) && Number.isFinite(finished) && started <= finished && finished <= completed) return false;
		}
		return value.status !== 'polling' && value.status !== 'unresolved';
	});
}

function containerState(command: CommandRunner, service: typeof services[number]) {
	const name = `${projectName}-${service}-1`;
	const value = JSON.parse(String(command('/usr/bin/docker', ['inspect', name, '--format',
		'{"labels":{{json .Config.Labels}},"running":{{json .State.Running}},"environment":{{json .Config.Env}},"mounts":{{json .Mounts}}}'])));
	if (value.labels?.['com.docker.compose.project'] !== projectName || value.labels?.['com.docker.compose.service'] !== service || typeof value.running !== 'boolean')
		throw new Error('Agent container ownership does not match the managed component.');
	const environment: unknown[] = Array.isArray(value.environment) ? value.environment : [];
	const connectionEnvironment = Object.fromEntries(environment
		.map(String).map((entry: string) => entry.split(/=(.*)/su, 2) as [string, string])
		.filter(([key]) => ['TREESEED_CONTROL_PLANE_URL', 'TREESEED_SERVER_PROFILE_LOCAL_URL', 'TREESEED_API_URL'].includes(key)));
	const guestDigest = environment.map(String).find((entry) => entry.startsWith('TREESEED_DEVELOPMENT_SANDBOX_GUEST_DIGEST='))
		?.slice('TREESEED_DEVELOPMENT_SANDBOX_GUEST_DIGEST='.length) ?? null;
	const runtimeBuild=environment.map(String).filter(entry=>entry.startsWith('TREESEED_PROVIDER_RUNTIME_BUILD='));
	return { name, running: value.running as boolean, labels: value.labels as Record<string, string>, connectionEnvironment, guestDigest,
		mounts:value.mounts as unknown,runtimeBuild:runtimeBuild.length===1?runtimeBuild[0]!.slice('TREESEED_PROVIDER_RUNTIME_BUILD='.length):null };
}

export function providerDailyLimitChange(previous: string, desired: string) {
 const normalize=(text:string)=>{
  const document=parseDocument(text); if(document.errors.length) return null;
  const value=document.toJS() as Record<string,unknown>;
  if(!value||!Array.isArray(value.adapters)) return null;
  for(const adapter of value.adapters) {
   const limits=adapter?.nativeLimits;
   if(!limits||typeof limits!=='object'||!limits.capabilityLimits||typeof limits.capabilityLimits!=='object') return null;
   for(const entry of [limits,...Object.values(limits.capabilityLimits)] as Array<Record<string,unknown>>) {
    if(!entry||!Number.isSafeInteger(entry.dailyActiveSecondsLimit)||Number(entry.dailyActiveSecondsLimit)<0) return null;
    entry.dailyActiveSecondsLimit=0;
   }
  }
  return value;
 };
 const oldPolicy=normalize(previous),newPolicy=normalize(desired);
 return oldPolicy!==null&&newPolicy!==null&&previous!==desired&&isDeepStrictEqual(oldPolicy,newPolicy);
}

function selectedProviderRuntime(command: CommandRunner, sessionId: string, directory: string) {
 const states = services.map(service => containerState(command, service));
 for(const state of states) assertDevelopmentRuntimeMounts(state,sessionId,'agent.provider',directory,runtimeRoots.map(root=>root.target));
 const runtime=developmentRuntimeStatus(directory,runtimeRoots.map(root=>root.target));
 if(states.some(state=>state.runtimeBuild!==runtime.digest)) throw new Error('Provider runtime build does not match its selected copy.');
 return {states,runtime};
}

export function providerGuestTrustReady(expectedDigest: string, instances: readonly { running: boolean; guestDigest: string | null }[]) {
	return instances.length === services.length && instances.every(({ running, guestDigest }) => running && guestDigest === expectedDigest);
}

function stopService(command: CommandRunner, service: typeof services[number]) {
	const state = containerState(command, service);
	if (state.running) command('/usr/bin/docker', ['stop', '--time', '30', state.name]);
}

function startService(command: CommandRunner, service: typeof services[number]) {
	const state = containerState(command, service);
	if (!state.running) command('/usr/bin/docker', ['start', state.name]);
}

function restoreReleasedAgent(command: CommandRunner, compose: string[]) {
	command('/usr/bin/docker', [...compose, 'up', '--detach', '--wait', '--wait-timeout', '120', '--force-recreate', ...services]);
}

function expiredRecoveryClaim(value: unknown) {
	const row = (input: unknown): Record<string, unknown> => input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
	const claim = row(value), assignment = row(row(claim.dispatchEnvelope).assignment), attempt = row(assignment.assignmentAttempt);
	const clock = (input: unknown) => typeof input === 'string' && /^\d{4}-\d{2}-\d{2}T.*Z$/u.test(input) ? Date.parse(input) : NaN;
	const deadline = clock(attempt.deadline), lease = clock(claim.leaseExpiresAt), start = clock(claim.activeStartedAt), now = Date.now();
	// The provider records this original start after authenticated execution-start.
	// Its frozen productive limit can expire before the enclosing workday deadline.
	const maximumSeconds = row(attempt.limits).maximumSeconds;
	const executionDeadline = typeof maximumSeconds === 'number' && Number.isSafeInteger(maximumSeconds) && maximumSeconds > 0
		&& Number.isSafeInteger(start + maximumSeconds * 1_000) ? start + maximumSeconds * 1_000 : NaN;
	return claim.status === 'recovery' && typeof claim.assignmentId === 'string' && claim.assignmentId.length > 0
		&& attempt.schemaVersion === 'treeseed.assignment-attempt/v1' && attempt.id === claim.assignmentId
		&& Number.isFinite(deadline) && Number.isFinite(lease) && Number.isFinite(start) && start <= deadline
		&& Math.min(deadline, Number.isFinite(executionDeadline) ? executionDeadline : deadline) <= now && lease <= now;
}

/** Reject unsafe work before image import can change broker trust. */
export function assertSandboxGuestHandoffClaims(stateRoot: string) {
	const active = activeAgentClaims(stateRoot, true);
	if (active.some(claim => !expiredRecoveryClaim(claim)))
		throw new Error(`Managed sandbox development cannot replace guest trust while ${active.length} assignment claim(s) are active or recoverable.`);
}

/** Quiesce the existing producer and observe execution absence. This permits
 * provider code replacement only; retained clocks, usage and leases stay held. */
function expiredRecoverySnapshot(stateRoot: string) {
	const path = resolve(stateRoot, 'runtime', 'capacity-state.json');
	if (!existsSync(path)) return [];
	const state = JSON.parse(readFileSync(path, 'utf8')) as { schemaVersion?: unknown; claims?: unknown };
	if (state.schemaVersion !== 1 || !Array.isArray(state.claims)) throw new Error('Provider-local capacity state is invalid.');
	return state.claims.filter((claim) => {
		if (!claim || typeof claim !== 'object' || Array.isArray(claim)) throw new Error('Provider-local capacity claim is invalid.');
		const value = claim as Record<string, unknown>;
		return value.status === 'recovery' && expiredRecoveryClaim(value);
	}).map((claim) => JSON.stringify(claim)).sort();
}

function fenceExpiredRecovery(command: CommandRunner, stateRoot: string, expected: string[], keepBrokerStopped: boolean,
	brokerAlreadyStopped = false, leaveBrokerStoppedOnFailure = false) {
	const broker = 'treeseed-sandbox-broker.service', configuration = loadSandboxBrokerConfiguration();
	if (!brokerAlreadyStopped) command('/usr/bin/systemctl', ['is-active', '--quiet', broker]);
	else if (String(command('/usr/bin/systemctl', ['show', broker, '--property=ActiveState', '--value'])).trim() !== 'inactive')
		throw new Error('Expired recovery handoff requires confirmed broker shutdown.');
	let complete = false;
	try {
		if (!brokerAlreadyStopped) command('/usr/bin/systemctl', ['stop', broker]);
		if (String(command('/usr/bin/systemctl', ['show', broker, '--property=ActiveState', '--value'])).trim() !== 'inactive')
			throw new Error('Expired recovery handoff requires confirmed broker shutdown.');
		for (let observation = 0; observation < 2; observation++) {
			const prefix = ['--address', configuration.containerdAddress, '--namespace', configuration.namespace];
			for (const kind of ['tasks', 'containers']) {
				if (String(command('/usr/bin/ctr', [...prefix, kind, 'list', '--quiet'])).trim())
					throw new Error('Expired recovery handoff requires no remaining sandbox tasks or containers.');
			}
			const vms = inspectVmProcesses();
			if (!vms.complete || vms.processes === null || vms.processes.length)
				throw new Error('Expired recovery handoff requires complete physical VM absence.');
			if (JSON.stringify(expiredRecoverySnapshot(stateRoot)) !== JSON.stringify(expected)
				|| activeAgentClaims(stateRoot, true).some(claim => !expiredRecoveryClaim(claim)))
				throw new Error('Provider recovery authority changed while execution was fenced.');
		}
		complete = true;
	} finally { if (!keepBrokerStopped || (!complete && !leaveBrokerStoppedOnFailure)) command('/usr/bin/systemctl', ['start', broker]); }
}

export function stopForHandoff(command: CommandRunner, stateRoot: string, restoreManager: () => void,
	options: { keepBrokerStopped?: boolean; brokerAlreadyStopped?: boolean; leaveBrokerStoppedOnFailure?: boolean; leaveRolesStoppedOnFailure?: boolean } = {}) {
	const running = new Set(services.filter(service => containerState(command, service).running));
	try {
		stopService(command, 'manager');
		const active = activeAgentClaims(stateRoot, true);
		if (active.some(claim => !expiredRecoveryClaim(claim))) throw new Error(`Managed Agent development cannot interrupt ${active.length} active or recoverable assignment claim(s).`);
		const expected = expiredRecoverySnapshot(stateRoot);
		stopService(command, 'runner');
		const drained = activeAgentClaims(stateRoot, true);
		if (drained.some(claim => !expiredRecoveryClaim(claim))) throw new Error('Managed Agent development cannot interrupt authority acquired during drain.');
		if (JSON.stringify(expiredRecoverySnapshot(stateRoot)) !== JSON.stringify(expected))
			throw new Error('Provider recovery authority changed while execution was drained.');
		if (drained.length || options.keepBrokerStopped) {
			fenceExpiredRecovery(command, stateRoot, expected, options.keepBrokerStopped === true, options.brokerAlreadyStopped === true, options.leaveBrokerStoppedOnFailure === true);
		}
		if (services.some(service => containerState(command, service).running)) throw new Error('Managed Agent provider drain was not confirmed.');
	} catch (error) {
		// Restore only services that were running; reopen admissions last.
		if (!options.leaveRolesStoppedOnFailure) {
			if (running.has('runner')) startService(command, 'runner');
			if (running.has('manager')) restoreManager();
		}
		throw error;
	}
	return running;
}

function restoreProviderRoles(command: CommandRunner, running: ReadonlySet<'manager' | 'runner'>) {
	try {
		if (running.has('runner')) startService(command, 'runner');
		if (running.has('manager')) startService(command, 'manager');
	} catch (error) {
		for (const service of ['runner', 'manager'] as const) try { stopService(command, service); } catch { /* keep admission closed */ }
		throw error;
	}
}

interface SandboxDevelopmentReceipt {
	schemaVersion: 1;
	sessionId: string;
	priorDigest: string;
	digest: string;
	image: string;
}

function sandboxReceipt(path: string) {
	if (!existsSync(path)) return null;
	const value = JSON.parse(readFileSync(path, 'utf8')) as SandboxDevelopmentReceipt;
	if (value.schemaVersion !== 1 || !/^dev-[a-z0-9-]{1,64}$/u.test(value.sessionId)
		|| !/^sha256:[a-f0-9]{64}$/u.test(value.priorDigest) || !/^sha256:[a-f0-9]{64}$/u.test(value.digest)
		|| value.image !== 'treeseed/sandbox-codex:local') throw new Error('Managed sandbox development receipt is invalid.');
	return value;
}

export function restoreSandboxProviderDirectory(providerSelected: boolean, hadProviderDirectory: boolean, providerSnapshotReady: boolean, providerDirectory: string, providerSnapshot: string) {
	if (!providerSelected) return;
	if (hadProviderDirectory && !providerSnapshotReady) {
		// cpSync may leave a partial destination when it throws. This path is the
		// sandbox transaction's owned snapshot, so discard it without touching the
		// still-selected provider directory.
		rmSync(providerSnapshot, { recursive: true, force: true });
		return;
	}
	rmSync(providerDirectory, { recursive: true, force: true });
	if (providerSnapshotReady) renameSync(providerSnapshot, providerDirectory);
}

function executeSandboxDevelopment(input: AgentDevelopmentInput, record: ManagedDevelopmentSession, command: CommandRunner) {
	const directory = resolve(root, input.sessionId, 'agent', 'sandbox');
	const archive = resolve(directory, 'sandbox-codex.tar');
	const receiptPath = resolve(directory, 'receipt.json');
	const receipt = sandboxReceipt(receiptPath);
	if (input.action === 'logs') return { events: receipt ? [{ service: 'sandbox-guest', output: JSON.stringify(receipt) }] : [] };
	if (input.action === 'status') {
		if (!receipt) return { registered: false, state: null };
		const activeDigest = configuredSandboxGuestDigest();
		return { registered: true, ready: activeDigest === receipt.digest, digest: receipt.digest, activeDigest };
	}
	if (input.action === 'stop') {
		if (receipt) {
			const active = activeAgentClaims(componentStateRoot(loadHostConfiguration(), 'agent'));
			if (active.length) throw new Error(`Managed sandbox development cannot restore guest trust while ${active.length} assignment claim(s) are active or recoverable.`);
			bindExistingSandboxGuestTrust(receipt.priorDigest, command); recordHostDevelopmentGuestImage(receipt.priorDigest);
		}
		rmSync(directory, { recursive: true, force: true });
		if (record.session.targets.some((target) => target.projectId === 'agent' && target.targetId === 'provider' && target.mode !== 'released'))
			executeAgentDevelopmentContainer({ ...input, targetId: 'provider', action: 'start' }, command);
		return { stopped: true };
	}
	if (record.session.status !== 'active') throw new Error('Development session is not active.');
	const stateRoot = componentStateRoot(loadHostConfiguration(), 'agent');
	assertSandboxGuestHandoffClaims(stateRoot);
	const source = sourceFor(record).worktree;
	for (const path of ['Dockerfile', 'Dockerfile.sandbox-codex', 'dist/sandbox/guest.js', '.treeseed/docker/runtime/shared/node_modules']) {
		if (!existsSync(resolve(source, path))) throw new Error(`Managed sandbox development input ${path} is unavailable.`);
	}
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const lockPath = resolve(directory, 'rebuild.lock');
	let lock: number;
	try { lock = openSync(lockPath, 'wx', 0o600); }
	catch { throw new Error('Managed sandbox development rebuild is already active.'); }
	try {
		const rollbackDigest = receipt?.digest ?? configuredSandboxGuestDigest();
		const priorReceipt = existsSync(receiptPath) ? readFileSync(receiptPath) : null;
		const priorDigest = receipt?.priorDigest ?? rollbackDigest;
		const providerSelected = record.session.targets.some((target) => target.projectId === 'agent' && target.targetId === 'provider' && target.mode !== 'released');
		const providerDirectory = resolve(root, input.sessionId, 'agent', 'provider');
		const providerSnapshot = resolve(directory, 'provider-prior');
		const hadProviderDirectory = providerSelected && existsSync(providerDirectory);
		let providerSnapshotReady = false;
		command('/usr/bin/docker', ['build', '--file', resolve(source, 'Dockerfile'), '--target', 'sandbox-base', '--tag', 'treeseed/sandbox-base:local', source]);
		command('/usr/bin/docker', ['build', '--file', resolve(source, 'Dockerfile.sandbox-codex'), '--build-arg', 'SANDBOX_BASE=treeseed/sandbox-base:local', '--tag', 'treeseed/sandbox-codex:local', source]);
		command('/usr/bin/docker', ['image', 'save', '--output', archive, 'treeseed/sandbox-codex:local']);
		const metadata = lstatSync(archive);
		if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1_024 || metadata.size > 4_294_967_296 || (metadata.mode & 0o022) !== 0)
			throw new Error('Managed sandbox archive failed bounded supervisor custody validation.');
		// Image creation above is inert. Reuse the provider's existing handoff
		// fence before importing or selecting a guest digest, including its second
		// authority read and twice-complete physical absence proof for recovery.
		const originalRunningRoles = stopForHandoff(command, stateRoot, () => startService(command, 'manager'), { keepBrokerStopped: true });
		try {
			if (hadProviderDirectory) {
				cpSync(providerDirectory, providerSnapshot, { recursive: true, errorOnExist: true });
				providerSnapshotReady = true;
			}
			const imported = importSandboxGuestArchive(archive, 'treeseed/sandbox-codex:local', command, undefined, false);
			const next: SandboxDevelopmentReceipt = { schemaVersion: 1, sessionId: input.sessionId, priorDigest, digest: imported.digest, image: imported.image };
			recordHostDevelopmentGuestImage(next.digest);
			atomicJson(receiptPath, next, 0o600);
			if (providerSelected)
				executeAgentDevelopmentContainer({ ...input, targetId: 'provider', action: 'start', guestReplacement: true }, command);
			command('/usr/bin/systemctl', ['start', 'treeseed-sandbox-broker.service']);
			if (providerSnapshotReady) rmSync(providerSnapshot, { recursive: true, force: true });
			return { started: true, ...next };
		} catch (error) {
			try {
				// The provider start can partially recreate roles. Keep them fenced
				// while restoring the prior guest, host selection, and receipt.
				command('/usr/bin/systemctl', ['stop', 'treeseed-sandbox-broker.service']);
				if (String(command('/usr/bin/systemctl', ['show', 'treeseed-sandbox-broker.service', '--property=ActiveState', '--value'])).trim() !== 'inactive')
					throw new Error('Broker shutdown could not be confirmed.');
				try {
					stopForHandoff(command, stateRoot, () => startService(command, 'manager'), {
						keepBrokerStopped: true, brokerAlreadyStopped: true, leaveBrokerStoppedOnFailure: true, leaveRolesStoppedOnFailure: true });
				} catch (drainError) {
					for (const service of ['runner', 'manager'] as const) try { stopService(command, service); } catch { /* retain the broker fence */ }
					throw drainError;
				}
				bindExistingSandboxGuestTrust(rollbackDigest, command, undefined, false);
				recordHostDevelopmentGuestImage(rollbackDigest);
				if (priorReceipt) writeFileSync(receiptPath, priorReceipt, { mode: 0o600 });
				else rmSync(receiptPath, { force: true });
				restoreSandboxProviderDirectory(providerSelected, hadProviderDirectory, providerSnapshotReady, providerDirectory, providerSnapshot);
				restoreProviderRoles(command, originalRunningRoles);
				command('/usr/bin/systemctl', ['start', 'treeseed-sandbox-broker.service']);
			} catch (restoreError) {
				throw new Error(`Managed sandbox guest replacement failed; rollback could not confirm prior trust or provider and broker quiescence. ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`, { cause: error });
			}
			throw error;
		}
	} finally {
		closeSync(lock!);
		rmSync(lockPath, { force: true });
		rmSync(archive, { force: true });
	}
}

/** Fixed Agent provider handoff. No source command, image, mount, or Compose option crosses this boundary. */
export function executeAgentDevelopmentContainer(input: AgentDevelopmentInput, command: CommandRunner) {
	if (input.targetId !== 'provider' && input.targetId !== 'sandbox') throw new Error('Managed Agent development target is invalid.');
	const record = new DevelopmentSessionStore().load(input.sessionId);
	if (!record.session.targets.some((target) => target.projectId === 'agent' && target.targetId === input.targetId))
		throw new Error('Development container is outside the registered session.');
	if (input.targetId === 'sandbox') return executeSandboxDevelopment(input, record, command);
	const directory = resolve(root, input.sessionId, 'agent', 'provider');
	const runtimeRoot = resolve(directory, 'runtime');
	const override = resolve(directory, 'compose.json');
	const handoff = resolve(directory, 'released-agent.json');
	const releases = loadActiveComponents();
	const component = releases.find((release) => release.componentId === 'agent');
	if (!component) throw new Error('Installed Agent foundation is required for development.');
	const compose = ['/usr/bin/docker', 'compose', ...componentComposeArguments('agent', composeFiles(component)), '--project-name', projectName] as const;
	const dockerCompose = compose.slice(1);
	const candidateCompose = [...dockerCompose.slice(0, -2), '--file', override, ...dockerCompose.slice(-2)];
	const stateRoot = componentStateRoot(loadHostConfiguration(), 'agent');

	if (input.action === 'logs') {
		for (const service of services) {
			const state = containerState(command, service);
			if (state.labels['org.treeseed.development.session'] !== input.sessionId || state.labels['org.treeseed.development.target'] !== 'agent.provider')
				throw new Error('Agent development log ownership does not match the session.');
		}
		return { events: services.map((service) => ({ service, output: String(command('/usr/bin/docker', ['logs', '--tail', '100', '--since', '15m', `${projectName}-${service}-1`])) })) };
	}
	if (input.action === 'status') {
		if (!existsSync(override)) return { registered: false, state: null };
		const {states,runtime}=selectedProviderRuntime(command,input.sessionId,directory);
		const expectedDigest = configuredSandboxGuestDigest();
		const instances = states.map(({ name, running, labels, connectionEnvironment, guestDigest }) => ({ name, running, health: running ? 'healthy' : 'stopped', sessionId: labels['org.treeseed.development.session'], target: labels['org.treeseed.development.target'], connectionEnvironment, guestDigest }));
		return { registered: true, instances, ready: providerGuestTrustReady(expectedDigest, instances), expectedGuestDigest: expectedDigest, runtime };
	}
	if (input.action === 'stop') {
		if (!existsSync(override)) { if (existsSync(directory)) rmSync(directory, { recursive: true }); return { stopped: true }; }
		stopForHandoff(command, stateRoot, () => startService(command, 'manager'), input.guestReplacement
			? { keepBrokerStopped: true, brokerAlreadyStopped: true, leaveRolesStoppedOnFailure: true } : undefined);
		try { restoreReleasedAgent(command, dockerCompose); }
		catch (error) {
			try { command('/usr/bin/docker', [...candidateCompose, 'up', '--detach', '--wait', '--wait-timeout', '120', ...services]); } catch { /* retain custody for retry */ }
			throw error;
		}
		rmSync(directory, { recursive: true });
		return { stopped: true };
	}

	if (record.session.status !== 'active') throw new Error('Development session is not active.');
	// Daily limits govern prospective admission; issued claims and selected code stay intact.
	const desiredManifest=(loadHostConfiguration().components.agent?.configuration?.files as Record<string,unknown>|undefined)?.['treeseed.capacity-provider.yaml'];
	const selectedManifest=resolve(directory,'treeseed.capacity-provider.yaml');
	const reloadLimits=typeof desiredManifest==='string'&&existsSync(selectedManifest)
		&&providerDailyLimitChange(readFileSync(selectedManifest,'utf8'),desiredManifest);
	// Resume original immutable execution after interruption; replacement still requires drain.
	if (existsSync(override) && activeAgentClaims(stateRoot).length
		&& (reloadLimits||services.every(service => !containerState(command,service).running))) {
		const {states,runtime}=selectedProviderRuntime(command,input.sessionId,directory);
		if(states.some(state=>state.guestDigest!==configuredSandboxGuestDigest()))
			throw new Error('Stopped provider guest trust does not match its selected runtime.');
		if(reloadLimits)writeAgentDevelopmentManifest(selectedManifest,desiredManifest as string);
		startService(command,'runner');
		startService(command,'manager');
		return {started:true,resumed:true,runtime};
	}
	const source = sourceFor(record);
	const host = loadHostConfiguration();
	const environment = managedContainerDevelopmentConnectionEnvironment(host, component, releases, record.routes);
	const manifest = (host.components.agent?.configuration?.files as Record<string, unknown> | undefined)?.['treeseed.capacity-provider.yaml'];
	if (typeof manifest !== 'string' || !manifest.trim()) throw new Error('Managed provider development requires its desired manifest.');
	const guestDigest = configuredSandboxGuestDigest();
	const manifestPath = resolve(directory, 'treeseed.capacity-provider.yaml');
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const prepared = mkdtempSync(resolve(directory, 'prepare-'));
	try {
		// Materialize separately while the old immutable selection remains intact.
		const receipt = copyDevelopmentRuntime({ worktree: source.worktree, workspace: source.workspace,
			destination: resolve(prepared, 'runtime'), sourceUid: source.uid, roots: runtimeRoots });
		stopForHandoff(command, stateRoot, () => startService(command, 'manager'), input.guestReplacement
			? { keepBrokerStopped: true, brokerAlreadyStopped: true, leaveRolesStoppedOnFailure: true } : undefined);
		try {
			rmSync(runtimeRoot, { recursive: true, force: true });
			renameSync(resolve(prepared, 'runtime'), runtimeRoot);
			atomicJson(resolve(directory, 'runtime-receipt.json'), receipt, 0o600);
			writeAgentDevelopmentManifest(manifestPath, manifest);
			atomicJson(override, renderAgentDevelopmentOverride({ sessionId: input.sessionId, runtimeRoot, sourceClosureDigest: receipt.digest, environment, sandboxGuestDigest: guestDigest, manifestPath }), 0o600);
			atomicJson(handoff, { restore: true }, 0o600);
			command('/usr/bin/docker', [...candidateCompose, 'up', '--detach', '--wait', '--wait-timeout', '120', '--force-recreate', ...services]);
		} catch (error) {
			if (!input.guestReplacement) {
				try { restoreReleasedAgent(command, dockerCompose); rmSync(directory, { recursive: true }); } catch { /* retain handoff marker for idempotent cleanup */ }
			}
			throw error;
		}
		return { started: true, runtime: receipt };
	} finally {
		rmSync(prepared, { recursive: true, force: true });
	}
}
