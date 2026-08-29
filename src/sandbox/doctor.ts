import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import type { SandboxBrokerConfiguration } from './protocol.js';

function command(path: string, args: string[]) {
	try { return execFileSync(path, args, { encoding: 'utf8', timeout: 10_000 }).trim(); }
	catch { return null; }
}

export function inspectSandboxHost(configuration: SandboxBrokerConfiguration, options: { requireBrokerSocket?: boolean } = {}) {
	const checks = {
		kvm: existsSync('/dev/kvm'), containerd: existsSync(configuration.containerdAddress),
		kataRuntime: false, trustedProviders: existsSync(configuration.trustedProvidersPath),
		modelGateway: (existsSync(configuration.modelGateway.credentialFile) || existsSync('/etc/treeseed/credentials/model-provider-api-key.cred')) && configuration.modelGateway.allowedProviders.length > 0 && configuration.modelGateway.allowedModels.length > 0,
		relay: existsSync(configuration.relay.certificateFile) && (existsSync(configuration.relay.privateKeyFile) || existsSync('/etc/treeseed/credentials/sandbox-relay-tls-key.cred')) && existsSync('/etc/cni/net.d/20-treeseed-sandboxes.conflist'),
		brokerSocket: options.requireBrokerSocket !== true || existsSync(configuration.socketPath), guestImages: configuration.guestImages.length > 0,
	};
	try { accessSync('/dev/kvm', constants.R_OK | constants.W_OK); } catch { checks.kvm = false; }
	checks.containerd = checks.containerd && command('/usr/bin/ctr', ['--address', configuration.containerdAddress, 'version']) !== null;
	checks.kataRuntime = existsSync('/usr/local/bin/containerd-shim-kata-v2') && existsSync('/etc/kata-containers/configuration.toml');
	checks.guestImages = checks.guestImages && configuration.guestImages.every((entry) => command('/usr/bin/ctr', ['--address', configuration.containerdAddress, '--namespace', configuration.namespace, 'images', 'check', `${entry.image}@${entry.digest}`]) !== null);
	const version = command('/usr/local/bin/containerd-shim-kata-v2', ['--version']);
	const kernel = existsSync('/proc/version') ? readFileSync('/proc/version', 'utf8').trim() : 'unknown';
	const ready = Object.values(checks).every(Boolean);
	return { schemaVersion: 1, ready, reason: ready ? null : 'sandbox_host_prerequisites_unavailable', checks, runtime: configuration.runtime, kataVersion: version, hostKernel: kernel };
}
