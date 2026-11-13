/** Read-only admission: private V2 staging is optional at runtime, but its
 * candidate binary must not claim the new schema without its isolation guards.
 */
import {historySourceRuntimeSql} from './history-source-runtime-schema.js';
export const historySyncRuntimeSql = `(${historySourceRuntimeSql}) AND NOT EXISTS(
 SELECT 1 FROM (VALUES ('history_account_identities',false),('history_sync_runs',true),
 ('history_sync_chunks',true),('history_sync_receipts',false),('history_sync_peers',false),
 ('history_sync_catalogue_pages',false),('history_sync_native_peers',false),('history_sync_record_results',false),
 ('history_sync_live_proofs',false),('history_sync_deliveries',true),('history_sync_remote_peers',false)) required(name,mutable)
 WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.'||required.name)
  AND c.relrowsecurity AND c.relforcerowsecurity AND pg_catalog.pg_get_userbyid(c.relowner)='jrc_migrator'
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid AND p.polname='history_sync_tenant'
   AND p.polcmd='*' AND p.polroles=ARRAY[(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='jrc_app')])
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid AND p.polname='lifecycle_migrator'
   AND p.polcmd='*' AND p.polroles=ARRAY[(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='jrc_migrator')]
   AND pg_catalog.pg_get_expr(p.polqual,p.polrelid)='true' AND pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid)='true')
  AND pg_catalog.has_table_privilege('jrc_app',c.oid,'SELECT') AND pg_catalog.has_table_privilege('jrc_app',c.oid,'INSERT')
  AND pg_catalog.has_table_privilege('jrc_app',c.oid,'UPDATE')=required.mutable
  AND NOT pg_catalog.has_table_privilege('jrc_app',c.oid,'DELETE')
  AND NOT pg_catalog.has_table_privilege('jrc_auth',c.oid,'SELECT')
  AND NOT pg_catalog.has_table_privilege('jrc_platform',c.oid,'SELECT')
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a WHERE a.grantee=0)
 )) AND EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a
 WHERE a.attrelid=pg_catalog.to_regclass('public.history_sync_chunks') AND a.attname='admission_kind' AND a.attnotnull AND NOT a.attisdropped)
 AND NOT EXISTS(SELECT 1 FROM (VALUES ('history_sync_runs','history_sync_run_guard'),
 ('history_sync_chunks','history_sync_chunk_guard'),('history_account_identities','history_sync_identity_immutable'),
 ('history_sync_peers','history_sync_peer_guard')) required(name,trigger_name)
 WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=pg_catalog.to_regclass('public.'||required.name)
 AND t.tgname=required.trigger_name AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal))
 AND NOT EXISTS(SELECT 1 FROM (VALUES ('recipient_kind'),('peer_jid')) required(name)
  WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a
   WHERE a.attrelid=pg_catalog.to_regclass('public.history_sync_record_results') AND a.attname=required.name
   AND a.atttypid='text'::regtype AND NOT a.attisdropped))
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid=pg_catalog.to_regclass('public.history_sync_record_results')
  AND c.conname='history_sync_result_peer' AND c.contype='c' AND c.convalidated)
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_index i WHERE i.indexrelid=pg_catalog.to_regclass('public.history_sync_result_peers')
  AND i.indrelid=pg_catalog.to_regclass('public.history_sync_record_results') AND i.indisvalid AND i.indisready)
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=pg_catalog.to_regprocedure('public.history_media_upload_identity_valid(jsonb,text,uuid)')
  AND p.provolatile='i' AND NOT p.prosecdef AND pg_catalog.pg_get_userbyid(p.proowner)='jrc_migrator'
  AND pg_catalog.has_function_privilege('jrc_app',p.oid,'EXECUTE')
  AND NOT pg_catalog.has_function_privilege('jrc_auth',p.oid,'EXECUTE')
  AND NOT pg_catalog.has_function_privilege('jrc_platform',p.oid,'EXECUTE')
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee=0))
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid=pg_catalog.to_regclass('public.messaging_media')
  AND c.conname='messaging_media_upload_identity' AND c.contype='c' AND c.convalidated
  AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%history_media_upload_identity_valid(descriptor, source_key, id)%')`;
