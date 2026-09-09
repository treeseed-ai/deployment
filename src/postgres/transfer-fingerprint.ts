import { createHash } from 'node:crypto';
import { deploymentDigest } from '@treeseed/sdk/deployment';
import type { PostgresInspectionSession } from './inventory.js';
import { transferOwnershipSql, transferRelationsSql, transferSchemaSql, transferUnsupportedSql } from './transfer-catalog.js';

const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const name = (value: unknown) => { if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error(); return value; };

/** Fingerprints are internal digests, not row dumps. Caller must already fence
 * writers on both databases and verify again before binding CAS. A consistent
 * snapshot alone cannot prove writers remain fenced after this function exits.
 */
export async function fingerprintPostgresTransfer(session: PostgresInspectionSession, expected: { database: string; owner: string; major: 16 | 17 }) {
  try {
    await session.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await session.query("SET LOCAL search_path=pg_catalog; SET LOCAL timezone='UTC'; SET LOCAL extra_float_digits=3; SET LOCAL bytea_output='hex'; SET LOCAL datestyle='ISO, YMD'");
    const identity = await session.query(`SELECT current_database() AS database, current_setting('server_version_num')::int/10000 AS major,
      jsonb_build_object('encoding',pg_encoding_to_char(d.encoding),'collate',d.datcollate,'ctype',d.datctype,
        'provider',d.datlocprovider,'version',d.datcollversion,'locale',COALESCE(to_jsonb(d)->>'datlocale',to_jsonb(d)->>'daticulocale')) AS locale
      FROM pg_database d WHERE d.datname=current_database()`);
    if (identity.rows.length !== 1 || identity.rows[0]?.database !== expected.database || Number(identity.rows[0]?.major) !== expected.major) throw new Error();
    if ((await session.query(transferUnsupportedSql)).rows[0]?.unsupported !== false) throw new Error();
    if ((await session.query(transferOwnershipSql, [expected.owner])).rows[0]?.owned !== true) throw new Error();
    const relations = (await session.query(transferRelationsSql)).rows;
    const schema = (await session.query(transferSchemaSql)).rows;
    if (relations.length > 10000 || schema.length > 100000) throw new Error();
    const content: Array<{ schema: string; name: string; digest: string; rows: number }> = [];
    for (const relation of relations) {
      const schemaName = name(relation.schema), relationName = name(relation.name);
      if (relation.owner !== expected.owner || !['r','p','v','m','S','c'].includes(String(relation.kind))) throw new Error();
      relation.owner = 'allocation-owner'; // Only this explicitly allowed mapping is normalized.
      const selected = `${quote(schemaName)}.${quote(relationName)}`;
      if (relation.kind === 'S') {
        const state = await session.query(`SELECT last_value::text AS value,is_called AS called FROM ${selected}`);
        if (state.rows.length !== 1 || typeof state.rows[0]?.value !== 'string' || typeof state.rows[0]?.called !== 'boolean') throw new Error();
        content.push({ schema: schemaName, name: relationName, digest: deploymentDigest(state.rows), rows: 1 });
      } else if (relation.kind === 'r' || relation.kind === 'm') {
        const hash = createHash('sha256'); let rows = 0;
        // Sort under bytewise collation to preserve duplicate rows without
        // depending on primary keys, insertion order or host locale.
        await session.query(`DECLARE treeseed_transfer_rows NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS value FROM ONLY ${selected} t ORDER BY row_to_json(t)::text COLLATE "C"`);
        for (;;) {
          const batch = await session.query('FETCH FORWARD 256 FROM treeseed_transfer_rows');
          if (batch.rows.length > 256) throw new Error();
          for (const row of batch.rows) {
            const value = name(row.value);
            hash.update(String(Buffer.byteLength(value))); hash.update(':'); hash.update(value);
            delete row.value; rows++;
            if (!Number.isSafeInteger(rows)) throw new Error();
          }
          if (batch.rows.length < 256) break;
        }
        await session.query('CLOSE treeseed_transfer_rows');
        content.push({ schema: schemaName, name: relationName, digest: `sha256:${hash.digest('hex')}`, rows });
      }
    }
    if (!identity.rows[0]?.locale || typeof identity.rows[0].locale !== 'object') throw new Error();
    const result = { schemaDigest: deploymentDigest({ locale: identity.rows[0].locale, relations, schema }), contentDigest: deploymentDigest(content), relationCount: relations.length };
    await session.query('COMMIT');
    return result;
  } catch {
    await session.query('ROLLBACK').catch(() => undefined);
    throw new Error('PostgreSQL transfer fingerprint unavailable or unsupported; binding unchanged.');
  }
}
