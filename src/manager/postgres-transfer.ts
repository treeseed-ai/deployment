import { postgresTransitionSelectionSchema, postgresTransferPreparationResultSchema, postgresTransferStatusSchema } from '@treeseed/sdk/deployment';
import type { HostCommandRequest } from './operations.js';
import { requestSupervisor } from '../supervisor/client.js';

export async function executePostgresTransferCommand(request: HostCommandRequest, local: boolean) {
  if (!local) throw new Error('PostgreSQL transfer preparation/status requires the protected local manager socket');
  if (request.arguments.length || request.configuration) throw new Error('Unexpected PostgreSQL transfer command inputs');
  if (request.handlerId === 'local.host.postgres.transfer.status') {
    if (Object.keys(request.options).length) throw new Error('Unexpected PostgreSQL transfer status options');
    const status = postgresTransferStatusSchema.safeParse(await requestSupervisor({ operation: 'postgres.transfer.status' }));
    if (!status.success) throw new Error('Managed PostgreSQL transfer status is unavailable or malformed');
    return status.data;
  }
  let selection;
  try {
    if (request.handlerId !== 'local.host.postgres.transfer.prepare' ||
      Object.keys(request.options).some(key => !['payload','plan'].includes(key)) ||
      (request.options.plan !== undefined && typeof request.options.plan !== 'boolean') ||
      typeof request.options.payload !== 'string' || Buffer.byteLength(request.options.payload) > 16_384) throw new Error();
    selection = postgresTransitionSelectionSchema.parse(JSON.parse(request.options.payload));
  } catch { throw new Error('Exact PostgreSQL transfer selection required; no credentials, SQL, URLs or paths are accepted'); }
  const result = postgresTransferPreparationResultSchema.safeParse(await requestSupervisor({
    operation: 'postgres.transfer.prepare', ...selection, planOnly: request.options.plan === true,
  }));
  if (!result.success) throw new Error('Managed PostgreSQL transfer preparation result is unavailable or malformed');
  return result.data;
}
