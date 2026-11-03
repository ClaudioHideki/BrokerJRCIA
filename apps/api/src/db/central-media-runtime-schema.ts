/** Read-only app-role guard for 0083. References never authorize a download. */
export const centralMediaRuntimeSql = `
 EXISTS(SELECT 1 FROM pg_catalog.pg_class c
  WHERE c.oid=pg_catalog.to_regclass('public.central_flow_input_media')
   AND c.relrowsecurity AND c.relforcerowsecurity AND pg_catalog.pg_get_userbyid(c.relowner)='jrc_migrator'
   AND pg_catalog.has_table_privilege('jrc_app',c.oid,'SELECT')
   AND pg_catalog.has_table_privilege('jrc_app',c.oid,'INSERT')
   AND NOT pg_catalog.has_table_privilege('jrc_app',c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   AND NOT pg_catalog.has_table_privilege('jrc_auth',c.oid,'SELECT,INSERT,UPDATE,DELETE')
   AND NOT pg_catalog.has_table_privilege('jrc_platform',c.oid,'SELECT,INSERT,UPDATE,DELETE')
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a WHERE a.grantee=0)
   AND (SELECT count(*) FROM pg_catalog.pg_policy WHERE polrelid=c.oid)=2
   AND EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid AND p.polname='central_tenant'
    AND p.polcmd='*' AND p.polpermissive AND p.polroles=ARRAY[(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='jrc_app')]
    AND pg_catalog.pg_get_expr(p.polqual,p.polrelid)=pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid)
    AND regexp_replace(pg_catalog.pg_get_expr(p.polqual,p.polrelid),'[[:space:]()]|::text','','g')=
     $policy$organization_id=NULLIFcurrent_setting'app.organization_id',true,''::uuid$policy$)
   AND EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid AND p.polname='lifecycle_migrator'
    AND p.polcmd='*' AND p.polroles=ARRAY[(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='jrc_migrator')]
    AND pg_catalog.pg_get_expr(p.polqual,p.polrelid)='true' AND pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid)='true'))
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc f ON f.oid=t.tgfoid
  WHERE t.tgrelid=pg_catalog.to_regclass('public.central_flow_input_media')
   AND t.tgname='central_flow_input_media_immutable' AND NOT t.tgisinternal AND t.tgenabled IN ('O','A') AND t.tgtype=19
   AND f.oid=pg_catalog.to_regprocedure('public.reject_central_flow_input_media_update()')
   AND pg_catalog.pg_get_userbyid(f.proowner)='jrc_migrator' AND NOT f.prosecdef
   AND f.proconfig=ARRAY['search_path=pg_catalog, public']
   AND regexp_replace(f.prosrc,'[[:space:]]','','g')='BEGINRAISEEXCEPTION''CENTRAL_MEDIA_REFERENCE_IMMUTABLE'';END'
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(f.proacl,pg_catalog.acldefault('f',f.proowner))) a WHERE a.grantee=0))
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=pg_catalog.to_regclass('public.central_runtime_events')
  AND attname='media_input' AND atttypid='jsonb'::regtype AND attnum>0 AND NOT attisdropped)
 -- A surviving FK/index cannot establish that every column used by the runtime still exists.
 AND NOT EXISTS(SELECT 1 FROM (VALUES
  ('organization_id','uuid'),('id','uuid'),('channel_id','uuid'),('integration_id','uuid'),
  ('conversation_id','uuid'),('event_id','uuid'),('origin','text'),('account_id','int8'),
  ('inbox_id','int8'),('contact_id','int8'),('remote_conversation_id','int8'),
  ('remote_message_id','int8'),('attachment_id','int8'),('destination_revision','int4'),
  ('credential_version','int4'),('owner_revision','int4'),('kind','text'),('file_name','text'),('created_at','timestamptz')
 ) required(column_name,type_name)
 WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a
  WHERE a.attrelid=pg_catalog.to_regclass('public.central_flow_input_media') AND a.attname=required.column_name
   AND a.attnum>0 AND NOT a.attisdropped AND a.attnotnull AND a.atttypmod=-1
   AND a.attidentity='' AND a.attgenerated='' AND a.atttypid=pg_catalog.to_regtype('pg_catalog.'||required.type_name)))
 AND NOT EXISTS(SELECT 1 FROM (VALUES ('id','gen_random_uuid()'),('created_at','now()')) required(column_name,expression)
  WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE a.attrelid=pg_catalog.to_regclass('public.central_flow_input_media') AND a.attname=required.column_name
    AND pg_catalog.pg_get_expr(d.adbin,d.adrelid)=required.expression))
 -- Hashes pin canonical pg_get_constraintdef output, not untrusted names or substrings.
 -- The migration and isolated schema corruption tests are the source of these definitions.
 AND NOT EXISTS(SELECT 1 FROM (VALUES
  ('central_flow_input_media','central_flow_media_event_fk','1405d753ee1393a650c5eddce49b1472'),
  ('central_flow_input_media','central_flow_media_conversation_fk','9ec2a1ac98da9b38563a672f74f55d84'),
  ('central_flow_input_media','central_flow_media_connection_fk','fbdd93142c6c4de3fb0ff197ae8fb486'),
  ('central_flow_input_media','central_flow_input_media_pkey','a939bab307e3e7445cb8f5502094acbc'),
  ('central_flow_input_media','central_flow_input_media_organization_id_event_id_attachmen_key','5f79443e030f51bbda308ff37de444ff'),
  ('central_flow_input_media','central_flow_input_media_organization_id_integration_id_rem_key','027b85f2ede03815b488a8b1cbd6c277'),
  ('central_flow_input_media','central_flow_input_media_account_id_check','4900f8061d7cf7d1521426116e7ef75e'),
  ('central_flow_input_media','central_flow_input_media_attachment_id_check','5b7832adceb4494768592f072e72d1de'),
  ('central_flow_input_media','central_flow_input_media_contact_id_check','c8d3d95378b328d93f9d7364fcd343cb'),
  ('central_flow_input_media','central_flow_input_media_credential_version_check','6cbb8ef905a079d8d78aed2061f7caf6'),
  ('central_flow_input_media','central_flow_input_media_destination_revision_check','32b4c816776dc177034c88ca7577db46'),
  ('central_flow_input_media','central_flow_input_media_file_name_check','51f297ca70d507d6376d983161b3af99'),
  ('central_flow_input_media','central_flow_input_media_inbox_id_check','427ce4f9957b5b361df436c843c5fd9d'),
  ('central_flow_input_media','central_flow_input_media_kind_check','2a3bd71bac8dc917cfd363303a6a5b56'),
  ('central_flow_input_media','central_flow_input_media_origin_check','6e8b7aee1612e982461cf25004beec89'),
  ('central_flow_input_media','central_flow_input_media_owner_revision_check','2b6c14fafd8bffe7061ccedbddd9df88'),
  ('central_flow_input_media','central_flow_input_media_remote_conversation_id_check','18af5342aa4981ea3ebff16e4c90e76d'),
  ('central_flow_input_media','central_flow_input_media_remote_message_id_check','05a5774be967b99088be1269ae226981'),
  ('central_runtime_events','central_runtime_events_kind_check','41cf435f951938e2f63ce5f89643746b'),
  ('central_runtime_events','central_runtime_events_media_input_check','049d5b814322ef23874b5cf72c0dede0'),
  ('central_runtime_events','central_runtime_media_scope_unique','11cf4f357e23f57d70cbd6fc42791fc9')
 ) required(relation_name,constraint_name,definition_hash)
 WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c
  WHERE c.conrelid=pg_catalog.to_regclass('public.'||required.relation_name) AND c.conname=required.constraint_name
   AND c.convalidated AND md5(pg_catalog.pg_get_constraintdef(c.oid))=required.definition_hash))
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
  WHERE i.indexrelid=pg_catalog.to_regclass('public.central_flow_input_media_scope')
   AND i.indrelid=pg_catalog.to_regclass('public.central_flow_input_media') AND i.indisvalid AND i.indisready
   AND i.indpred IS NULL AND i.indexprs IS NULL AND i.indnkeyatts=4 AND i.indnatts=4
   AND pg_catalog.pg_get_userbyid(c.relowner)='jrc_migrator'
   AND (SELECT array_agg(a.attname::text ORDER BY k.ordinality)
    FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality)
    JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum)
     =ARRAY['organization_id','channel_id','conversation_id','id'])`;
