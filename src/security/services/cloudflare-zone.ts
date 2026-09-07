/** Resolve only the exact zone in the requested account; never guess a parent zone. */
export async function resolveCloudflareZone(accountId: string, domain: string, token: string, fetchImpl: typeof fetch = fetch) {
  if (!/^[a-fA-F0-9]{32}$/.test(accountId) || !token) throw new Error('Cloudflare account and DNS credentials are required.');
  const name = domain.trim().toLowerCase();
  if (name.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name))
    throw new Error('Enter the domain exactly as registered in Cloudflare, without a URL or path.');
  const query = new URLSearchParams({name, 'account.id': accountId, match: 'all', per_page: '2'});
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4/zones?${query}`, {
    headers: {authorization: `Bearer ${token}`}, redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Cloudflare zone lookup failed. Check Zone Read permission and domain access.'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Cloudflare zone lookup returned no response.');
  let length = 0; const chunks: Uint8Array[] = [];
  try { for (;;) { const {done, value} = await reader.read(); if (done) break;
    length += value.byteLength; if (length > 65_536) throw new Error('Cloudflare zone response exceeded the limit.'); chunks.push(value);
  } } finally { await reader.cancel(); }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const zone = body.result?.[0];
  if (body.success !== true || !Array.isArray(body.result) || body.result.length !== 1
    || (body.result_info?.total_count !== undefined && body.result_info.total_count !== 1)
    || zone?.name !== name || zone?.account?.id !== accountId || !/^[a-fA-F0-9]{32}$/.test(zone?.id ?? ''))
    throw new Error('The domain must match exactly one accessible zone in this Cloudflare account.');
  return {domain: name, zoneId: zone.id as string};
}
