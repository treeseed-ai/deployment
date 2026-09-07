import { randomUUID } from 'node:crypto';
import { aiModeStatus, requestAiMode } from './ai-mode.js';

export function setAiModeCommand(request: {arguments: string[]; options: Record<string, unknown>}) {
	const target = request.arguments[0];
	if (target !== 'awake' && target !== 'sleep') throw new Error('AI mode must be awake or sleep.');
	const requestValue = { schemaVersion: 'treeseed.ai-mode-request/v1', target, idempotencyKey: typeof request.options.idempotencyKey === 'string' ? request.options.idempotencyKey : randomUUID(), drainTimeoutSeconds: typeof request.options.drainTimeout === 'number' ? request.options.drainTimeout : typeof request.options.drainTimeout === 'string' ? Number(request.options.drainTimeout) : 900 };
	if (request.options.plan === true) return { ...aiModeStatus(), proposedMode: target, mutation: false };
	return requestAiMode(requestValue, 'operator');
}
