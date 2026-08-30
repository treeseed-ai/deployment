import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SandboxBrokerConfiguration } from './protocol.js';
import type { SandboxAssignment } from '@treeseed/sdk/capacity-provider';

async function boundedBody(request: IncomingMessage, maximum = 16 * 1024 * 1024) {
	const chunks: Buffer[] = []; let bytes = 0;
	for await (const chunk of request) { const value = Buffer.from(chunk as Buffer); bytes += value.byteLength; if (bytes > maximum) throw new Error('Model gateway request exceeds its bounded payload size.'); chunks.push(value); }
	return Buffer.concat(chunks);
}

export async function proxyModelRequest(input: { request: IncomingMessage; response: ServerResponse; configuration: SandboxBrokerConfiguration; policy: SandboxAssignment['modelPolicy'] }) {
	const gateway = input.configuration.modelGateway;
	if (!gateway) throw new Error('No execution-provider model credential is configured on this host.');
	if (gateway.authenticationMode !== 'api-key') throw new Error('The API model gateway is disabled for assignment-scoped subscription authentication.');
	if (input.request.method !== 'POST') throw new Error('Model gateway only permits POST requests.');
	if (!gateway.allowedProviders.includes(input.policy.provider) || !gateway.allowedModels.includes(input.policy.model)) throw new Error('Assignment model policy is not enabled by the host gateway.');
	const body = await boundedBody(input.request), parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
	if (parsed.model !== input.policy.model) throw new Error('Model gateway request does not match the signed assignment model.');
	if (input.policy.maxOutputTokens && Number(parsed.max_output_tokens ?? input.policy.maxOutputTokens) > input.policy.maxOutputTokens) throw new Error('Model gateway request exceeds the signed output-token budget.');
	const credential = readFileSync(gateway.credentialFile, 'utf8').trim(); if (credential.length < 20) throw new Error('Model gateway credential is unavailable.');
	const upstream = await fetch(`${gateway.upstreamBaseUrl}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json', accept: input.request.headers.accept ?? 'application/json' }, body });
	const responseBody = Buffer.from(await upstream.arrayBuffer()); if (responseBody.byteLength > 16 * 1024 * 1024) throw new Error('Model gateway response exceeds its bounded payload size.');
	if (responseBody.includes(Buffer.from(credential))) throw new Error('Model provider response contained a credential fingerprint and was quarantined.');
	input.response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store', 'content-length': String(responseBody.byteLength) }); input.response.end(responseBody);
}
