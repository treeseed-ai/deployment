import { z } from 'zod';

export const supervisorOperationSchema = z.discriminatedUnion('operation', [
	z.object({ operation: z.literal('apt.install'), packages: z.array(z.string().regex(/^treeseed(?:-[a-z0-9-]+)?=[0-9A-Za-z.+:~-]+$/u)).min(1) }).strict(),
	z.object({ operation: z.literal('compose.activate'), componentId: z.string().regex(/^[a-z][a-z0-9.-]+$/u), files: z.array(z.string().min(1)).min(1), projectName: z.string().regex(/^treeseed-[a-z0-9-]+$/u) }).strict(),
	z.object({ operation: z.literal('compose.stop'), componentId: z.string().regex(/^[a-z][a-z0-9.-]+$/u), files: z.array(z.string().min(1)).min(1), projectName: z.string().regex(/^treeseed-[a-z0-9-]+$/u) }).strict(),
	z.object({ operation: z.literal('edge.apply'), caddyfile: z.string().min(1), aliases: z.array(z.string().endsWith('.localhost')).min(1) }).strict(),
	z.object({ operation: z.literal('systemd.control'), unit: z.enum(['treeseed-manager-api.service', 'treeseed-manager-reconcile.service', 'treeseed-edge.service']), action: z.enum(['start', 'stop', 'restart', 'reload']) }).strict(),
	z.object({ operation: z.literal('recovery.restore'), generation: z.number().int().positive() }).strict(),
]);

export type SupervisorOperation = z.infer<typeof supervisorOperationSchema>;
