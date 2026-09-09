import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import type { CommandRunner } from './compose-runtime.js';

const name = 'treeseed-api-operations-runner-1';
const resultSchema = z.object({
  status: z.enum(['authenticated', 'configuration-unavailable', 'identity-unavailable', 'login-rejected', 'transport-failed', 'revocation-failed']),
  httpStatus: z.number().int().min(100).max(599).optional(),
  transport: z.enum(['tls', 'timeout', 'connection', 'other']).optional(),
  trustModifiedAt: z.string().datetime().optional(),
}).strict();

// Serialized only from compiled TypeScript into a fixed container invocation.
// No input from an operator is evaluated or used as a path/URL/command.
async function probeInContainer() {
  const { readFileSync, lstatSync } = await import('node:fs');
  const base = 'https://openbao:8200';
  if (process.env.TREESEED_OPENBAO_ADDRESS !== base || process.env.TREESEED_OPENBAO_IDENTITY_FILE !== '/run/openbao-client/identity.json'
    || process.env.NODE_EXTRA_CA_CERTS !== '/run/openbao-client/ca.pem') {
    console.log(JSON.stringify({ status: 'configuration-unavailable' })); return;
  }
  let identity: { roleId: string; secretId: string }, trustModifiedAt: string;
  try {
    const path = '/run/openbao-client/identity.json', stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384 || (stat.mode & 0o027)) throw new Error();
    identity = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof identity.roleId !== 'string' || !identity.roleId || typeof identity.secretId !== 'string' || !identity.secretId) throw new Error();
    trustModifiedAt = lstatSync('/run/openbao-client/ca.pem').mtime.toISOString();
  } catch { console.log(JSON.stringify({ status: 'identity-unavailable' })); return; }
  try {
    const response = await fetch(`${base}/v1/auth/approle/login`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role_id: identity.roleId, secret_id: identity.secretId }) });
    if (!response.ok) { await response.body?.cancel(); console.log(JSON.stringify({ status: 'login-rejected', httpStatus: response.status, trustModifiedAt })); return; }
    const payload = await response.json() as { auth?: { client_token?: string } };
    const token = payload.auth?.client_token;
    if (!token) { console.log(JSON.stringify({ status: 'login-rejected', httpStatus: response.status, trustModifiedAt })); return; }
    const revoked = await fetch(`${base}/v1/auth/token/revoke-self`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'x-vault-token': token } });
    await revoked.body?.cancel();
    console.log(JSON.stringify({ status: revoked.ok ? 'authenticated' : 'revocation-failed', httpStatus: revoked.status, trustModifiedAt }));
  } catch (error) {
    const value = error as { name?: string; cause?: { code?: string } };
    const code = value.cause?.code ?? '';
    const transport = ['SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(code) ? 'tls'
      : value.name === 'TimeoutError' ? 'timeout' : ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code) ? 'connection' : 'other';
    console.log(JSON.stringify({ status: 'transport-failed', transport, trustModifiedAt }));
  }
}

const bounded: CommandRunner = (executable, args, input) => {
  const result = spawnSync(executable, [...args], { input, encoding: 'utf8', timeout: 45000, maxBuffer: 8192,
    stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } });
  if (result.error || result.status !== 0) throw new Error('Runner custody probe unavailable');
  return result.stdout;
};

/** Operator-only, fixed managed container, bounded and allowlisted output. */
export function probeRunnerCustody(command: CommandRunner = bounded) {
  try {
    const raw = String(command('/usr/bin/docker', ['inspect', name, '--format', '{"id":{{json .Id}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"running":{{json .State.Running}},"startedAt":{{json .State.StartedAt}}'], ''));
    const state = JSON.parse(raw);
    if (!/^[a-f0-9]{64}$/u.test(state.id) || state.project !== 'treeseed-api' || state.service !== 'operations-runner' || state.running !== true
      || !Number.isFinite(Date.parse(state.startedAt))) throw new Error();
    const script = `(${probeInContainer.toString()})().catch(() => console.log(JSON.stringify({status:'transport-failed',transport:'other'})))`;
    const output = String(command('/usr/bin/docker', ['exec', '-i', state.id, 'node', '--input-type=module'], script));
    if (output.length > 2048) throw new Error();
    const result = resultSchema.parse(JSON.parse(output));
    return { ...result, startedAt: new Date(state.startedAt).toISOString(),
      startedBeforeTrustFile: result.trustModifiedAt ? Date.parse(state.startedAt) < Date.parse(result.trustModifiedAt) : null };
  } catch { throw new Error('Runner custody probe unavailable; no provider diagnostics exposed'); }
}
