import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { supervisorOperationSchema, type SupervisorOperation } from './protocol.js';
import { paths } from '../core/paths.js';
import { atomicJson } from '../core/files.js';
import { generateEdgeCertificate } from '../edge/certificates.js';
import { assertNewGeneration, loadHostConfiguration, tryLoadHostConfiguration } from '../core/configuration.js';
import { enrollClient } from './pki.js';
import { configureComponent, resolveDevelopmentSecretEnvironment, restoreComponentSecretFiles } from './component.js';
import { createGenerationBackup, inspectGenerationBackup, listGenerationBackups, restoreGenerationBackup } from './backup.js';
import { resetPlatformState } from './reset.js';
import { planHostUninstall, scheduleHostUninstall } from './uninstall.js';
import { initializeProviderCredential, initializeProviderSecurity, providerSecurityPlan, providerSecurityStatus, rotateProviderSecurityKey, verifyProviderRecoveryBundle, verifyProviderSecurity } from '../security/provider-volume.js';
import { inspectSandboxHost } from '../sandbox/doctor.js';
import { loadSandboxBrokerConfiguration } from '../sandbox/configuration.js';
import { containerdImageReference } from '../sandbox/image-reference.js';
import { ensureSandboxNetwork } from '../sandbox/network.js';
import { sandboxBrokerConfigurationSchema } from '../sandbox/protocol.js';
import { activateHostDevelopment, deactivateHostDevelopment, hostDevelopmentStatus, recordHostDevelopmentGuestImage } from './host-development.js';

export type CommandRunner = (executable: string, arguments_: readonly string[], input?: string) => unknown;
const run: CommandRunner = (executable, arguments_, input) => {
	const output = execFileSync(executable, [...arguments_], { stdio: input === undefined ? 'inherit' : ['pipe', 'pipe', 'inherit'], ...(input === undefined ? {} : { input, encoding: 'utf8' }), env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', DEBIAN_FRONTEND: 'noninteractive' } });
	return typeof output === 'string' ? output : undefined;
};

function enrollmentReceipt(output: unknown, connectionId: string) {
	if (typeof output !== 'string' || output.trim().length === 0) throw new Error('Provider enrollment returned no receipt.');
	const receipt = JSON.parse(output) as unknown;
	if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('Provider enrollment returned an invalid receipt.');
	const result = receipt as Record<string, unknown>;
	if (result.connectionId !== connectionId) throw new Error('Provider enrollment receipt did not match the requested connection.');
	return result;
}

function sandboxIdentityReceipts(output: unknown) {
	if (typeof output !== 'string' || output.trim().length === 0) throw new Error('Provider identity reconciliation returned no receipt.');
	const receipt = JSON.parse(output) as unknown;
	if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('Provider identity reconciliation returned an invalid receipt.');
	const identities = (receipt as Record<string, unknown>).identities;
	if (!Array.isArray(identities)) throw new Error('Provider identity reconciliation omitted its identity collection.');
	return identities.map((identity) => {
		if (!identity || typeof identity !== 'object' || Array.isArray(identity) || typeof (identity as Record<string, unknown>).connectionId !== 'string') throw new Error('Provider identity reconciliation returned an invalid scoped identity.');
		return identity as Record<string, unknown>;
	});
}

function trustProviderSandboxIdentity(receipt: Record<string, unknown>) {
	const identity = receipt.sandboxIdentity as Record<string, unknown> | undefined, keyId = String(identity?.signingKeyId ?? ''), publicJwk = identity?.publicJwk as Record<string, unknown> | undefined;
	if (!/^provider-[a-f0-9]{16}$/u.test(keyId) || publicJwk?.kty !== 'OKP' || publicJwk.crv !== 'Ed25519' || typeof publicJwk.x !== 'string') throw new Error('Provider enrollment omitted its valid sandbox signing identity.');
	const path = '/etc/treeseed/sandbox/providers.json'; mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
	const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as { schemaVersion: 1; providers: Record<string, unknown> } : { schemaVersion: 1 as const, providers: {} };
	const scoped = { publicJwk: { kty: 'OKP', crv: 'Ed25519', x: publicJwk.x }, providerId: String(receipt.providerId ?? ''), teamId: String(receipt.teamId ?? '') }; if (!scoped.providerId || !scoped.teamId) throw new Error('Provider enrollment omitted its provider or team scope.');
	const prior = current.providers[keyId] as typeof scoped | undefined;
	if (prior && (prior.providerId !== scoped.providerId || prior.teamId !== scoped.teamId || prior.publicJwk?.kty !== scoped.publicJwk.kty || prior.publicJwk.crv !== scoped.publicJwk.crv || prior.publicJwk.x !== scoped.publicJwk.x)) throw new Error('Sandbox signing key identity collision.');
	current.providers[keyId] = scoped; atomicJson(path, current, 0o640);
}

export function bindSandboxGuestTrust(digest: string, command: CommandRunner, path = '/etc/treeseed/sandbox/broker.json') {
	const current = sandboxBrokerConfigurationSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
	if (current.guestImages.length === 0) throw new Error('Sandbox broker has no authorized guest images to bind.');
	const architecture = process.arch === 'arm64' ? 'linux/arm64' : process.arch === 'x64' ? 'linux/amd64' : null;
	if (!architecture) throw new Error(`Unsupported sandbox host architecture ${process.arch}.`);
	const images = [...new Set(current.guestImages.map((entry) => entry.image))];
	for (const image of images) command('/usr/bin/ctr', ['--address', current.containerdAddress, '--namespace', current.namespace, 'images', 'pull', '--platform', architecture, containerdImageReference(image, digest)]);
	const next = { ...current, guestImages: current.guestImages.map((entry) => ({ ...entry, digest })) };
	atomicJson(path, next, 0o640);
	command('/usr/bin/systemctl', ['restart', 'treeseed-sandbox-broker.service']);
	return { changed: current.guestImages.some((entry) => entry.digest !== digest), digest, images };
}

export function importDevelopmentSandboxGuest(archivePath: string, image: string, command: CommandRunner, options: { stateRoot?: string; brokerPath?: string } = {}) {
	const stateRoot = realpathSync(options.stateRoot ?? '/home'), archive = realpathSync(archivePath), metadata = lstatSync(archive);
	if (!archive.startsWith(`${stateRoot}${sep}`) || !/\/\.local\/state\/treeseed\/development\/images\/sandbox-[a-f0-9-]{8,80}\.tar$/u.test(archive)
		|| !metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1_024 || metadata.size > 4_294_967_296 || (metadata.mode & 0o022) !== 0) throw new Error('Development sandbox archive failed bounded local custody validation.');
	const current = sandboxBrokerConfigurationSchema.parse(JSON.parse(readFileSync(options.brokerPath ?? '/etc/treeseed/sandbox/broker.json', 'utf8')));
	const requested = image.replace(/^docker\.io\//u, '').replace(/:local$/u, '');
	const configured = [...new Set(current.guestImages.map(({ image: configuredImage }) => configuredImage.replace(/^docker\.io\//u, '').replace(/(?::[^/]+)?$/u, '')))];
	if (!configured.includes(requested)) throw new Error('Development sandbox image does not match an authorized provider image repository.');
	const architecture = process.arch === 'arm64' ? 'linux/arm64' : process.arch === 'x64' ? 'linux/amd64' : null;
	if (!architecture) throw new Error(`Unsupported sandbox host architecture ${process.arch}.`);
	const sourceImage = image.startsWith('docker.io/') ? image : `docker.io/${image}`;
	command('/usr/bin/ctr', ['--address', current.containerdAddress, '--namespace', current.namespace, 'images', 'import', '--platform', architecture, '--digests', archive]);
	const inspected = String(command('/usr/bin/ctr', ['--address', current.containerdAddress, '--namespace', current.namespace, 'images', 'inspect', sourceImage], '') ?? '');
	const digest = /\b(sha256:[a-f0-9]{64})\b/iu.exec(inspected)?.[1];
	if (!digest) throw new Error('Containerd did not report an immutable target digest for the imported development sandbox image.');
	for (const configuredImage of new Set(current.guestImages.map((entry) => entry.image))) command('/usr/bin/ctr', ['--address', current.containerdAddress, '--namespace', current.namespace, 'images', 'tag', '--force', sourceImage, containerdImageReference(configuredImage, digest)]);
	const next = { ...current, guestImages: current.guestImages.map((entry) => ({ ...entry, digest })) };
	atomicJson(options.brokerPath ?? '/etc/treeseed/sandbox/broker.json', next, 0o640);
	command('/usr/bin/systemctl', ['restart', 'treeseed-sandbox-broker.service']);
	return { image, digest, architecture, imported: true };
}

function bundledComposeFiles(files: readonly string[]) {
	return files.flatMap((file) => {
		const absolute = resolve(paths.bundles, file), root = resolve(paths.bundles);
		if (!absolute.startsWith(`${root}${sep}`)) throw new Error('Compose file is outside the packaged component root.');
		return ['--file', absolute];
	});
}

function componentComposeArguments(componentId: string, files: readonly string[]) {
	return ['--env-file', `/etc/treeseed/components/${componentId}/environment`, ...bundledComposeFiles(files)];
}

function composeProjectContainerIds(projectName: string, command: CommandRunner, runningOnly = false) {
	const output = command('/usr/bin/docker', [
		'ps', ...(runningOnly ? [] : ['--all']), '--quiet', '--filter', `label=com.docker.compose.project=${projectName}`,
	], '');
	return typeof output === 'string' ? output.trim().split(/\s+/u).filter(Boolean) : [];
}

function ensureNetwork(name: 'treeseed-platform' | 'treeseed-edge', command: CommandRunner) {
	try { command('/usr/bin/docker', ['network', 'inspect', name]); }
	catch { command('/usr/bin/docker', ['network', 'create', '--driver', 'bridge', '--label', 'org.treeseed.manager=true', name]); }
}

const aiRuntime = {
	inference: { componentId: 'ai-inference', projectName: 'treeseed-ai-inference', gateService: 'inference-api', gpuServices: ['inference-vllm'] },
	training: { componentId: 'ai-training', projectName: 'treeseed-ai-training', gateService: 'training-api', gpuServices: ['training-marker', 'training-axolotl'] },
} as const;

function aiCompose(role: keyof typeof aiRuntime, files: readonly string[]) {
	const runtime = aiRuntime[role];
	return ['compose', ...componentComposeArguments(runtime.componentId, files), '--project-name', runtime.projectName];
}

function aiGate(role: keyof typeof aiRuntime, action: 'open' | 'close' | 'status', files: readonly string[], command: CommandRunner) {
	const runtime = aiRuntime[role];
	const output = command('/usr/bin/docker', [...aiCompose(role, files), 'exec', '-T', runtime.gateService, '/usr/local/bin/treeseed-ai-gpu-gate', action], '');
	if (typeof output !== 'string') throw new Error(`AI ${role} gate returned no status.`);
	const value = JSON.parse(output) as { admission?: unknown; active?: unknown };
	if ((value.admission !== 'open' && value.admission !== 'closed') || !Number.isInteger(value.active) || Number(value.active) < 0) throw new Error(`AI ${role} gate returned invalid status.`);
	return { role, admission: value.admission, active: Number(value.active) };
}

function aiWorkload(role: keyof typeof aiRuntime, action: 'start' | 'stop' | 'status' | 'warm', files: readonly string[], waitTimeoutSeconds: number, command: CommandRunner) {
	const runtime = aiRuntime[role], compose = aiCompose(role, files);
	if (action === 'warm') {
		if (role !== 'inference') throw new Error('Only the inference workload supports warming.');
		command('/usr/bin/docker', [...compose, 'exec', '-T', 'inference-vllm', '/usr/local/bin/treeseed-ai-warm'], '');
		return { role, action, ready: true };
	}
	if (action === 'start') command('/usr/bin/docker', [...compose, 'up', '--detach', '--no-deps', '--wait', '--wait-timeout', String(waitTimeoutSeconds), ...runtime.gpuServices]);
	if (action === 'stop') command('/usr/bin/docker', [...compose, 'stop', ...runtime.gpuServices]);
	const output = command('/usr/bin/docker', [...compose, 'ps', '--status', 'running', '--services', ...runtime.gpuServices], '');
	const running = new Set(typeof output === 'string' ? output.trim().split(/\s+/u).filter(Boolean) : []);
	return { role, action, running: runtime.gpuServices.filter((service) => running.has(service)), ready: runtime.gpuServices.every((service) => running.has(service)) };
}

function resetUnacceptedComponentState(componentId: string) {
	if (existsSync(`${paths.managerState}/current-receipt.json`) || existsSync(`${paths.managerState}/active-components.json`)) throw new Error('Accepted component state cannot be reset by bootstrap recovery.');
	const root = resolve(paths.components), target = resolve(root, componentId);
	if (!target.startsWith(`${root}${sep}`)) throw new Error('Component state reset escaped the managed state root.');
	rmSync(target, { recursive: true, force: true });
}

function ensureAiModeCredentials(command: CommandRunner) {
	const root = '/etc/treeseed/credentials', key = `${root}/ai-mode-client.key`, certificate = `${root}/ai-mode-client.crt`, ca = `${root}/ai-mode-ca.crt`;
	if (!existsSync(key) || !existsSync(certificate) || !existsSync(ca)) {
		mkdirSync(root, { recursive: true, mode: 0o700 });
		const enrollment = enrollClient('client-ai-lab-mode', command);
		writeFileSync(key, enrollment.privateKey, { mode: 0o600 });
		writeFileSync(certificate, enrollment.certificate, { mode: 0o600 });
		writeFileSync(ca, enrollment.certificateAuthority, { mode: 0o644 });
	}
	return { clientCommonName: 'client-ai-lab-mode', key, certificate, certificateAuthority: ca };
}

export function repairSandboxTrustAnchor(operations = { exists: existsSync, chmod: chmodSync }) {
	const path = '/etc/treeseed/sandbox/relay-ca.crt';
	if (!operations.exists(path)) return { repaired: false, reason: 'not_initialized' };
	operations.chmod(path, 0o644);
	return { repaired: true, path, mode: '0644' };
}

const r2CredentialIds = ['cloudflare-r2-account-id', 'cloudflare-r2-management-token', 'cloudflare-r2-bucket-name', 'cloudflare-r2-access-key-id', 'cloudflare-r2-secret-access-key'] as const;
const storageSafe = (value: string) => value.replaceAll(/[^a-z0-9-]/giu, '-').toLowerCase();
function r2StorageStatus(controlPlaneId: string) {
	const metadata = `${paths.managerState}/storage/cloudflare-r2/control-planes/${storageSafe(controlPlaneId)}.json`;
	const binding = existsSync(metadata) ? JSON.parse(readFileSync(metadata, 'utf8')) as Record<string, unknown> : null;
	return { metadataReady: Boolean(binding), childCredentialsReady: r2CredentialIds.every((id) => existsSync(`/etc/treeseed/credentials/${id}`)), metadata, binding };
}

function installR2Storage(operation: SupervisorOperation & { operation: 'storage.r2.install' }, command: CommandRunner) {
	const storage = `${paths.managerState}/storage/cloudflare-r2`, authorities = `${storage}/authorities`, controlPlanes = `${storage}/control-planes`, credentials = '/etc/treeseed/credentials';
	mkdirSync(authorities, { recursive: true, mode: 0o700 }); mkdirSync(controlPlanes, { recursive: true, mode: 0o700 }); mkdirSync(credentials, { recursive: true, mode: 0o700 });
	writeFileSync(`${authorities}/${operation.accountId}.token`, operation.bootstrapToken, { mode: 0o600 });
	const values: Record<(typeof r2CredentialIds)[number], string> = {
		'cloudflare-r2-account-id': operation.accountId, 'cloudflare-r2-management-token': operation.managementToken,
		'cloudflare-r2-bucket-name': operation.bucket, 'cloudflare-r2-access-key-id': operation.accessKeyId,
		'cloudflare-r2-secret-access-key': operation.secretAccessKey,
	};
	for (const [id, secret] of Object.entries(values)) writeFileSync(`${credentials}/${id}`, secret, { mode: 0o600 });
	atomicJson(`${controlPlanes}/${storageSafe(operation.controlPlaneId)}.json`, { schemaVersion: 'treeseed.host-storage-binding/v2', backend: 'cloudflare-r2', controlPlaneId: operation.controlPlaneId,
		accountId: operation.accountId, bucket: operation.bucket, tokens: { privacy: operation.privacyTokenId, publisher: operation.publisherTokenId }, updatedAt: new Date().toISOString() }, 0o600);
	command('/usr/bin/chown', ['-R', 'treeseed-manager:treeseed-manager', storage]);
	return r2StorageStatus(operation.controlPlaneId);
}

export function recoverInvalidConfiguration(configuration: SupervisorOperation & { operation: 'configuration.recover' }, configurationPath: string = paths.configuration, archiveRoot: string = `${paths.managerState}/invalid-configurations`) {
	if (tryLoadHostConfiguration(configurationPath)) throw new Error('Configuration recovery is only available when the installed configuration is invalid.');
	const raw = readFileSync(configurationPath, 'utf8');
	mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
	const archive = `${archiveRoot}/${Date.now()}-${process.pid}.json.invalid`;
	writeFileSync(archive, raw, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
	atomicJson(configurationPath, configuration.configuration, 0o640);
	return { recovered: true, archive };
}

export function executeSupervisorOperation(input: unknown, command: CommandRunner = run, restoreSecrets: (componentId: string) => unknown = restoreComponentSecretFiles) {
	if (process.getuid?.() !== 0 && command === run) throw new Error('TreeSeed supervisor must run as root.');
	const operation: SupervisorOperation = supervisorOperationSchema.parse(input);
	switch (operation.operation) {
		case 'supervisor.ping': return { ready: true };
		case 'security.plan': return providerSecurityPlan();
		case 'security.status': return providerSecurityStatus();
		case 'security.verify': return verifyProviderSecurity(command);
		case 'security.initialize': return initializeProviderSecurity(operation.recoveryBundle, operation.recoveryPassphrase, command);
		case 'provider.credentials.status': return { configuredCredentialIds: operation.credentialIds.filter((credentialId) => existsSync(`/etc/treeseed/credentials/${credentialId}.cred`)) };
		case 'provider.credential.initialize': return initializeProviderCredential(operation.initializerId, operation.sourceId, operation.secret, command);
		case 'security.rotate': return rotateProviderSecurityKey(operation, command);
		case 'security.recovery.verify': return verifyProviderRecoveryBundle(operation.recoveryBundle, operation.recoveryPassphrase);
		case 'sandbox.status':
		case 'sandbox.doctor': return inspectSandboxHost(loadSandboxBrokerConfiguration(), { requireBrokerSocket: true });
		case 'sandbox.trust-anchor.repair': return repairSandboxTrustAnchor();
		case 'sandbox.guest-trust.digests': return loadSandboxBrokerConfiguration().guestImages.map(({ digest }) => digest);
		case 'sandbox.guest-trust.bind': return bindSandboxGuestTrust(operation.digest, command);
		case 'sandbox.guest-image.import': {
			const imported = importDevelopmentSandboxGuest(operation.archivePath, operation.image, command);
			recordHostDevelopmentGuestImage(imported.digest);
			return imported;
		}
		case 'apt.refresh':
		case 'apt.install':
			atomicJson(`${paths.managerState}/pending-packages.json`, operation, 0o600);
			command('/usr/bin/systemctl', ['start', 'treeseed-manager-apt-helper.service']);
			if (operation.operation === 'apt.refresh' && existsSync(`${paths.managerState}/last-apt-result.json`)) return JSON.parse(readFileSync(`${paths.managerState}/last-apt-result.json`, 'utf8')) as unknown;
			break;
		case 'component.configure':
			if (operation.sandboxGuestImageDigest) bindSandboxGuestTrust(operation.sandboxGuestImageDigest, command);
			configureComponent(operation.componentId, operation.connectionEnvironment, operation.secretFileIds ?? [], operation.sandboxGuestImageDigest); break;
		case 'development.environment': return { environment: resolveDevelopmentSecretEnvironment(loadHostConfiguration(), operation.componentId, operation.secretRefs, operation.connectionEnvironment) };
		case 'component.reset-unaccepted': resetUnacceptedComponentState(operation.componentId); break;
		case 'provider.enroll': {
			const marker = `${paths.managerState}/provider-enrollments/${operation.connectionId}.json`;
			if (existsSync(marker)) {
				const input = `${JSON.stringify({ action: 'identity', connectionId: operation.connectionId })}\n`;
				const identity = enrollmentReceipt(command('/usr/bin/docker', ['compose', ...componentComposeArguments('agent', operation.files), '--project-name', operation.projectName, 'run', '--rm', '--no-deps', '-T', 'manager', 'enroll', '--json'], input), operation.connectionId);
				trustProviderSandboxIdentity(identity);
				const current = JSON.parse(readFileSync(marker, 'utf8')) as Record<string, unknown>;
				const result = { ...current, sandboxSigningKeyId: (identity.sandboxIdentity as Record<string, unknown>).signingKeyId };
				atomicJson(marker, result, 0o600);
				return result;
			}
			const secretPath = `/etc/treeseed/credentials/${operation.registrationSecretId}`;
			const enrollmentToken = readFileSync(secretPath, 'utf8').replace(/\r?\n$/u, '');
			if (!enrollmentToken) throw new Error('Provider registration credential is empty.');
			const input = `${JSON.stringify({ action: 'begin', connectionId: operation.connectionId, teamId: operation.teamId, controlPlaneUrl: operation.controlPlaneUrl, controlPlaneAudience: operation.controlPlaneAudience, enrollmentToken })}\n`;
			const enrollment = enrollmentReceipt(command('/usr/bin/docker', ['compose', ...componentComposeArguments('agent', operation.files), '--project-name', operation.projectName, 'run', '--rm', '--no-deps', '-T', 'manager', 'enroll', '--json'], input), operation.connectionId);
			trustProviderSandboxIdentity(enrollment);
			unlinkSync(secretPath);
			const result = { connectionId: operation.connectionId, state: 'pending-approval', oneTimeCredentialRemoved: true, sandboxSigningKeyId: (enrollment.sandboxIdentity as Record<string, unknown>).signingKeyId };
			atomicJson(marker, result, 0o600);
			return result;
		}
		case 'provider.enrollment-handoff': {
			const input = `${JSON.stringify(operation.payload)}\n`;
			const output = command('/usr/bin/docker', ['compose', ...componentComposeArguments('agent', operation.files), '--project-name', operation.projectName, 'run', '--rm', '--no-deps', '-T', 'manager', 'enroll', '--json'], input);
			return enrollmentReceipt(output, operation.payload.connectionId);
		}
		case 'compose.activate':
			ensureNetwork('treeseed-platform', command);
			try { command('/usr/bin/docker', ['compose', ...componentComposeArguments(operation.componentId, operation.files), '--project-name', operation.projectName, 'up', '--detach', '--remove-orphans', '--wait', '--wait-timeout', String(operation.waitTimeoutSeconds), ...(operation.services ?? [])]); }
			catch (error) { restoreSecrets(operation.componentId); throw error; }
			if (operation.componentId === 'agent') {
				const input = `${JSON.stringify({ action: 'identities' })}\n`;
				const output = command('/usr/bin/docker', ['compose', ...componentComposeArguments('agent', operation.files), '--project-name', operation.projectName, 'run', '--rm', '--no-deps', '-T', 'manager', 'enroll', '--json'], input);
				for (const identity of sandboxIdentityReceipts(output)) trustProviderSandboxIdentity(identity);
			}
			break;
		case 'compose.stop': try {
			if (composeProjectContainerIds(operation.projectName, command, true).length === 0) break;
			try { command('/usr/bin/docker', ['compose', ...componentComposeArguments(operation.componentId, operation.files), '--project-name', operation.projectName, 'stop']); }
			catch (error) {
				const remaining = composeProjectContainerIds(operation.projectName, command, true);
				if (remaining.length === 0) break;
				command('/usr/bin/docker', ['stop', ...remaining]);
				if (composeProjectContainerIds(operation.projectName, command, true).length > 0) throw error;
			}
		} finally { restoreSecrets(operation.componentId); } break;
		case 'compose.status': {
			const containers = composeProjectContainerIds(operation.projectName, command);
			const running = composeProjectContainerIds(operation.projectName, command, true);
			return { present: containers.length > 0, running: running.length > 0, containers: containers.length, runningContainers: running.length };
		}
		case 'compose.remove': try { command('/usr/bin/docker', ['compose', ...componentComposeArguments(operation.componentId, operation.files), '--project-name', operation.projectName, 'down', '--remove-orphans']); } finally { restoreSecrets(operation.componentId); } break;
		case 'ai.gpu.gate': return aiGate(operation.role, operation.action, operation.files, command);
		case 'ai.gpu.workload': return aiWorkload(operation.role, operation.action, operation.files, operation.waitTimeoutSeconds, command);
		case 'ai.mode.credentials.ensure': return ensureAiModeCredentials(command);
		case 'storage.r2.status': return r2StorageStatus(operation.controlPlaneId);
		case 'storage.r2.install': return installR2Storage(operation, command);
		case 'host.development.activate': {
			ensureSandboxNetwork(command);
			if (operation.activation.guestImageDigest) bindSandboxGuestTrust(operation.activation.guestImageDigest, command);
			return activateHostDevelopment(operation.activation, command);
		}
		case 'host.development.status': return hostDevelopmentStatus();
		case 'host.development.deactivate': return deactivateHostDevelopment(command);
		case 'systemd.control': command('/usr/bin/systemctl', [operation.action, operation.unit]); break;
		case 'edge.apply': {
			const target = `${paths.edge}/Caddyfile`, temporary = `${target}.new`;
			mkdirSync(dirname(target), { recursive: true, mode: 0o750 });
			writeFileSync(temporary, operation.caddyfile, { mode: 0o640 });
			generateEdgeCertificate(operation.aliases, command);
			command('/usr/bin/docker', ['compose', '--file', '/usr/share/treeseed/edge/compose.yml', 'run', '--rm', '--no-deps', 'caddy', 'caddy', 'validate', '--config', temporary, '--adapter', 'caddyfile']);
			renameSync(temporary, target);
			command('/usr/bin/systemctl', ['reload-or-restart', 'treeseed-edge.service']);
			break;
		}
		case 'backup.create': return createGenerationBackup(operation.generation, command);
		case 'backup.inspect': return inspectGenerationBackup(operation.generation);
		case 'backup.list': return listGenerationBackups();
		case 'recovery.restore': return restoreGenerationBackup(operation.generation, command);
		case 'platform.reset': {
			const result = resetPlatformState({ components: operation.componentDataRoot, componentConfiguration: '/etc/treeseed/components', managerState: paths.managerState, backups: paths.backups });
			// The supervisor performs deletion as root, but reconciliation and the
			// local manager API deliberately run as treeseed-manager. Restore their
			// custody before the supervisor records completion or reset continues.
			// Materialize the ledger first so the root completion event appends to
			// the manager-owned inode instead of recreating it as root.
			writeFileSync(`${paths.managerState}/events.jsonl`, '', { encoding: 'utf8', mode: 0o640 });
			command('/usr/bin/chown', ['-R', 'treeseed-manager:treeseed-manager', paths.managerState]);
			return result;
		}
		case 'platform.uninstall.plan': return planHostUninstall();
		case 'platform.uninstall.execute': return scheduleHostUninstall(operation.purgeSecurity);
		case 'cli.configure': {
			mkdirSync(paths.cli, { recursive: true, mode: 0o755 });
			writeFileSync(`${paths.cli}/api-base-url`, `${operation.controlPlaneUrl}\n`, { encoding: 'utf8', mode: 0o644 });
			writeFileSync(`${paths.cli}/localhost-ca.crt`, readFileSync(`${paths.tls}/ca.crt`), { mode: 0o644 });
			break;
		}
		case 'manager.restart': command('/usr/bin/systemctl', ['--no-block', 'start', 'treeseed-manager-restart.service']); break;
		case 'configuration.replace': {
			const current = loadHostConfiguration();
			assertNewGeneration(current, operation.configuration);
			atomicJson(paths.configuration, operation.configuration, 0o640);
			break;
		}
		case 'configuration.adopt': {
			const current = loadHostConfiguration();
			if (current.configurationId === operation.configuration.configurationId) throw new Error('Configuration adoption requires a different configuration identity.');
			atomicJson(`${paths.managerState}/adopted-configurations/${current.configurationId}-${current.generation}.json`, current, 0o600);
			atomicJson(paths.configuration, operation.configuration, 0o640);
			break;
		}
		case 'configuration.recover': return recoverInvalidConfiguration(operation);
		case 'pki.enroll': return enrollClient(operation.clientId, command);
	}
}
