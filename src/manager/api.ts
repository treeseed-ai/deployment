import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { loadHostConfiguration } from '../core/configuration.js';
import { recentEvents } from '../core/events.js';
import { paths } from '../core/paths.js';

function json(response: import('node:http').ServerResponse, status: number, value: unknown) {
	response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
	response.end(`${JSON.stringify(value)}\n`);
}

export function createManagerApi(): Server {
	const server = createServer({
		key: readFileSync(`${paths.tls}/server.key`),
		cert: readFileSync(`${paths.tls}/server.crt`),
		ca: readFileSync(`${paths.tls}/ca.crt`),
		requestCert: true,
		rejectUnauthorized: true,
	}, (request, response) => {
		if (!(request.socket as TLSSocket).authorized) return json(response, 401, { ok: false, error: 'mtls_required' });
		if (request.method === 'GET' && request.url === '/v1/health') return json(response, 200, { ok: true, service: 'treeseed-manager', configuration: loadHostConfiguration().configurationId });
		if (request.method === 'GET' && request.url === '/v1/status') {
			const host = loadHostConfiguration();
			return json(response, 200, { ok: true, configurationId: host.configurationId, generation: host.generation, components: host.components, events: recentEvents(20) });
		}
		if (request.method === 'GET' && request.url?.startsWith('/v1/events')) return json(response, 200, { ok: true, events: recentEvents(100) });
		return json(response, 404, { ok: false, error: 'not_found' });
	});
	return server;
}

export function startManagerApi() {
	const host = loadHostConfiguration();
	const [hostname, port] = host.network.manager.binding.split(':');
	return createManagerApi().listen(Number(port), hostname);
}
