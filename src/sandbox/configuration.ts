import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sandboxBrokerConfigurationSchema, type SandboxBrokerConfiguration } from './protocol.js';

const defaults: SandboxBrokerConfiguration = {
	socketPath: '/run/treeseed/sandbox/broker.sock', containerdAddress: '/run/containerd/containerd.sock',
	namespace: 'treeseed-sandboxes', runtime: 'io.containerd.kata.v2', stateRoot: '/var/lib/treeseed/sandboxes',
	trustedProvidersPath: '/etc/treeseed/sandbox/providers.json', modelGateway: { upstreamBaseUrl: 'https://api.openai.com', credentialFile: '/run/credentials/model-provider-api-key', allowedProviders: [], allowedModels: [] },
	relay: { listenHost: '10.89.0.1', port: 7443, publicUrl: 'https://10.89.0.1:7443', certificateFile: '/etc/treeseed/sandbox/relay.crt', privateKeyFile: '/run/credentials/relay-tls-key' },
	guestImages: [],
};

export function loadSandboxBrokerConfiguration(path = '/etc/treeseed/sandbox/broker.json') {
	try {
		const parsed = sandboxBrokerConfigurationSchema.parse(JSON.parse(readFileSync(path, 'utf8'))), credentials = process.env.CREDENTIALS_DIRECTORY;
		return credentials ? { ...parsed, relay: { ...parsed.relay, privateKeyFile: resolve(credentials, 'relay-tls-key') }, modelGateway: { ...parsed.modelGateway, credentialFile: resolve(credentials, 'model-provider-api-key') } } : parsed;
	}
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaults;
		throw error;
	}
}
