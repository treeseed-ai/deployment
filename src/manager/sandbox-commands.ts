import type { HostCommandRequest } from './operations.js';
import { sourceExportSelectionSchema } from '../sandbox/protocol.js';
import { requestSupervisor } from '../supervisor/client.js';

/** Fixed sandbox commands share the existing manager/supervisor boundary. */
export function executeSandboxHostCommand(request: HostCommandRequest, local: boolean) {
 switch (request.handlerId) {
  case 'local.host.sandbox.status':
   if (request.arguments.length || Object.keys(request.options).length || request.configuration !== undefined)
    throw new Error('Sandbox status accepts no caller-selected paths, commands or resource scope.');
   return requestSupervisor({ operation: 'sandbox.status' });
  case 'local.host.sandbox.cache.collect':
   if (!local) throw new Error('Sandbox cache collection is available only through the protected local manager socket.');
   if (request.arguments.length || Object.keys(request.options).length || request.configuration !== undefined)
    throw new Error('Sandbox cache collection accepts no caller-selected paths, commands or resource scope.');
   return requestSupervisor({ operation: 'sandbox.workspace.cache.collect' });
  case 'local.host.sandbox.doctor': return requestSupervisor({ operation: 'sandbox.doctor' });
  case 'local.host.sandbox.source.export': {
   if (!local || request.arguments.length || request.configuration !== undefined
    || Object.keys(request.options).length !== 1 || typeof request.options.payload !== 'string')
    throw new Error('Source export requires the protected local manager socket and an exact selection only.');
   const selection = sourceExportSelectionSchema.parse(JSON.parse(request.options.payload));
   return requestSupervisor({ operation: 'sandbox.source.export', ...selection });
  }
  default: throw new Error('Unsupported sandbox host command.');
 }
}
