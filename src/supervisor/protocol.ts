import { hostConfigurationSchema } from '@treeseed/sdk/deployment';
import { z } from 'zod';

export const supervisorOperationSchema = z.discriminatedUnion('operation', [
	z.object({ operation: z.literal('supervisor.ping') }).strict(),
	z.object({ operation: z.literal('apt.refresh'), track: z.enum(['stable', 'development']), updateCore: z.boolean() }).strict(),
	z.object({ operation: z.literal('apt.install'), packages: z.array(z.string().regex(/^treeseed(?:-[a-z0-9-]+)?=[0-9A-Za-z.+:~-]+$/u)).min(1) }).strict(),
	z.object({ operation: z.literal('compose.activate'), componentId: z.string().regex(/^[a-z][a-z0-9.-]+$/u), files: z.array(z.string().min(1)).min(1), projectName: z.string().regex(/^treeseed-[a-z0-9-]+$/u), waitTimeoutSeconds: z.number().int().min(1).max(3_600) }).strict(),
	z.object({ operation: z.literal('compose.stop'), componentId: z.string().regex(/^[a-z][a-z0-9.-]+$/u), files: z.array(z.string().min(1)).min(1), projectName: z.string().regex(/^treeseed-[a-z0-9-]+$/u) }).strict(),
	z.object({ operation: z.literal('component.configure'), componentId: z.string().regex(/^[a-z][a-z0-9.-]+$/u) }).strict(),
	z.object({ operation: z.literal('component.reset-unaccepted'), componentId: z.string().regex(/^[a-z][a-z0-9.-]+$/u) }).strict(),
	z.object({ operation: z.literal('edge.apply'), caddyfile: z.string().min(1), aliases: z.array(z.string().endsWith('.localhost')).min(1) }).strict(),
	z.object({ operation: z.literal('systemd.control'), unit: z.enum(['treeseed-manager-api.service', 'treeseed-manager-reconcile.service', 'treeseed-edge.service']), action: z.enum(['start', 'stop', 'restart', 'reload']) }).strict(),
	z.object({ operation: z.literal('recovery.restore'), generation: z.number().int().positive() }).strict(),
	z.object({ operation: z.literal('backup.create'), generation: z.number().int().positive() }).strict(),
	z.object({ operation: z.literal('manager.restart') }).strict(),
	z.object({ operation: z.literal('configuration.replace'), configuration: hostConfigurationSchema }).strict(),
	z.object({ operation: z.literal('pki.enroll'), clientId: z.string().regex(/^client-[a-z0-9-]{8,64}$/u) }).strict(),
]);

export type SupervisorOperation = z.infer<typeof supervisorOperationSchema>;
