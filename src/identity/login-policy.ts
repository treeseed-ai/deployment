import { z } from 'zod';

export const identityLoginPolicySchema = z.object({
  registrationAllowed: z.boolean(), resetPasswordAllowed: z.boolean(),
  mailTransport: z.enum(['existing', 'local-mailpit']),
}).strict();
export type IdentityLoginPolicy = z.infer<typeof identityLoginPolicySchema>;

/** Fixed realm fields only. Secret SMTP configuration is neither returned nor
 * overwritten. Local mail capture is explicitly staging-only at the host plan. */
export async function reconcileIdentityLoginPolicy(options: {
  resource: string; transport: typeof fetch; token: string; policy: IdentityLoginPolicy;
}) {
  const policy = identityLoginPolicySchema.parse(options.policy);
  const request = async (method: 'GET' | 'PUT', body?: unknown) => {
    const response = await options.transport(options.resource, { method, redirect: 'error', credentials: 'omit',
      signal: AbortSignal.timeout(10_000), headers: { authorization: `Bearer ${options.token}`, accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.redirected || !response.ok) { await response.body?.cancel(); throw new Error('Identity login policy request failed'); }
    if (method === 'PUT') { await response.body?.cancel(); return {}; }
    const reader = response.body?.getReader(); if (!reader) throw new Error('Identity realm read-back missing');
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break;
      size += part.value.length; if (size > 1_048_576) throw new Error('Identity realm exceeds limit'); chunks.push(part.value); }
    } finally { await reader.cancel(); reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  };
  const current = await request('GET');
  const smtp = current.smtpServer as Record<string, unknown> | undefined;
  if (policy.mailTransport === 'existing' && (policy.resetPasswordAllowed || policy.registrationAllowed)
    && (!smtp?.host || !smtp.from || !(smtp.starttls === 'true' || smtp.ssl === 'true')))
    throw new Error('Configure a verified TLS email transport before enabling registration or recovery');
  const desired = { loginTheme: 'treeseed', displayName: 'TreeSeed', registrationAllowed: policy.registrationAllowed,
    resetPasswordAllowed: policy.resetPasswordAllowed, registrationEmailAsUsername: true, loginWithEmailAllowed: true,
    duplicateEmailsAllowed: false, verifyEmail: true,
    ...(policy.mailTransport === 'local-mailpit' ? { smtpServer: { host: 'mailpit', port: '1025', auth: 'false', ssl: 'false', starttls: 'false',
      from: `noreply@${new URL(options.resource).hostname}`, fromDisplayName: 'TreeSeed' } } : {}) };
  const matches = (actual: Record<string, unknown>) => Object.entries(desired).every(([key, value]) =>
    typeof value === 'object' ? Object.entries(value).every(([field, wanted]) => (actual[key] as Record<string, unknown> | undefined)?.[field] === wanted)
      : actual[key] === value);
  if (matches(current)) return { action: 'noop' as const };
  await request('PUT', desired);
  if (!matches(await request('GET'))) throw new Error('Identity login policy read-back differs');
  return { action: 'updated' as const };
}
