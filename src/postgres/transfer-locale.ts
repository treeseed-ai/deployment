import { z } from 'zod';
import { deploymentDigest } from '@treeseed/sdk/deployment';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const localeName = z.string().min(1).max(256).refine(value => !/[\u0000-\u001f]/u.test(value));
export const postgresTransferLocaleSchema = z.object({
  encoding: localeName, collate: localeName, ctype: localeName,
  provider: z.enum(['c', 'i', 'b']), version: localeName.nullable(), locale: localeName.nullable(),
}).strict();

/** Internal transfer intent, not a general authorization or public API. Only
 * explicit logical-rebuild conversion may differ from the default exact locale.
 * Source/destination descriptors are captured by fixed privileged inspection.
 */
export const postgresLocaleConversionSchema = z.object({
  method: z.literal('logical-rebuild'),
  source: postgresTransferLocaleSchema,
  destination: postgresTransferLocaleSchema,
}).strict().superRefine((value, context) => {
  if (value.source.encoding !== 'UTF8' || value.destination.encoding !== 'UTF8'
    || value.source.provider !== 'c' || value.destination.provider !== 'c'
    || value.source.locale !== null || value.destination.locale !== null
    || value.destination.version === null)
    context.addIssue({ code: 'custom', message: 'Explicit UTF8 libc conversion to a versioned destination is required' });
});

const fingerprintSchema = z.object({
  schemaDigest: digest, definitionDigest: digest, localeDigest: digest, contentDigest: digest,
  relationCount: z.number().int().nonnegative(),
}).strict();

/** Fingerprints are produced only after invalid indexes, unvalidated constraints
 * and stale database collation versions have been rejected. Restore must rebuild
 * indexes in a fresh owned destination; this comparison never authorizes REINDEX
 * in place or a catalog-only REFRESH COLLATION VERSION.
 */
export function verifyPostgresTransferFingerprints(source: unknown, destination: unknown, conversion?: unknown) {
  const left = fingerprintSchema.parse(source), right = fingerprintSchema.parse(destination);
  if (left.definitionDigest !== right.definitionDigest || left.contentDigest !== right.contentDigest
    || left.relationCount !== right.relationCount) return false;
  if (conversion === undefined) return left.schemaDigest === right.schemaDigest && left.localeDigest === right.localeDigest;
  const policy = postgresLocaleConversionSchema.parse(conversion);
  return left.localeDigest === deploymentDigest(policy.source) && right.localeDigest === deploymentDigest(policy.destination);
}

export const postgresTransferValiditySql = `SELECT
  NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      AND (NOT i.indisvalid OR NOT i.indisready OR NOT i.indislive))
  AND NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND NOT c.convalidated)
  AND EXISTS (SELECT 1 FROM pg_database d WHERE d.datname=current_database()
    AND d.datcollversion IS NOT DISTINCT FROM pg_database_collation_actual_version(d.oid)) AS valid`;
