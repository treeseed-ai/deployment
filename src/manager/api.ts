import { chmodSync, readFileSync, unlinkSync } from 'node:fs';
import { createServer as createHttpServer, type RequestListener } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { loadHostConfiguration } from '../core/configuration.js';
import { recentEvents } from '../core/events.js';
import { paths } from '../core/paths.js';

function json(response: import('node:http').ServerResponse, status: number, value: unknown) {
	response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
	response.end(`${JSON.stringify(value)}\n`);
}

function managerHandler(requireMtls: boolean): RequestListener {
	return (request, response) => {
		if (requireMtls && !(request.socket as TLSSocket).authorized) return json(response, 401, { ok: false, error: 'mtls_required' });
		if (request.method === 'GET' && request.url === '/v1/health') return json(response, 200, { ok: true, service: 'treeseed-manager', configuration: loadHostConfiguration().configurationId });
		if (request.method === 'GET' && request.url === '/v1/status') {
			const host = loadHostConfiguration();
			return json(response, 200, { ok: true, configurationId: host.configurationId, generation: host.generation, components: host.components, events: recentEvents(20) });
		}
		if (request.method === 'GET' && request.url?.startsWith('/v1/events')) return json(response, 200, { ok: true, events: recentEvents(100) });
		return json(response, 404, { ok: false, error: 'not_found' });
	};
}

export function createManagerApi(): Server {
	return createServer({
		key: readFileSync(`${paths.tls}/server.key`),
		cert: readFileSync(`${paths.tls}/server.crt`),
		ca: readFileSync(`${paths.tls}/ca.crt`),
		requestCert: true,
		rejectUnauthorized: true,
	}, managerHandler(true));
}

export function startManagerApi() {
	const host = loadHostConfiguration();
	const [hostname, port] = host.network.manager.binding.split(':');
	const socket = '/run/treeseed/manager/api.sock';
	try { unlinkSync(socket); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
	const local = createHttpServer(managerHandler(false)).listen(socket, () => chmodSync(socket, 0o660));
	const remote = createManagerApi().listen(Number(port), hostname);
	return { local, remote };
}
