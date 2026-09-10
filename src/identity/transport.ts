import { request } from 'node:https';

/** Deployment supplies the trusted origin, CA and private service route. OAuth
 * still sees and verifies the public issuer; credentials never follow redirects
 * or cross to another origin. No process-wide TLS or DNS override is installed.
 */
export function createIdentityTransport(options: { origin: string; ca: string; hostname: string; port: number }): typeof fetch {
  const origin = new URL(options.origin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
    || !options.ca.includes('-----BEGIN CERTIFICATE-----') || !/^[a-zA-Z0-9.-]+$/u.test(options.hostname)
    || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('Invalid managed Identity transport');
  return async (input, init) => {
    const incoming = new Request(input, init), url = new URL(incoming.url);
    if (url.origin !== origin.origin || url.username || url.password || url.hash
      || !['GET', 'POST', 'PUT', 'DELETE'].includes(incoming.method)) throw new Error('Identity transport boundary rejected');
    const bytes = Buffer.from(await incoming.arrayBuffer());
    if (bytes.length > 1_048_576) { bytes.fill(0); throw new Error('Identity request exceeds limit'); }
    try {
      return await new Promise<Response>((resolve, reject) => {
        const headers = Object.fromEntries(incoming.headers);
        delete headers.host; delete headers.cookie; delete headers.connection; delete headers['content-length'];
        const call = request({ hostname: options.hostname, port: options.port, servername: origin.hostname,
          ca: options.ca, rejectUnauthorized: true, path: `${url.pathname}${url.search}`, method: incoming.method,
          headers: { ...headers, host: origin.host, 'content-length': String(bytes.length) }, signal: incoming.signal,
          timeout: 15_000, agent: false }, response => {
          const chunks: Buffer[] = []; let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 1_048_576) { response.destroy(new Error('Identity response exceeds limit')); return; }
            chunks.push(chunk);
          });
          response.once('error', () => { for (const chunk of chunks) chunk.fill(0); reject(new Error('Managed Identity transport failed')); });
          response.once('end', () => {
            const status = response.statusCode ?? 502;
            if (status >= 300 && status < 400) {
              for (const chunk of chunks) chunk.fill(0);
              reject(new Error('Identity redirect rejected')); return;
            }
            const output = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (value === undefined || ['set-cookie', 'transfer-encoding', 'connection'].includes(name)) continue;
              for (const item of Array.isArray(value) ? value : [value]) output.append(name, item);
            }
            const body = Buffer.concat(chunks);
            resolve(new Response([204, 205, 304].includes(status) ? null : body, { status, headers: output }));
            for (const chunk of chunks) chunk.fill(0); body.fill(0);
          });
        });
        call.once('timeout', () => call.destroy(new Error('Identity transport deadline exceeded')));
        call.once('error', () => reject(new Error('Managed Identity transport failed')));
        call.end(bytes);
      });
    } finally { bytes.fill(0); }
  };
}
