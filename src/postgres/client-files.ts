import { X509Certificate } from 'node:crypto';
import { postgresTopologySchema } from '@treeseed/sdk/deployment';

/** Standard per-allocation mount. Consumers receive only their selected phase,
 * never the bootstrap password, owner role, or another application's material.
 */
export function postgresClientMaterial(input: unknown, requirementId: string, phase: 'migration' | 'runtime', password: string, certificateAuthority: string) {
  const topology = postgresTopologySchema.parse(input);
  const allocation = topology.allocations.find(item => item.requirementId === requirementId);
  if (!allocation || !topology.requirements.some(item => item.id === requirementId && item.enabled)
    || !['migration', 'runtime'].includes(phase) || !/^[A-Za-z0-9_-]{32,128}$/u.test(password)) throw new Error('Invalid PostgreSQL client allocation');
  const server = topology.servers.find(item => item.id === allocation.serverId)!;
  try {
    const certificate = new X509Certificate(certificateAuthority);
    if (Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now()) throw new Error();
  } catch { throw new Error('Valid PostgreSQL TLS trust is required'); }
  const username = phase === 'migration' ? allocation.migrationRole : allocation.runtimeRole;
  const mount = `/run/treeseed/postgres/${requirementId}`;
  const query = new URLSearchParams({ sslmode: 'verify-full', sslrootcert: `${mount}/ca.pem` });
  const address = `${server.hostname}:${server.port}/${allocation.database}`;
  return {
    mount,
    files: {
      password, username, database: allocation.database, hostname: server.hostname, port: String(server.port),
      'ca.pem': certificateAuthority,
      url: `postgresql://${username}:${encodeURIComponent(password)}@${address}?${query}`,
      'jdbc-url': `jdbc:postgresql://${address}?${query}`,
    },
  };
}
