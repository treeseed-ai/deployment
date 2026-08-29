import { chmodSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { dirname } from 'node:path';
import { loadSandboxBrokerConfiguration } from './configuration.js';
import { inspectSandboxHost } from './doctor.js';
import { KataSandboxRuntime } from './runtime.js';
import { verifySandboxAssignment, verifySandboxLeaseRenewal } from './trust.js';
import { sandboxAssignmentSchema, sandboxLeaseRenewalSchema } from '@treeseed/sdk/capacity-provider';
import { proxyModelRequest } from './model-gateway.js';

async function body(request: IncomingMessage) {
	let input = ''; for await (const chunk of request) { input += String(chunk); if (input.length > 1_048_576) throw new Error('Sandbox broker request exceeds one MiB.'); }
	return JSON.parse(input) as unknown;
}
function respond(response: ServerResponse, status: number, value: unknown) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(`${JSON.stringify(value)}\n`); }
const token = (request: IncomingMessage) => String(request.headers.authorization ?? '').replace(/^Bearer\s+/iu, '');

export function startSandboxBroker() {
	if (process.getuid?.() !== 0) throw new Error('TreeSeed sandbox broker must run as root.');
	const configuration = loadSandboxBrokerConfiguration(), runtime = new KataSandboxRuntime(configuration);
	runtime.reconcile();
	mkdirSync(dirname(configuration.socketPath), { recursive: true, mode: 0o750 }); rmSync(configuration.socketPath, { force: true });
	const server = createServer(async (request, response) => {
		try {
			if (request.method === 'GET' && request.url === '/v1/status') return respond(response, 200, inspectSandboxHost(configuration));
			if (request.method === 'POST' && request.url === '/v1/sandboxes') {
				const value = await body(request) as Record<string, unknown>, assignment = sandboxAssignmentSchema.parse(value.assignment); verifySandboxAssignment(assignment, configuration.trustedProvidersPath);
				const health = inspectSandboxHost(configuration); if (!health.ready) return respond(response, 503, { error: health.reason, checks: health.checks });
				return respond(response, 201, await runtime.prepare(assignment));
			}
			const input = request.url?.match(/^\/v1\/sandboxes\/([a-zA-Z0-9_.-]+)\/inputs\/([a-z][a-z0-9._-]{0,127})$/u);
			if (request.method === 'PUT' && input?.[1] && input[2]) return respond(response, 200, await runtime.upload(input[1], input[2], token(request), request));
			const artifact = request.url?.match(/^\/v1\/sandboxes\/([a-zA-Z0-9_.-]+)\/artifacts\/([a-z][a-z0-9._-]{0,127})$/u);
			if (request.method === 'GET' && artifact?.[1] && artifact[2]) {
				const collected = runtime.collectArtifact(artifact[1], artifact[2], token(request)); response.writeHead(200, { 'content-type': collected.artifact.mediaType, 'content-length': String(collected.artifact.bytes), 'x-content-sha256': collected.artifact.digest }); collected.stream.pipe(response); return;
			}
			const operation = request.url?.match(/^\/v1\/sandboxes\/([a-zA-Z0-9_.-]+)(?:\/(execute|cancel|outputs|renew))?$/u), sandboxId = operation?.[1], action = operation?.[2];
			const model = request.url?.match(/^\/v1\/sandboxes\/([a-zA-Z0-9_.-]+)\/model\/responses$/u);
			if (model?.[1]) return await proxyModelRequest({ request, response, configuration, policy: runtime.modelPolicy(model[1], token(request)) });
			if (sandboxId && request.method === 'POST' && action === 'execute') {
				const value = await body(request) as Record<string, unknown>;
				const execution = value.execution && typeof value.execution === 'object' && !Array.isArray(value.execution) ? value.execution as Record<string, unknown> : {};
				return respond(response, 200, await runtime.execute(sandboxId, token(request), execution));
			}
			if (sandboxId && request.method === 'POST' && action === 'cancel') return respond(response, 200, runtime.cancel(sandboxId, token(request)));
			if (sandboxId && request.method === 'POST' && action === 'renew') {
				const value = await body(request) as Record<string, unknown>, renewal = sandboxLeaseRenewalSchema.parse(value.renewal); verifySandboxLeaseRenewal(renewal, configuration.trustedProvidersPath);
				return respond(response, 200, runtime.renewLease(sandboxId, token(request), renewal));
			}
			if (sandboxId && request.method === 'GET' && action === 'outputs') return respond(response, 200, runtime.collect(sandboxId, token(request)));
			if (sandboxId && request.method === 'GET' && !action) return respond(response, 200, runtime.inspect(sandboxId, token(request)));
			if (sandboxId && request.method === 'DELETE' && !action) return respond(response, 200, await runtime.destroy(sandboxId, token(request)));
			respond(response, 404, { error: 'operation_not_found' });
		} catch (error) { respond(response, 400, { error: error instanceof Error ? error.message : 'operation_failed' }); }
	});
	server.listen(configuration.socketPath, () => chmodSync(configuration.socketPath, 0o660));
	const relay = createTlsServer({ cert: readFileSync(configuration.relay.certificateFile), key: readFileSync(configuration.relay.privateKeyFile), minVersion: 'TLSv1.3' }, async (request, response) => {
		try {
			const model = request.url?.match(/^\/v1\/sandboxes\/([a-zA-Z0-9_.-]+)\/model\/responses$/u);
			if (!model?.[1] || request.method !== 'POST') return respond(response, 404, { error: 'relay_operation_not_found' });
			await proxyModelRequest({ request, response, configuration, policy: runtime.modelPolicy(model[1], token(request)) });
		} catch (error) { respond(response, 400, { error: error instanceof Error ? error.message : 'relay_operation_failed' }); }
	});
	relay.listen(configuration.relay.port, configuration.relay.listenHost);
	return server;
}
