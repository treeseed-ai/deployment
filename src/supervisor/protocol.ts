import { hostConfigurationSchema } from '@treeseed/sdk/deployment';
import { z } from 'zod';

export const supervisorOperationSchema = z.discriminatedUnion('operation', [
	z.object({ operation: z.literal('supervisor.ping') }).strict(),
	z.object({ operation: z.literal('apt.refresh'), track: z.enum(['stable', 'development']), updateCore: z.boolean() }).strict(),
	z.object({ operation: z.literal('apt.install'), packages: z.array(z.string().regex(/^treeseed(?:-[a-z0-9-]+)?(?:(?:=[0-9A-Za-z.+:~-]+)|(?:\/(?:stable|development)))?$/u)).min(1) }).strict(),
	z.object({ operation: z.literal('compose.activate'), componentId: z.string().regex(/^[a-z][a-z0-9.-]+$/u), files: z.array(z.string().min(1)).min(1), projectName: z.string().regex(/^treeseed-[a-z0-9-]+$/u), waitTimeoutSeconds: z.number().int().min(1).max(3_600) }).strict(),
	z.object({ operation: z.literal('compose.stop'), componentId: z.string().regex(/^[a-z][a-z0-9.-]+$/u), files: z.array(z.string().min(1)).min(1), projectName: z.string().regex(/^treeseed-[a-z0-9-]+$/u) }).strict(),
	z.object({ operation: z.literal('compose.status'), projectName: z.string().regex(/^treeseed-[a-z0-9-]+$/u) }).strict(),
	z.object({ operation: z.literal('compose.remove'), componentId: z.string().regex(/^[a-z][a-z0-9.-]+$/u), files: z.array(z.string().min(1)).min(1), projectName: z.string().regex(/^treeseed-[a-z0-9-]+$/u) }).strict(),
	z.object({ operation: z.literal('component.configure'), componentId: z.string().regex(/^[a-z][a-z0-9.-]+$/u), connectionEnvironment: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u), z.string().max(16_384)), secretFileIds: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u)).max(128).optional() }).strict(),
	z.object({ operation: z.literal('development.environment'), componentId: z.string().regex(/^[a-z][a-z0-9.-]+$/u), connectionEnvironment: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u), z.string().max(16_384)), secretRefs: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u), z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u)) }).strict(),
	z.object({ operation: z.literal('component.reset-unaccepted'), componentId: z.string().regex(/^[a-z][a-z0-9.-]+$/u) }).strict(),
	z.object({ operation: z.literal('provider.enroll'), connectionId: z.string().regex(/^[a-z][a-z0-9.-]+$/u), teamId: z.string().min(1).max(256), controlPlaneUrl: z.string().url().startsWith('https://'), controlPlaneAudience: z.string().url().startsWith('https://'), registrationSecretId: z.string().regex(/^[a-z][a-z0-9.-]+$/u), offer: z.object({ maxConcurrentRunners: z.number().int().positive().max(1_024), capabilities: z.array(z.string().min(1).max(128)).max(256), metadata: z.record(z.union([z.string(), z.number(), z.boolean()])).optional() }).strict(), files: z.array(z.string().min(1)).min(1), projectName: z.literal('treeseed-agent') }).strict(),
	z.object({ operation: z.literal('provider.enrollment-handoff'), payload: z.discriminatedUnion('action', [
		z.object({ action: z.literal('begin'), connectionId: z.string().regex(/^[a-z][a-z0-9.-]+$/u), teamId: z.string().min(1).max(256), controlPlaneUrl: z.string().url(), controlPlaneAudience: z.string().url(), enrollmentToken: z.string().min(1).max(16_384) }).strict(),
		z.object({ action: z.literal('complete'), connectionId: z.string().regex(/^[a-z][a-z0-9.-]+$/u) }).strict(),
	]), files: z.array(z.string().min(1)).min(1), projectName: z.literal('treeseed-agent') }).strict(),
	z.object({ operation: z.literal('edge.apply'), caddyfile: z.string().min(1), aliases: z.array(z.string().endsWith('.localhost')).min(1) }).strict(),
	z.object({ operation: z.literal('systemd.control'), unit: z.enum(['treeseed-manager-api.service', 'treeseed-manager-reconcile.service', 'treeseed-edge.service']), action: z.enum(['start', 'stop', 'restart', 'reload']) }).strict(),
	z.object({ operation: z.literal('recovery.restore'), generation: z.number().int().positive() }).strict(),
	z.object({ operation: z.literal('backup.create'), generation: z.number().int().positive() }).strict(),
	z.object({ operation: z.literal('backup.inspect'), generation: z.number().int().positive() }).strict(),
	z.object({ operation: z.literal('backup.list') }).strict(),
	z.object({ operation: z.literal('platform.reset'), componentDataRoot: z.union([
		z.literal('/var/lib/treeseed/components'),
		z.string().startsWith('/').regex(/\/\.treeseed\/data$/u),
	]) }).strict(),
	z.object({ operation: z.literal('cli.configure'), controlPlaneUrl: z.string().url().refine((value) => value.startsWith('https://') || value.startsWith('http://127.0.0.1'), 'Control-plane URL must use HTTPS or loopback HTTP.') }).strict(),
	z.object({ operation: z.literal('manager.restart') }).strict(),
	z.object({ operation: z.literal('configuration.replace'), configuration: hostConfigurationSchema }).strict(),
	z.object({ operation: z.literal('configuration.adopt'), configuration: hostConfigurationSchema }).strict(),
	z.object({ operation: z.literal('configuration.recover'), configuration: hostConfigurationSchema }).strict(),
	z.object({ operation: z.literal('pki.enroll'), clientId: z.string().regex(/^client-[a-z0-9-]{8,64}$/u) }).strict(),
]);

export type SupervisorOperation = z.infer<typeof supervisorOperationSchema>;
