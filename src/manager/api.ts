import { chmodSync, readFileSync, unlinkSync } from 'node:fs';
import { createServer as createHttpServer, type RequestListener } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { loadHostConfiguration, tryLoadHostConfiguration } from '../core/configuration.js';
import { recentEvents } from '../core/events.js';
import { paths } from '../core/paths.js';
import { executeHostCommand } from './operations.js';

const maximumRequestBytes = 64 * 1024;

function json(response: import('node:http').ServerResponse, status: number, value: unknown) {
	response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
	response.end(`${JSON.stringify(value)}\n`);
}

async function readJson(request: import('node:http').IncomingMessage) {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += value.length;
		if (size > maximumRequestBytes) throw new Error('request_too_large');
		chunks.push(value);
	}
	if (size === 0) throw new Error('request_body_required');
	try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
	catch { throw new Error('invalid_json'); }
}

function managerHandler(requireMtls: boolean, local: boolean): RequestListener {
	return async (request, response) => {
		if (requireMtls && !(request.socket as TLSSocket).authorized) return json(response, 401, { ok: false, error: 'mtls_required' });
		if (request.method === 'GET' && request.url === '/v1/health') {
			const host = tryLoadHostConfiguration();
			return json(response, host ? 200 : 503, { ok: Boolean(host), service: 'treeseed-manager', configurationReady: Boolean(host), configuration: host?.configurationId ?? null, recoveryRequired: !host });
		}
		if (request.method === 'GET' && request.url === '/v1/status') {
			const host = loadHostConfiguration();
			return json(response, 200, { ok: true, configurationId: host.configurationId, generation: host.generation, components: host.components, events: recentEvents(20) });
		}
		if (request.method === 'GET' && request.url?.startsWith('/v1/events')) return json(response, 200, { ok: true, events: recentEvents(100) });
		if (request.method === 'POST' && request.url === '/v1/host/commands') {
			try {
				const data = await executeHostCommand(await readJson(request), { local });
				return json(response, 200, { ok: true, data, error: null });
			} catch (error) {
				const message = error instanceof Error ? error.message : 'host_command_failed';
				const status = message === 'request_too_large' ? 413 : 400;
				return json(response, status, { ok: false, data: null, error: { code: message.replaceAll(/[^a-z0-9]+/giu, '_').toLowerCase(), message } });
			}
		}
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
	}, managerHandler(true, false));
}

export function startManagerApi() {
	const socket = '/run/treeseed/manager/api.sock';
	try { unlinkSync(socket); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
	const local = createHttpServer(managerHandler(false, true)).listen(socket, () => chmodSync(socket, 0o660));
	const host = tryLoadHostConfiguration();
	if (!host) return { local, remote: undefined, configurationReady: false as const };
	const [hostname, port] = host.network.manager.binding.split(':');
	const remote = createManagerApi().listen(Number(port), hostname);
	return { local, remote, configurationReady: true as const };
}
