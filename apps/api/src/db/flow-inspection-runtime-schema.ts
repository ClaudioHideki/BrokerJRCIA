/** Read-only app-role guard for migrations 0081/0082; no credential contents. */
export const flowInspectionRuntimeSql=`
 EXISTS(SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
  WHERE i.indexrelid=pg_catalog.to_regclass('public.automation_execution_inspection_page')
   AND i.indrelid=pg_catalog.to_regclass('public.automation_executions') AND i.indisvalid AND i.indisready
   AND i.indpred IS NULL AND i.indexprs IS NULL AND i.indnkeyatts=3 AND i.indnatts=3
   AND i.indoption::text='0 3 3' AND pg_catalog.pg_get_userbyid(c.relowner)='jrc_migrator'
   AND (SELECT array_agg(a.attname::text ORDER BY k.ordinality)
    FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality)
    JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum)
     =ARRAY['organization_id','started_at','id'])
 AND NOT EXISTS(SELECT 1 FROM (VALUES
  ('flow_delegation_credentials',true),('flow_delegation_session_grants',true),('flow_member_grants',false)
 ) required(relation_name,requires_scope)
 WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c
  WHERE c.conrelid=pg_catalog.to_regclass('public.'||required.relation_name)
   AND c.conname=required.relation_name||'_scopes_check' AND c.contype='c' AND c.convalidated
   -- Names or a substring alone could approve a legacy/permissive same-named CHECK.
   -- Compare the canonical PostgreSQL expression of the bounded scope contract.
   AND regexp_replace(pg_catalog.pg_get_expr(c.conbin,c.conrelid),'[[:space:]()]|::text','','g')=
    (CASE WHEN required.requires_scope THEN 'cardinalityscopes>=1AND' ELSE '' END)||
    'cardinalityscopes<=5ANDarray_positionscopes,NULLISNULLANDscopes<@ARRAY[''flow:read'',''flow:edit'',''flow:publish'',''flow:bind'',''flow:executions:read'']'))`;
