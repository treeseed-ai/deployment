import { z } from 'zod';
import { requestSupervisor } from '../supervisor/client.js';

const profileId = z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/u);
const variableName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/u);
const mutationPayload = z.object({ profileId, name: variableName, value: z.string().max(1_048_576).optional() }).strict();
type ProviderEnvironmentRequest = { handlerId: string; arguments: string[]; options: Record<string, string | number | boolean | string[]> };

export async function executeProviderEnvironmentCommand(request: ProviderEnvironmentRequest, context: { local: boolean }) {
	if (!context.local) throw new Error('Provider environment custody is available only through the protected local manager socket.');
	const operation = request.handlerId.slice('local.host.provider.environment.'.length);
	if (operation === 'list') return requestSupervisor({ operation: 'provider.environment.list' });
	if (['show', 'status', 'verify'].includes(operation)) return requestSupervisor({ operation: 'provider.environment.show', profileId: profileId.parse(request.arguments[0]) });
	if (operation === 'set' || operation === 'rotate') {
		const payload = mutationPayload.parse(JSON.parse(String(request.options.payload ?? '')));
		if (request.options.plan === true) return { action: operation, profileId: payload.profileId, name: payload.name, mutation: false };
		if (payload.value === undefined) throw new Error('Provider environment mutation requires a protected value.');
		return operation === 'rotate' ? requestSupervisor({ operation: 'provider.environment.rotate', ...payload, value: payload.value })
			: requestSupervisor({ operation: 'provider.environment.set', ...payload, value: payload.value });
	}
	if (operation === 'import') {
		if (request.options.plan === true) return { action: 'import', profileId: profileId.parse(request.arguments[0]), mutation: false };
		const payload = z.object({ profileId, envFile: z.string().max(1_048_576) }).strict().parse(JSON.parse(String(request.options.payload ?? '')));
		return requestSupervisor({ operation: 'provider.environment.import', ...payload });
	}
	if (operation === 'unset') {
		const payload = z.object({ profileId, name: variableName }).strict().parse(JSON.parse(String(request.options.payload ?? '')));
		if (request.options.plan === true) return { action: 'unset', profileId: payload.profileId, name: payload.name, mutation: false };
		return requestSupervisor({ operation: 'provider.environment.unset', ...payload });
	}
	throw new Error('Unknown provider environment operation.');
}
