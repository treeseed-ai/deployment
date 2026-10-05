import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { paths } from '../core/paths.js';

const bootstrapHandoffSchema = z.object({
	complete: z.boolean(),
	foundationReady: z.boolean().default(false),
	initializationRequired: z.boolean().default(false),
	installerCredentialsRetained: z.boolean(),
}).strict();

export function bootstrapStatus() {
	const marker = `${paths.managerState}/bootstrap-status.json`;
	const handoff = existsSync(marker)
		? bootstrapHandoffSchema.parse(JSON.parse(readFileSync(marker, 'utf8')))
		: { complete: false, foundationReady: false, initializationRequired: true, installerCredentialsRetained: false };
	return { ...handoff, configurationInstalled: existsSync(paths.configuration), managerTlsReady: existsSync(`${paths.tls}/ca.crt`) };
}
