import type { HostCommandRequest } from './operations.js';
import { sourceExportSelectionSchema } from '../sandbox/protocol.js';
import { requestSupervisor } from '../supervisor/client.js';

/** Fixed sandbox commands share the existing manager/supervisor boundary. */
export function executeSandboxHostCommand(request: HostCommandRequest, local: boolean) {
 switch (request.handlerId) {
  case 'local.host.sandbox.status':
   if (request.arguments.length || request.configuration !== undefined)
    throw new Error('Sandbox status accepts no caller-selected paths or commands.');
   if (Object.keys(request.options).length === 0) return requestSupervisor({ operation: 'sandbox.status' });
   if (Object.keys(request.options).length !== 2 || typeof request.options.assignmentId !== 'string'
    || typeof request.options.sandboxId !== 'string') throw new Error('Scoped sandbox status requires both assignmentId and sandboxId.');
   return requestSupervisor({ operation: 'sandbox.status', assignmentId: request.options.assignmentId, sandboxId: request.options.sandboxId });
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
