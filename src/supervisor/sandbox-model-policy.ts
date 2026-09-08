import { existsSync, readFileSync } from 'node:fs';
import type { HostConfiguration } from '@treeseed/sdk/deployment';
import { atomicJson } from '../core/files.js';
import { sandboxBrokerConfigurationSchema } from '../sandbox/protocol.js';
import type { CommandRunner } from './compose-runtime.js';

/** Reconcile policy only; credential enrollment remains a separate authority. */
export function reconcileSandboxModelPolicy(host: HostConfiguration, command: CommandRunner, path = '/etc/treeseed/sandbox/broker.json') {
	const policy = host.security?.sandbox.modelGateway;
	if (!policy || !existsSync(path)) return { changed: false, active: false };
	const current = sandboxBrokerConfigurationSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
	if (!current.modelGateway) return { changed: false, active: false };
	const modelGateway = { ...current.modelGateway, upstreamBaseUrl: policy.upstreamBaseUrl,
		allowedProviders: [policy.provider], allowedModels: [...new Set(policy.allowedModels)].sort() };
	const previous = { ...current.modelGateway, allowedModels: [...new Set(current.modelGateway.allowedModels)].sort() };
	if (JSON.stringify(previous) === JSON.stringify(modelGateway)) return { changed: false, active: true };
	const next = sandboxBrokerConfigurationSchema.parse({ ...current, modelGateway });
	atomicJson(path, next, 0o640);
	command('/usr/bin/systemctl', ['restart', 'treeseed-sandbox-broker.service']);
	return { changed: true, active: true };
}
