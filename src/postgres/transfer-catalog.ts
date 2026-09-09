// Catalog-only SQL. Values are hashed internally and never returned as evidence.
const userSchema = "n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'";
const independent = (catalog: string, alias: string) => `NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='${catalog}'::regclass AND d.objid=${alias}.oid AND d.deptype='e')`;

export const transferUnsupportedSql = `SELECT
  EXISTS (SELECT 1 FROM pg_largeobject_metadata) OR
  EXISTS (SELECT 1 FROM pg_foreign_table) OR
  EXISTS (SELECT 1 FROM pg_subscription) OR
  EXISTS (SELECT 1 FROM pg_publication) OR
  EXISTS (SELECT 1 FROM pg_event_trigger) OR
  EXISTS (SELECT 1 FROM pg_extension WHERE extconfig IS NOT NULL) OR
  EXISTS (SELECT 1 FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${userSchema} AND r.rulename<>'_RETURN') OR
  EXISTS (SELECT 1 FROM pg_cast c JOIN pg_type t ON t.oid=c.castsource JOIN pg_type target ON target.oid=c.casttarget
    JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_namespace target_n ON target_n.oid=target.typnamespace
    WHERE (${userSchema} OR (target_n.nspname !~ '^pg_' AND target_n.nspname<>'information_schema')) AND ${independent('pg_cast', 'c')}) OR
  EXISTS (SELECT 1 FROM pg_conversion c JOIN pg_namespace n ON n.oid=c.connamespace WHERE ${userSchema} AND ${independent('pg_conversion', 'c')}) OR
  EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE ${userSchema}
    AND ${independent('pg_type', 't')} AND t.typtype NOT IN ('e','d') AND t.typrelid=0 AND t.typelem=0) OR
  EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE ${userSchema}
    AND ${independent('pg_proc', 'p')} AND p.prokind NOT IN ('f','p')) OR
  EXISTS (SELECT 1 FROM pg_operator o JOIN pg_namespace n ON n.oid=o.oprnamespace WHERE ${userSchema} AND ${independent('pg_operator', 'o')}) OR
  EXISTS (SELECT 1 FROM pg_collation c JOIN pg_namespace n ON n.oid=c.collnamespace WHERE ${userSchema} AND ${independent('pg_collation', 'c')})
  AS unsupported`;

export const transferRelationsSql = `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind,
  pg_get_userbyid(c.relowner) AS owner, c.relpersistence AS persistence,
  c.relrowsecurity AS rls, c.relforcerowsecurity AS "forceRls", c.reloptions AS options,
  CASE WHEN c.relkind='p' THEN pg_get_partkeydef(c.oid) END AS partition,
  CASE WHEN c.relispartition THEN pg_get_expr(c.relpartbound,c.oid) END AS bound,
  CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid) END AS view,
  ARRAY(SELECT pn.nspname||'.'||pc.relname FROM pg_inherits i JOIN pg_class pc ON pc.oid=i.inhparent
    JOIN pg_namespace pn ON pn.oid=pc.relnamespace WHERE i.inhrelid=c.oid ORDER BY i.inhseqno) AS parents
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${userSchema}
    AND c.relkind IN ('r','p','v','m','S','f','c') AND ${independent('pg_class', 'c')}
  ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C" LIMIT 10001`;

export const transferSchemaSql = `SELECT kind, value FROM (
  SELECT 'schema' AS kind, jsonb_build_object('name',n.nspname) AS value FROM pg_namespace n WHERE ${userSchema}
  UNION ALL SELECT 'extension',jsonb_build_object('name',e.extname,'version',e.extversion,'schema',n.nspname)
    FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname<>'plpgsql'
  UNION ALL SELECT 'column',jsonb_build_object('schema',n.nspname,'table',c.relname,'name',a.attname,
      'ordinal',row_number() OVER (PARTITION BY c.oid ORDER BY a.attnum),
      'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,
      'default',pg_get_expr(ad.adbin,ad.adrelid),'collation',co.collname)
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef ad ON ad.adrelid=c.oid AND ad.adnum=a.attnum LEFT JOIN pg_collation co ON co.oid=a.attcollation
    WHERE ${userSchema} AND a.attnum>0 AND NOT a.attisdropped AND c.relkind IN ('r','p','v','m','c') AND ${independent('pg_class', 'c')}
  UNION ALL SELECT 'constraint',jsonb_build_object('schema',n.nspname,'table',c.relname,'name',co.conname,'definition',pg_get_constraintdef(co.oid))
    FROM pg_constraint co JOIN pg_namespace n ON n.oid=co.connamespace LEFT JOIN pg_class c ON c.oid=co.conrelid
    WHERE ${userSchema} AND ${independent('pg_constraint', 'co')}
  UNION ALL SELECT 'index',jsonb_build_object('schema',n.nspname,'table',c.relname,'definition',pg_get_indexdef(i.indexrelid))
    FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE ${userSchema} AND ${independent('pg_class', 'c')}
  UNION ALL SELECT 'trigger',jsonb_build_object('schema',n.nspname,'table',c.relname,'definition',pg_get_triggerdef(t.oid),'enabled',t.tgenabled)
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE ${userSchema} AND NOT t.tgisinternal AND ${independent('pg_trigger', 't')}
  UNION ALL SELECT 'function',jsonb_build_object('schema',n.nspname,'definition',pg_get_functiondef(p.oid))
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE ${userSchema} AND p.prokind IN ('f','p') AND ${independent('pg_proc', 'p')}
  UNION ALL SELECT 'enum',jsonb_build_object('schema',n.nspname,'name',t.typname,'value',e.enumlabel,'order',row_number() OVER (PARTITION BY t.oid ORDER BY e.enumsortorder))
    FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE ${userSchema}
  UNION ALL SELECT 'domain',jsonb_build_object('schema',n.nspname,'name',t.typname,'base',format_type(t.typbasetype,t.typtypmod),'notNull',t.typnotnull,'default',t.typdefault)
    FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE ${userSchema} AND t.typtype='d' AND ${independent('pg_type', 't')}
  UNION ALL SELECT 'sequence',jsonb_build_object('schema',n.nspname,'name',c.relname,'type',format_type(s.seqtypid,NULL),'start',s.seqstart,'increment',s.seqincrement,'max',s.seqmax,'min',s.seqmin,'cache',s.seqcache,'cycle',s.seqcycle)
    FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${userSchema} AND ${independent('pg_class', 'c')}
  UNION ALL SELECT 'sequence-binding',jsonb_build_object('schema',n.nspname,'name',c.relname,'tableSchema',tn.nspname,'table',t.relname,'column',a.attname,'kind',d.deptype)
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=c.oid AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i')
    JOIN pg_class t ON t.oid=d.refobjid JOIN pg_namespace tn ON tn.oid=t.relnamespace JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
    WHERE ${userSchema} AND c.relkind='S' AND ${independent('pg_class', 'c')}
  UNION ALL SELECT 'policy',jsonb_build_object('schema',n.nspname,'table',c.relname,'name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,
      'using',pg_get_expr(p.polqual,c.oid),'check',pg_get_expr(p.polwithcheck,c.oid),
      'roles',ARRAY(SELECT CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END FROM unnest(p.polroles) r ORDER BY 1))
    FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${userSchema}
) metadata ORDER BY kind COLLATE "C",value::text COLLATE "C" LIMIT 100001`;

export const transferOwnershipSql = `SELECT NOT EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE ${userSchema} AND ${independent('pg_proc', 'p')} AND pg_get_userbyid(p.proowner)<>$1
  UNION ALL SELECT 1 FROM pg_namespace n WHERE ${userSchema} AND n.nspname<>'public' AND pg_get_userbyid(n.nspowner)<>$1
  UNION ALL SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE ${userSchema} AND ${independent('pg_type', 't')} AND t.typtype IN ('e','d') AND pg_get_userbyid(t.typowner)<>$1
) AS owned`;
