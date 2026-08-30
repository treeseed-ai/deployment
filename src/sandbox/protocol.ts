import { sandboxAssignmentSchema } from '@treeseed/sdk/capacity-provider';
import { z } from 'zod';

export const sandboxCreateRequestSchema = z.object({
	assignment: sandboxAssignmentSchema,
}).strict();

export const sandboxBrokerConfigurationSchema = z.object({
	socketPath: z.string().startsWith('/run/treeseed/sandbox/'),
	containerdAddress: z.string().startsWith('/run/'),
	namespace: z.literal('treeseed-sandboxes'),
	runtime: z.literal('io.containerd.kata.v2'),
	stateRoot: z.string().startsWith('/var/lib/treeseed/sandboxes'),
	trustedProvidersPath: z.string().startsWith('/etc/treeseed/sandbox/'),
	relay: z.object({ listenHost: z.string().ip({ version: 'v4' }), port: z.number().int().min(1024).max(65535), publicUrl: z.string().url().startsWith('https://'), certificateFile: z.string().startsWith('/etc/treeseed/sandbox/'), privateKeyFile: z.string().startsWith('/run/credentials/') }).strict(),
	modelGateway: z.object({ upstreamBaseUrl: z.string().url().startsWith('https://'), authenticationMode: z.enum(['api-key', 'codex-subscription']), credentialFile: z.string().startsWith('/run/credentials/'), allowedProviders: z.array(z.string().min(1)), allowedModels: z.array(z.string().min(1)) }).strict(),
	guestImages: z.array(z.object({ image: z.string().min(1), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u), profiles: z.array(z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/u)).min(1) }).strict()),
}).strict();

export type SandboxCreateRequest = z.infer<typeof sandboxCreateRequestSchema>;
export type SandboxBrokerConfiguration = z.infer<typeof sandboxBrokerConfigurationSchema>;
