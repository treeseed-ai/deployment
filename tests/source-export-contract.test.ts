import { expect, it } from 'vitest';
import { sourceExportSelectionSchema } from '../src/sandbox/protocol.js';
import { supervisorOperationSchema } from '../src/supervisor/protocol.js';

const selection = { sandboxId: 'sandbox-assignment-source-1', assignmentId: 'assignment_source', providerId: 'provider_source', attempt: 1,
 source: { controlPlaneId: 'https://api.treeseed.localhost', teamId: 'team-source', projectId: 'project-source',
  repositoryId: 'treeseed-ai/ui', commit: 'a'.repeat(40), formatVersion: 1, profile: 'source-only' }, commit: 'b'.repeat(40) };

it('accepts exact source identities without a caller-selected filesystem or ref', () => {
 expect(sourceExportSelectionSchema.parse(selection)).toEqual(selection);
 expect(supervisorOperationSchema.parse({ operation: 'sandbox.source.export', ...selection })).toEqual({ operation: 'sandbox.source.export', ...selection });
});
it('rejects path and ref selection and malformed owner attempts at both public protocol boundaries', () => {
 for (const field of ['path', 'repositoryPath', 'outputPath', 'bundlePath', 'ref', 'branch', 'resultId', 'reviewId']) {
  const injected = { ...selection, [field]: '/var/lib/treeseed/private' };
  expect(sourceExportSelectionSchema.safeParse(injected).success, field).toBe(false);
  expect(supervisorOperationSchema.safeParse({ operation: 'sandbox.source.export', ...injected }).success, field).toBe(false);
 }
 for (const patch of [{ sandboxId: '../escape' }, { sandboxId: 'sandbox-source/escape' }, { attempt: 0 }, { attempt: 1.5 },
  { attempt: Number.MAX_SAFE_INTEGER + 1 }, { commit: 'staging' }, { providerId: '' }, { assignmentId: '' }]) {
  expect(sourceExportSelectionSchema.safeParse({ ...selection, ...patch }).success).toBe(false);
 }
});
