import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { HostConfiguration } from '@treeseed/sdk/deployment';
import { loadHostConfiguration } from '../core/configuration.js';
import { paths } from '../core/paths.js';
import type { CommandRunner } from '../supervisor/execute.js';
import { createRecoveryBundle, openRecoveryBundle, verifyRecoveryBundle } from './recovery-bundle.js';
import { inspectSandboxHost } from '../sandbox/doctor.js';
import { loadSandboxBrokerConfiguration } from '../sandbox/configuration.js';
import { containerdImageReference } from '../sandbox/image-reference.js';
import { credentialInitializer, credentialRoot as registeredCredentialRoot } from './credential-initializers.js';
import { ensureSandboxNetwork } from '../sandbox/network.js';

const credentialRoot = registeredCredentialRoot;
const mapperName = 'treeseed-provider-data';
const credentialIds = ['application-credential-kek-v1', 'application-diagnostics-kek-v1', 'application-backup-kek-v1'] as const;

export function providerSecuritySettings(configuration: HostConfiguration = loadHostConfiguration()) {
	const security = configuration.security;
	if (!security) throw new Error('Host security configuration is not defined.');
	const volume = security.providerVolume, backing = resolve(volume.backingPath), mount = resolve(volume.mountPath);
	const production = configuration.runtime.environment === 'production';
	if (production && backing !== '/var/lib/treeseed/encrypted/provider-data.luks') throw new Error('Production provider volume backing path is not accepted.');
	if (!production && backing !== '/var/lib/treeseed/encrypted/provider-data.luks' && !/\/\.treeseed\/data\/\.encrypted\/provider-data\.luks$/u.test(backing)) throw new Error('Development provider volume backing path is not accepted.');
	if (lstatIfPresent(backing)?.isSymbolicLink() || lstatIfPresent(mount)?.isSymbolicLink()) throw new Error('Provider volume paths may not be symbolic links.');
	return { configuration, security, volume, backing, mount, production };
}
function lstatIfPresent(path: string) { try { return lstatSync(path); } catch { return null; } }
function key() { return randomBytes(32).toString('base64url'); }
function mounted(path: string) {
	try { return readFileSync('/proc/self/mountinfo', 'utf8').split('\n').some((line) => line.split(' ')[4] === path); } catch { return false; }
}
function inventory(root: string, relative = ''): string[] {
	const directory = resolve(root, relative);
	if (!existsSync(directory)) return [];
	return readdirSync(directory).sort().flatMap((name) => {
		const child = relative ? `${relative}/${name}` : name, path = resolve(root, child), stat = lstatSync(path);
		if (stat.isDirectory()) return [`d:${child}:${stat.mode & 0o7777}`, ...inventory(root, child)];
		if (stat.isSymbolicLink()) return [`l:${child}:${readlinkSync(path)}`];
		return [`f:${child}:${stat.size}:${createHash('sha256').update(readFileSync(path)).digest('hex')}:${stat.mode & 0o7777}`];
	});
}

export function providerSecurityPlan() {
	const value = providerSecuritySettings();
	return { mutation: false, sandbox: value.security.sandbox, providerVolume: { ...value.volume, backingPath: value.backing, mountPath: value.mount },
		unlockProtection: value.production ? 'hardware-backed' : 'development-systemd-credential', steps: ['drain-assignments', 'encrypted-backup', 'format-luks2', 'copy-and-verify', 'switch-mount', 'health-gate', 'rotate-historical-credentials'] };
}

export function providerSecurityStatus() {
	const value = providerSecuritySettings(), mapper = `/dev/mapper/${mapperName}`;
	return { configured: true, backingExists: existsSync(value.backing), mapperOpen: existsSync(mapper), mounted: mounted(value.mount),
		credentialKeksReady: credentialIds.every((id) => existsSync(`${credentialRoot}/${id}.cred`)), recoveryBundleVerified: existsSync(`${paths.securityState}/recovery-verified.json`),
		sandboxSocketReady: existsSync(paths.sandboxSocket), unlock: value.volume.unlock };
}

export function verifyProviderSecurity(command: CommandRunner) {
	const value = providerSecuritySettings(), status = providerSecurityStatus();
	let luks2 = false;
	if (status.backingExists) { try { command('/usr/sbin/cryptsetup', ['isLuks', '--type', 'luks2', value.backing]); luks2 = true; } catch { luks2 = false; } }
	const mountLine = readFileSync('/proc/self/mountinfo', 'utf8').split('\n').find((line) => line.includes(` ${value.mount} `)) ?? '';
	const secureMountOptions = ['nodev', 'nosuid', 'noexec'].every((option) => mountLine.split(' - ')[0]?.split(' ')[5]?.split(',').includes(option));
	return { ...status, luks2, secureMountOptions, verified: luks2 && status.mounted && secureMountOptions && status.credentialKeksReady };
}

type SandboxCredentialActivation = { authenticationMode: 'api-key' | 'codex-subscription'; credentialId: string };

function configureBrokerCredential(activation: SandboxCredentialActivation | undefined) {
	const dropInRoot = '/etc/systemd/system/treeseed-sandbox-broker.service.d', dropIn = `${dropInRoot}/20-execution-provider-credential.conf`;
	mkdirSync(dropInRoot, { recursive: true, mode: 0o755 });
	if (!activation) { rmSync(dropIn, { force: true }); return; }
	writeFileSync(dropIn, `[Service]\nLoadCredentialEncrypted=${activation.credentialId}:${credentialRoot}/${activation.credentialId}.cred\n`, { mode: 0o644 });
}

function completeProviderSecurity(value: ReturnType<typeof providerSecuritySettings>, command: CommandRunner, activation?: SandboxCredentialActivation) {
	const guestImages = [...new Map(value.security.sandbox.profiles.map((profile) => [`${profile.guestImage}@${profile.guestImageDigest}`, { image: profile.guestImage, digest: profile.guestImageDigest,
		profiles: value.security.sandbox.profiles.filter((candidate) => candidate.guestImage === profile.guestImage && candidate.guestImageDigest === profile.guestImageDigest).map((candidate) => candidate.id) }])).values()];
	mkdirSync('/etc/treeseed/sandbox', { recursive: true, mode: 0o750 }); mkdirSync('/etc/cni/net.d', { recursive: true, mode: 0o755 });
	if (!existsSync('/etc/treeseed/sandbox/relay.crt') || !existsSync(`${credentialRoot}/sandbox-relay-tls-key.cred`)) throw new Error('Sandbox completion requires the sealed relay credential from provider-volume initialization.');
	if (!existsSync('/etc/treeseed/sandbox/providers.json')) writeFileSync('/etc/treeseed/sandbox/providers.json', `${JSON.stringify({ schemaVersion: 1, providers: {} })}\n`, { mode: 0o640, flag: 'wx' });
	ensureSandboxNetwork(command);
	const modelGateway = activation ? { upstreamBaseUrl: value.security.sandbox.modelGateway.upstreamBaseUrl, authenticationMode: activation.authenticationMode, credentialFile: `/run/credentials/${activation.credentialId}`, allowedProviders: [value.security.sandbox.modelGateway.provider], allowedModels: value.security.sandbox.modelGateway.allowedModels } : undefined;
	writeFileSync('/etc/treeseed/sandbox/broker.json', `${JSON.stringify({ socketPath: value.security.sandbox.brokerSocket, containerdAddress: '/run/containerd/containerd.sock', namespace: 'treeseed-sandboxes', runtime: 'io.containerd.kata.v2', stateRoot: '/var/lib/treeseed/sandboxes', trustedProvidersPath: '/etc/treeseed/sandbox/providers.json',
		relay: { listenHost: '10.89.0.1', port: 7443, publicUrl: 'https://10.89.0.1:7443', certificateFile: '/etc/treeseed/sandbox/relay.crt', privateKeyFile: '/run/credentials/relay-tls-key' },
		...(modelGateway ? { modelGateway } : {}), guestImages })}\n`, { mode: 0o640 });
	for (const image of guestImages) command('/usr/bin/ctr', ['--address', '/run/containerd/containerd.sock', '--namespace', 'treeseed-sandboxes', 'images', 'pull', '--platform', 'linux/amd64', containerdImageReference(image.image, image.digest)]);
	configureBrokerCredential(activation); command('/usr/bin/systemctl', ['daemon-reload']);
	command('/usr/bin/systemctl', ['restart', 'treeseed-provider-volume.service']); command('/usr/bin/systemctl', ['restart', 'treeseed-sandbox-broker.service']);
	const verified = verifyProviderSecurity(command); let sandbox = inspectSandboxHost(loadSandboxBrokerConfiguration(), { requireBrokerSocket: true });
	const readinessDeadline = Date.now() + 30_000;
	while (!sandbox.ready && Date.now() < readinessDeadline) {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
		sandbox = inspectSandboxHost(loadSandboxBrokerConfiguration(), { requireBrokerSocket: true });
	}
	const completedAt = new Date().toISOString();
	const receipt = { schemaVersion: 'treeseed.host-security-receipt/v1', receiptId: `security-${randomUUID()}`, hostId: value.configuration.host.id,
		sandbox: { runtime: 'kata-runtime-rs-qemu', kvmReady: sandbox.checks.kvm, brokerReady: sandbox.ready, guestImageDigests: value.security.sandbox.profiles.map((profile) => profile.guestImageDigest) },
		providerVolume: { encrypted: verified.luks2, format: 'luks2', mountPath: value.mount, unlock: value.volume.unlock }, providerCredentials: { configured: activation ? [activation.credentialId] : [], separatelyManaged: true },
		keys: { provider: 'systemd-credential', activeCredentialVersion: value.security.applicationEncryption.activeKeyVersion, activeDiagnosticsVersion: value.security.applicationEncryption.diagnosticsKeyVersion, recoveryBundleVerified: true },
		state: verified.verified && sandbox.ready ? 'known-good' : 'blocked', completedAt };
	writeFileSync(`${paths.securityState}/security-receipt.json`, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
	if (!sandbox.ready) {
		const failed = Object.entries(sandbox.checks).filter(([, ready]) => !ready).map(([name]) => name);
		throw new Error(`Sandbox broker did not become ready within 30 seconds; failed checks: ${failed.join(', ') || 'unknown'}. The initialized security state is resumable.`);
	}
	return { ...verified, receipt };
}

export function initializeProviderSecurity(recoveryBundle: string, passphrase: string, command: CommandRunner) {
	const value = providerSecuritySettings(), current = providerSecurityStatus();
	const initialized = existsSync(`${paths.securityState}/initialized.json`);
	const priorReceipt = existsSync(`${paths.securityState}/security-receipt.json`) ? JSON.parse(readFileSync(`${paths.securityState}/security-receipt.json`, 'utf8')) as { state?: string } : null;
	const resumable = current.backingExists && !current.mapperOpen && !current.mounted && !current.credentialKeksReady && current.recoveryBundleVerified && !initialized;
	const completing = current.backingExists && current.credentialKeksReady && current.recoveryBundleVerified && initialized && priorReceipt?.state !== 'known-good';
	if ((current.backingExists || current.mapperOpen || current.mounted) && !resumable && !completing) throw new Error('Provider encryption is already initialized or contains a non-resumable partial state; run security verify before retrying.');
	if (completing) {
		verifyProviderRecoveryBundle(recoveryBundle, passphrase);
		if (!current.mounted) mountProviderSecurityVolume();
		return completeProviderSecurity(value, command);
	}
	for (const project of ['treeseed-agent', 'treeseed-capacity-provider']) {
		const active = command('/usr/bin/docker', ['ps', '--quiet', '--filter', `label=com.docker.compose.project=${project}`], '');
		if (typeof active === 'string' && active.trim()) throw new Error('Provider writers must be drained and stopped before encrypted-volume initialization.');
	}
	mkdirSync(dirname(value.backing), { recursive: true, mode: 0o700 }); mkdirSync(credentialRoot, { recursive: true, mode: 0o700 }); mkdirSync(paths.securityState, { recursive: true, mode: 0o700 });
	const recovered = resumable ? openRecoveryBundle(recoveryBundle, passphrase).secrets : null;
	const volumeKey = key(), recoveryKey = recovered?.volumeRecoveryKey ?? key();
	const applicationKeks = recovered?.applicationKeks ?? Object.fromEntries(credentialIds.map((id) => [id, key()]));
	if (!credentialIds.every((id) => typeof applicationKeks[id] === 'string')) throw new Error('Recovery bundle is missing an application encryption key required by this host configuration.');
	if (!resumable) createRecoveryBundle(recoveryBundle, passphrase, { volumeRecoveryKey: recoveryKey, applicationKeks });
	verifyProviderRecoveryBundle(recoveryBundle, passphrase);
	const keyRoot = '/run/treeseed/security-initialize'; mkdirSync(keyRoot, { recursive: true, mode: 0o700 });
	try {
	const volumeKeyPath = `${keyRoot}/volume.key`, recoveryKeyPath = `${keyRoot}/recovery.key`;
	writeFileSync(volumeKeyPath, volumeKey, { mode: 0o600, flag: 'wx' }); writeFileSync(recoveryKeyPath, recoveryKey, { mode: 0o600, flag: 'wx' });
	if (resumable) {
		command('/usr/sbin/cryptsetup', ['isLuks', '--type', 'luks2', value.backing]);
		command('/usr/sbin/cryptsetup', ['open', '--readonly', '--type', 'luks2', '--key-file', recoveryKeyPath, value.backing, mapperName]);
		try {
			const filesystem = command('/usr/bin/lsblk', ['--noheadings', '--output', 'FSTYPE', `/dev/mapper/${mapperName}`], '');
			if (typeof filesystem === 'string' && filesystem.trim()) throw new Error('Partial provider volume contains a filesystem and cannot be recreated automatically.');
		} finally { command('/usr/sbin/cryptsetup', ['close', mapperName]); }
		rmSync(value.backing);
	}
	command('/usr/bin/truncate', ['--size', String(value.volume.sizeBytes), value.backing]);
	command('/usr/sbin/cryptsetup', ['luksFormat', '--batch-mode', '--type', 'luks2', '--pbkdf', 'argon2id', '--key-file', volumeKeyPath, value.backing]);
	command('/usr/sbin/cryptsetup', ['luksAddKey', '--key-file', volumeKeyPath, '--new-keyfile', recoveryKeyPath, value.backing]);
	if (value.volume.unlock === 'tpm2') command('/usr/bin/systemd-cryptenroll', ['--unlock-key-file=-', '--tpm2-device=auto', value.backing], volumeKey);
	else command('/usr/bin/systemd-creds', ['encrypt', '--name=treeseed-provider-volume-key', '-', `${credentialRoot}/treeseed-provider-volume-key.cred`], volumeKey);
	for (const [id, secret] of Object.entries(applicationKeks)) command('/usr/bin/systemd-creds', ['encrypt', `--name=${id}`, '-', `${credentialRoot}/${id}.cred`], secret);
	const relayRoot = `${keyRoot}/relay`; mkdirSync(relayRoot, { mode: 0o700 });
	command('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-keyout', `${relayRoot}/ca.key`, '-out', `${relayRoot}/ca.crt`, '-subj', '/CN=TreeSeed Assignment Relay CA', '-days', '3650', '-sha256']);
	command('/usr/bin/openssl', ['req', '-newkey', 'rsa:3072', '-nodes', '-keyout', `${relayRoot}/relay.key`, '-out', `${relayRoot}/relay.csr`, '-subj', '/CN=treeseed-sandbox-relay']);
	writeFileSync(`${relayRoot}/relay.ext`, 'subjectAltName=DNS:treeseed-sandbox-relay,IP:10.89.0.1\nextendedKeyUsage=serverAuth\n', { mode: 0o600 });
	command('/usr/bin/openssl', ['x509', '-req', '-in', `${relayRoot}/relay.csr`, '-CA', `${relayRoot}/ca.crt`, '-CAkey', `${relayRoot}/ca.key`, '-CAcreateserial', '-out', `${relayRoot}/relay.crt`, '-days', '825', '-sha256', '-extfile', `${relayRoot}/relay.ext`]);
	command('/usr/bin/systemd-creds', ['encrypt', '--name=relay-tls-key', '-', `${credentialRoot}/sandbox-relay-tls-key.cred`], readFileSync(`${relayRoot}/relay.key`, 'utf8'));
	command('/usr/sbin/cryptsetup', ['open', '--type', 'luks2', '--key-file', volumeKeyPath, value.backing, mapperName]);
	command('/usr/sbin/mkfs.ext4', ['-F', '-L', 'treeseed-provider-data', `/dev/mapper/${mapperName}`]);
	const staging = '/run/treeseed/provider-volume-migration'; mkdirSync(staging, { recursive: true, mode: 0o700 });
	command('/usr/bin/mount', ['--options', 'nodev,nosuid,noexec', `/dev/mapper/${mapperName}`, staging]);
	const before = existsSync(value.mount) && statSync(value.mount).isDirectory() ? inventory(value.mount) : [];
	if (before.length) {
		mkdirSync(`${staging}/.treeseed-backups`, { mode: 0o700 });
		command('/usr/bin/tar', ['--create', '--gzip', '--file', `${staging}/.treeseed-backups/pre-migration.tar.gz`, '--directory', value.mount, '--numeric-owner', '.']);
		command('/usr/bin/rsync', ['--archive', '--hard-links', '--acls', '--xattrs', '--numeric-ids', '--fsync', `${value.mount}/`, `${staging}/`]);
		const after = inventory(staging).filter((entry) => !entry.includes('.treeseed-backups'));
		if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Encrypted provider-volume inventory verification failed.');
	}
	command('/usr/bin/umount', [staging]);
	if (existsSync(value.mount)) renameSync(value.mount, `${value.mount}.plaintext-rollback-${Date.now()}`);
	mkdirSync(value.mount, { recursive: true, mode: 0o700 }); command('/usr/bin/mount', ['--options', 'nodev,nosuid,noexec', `/dev/mapper/${mapperName}`, value.mount]);
	writeFileSync(`${paths.securityState}/initialized.json`, `${JSON.stringify({ schemaVersion: 1, backing: value.backing, mount: value.mount, recoveryBundleCreated: true, initializedAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: 'wx' });
	mkdirSync('/etc/treeseed/sandbox', { recursive: true, mode: 0o750 });
	writeFileSync('/etc/treeseed/sandbox/relay-ca.crt', readFileSync(`${relayRoot}/ca.crt`), { mode: 0o644 }); writeFileSync('/etc/treeseed/sandbox/relay.crt', readFileSync(`${relayRoot}/relay.crt`), { mode: 0o644 });
	chmodSync('/etc/treeseed/sandbox/relay-ca.crt', 0o644); chmodSync('/etc/treeseed/sandbox/relay.crt', 0o644);
	return completeProviderSecurity(value, command);
	} finally { rmSync(keyRoot, { recursive: true, force: true }); }
}

export function initializeProviderCredential(initializerId: string, sourceId: string, secret: string, command: CommandRunner) {
	const initializer = credentialInitializer(initializerId), source = initializer.sources.find((candidate) => candidate.id === sourceId);
	if (!source) throw new Error(`Credential source ${sourceId} is not registered by ${initializerId}.`);
	const bytes = Buffer.byteLength(secret);
	if (bytes < source.minimumBytes || bytes > source.maximumBytes) throw new Error(`Credential input must contain between ${source.minimumBytes} and ${source.maximumBytes} bytes.`);
	if (source.contentType === 'application/json') JSON.parse(secret);
	const security = verifyProviderSecurity(command);
	if (!security.verified) throw new Error('Host security must be initialized and verified before provider credentials can be stored.');
	mkdirSync(credentialRoot, { recursive: true, mode: 0o700 });
	command('/usr/bin/systemd-creds', ['encrypt', `--name=${initializer.credentialId}`, '-', `${credentialRoot}/${initializer.credentialId}.cred`], secret);
	const registeredMode = initializer.activation.authenticationModes[sourceId];
	if (!registeredMode) throw new Error(`Credential source ${sourceId} has no registered activation mode.`);
	const authenticationMode = registeredMode === 'subscription-file' ? 'codex-subscription' : 'api-key';
	const result = completeProviderSecurity(providerSecuritySettings(), command, { authenticationMode, credentialId: initializer.credentialId });
	return { initializerId, sourceId, credentialId: initializer.credentialId, configured: true, sandboxReady: result.receipt.sandbox.brokerReady };
}

export function verifyProviderRecoveryBundle(path: string, passphrase: string) {
	const result = verifyRecoveryBundle(path, passphrase); mkdirSync(paths.securityState, { recursive: true, mode: 0o700 });
	writeFileSync(`${paths.securityState}/recovery-verified.json`, `${JSON.stringify({ ...result, verifiedAt: new Date().toISOString() })}\n`, { mode: 0o600 }); return result;
}

export function mountProviderSecurityVolume() {
	const value = providerSecuritySettings(), mapper = `/dev/mapper/${mapperName}`; if (!existsSync(value.backing)) throw new Error('Encrypted provider volume backing file does not exist.');
	if (!existsSync(mapper)) {
		if (value.volume.unlock === 'tpm2') execFileSync('/usr/lib/systemd/systemd-cryptsetup', ['attach', mapperName, value.backing, '-', 'tpm2-device=auto'], { stdio: 'inherit' });
		else {
			const credential = execFileSync('/usr/bin/systemd-creds', ['decrypt', '--name=treeseed-provider-volume-key', `${credentialRoot}/treeseed-provider-volume-key.cred`, '-']);
			try { execFileSync('/usr/sbin/cryptsetup', ['open', '--type', 'luks2', '--key-file', '-', value.backing, mapperName], { input: credential, stdio: ['pipe', 'inherit', 'inherit'] }); }
			finally { credential.fill(0); }
		}
	}
	if (!mounted(value.mount)) { mkdirSync(value.mount, { recursive: true, mode: 0o700 }); execFileSync('/usr/bin/mount', ['--options', 'nodev,nosuid,noexec', mapper, value.mount], { stdio: 'inherit' }); }
	const verified = verifyProviderSecurity((executable, args) => execFileSync(executable, [...args], { stdio: 'ignore' })); if (!verified.verified) throw new Error('Encrypted provider volume failed its post-mount verification.'); return verified;
}

export function unmountProviderSecurityVolume() {
	const value = providerSecuritySettings(), mapper = `/dev/mapper/${mapperName}`; if (mounted(value.mount)) execFileSync('/usr/bin/umount', [value.mount], { stdio: 'inherit' });
	if (existsSync(mapper)) execFileSync('/usr/sbin/cryptsetup', ['close', mapperName], { stdio: 'inherit' }); return { mounted: false, mapperOpen: false };
}

export function rotateProviderSecurityKey(input: { target: 'volume' | 'credentials' | 'diagnostics'; recoveryBundle: string; recoveryPassphrase: string; newRecoveryBundle: string; newRecoveryPassphrase: string }, command: CommandRunner) {
	const value = providerSecuritySettings(), verified = verifyProviderSecurity(command); if (!verified.verified) throw new Error('Provider security must be verified before rotating keys.');
	const { secrets } = openRecoveryBundle(input.recoveryBundle, input.recoveryPassphrase), next = { volumeRecoveryKey: secrets.volumeRecoveryKey, applicationKeks: { ...secrets.applicationKeks } };
	let generation: string;
	if (input.target === 'volume') {
		const oldPath = '/run/treeseed/security-rotate-old.key', newPath = '/run/treeseed/security-rotate-new.key'; next.volumeRecoveryKey = key();
		writeFileSync(oldPath, secrets.volumeRecoveryKey, { mode: 0o600, flag: 'wx' }); writeFileSync(newPath, next.volumeRecoveryKey, { mode: 0o600, flag: 'wx' });
		try {
			command('/usr/sbin/cryptsetup', ['luksAddKey', '--key-file', oldPath, '--new-keyfile', newPath, value.backing]);
			command('/usr/sbin/cryptsetup', ['luksRemoveKey', '--key-file', oldPath, value.backing]);
		} finally { rmSync(oldPath, { force: true }); rmSync(newPath, { force: true }); }
		generation = `volume-${Date.now()}`;
	} else {
		const prefix = input.target === 'credentials' ? 'application-credential-kek-v' : 'application-diagnostics-kek-v';
		const version = Math.max(0, ...Object.keys(next.applicationKeks).filter((id) => id.startsWith(prefix)).map((id) => Number(id.slice(prefix.length)) || 0)) + 1;
		generation = `${prefix}${version}`; const secret = key(); next.applicationKeks[generation] = secret;
		command('/usr/bin/systemd-creds', ['encrypt', `--name=${generation}`, '-', `${credentialRoot}/${generation}.cred`], secret);
	}
	const bundle = createRecoveryBundle(input.newRecoveryBundle, input.newRecoveryPassphrase, next); mkdirSync(paths.securityState, { recursive: true, mode: 0o700 });
	const receipt = { schemaVersion: 'treeseed.host-security-rotation/v1', target: input.target, generation, oldKeysRetained: input.target !== 'volume',
		newRecoveryBundleVerified: verifyRecoveryBundle(input.newRecoveryBundle, input.newRecoveryPassphrase).authenticated, rotatedAt: new Date().toISOString(), bundle };
	writeFileSync(`${paths.securityState}/rotation-${Date.now()}.json`, `${JSON.stringify(receipt)}\n`, { mode: 0o600, flag: 'wx' }); return { ...receipt, mutation: true,
		state: input.target === 'volume' ? 'rotated' : 'staged', activationRequired: input.target === 'volume' ? null : { hostConfigurationField: input.target === 'credentials' ? 'security.applicationEncryption.activeKeyVersion' : 'security.applicationEncryption.diagnosticsKeyVersion', version: Number(generation.match(/v(\d+)$/u)?.[1]) } };
}
