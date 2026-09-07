import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { planManagedAiConfiguration } from '../src/core/ai-configuration.js';

// Developer/operator planning adapter. Applying remains the published
// `trsd host config plan/apply` operation and its managed reconciliation gates.
const [teamId, projectId, destination] = process.argv.slice(2);
if (!teamId || !projectId || !destination || process.argv.length !== 5) throw new Error('Usage: plan-ai-host <team-uuid> <project-uuid> <new-plan-file>');
const response = JSON.parse(execFileSync('trsd', ['host', 'config', 'show', '--json'], { encoding: 'utf8', maxBuffer: 2_097_152 }));
if (!response.ok) throw new Error('Managed host configuration could not be read.');
const current = response.result, environment = current.components.api?.configuration?.environment;
const issuer = new URL('/ai', environment?.TREESEED_TREEDX_JWT_ISSUER);
if (issuer.protocol !== 'https:') throw new Error('A verified HTTPS control-plane authority is required.');
const jwksResponse = await fetch(new URL('/.well-known/treedx-jwks.json', issuer), { redirect: 'error', signal: AbortSignal.timeout(10_000) });
if (!jwksResponse.ok) throw new Error('Control-plane public signing trust is unavailable.');
const jwks = await jwksResponse.json() as { keys: any[] };
const existing = environment.TREESEED_AI_RUNTIME ? JSON.parse(environment.TREESEED_AI_RUNTIME) : null;
const result = planManagedAiConfiguration(current, { teamId, projectId, nodeId: existing?.nodeId ?? randomUUID(), issuer: issuer.href, publicKeys: jwks.keys });
const output = resolve(destination), encoded = JSON.stringify(result.configuration, null, 2) + '\n';
if (existsSync(output)) {
	if (readFileSync(output, 'utf8') !== encoded) throw new Error('An existing plan cannot be overwritten; review it or choose a new file.');
} else writeFileSync(output, encoded, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ mutation: false, noop: result.noop, generation: result.configuration.generation, file: output,
	nextAction: 'Review with trsd host config plan, then apply through the manager.' }));
