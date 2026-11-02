/** Readiness for native modules, Evolution routing and bounded AI. */
export const consolidatedRuntimeSql=`
 NOT EXISTS(SELECT 1 FROM (VALUES ('flow_native_registration_challenges','tenant_scope','jrc_app','*','SELECT,INSERT,UPDATE'),
('flow_native_registration_targets','tenant_scope','jrc_app','*','SELECT,INSERT'),
('flow_native_registrations','tenant_scope','jrc_app','*','SELECT,INSERT,UPDATE'),
('flow_native_installation_grants','tenant_scope','jrc_app','*','SELECT,INSERT,UPDATE'),
('flow_native_installation_operations','tenant_scope','jrc_app','*','SELECT,INSERT,UPDATE'),
('flow_native_installation_targets','tenant_scope','jrc_app','*','SELECT,INSERT'),
('automation_action_resources','automation_effect_tenant','jrc_app','*','SELECT,INSERT,UPDATE'),
('automation_action_catalogs','automation_effect_tenant','jrc_app','*','SELECT,INSERT,UPDATE'),
('automation_conversation_state','automation_effect_tenant','jrc_app','*','SELECT,INSERT,UPDATE'),
('automation_private_notes','automation_effect_tenant','jrc_app','*','SELECT,INSERT,UPDATE'),
('automation_conversation_effects','automation_effect_tenant','jrc_app','*','SELECT,INSERT,UPDATE'),
('automation_media_assets','automation_effect_tenant','jrc_app','*','SELECT,INSERT,UPDATE'),
('automation_effect_version_pins','automation_effect_tenant','jrc_app','*','SELECT,INSERT,UPDATE'),
('chatwoot_group_scopes','group_central_tenant','jrc_app','*','SELECT,INSERT'),
('chatwoot_group_replies','group_central_tenant','jrc_app','*','SELECT,INSERT'),
('automation_ai_monthly_budgets','automation_ai_tenant','jrc_app','*','SELECT,INSERT,UPDATE'),
('automation_ai_reservations','automation_ai_tenant','jrc_app','*','SELECT,INSERT,UPDATE'),
('evolution_instance_bindings','evolution_binding_tenant','jrc_app','r','SELECT'),
('evolution_engines','evolution_engines_migrator','jrc_migrator','*',''),
('evolution_io_leases','evolution_io_migrator','jrc_migrator','*',''),
('evolution_io_backoff','evolution_backoff_migrator','jrc_migrator','*',''),
('evolution_operation_history','evolution_history_maintenance','jrc_migrator','*',''),
('evolution_cleanup_history','evolution_cleanup_history_maintenance','jrc_migrator','*',''),
('evolution_cleanup_io','evolution_cleanup_io_maintenance','jrc_migrator','*',''),
('evolution_io_history','evolution_io_history_maintenance','jrc_migrator','*','')) required(name,policy,role_name,command,privileges)
 WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.'||required.name) AND c.relrowsecurity AND c.relforcerowsecurity AND pg_catalog.pg_get_userbyid(c.relowner)='jrc_migrator'
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid AND p.polname=required.policy AND p.polcmd::text=required.command AND p.polroles=ARRAY[(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=required.role_name)]))
 OR EXISTS(SELECT 1 FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) privilege WHERE pg_catalog.has_table_privilege('jrc_app',pg_catalog.to_regclass('public.'||required.name),privilege) IS DISTINCT FROM (privilege=ANY(string_to_array(required.privileges,','))))
 OR pg_catalog.has_table_privilege('jrc_auth',pg_catalog.to_regclass('public.'||required.name),'SELECT,INSERT,UPDATE,DELETE')
 OR pg_catalog.has_table_privilege('jrc_platform',pg_catalog.to_regclass('public.'||required.name),'SELECT,INSERT,UPDATE,DELETE')
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c,LATERAL pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a WHERE c.oid=pg_catalog.to_regclass('public.'||required.name) AND a.grantee=0))
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid=pg_catalog.to_regclass('public.messaging_media')
  AND c.conname='messaging_media_upload_identity' AND c.contype='c' AND c.convalidated
  AND regexp_replace(pg_catalog.pg_get_expr(c.conbin,c.conrelid),'[[:space:]()]','','g')
   ='source<>''UPLOAD''::textORpartner_media_upload_identity_validdescriptor,source_key')
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=pg_catalog.to_regprocedure('public.partner_media_upload_identity_valid(jsonb,text)')
  AND NOT p.prosecdef AND p.provolatile='i' AND pg_catalog.pg_get_userbyid(p.proowner)='jrc_migrator'
  AND p.proconfig @> ARRAY['search_path=pg_catalog, public']::text[]
  AND md5(replace(p.prosrc,chr(13),''))='26e0f678d0906fbd829da07c904d6ada'
  AND pg_catalog.has_function_privilege('jrc_app',p.oid,'EXECUTE')
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee=0)
  AND NOT EXISTS(SELECT 1 FROM (VALUES ('jrc_auth'),('jrc_platform'),('jrc_lifecycle')) forbidden(role_name)
   WHERE pg_catalog.has_function_privilege(forbidden.role_name,p.oid,'EXECUTE')))
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=pg_catalog.to_regclass('public.automation_conversation_effects') AND t.tgname='automation_conversation_effect_immutable' AND t.tgenabled='O')
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=pg_catalog.to_regclass('public.chatwoot_group_scopes') AND t.tgname='group_scope_retirement' AND t.tgenabled='O')
 AND NOT EXISTS(SELECT 1 FROM (VALUES ('resolve_flow_installation_grant(text)','jrc_auth'),('resolve_flow_installation_reduction(text)','jrc_auth'),('evolution_assert_binding(uuid,uuid,text,bigint,text,boolean,boolean)','jrc_app'),('evolution_acquire_io(uuid,uuid,text,bigint,text,uuid,boolean,integer,uuid,jsonb)','jrc_app'),('evolution_settle_io(uuid,uuid,uuid,boolean,text,boolean)','jrc_app'),('evolution_cleanup_snapshot(uuid,uuid,uuid,boolean)','jrc_lifecycle')) required(signature,role_name)
 WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=pg_catalog.to_regprocedure('public.'||required.signature) AND p.prosecdef AND pg_catalog.pg_get_userbyid(p.proowner)='jrc_migrator')
 OR NOT pg_catalog.has_function_privilege(required.role_name,pg_catalog.to_regprocedure('public.'||required.signature),'EXECUTE')
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p,LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE p.oid=pg_catalog.to_regprocedure('public.'||required.signature) AND a.grantee=0))

 -- Snapshot UPDATE may also be granted per-column; table ACLs alone cannot see it.
 AND NOT EXISTS(SELECT 1 FROM (VALUES ('flow_native_registration_targets'),('flow_native_installation_targets')) required(name)
  WHERE pg_catalog.has_any_column_privilege('jrc_app',pg_catalog.to_regclass('public.'||required.name),'UPDATE'))
 -- 0060's structural witness remains visible to the app without catalogue access.
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c
  WHERE c.conrelid=pg_catalog.to_regclass('public.flow_native_registration_challenges')
   AND c.confrelid=pg_catalog.to_regclass('public.flow_native_registrations')
   AND c.conname='flow_native_challenge_registration_fk' AND c.contype='f'
   AND c.convalidated AND c.condeferrable AND NOT c.condeferred
   AND c.confdeltype='a' AND c.confupdtype='a' AND c.confmatchtype='s'
   AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
    FROM unnest(c.conkey) WITH ORDINALITY k(num,ord)
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num)
    =ARRAY['organization_id','registration_id']::text[]
   AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
    FROM unnest(c.confkey) WITH ORDINALITY k(num,ord)
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num)
    =ARRAY['organization_id','id']::text[])
 AND NOT EXISTS(SELECT 1 FROM (VALUES
  ('lifecycle_native_pending_count(uuid,uuid)',false),
  ('lifecycle_pending_count(uuid,uuid,uuid)',true),
  ('lifecycle_cancel_safe_work(uuid,uuid)',false),
  ('lifecycle_validate_purge(uuid,uuid,text)',true),
  ('lifecycle_pending_count_before_complete_native(uuid,uuid,uuid)',false),
  ('lifecycle_cancel_safe_work_before_complete_native(uuid,uuid)',false),
  ('lifecycle_validate_purge_before_complete_native(uuid,uuid,text)',false)
 ) required(signature,worker_execute)
  WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p
   WHERE p.oid=pg_catalog.to_regprocedure('public.'||required.signature)
    AND p.prosecdef AND pg_catalog.pg_get_userbyid(p.proowner)='jrc_migrator'
    AND p.proconfig @> ARRAY['search_path=pg_catalog, public']::text[])
   OR pg_catalog.has_function_privilege('jrc_lifecycle',pg_catalog.to_regprocedure('public.'||required.signature),'EXECUTE')
    IS DISTINCT FROM required.worker_execute
   OR pg_catalog.has_function_privilege('jrc_app',pg_catalog.to_regprocedure('public.'||required.signature),'EXECUTE')
   OR pg_catalog.has_function_privilege('jrc_auth',pg_catalog.to_regprocedure('public.'||required.signature),'EXECUTE')
   OR pg_catalog.has_function_privilege('jrc_platform',pg_catalog.to_regprocedure('public.'||required.signature),'EXECUTE')
   OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p,
    LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
    WHERE p.oid=pg_catalog.to_regprocedure('public.'||required.signature) AND acl.grantee=0))
`;
