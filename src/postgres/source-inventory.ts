import { z } from 'zod';
import { deploymentDigest, type ComponentRelease } from '@treeseed/sdk/deployment';

const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u);
export const postgresSourceDescriptorSchema = z.object({
  database: identifier, major: z.number().int().min(16).max(17),
  cluster: z.string().regex(/^[0-9]{1,20}$/u),
  locale: z.object({ encoding: z.string().max(64), collate: z.string().max(256), ctype: z.string().max(256),
    provider: z.string().max(8), version: z.string().max(256).nullable(), locale: z.string().max(256).nullable() }).strict(),
}).strict();

/** Fixed catalog read; no rows, password columns, caller SQL or network access. */
export const postgresSourceInventorySql = `BEGIN READ ONLY;
SET LOCAL search_path=pg_catalog; SET LOCAL statement_timeout='5s';
SELECT jsonb_build_object('database',current_database(),'major',current_setting('server_version_num')::int/10000,
  'cluster',(SELECT system_identifier::text FROM pg_control_system()),
  'locale',jsonb_build_object('encoding',pg_encoding_to_char(d.encoding),'collate',d.datcollate,'ctype',d.datctype,
    'provider',d.datlocprovider,'version',d.datcollversion,'locale',COALESCE(to_jsonb(d)->>'datlocale',to_jsonb(d)->>'daticulocale')))
FROM pg_database d WHERE d.datname=current_database(); COMMIT;`;

export type SourceDocker = (args: string[], timeoutSeconds: number, capture: boolean) => Promise<string>;

/** Internal adapter. The supervisor supplies a root-custodied manifest and
 * rendered Compose selection; this is not an API accepting caller manifests.
 */
export async function inspectPostgresSource(component: ComponentRelease, serviceId: string,
  configured: unknown, docker: SourceDocker) {
  try {
    if (deploymentDigest(component.runtime) !== component.runtimeDigest ||
      !/^[a-z][a-z0-9.-]{0,127}$/u.test(serviceId) ||
      !component.runtime.services.some(service => service.composeService === serviceId)) throw new Error();
    const configuration = z.object({ services: z.record(z.string(), z.unknown()) }).passthrough().parse(configured);
    const service = z.object({ image: z.string().min(1).max(512),
      environment: z.object({ POSTGRES_DB: identifier, POSTGRES_USER: identifier }).passthrough() }).passthrough()
      .parse(configuration.services[serviceId]);
    const repository = service.image.split('@')[0]!.replace(/:[^/:]+$/u, '');
    const image = component.images.find(item => item.repository === repository);
    if (!image) throw new Error();
    const imageId = (await docker(['image', 'inspect', '--format', '{{.Id}}', `${image.repository}@${image.digest}`], 10, true)).trim();
    if (!/^sha256:[a-f0-9]{64}$/u.test(imageId)) throw new Error();
    const ids = (await docker(['ps', '--all', '--quiet', '--no-trunc', '--filter',
      `label=com.docker.compose.project=${component.runtime.compose.projectName}`, '--filter',
      `label=com.docker.compose.service=${serviceId}`], 10, true)).trim().split(/\s+/u);
    if (ids.length !== 1 || !/^[a-f0-9]{64}$/u.test(ids[0]!)) throw new Error();
    const container = ids[0]!;
    const inspect = async () => {
      const value = z.object({ id: z.string(), image: z.string(), configuredImage: z.string(), state: z.string(),
        started: z.string().min(1), project: z.string(), service: z.string() }).strict().parse(JSON.parse(await docker([
        'inspect', '--format', '{"id":{{json .Id}},"image":{{json .Image}},"configuredImage":{{json .Config.Image}},"state":{{json .State.Status}},"started":{{json .State.StartedAt}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}}}', container], 10, true)));
      if (value.id !== container || value.image !== imageId || value.configuredImage !== service.image || value.state !== 'running' ||
        value.project !== component.runtime.compose.projectName || value.service !== serviceId) throw new Error();
      return value;
    };
    const before = await inspect();
    const inventory = postgresSourceDescriptorSchema.parse(JSON.parse(await docker(['exec', container, 'env', '-i',
      'PATH=/usr/local/bin:/usr/bin:/bin', 'PGPASSFILE=/dev/null', 'psql', '--no-password', '-X', '-qAt',
      '-h', '/var/run/postgresql', '-p', '5432', '-U', service.environment.POSTGRES_USER, '-d', service.environment.POSTGRES_DB,
      '-v', 'ON_ERROR_STOP=1', '-c', postgresSourceInventorySql], 15, true)));
    if (inventory.database !== service.environment.POSTGRES_DB || deploymentDigest(before) !== deploymentDigest(await inspect())) throw new Error();
    const { cluster, ...metadata } = inventory;
    const result = { componentId: component.componentId, release: component.release, serviceId, container,
      runtimeDigest: component.runtimeDigest, imageDigest: image.digest, clusterIdentity: deploymentDigest({ cluster }), ...metadata };
    return { ...result, inventoryDigest: deploymentDigest(result) };
  } catch { throw new Error('Installed PostgreSQL source inventory unavailable, unsupported or changed; source unchanged.'); }
}
