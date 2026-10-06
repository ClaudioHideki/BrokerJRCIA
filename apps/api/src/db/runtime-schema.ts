export const RUNTIME_SCHEMA_BASELINE = '0046_central_transport';

type SchemaProbeQuery = (sql: string) => Promise<{ rows: Array<{ ready: boolean | null }> }>;

// The app role cannot read drizzle.__drizzle_migrations. This is a structural
// readiness probe, not a migration journal/hash comparison.
const requiredObjectsSql = `SELECT
  EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=pg_catalog.to_regclass('public.messaging_channels')
    AND attname='transport' AND attnotnull AND attnum>0 AND NOT attisdropped)
  AND NOT EXISTS(SELECT 1 FROM (VALUES ('public.central_transport_bindings'),('public.central_runtime_events')) AS required(relation_name)
    WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass(required.relation_name)
      AND c.relrowsecurity AND c.relforcerowsecurity AND pg_catalog.pg_get_userbyid(c.relowner)='jrc_migrator'
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid AND p.polname='central_tenant'))
    OR NOT pg_catalog.has_table_privilege('jrc_app',pg_catalog.to_regclass(required.relation_name),'SELECT')
    OR NOT pg_catalog.has_table_privilege('jrc_app',pg_catalog.to_regclass(required.relation_name),'INSERT')
    OR NOT pg_catalog.has_table_privilege('jrc_app',pg_catalog.to_regclass(required.relation_name),'UPDATE')
    OR pg_catalog.has_table_privilege('jrc_auth',pg_catalog.to_regclass(required.relation_name),'SELECT')
    OR pg_catalog.has_table_privilege('jrc_platform',pg_catalog.to_regclass(required.relation_name),'SELECT')
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c,
      LATERAL pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      WHERE c.oid=pg_catalog.to_regclass(required.relation_name) AND a.grantee=0))
  AND NOT EXISTS(SELECT 1 FROM (VALUES
    ('public.messaging_channels','messaging_channels_organization_fk','f'),
    ('public.messaging_channels','messaging_channels_kind_fields','c'),
    ('public.central_transport_bindings','central_transport_bindings_origin_account_id_inbox_id_key','u'),
    ('public.central_runtime_events','central_runtime_events_organization_id_channel_id_event_key_key','u')
    ) AS required(relation_name,constraint_name,constraint_type)
    WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid=pg_catalog.to_regclass(required.relation_name)
      AND c.conname=required.constraint_name AND c.contype::text=required.constraint_type AND c.convalidated))
  AND
  NOT EXISTS (SELECT 1 FROM (VALUES ('public.users'),('public.login_sessions'),('public.refresh_tokens'),('public.chatwoot_embed_authorizations'),('public.chatwoot_embed_sessions')) AS required(relation_name)
    WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid=pg_catalog.to_regclass(required.relation_name) AND a.attname='auth_version' AND a.attnotnull AND a.attnum>0 AND NOT a.attisdropped))
  AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE oid=pg_catalog.to_regprocedure('public.revoke_user_authentication(uuid,timestamptz)') AND prosecdef)
  AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE oid=pg_catalog.to_regprocedure('public.create_login_selection(uuid,text,timestamptz,integer)') AND prosecdef)
  AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE oid=pg_catalog.to_regprocedure('public.lock_user_authentication(uuid)') AND prosecdef)
  AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE oid=pg_catalog.to_regprocedure('public.current_tenant_authentication_valid(uuid,integer)') AND prosecdef)
  AND
  pg_catalog.to_regclass('public.messaging_media') IS NOT NULL
  AND NOT pg_catalog.has_any_column_privilege('jrc_app',pg_catalog.to_regclass('public.users'),'SELECT')
  AND NOT EXISTS (
    SELECT 1 FROM (VALUES ('public.local_attendance_teams'),('public.local_attendance_team_members')) AS required(relation_name)
    WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid=pg_catalog.to_regclass(required.relation_name) AND c.relrowsecurity AND c.relforcerowsecurity
        AND EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid AND p.polname='attendance_tenant'))
  )
  AND NOT EXISTS (
    SELECT 1 FROM (VALUES ('public.local_attendance_teams'),('public.local_attendance_team_members')) AS required(relation_name)
    WHERE NOT pg_catalog.has_table_privilege('jrc_app',pg_catalog.to_regclass(required.relation_name),'SELECT')
       OR NOT pg_catalog.has_table_privilege('jrc_app',pg_catalog.to_regclass(required.relation_name),'INSERT')
       OR NOT pg_catalog.has_table_privilege('jrc_app',pg_catalog.to_regclass(required.relation_name),'UPDATE')
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c,
         LATERAL pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
         WHERE c.oid=pg_catalog.to_regclass(required.relation_name) AND a.grantee=0)
  )
  AND pg_catalog.has_table_privilege('jrc_app',pg_catalog.to_regclass('public.local_attendance_team_members'),'DELETE')
  AND NOT pg_catalog.has_table_privilege('jrc_app',pg_catalog.to_regclass('public.local_attendance_teams'),'DELETE')
  AND NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('public.local_attendance_teams','local_attendance_teams_pkey','p'),
      ('public.local_attendance_team_members','local_attendance_team_members_pkey','p')
    ) AS required(relation_name,constraint_name,constraint_type)
    WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
      WHERE c.conrelid=pg_catalog.to_regclass(required.relation_name) AND c.conname=required.constraint_name
        AND c.contype::text=required.constraint_type AND c.convalidated)
  )
  AND NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('public.memberships',ARRAY['organization_id','user_id']::text[]),
      ('public.local_attendance_teams',ARRAY['organization_id','team_id']::text[])
    ) AS required(relation_name,source_columns)
    WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
      WHERE c.conrelid=pg_catalog.to_regclass('public.local_attendance_team_members')
        AND c.confrelid=pg_catalog.to_regclass(required.relation_name) AND c.contype='f' AND c.convalidated
        AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
          FROM unnest(c.conkey) WITH ORDINALITY k(num,ord)
          JOIN pg_catalog.pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num)=required.source_columns
        AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
          FROM unnest(c.confkey) WITH ORDINALITY k(num,ord)
          JOIN pg_catalog.pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num)
          =CASE required.relation_name WHEN 'public.memberships' THEN ARRAY['organization_id','user_id']::text[] ELSE ARRAY['organization_id','id']::text[] END)
  )
  AND NOT EXISTS (
    SELECT 1 FROM (VALUES ('public.current_local_attendance_members()'),('public.lock_local_attendance_member(uuid)')) AS required(function_name)
    WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid=pg_catalog.to_regprocedure(required.function_name) AND p.prosecdef
        AND pg_catalog.pg_get_userbyid(p.proowner)='jrc_migrator'
        AND p.proconfig @> ARRAY['search_path=pg_catalog, public']::text[]
        AND pg_catalog.has_function_privilege('jrc_app',p.oid,'EXECUTE')
        AND NOT pg_catalog.has_function_privilege('jrc_auth',p.oid,'EXECUTE')
        AND NOT pg_catalog.has_function_privilege('jrc_platform',p.oid,'EXECUTE')
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
          WHERE a.grantee=0 AND a.privilege_type='EXECUTE'))
  )
  AND NOT EXISTS (
    SELECT 1 FROM (VALUES ('local_team_id'),('local_agent_id')) AS required(column_name)
    WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid=pg_catalog.to_regclass('public.attendance_sessions')
        AND a.attname=required.column_name AND a.atttypid='uuid'::regtype AND a.attnum>0 AND NOT a.attisdropped)
  )
  AND NOT EXISTS (
    SELECT 1 FROM (VALUES ('attendance_local_team_fk','f'),('attendance_local_agent_fk','f'),('attendance_local_target_scope','c')) AS required(constraint_name,constraint_type)
    WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
      WHERE c.conrelid=pg_catalog.to_regclass('public.attendance_sessions') AND c.conname=required.constraint_name
        AND c.contype::text=required.constraint_type AND c.convalidated)
  )
  AND pg_catalog.to_regclass('public.attendance_resume_operations') IS NOT NULL
  AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=pg_catalog.to_regclass('public.messaging_conversations')
    AND attname='attendance_revision' AND attnotnull AND attnum>0 AND NOT attisdropped)
  AND pg_catalog.to_regclass('public.automation_definitions') IS NOT NULL
  AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid=pg_catalog.to_regclass('public.automation_versions') AND attname='runtime_state_version' AND attnotnull AND attnum>0 AND NOT attisdropped)
  AND EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid=pg_catalog.to_regclass('public.automation_versions') AND conname='automation_versions_runtime_state_version_check' AND contype='c' AND convalidated)
  AND pg_catalog.to_regclass('public.automation_import_artifacts') IS NOT NULL
  AND pg_catalog.to_regclass('public.operational_heartbeats') IS NOT NULL
  AND pg_catalog.to_regclass('public.automation_legacy_migrations') IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = pg_catalog.to_regclass('public.instances')
      AND attname = 'archived_at' AND attnum > 0 AND NOT attisdropped
  )
  AND NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('public.instances', 'tenant_instances_restore_admission'),
      ('public.provider_operations', 'instance_archive_operations'),
      ('public.messaging_channels', 'instance_archive_channels'),
      ('public.messaging_messages', 'instance_archive_messages'),
      ('public.messaging_messages', 'instance_archive_message_retry'),
      ('public.automation_bindings', 'instance_archive_bindings'),
      ('public.automation_executions', 'instance_archive_executions'),
      ('public.chatwoot_connections', 'instance_archive_inbox_create'),
      ('public.chatwoot_connections', 'instance_archive_inbox_resume')
    ) AS required(relation_name, trigger_name)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid = pg_catalog.to_regclass(required.relation_name)
        AND t.tgname = required.trigger_name
        AND t.tgenabled IN ('O', 'A')
        AND NOT t.tgisinternal
    )
  )
  AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = pg_catalog.to_regclass('public.automation_bindings')
      AND conname = 'automation_binding_destination' AND contype = 'f'
  )
  AND pg_catalog.to_regclass('public.economic_groups') IS NOT NULL
  AND pg_catalog.to_regclass('public.commercial_plans') IS NOT NULL
  AND pg_catalog.to_regclass('public.commercial_plan_versions') IS NOT NULL
  AND pg_catalog.to_regclass('public.organization_commercial_plans') IS NOT NULL
  AND NOT pg_catalog.has_table_privilege('jrc_platform',pg_catalog.to_regclass('public.commercial_plan_versions'),'UPDATE')
  AND NOT pg_catalog.has_table_privilege('jrc_app',pg_catalog.to_regclass('public.organization_commercial_plans'),'UPDATE')
  AND pg_catalog.to_regclass('public.economic_group_organizations') IS NOT NULL
  AND pg_catalog.has_table_privilege('jrc_platform', pg_catalog.to_regclass('public.economic_groups'), 'DELETE')
  AND pg_catalog.to_regclass('public.lifecycle_deletions') IS NOT NULL
  AND pg_catalog.to_regclass('public.lifecycle_cleanup_items') IS NOT NULL
  AND pg_catalog.to_regclass('public.lifecycle_purge_catalogue') IS NOT NULL
  AND pg_catalog.to_regclass('public.group_company_removal_previews') IS NOT NULL
  AND pg_catalog.to_regclass('public.group_company_removals') IS NOT NULL
  AND pg_catalog.to_regclass('public.group_company_removal_children') IS NOT NULL
  AND NOT pg_catalog.has_table_privilege('jrc_platform',pg_catalog.to_regclass('public.group_company_removals'),'INSERT')
  AND NOT pg_catalog.has_table_privilege('jrc_app',pg_catalog.to_regclass('public.group_company_removals'),'SELECT')
  AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid=pg_catalog.to_regclass('public.lifecycle_deletions') AND attname='reconciliation_requested' AND attnum>0 AND NOT attisdropped)
  AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc
    WHERE oid=pg_catalog.to_regprocedure('public.lifecycle_request_reconciliation(uuid,uuid,uuid,text,text,uuid)') AND prosecdef)
  AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc
    WHERE oid=pg_catalog.to_regprocedure('public.group_removal_request(uuid,jsonb)') AND prosecdef)
  AND EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid=pg_catalog.to_regclass('public.lifecycle_deletions') AND tgname='group_removal_scrub_company' AND tgenabled IN ('O','A') AND NOT tgisinternal)
  AND pg_catalog.to_regclass('public.support_tickets') IS NOT NULL
  AND pg_catalog.to_regclass('public.support_messages') IS NOT NULL
  AND pg_catalog.to_regclass('public.attendance_owners') IS NOT NULL
  AND pg_catalog.to_regclass('public.attendance_sessions') IS NOT NULL
  AND EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid=pg_catalog.to_regclass('public.attendance_handoff_operations') AND conname='native_handoff_snapshot_required' AND convalidated)
  AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE oid=pg_catalog.to_regprocedure('public.lifecycle_pending_count_before_native_handoff(uuid,uuid,uuid)') AND prosecdef)
  AND NOT EXISTS (
    SELECT 1 FROM (VALUES ('public.chatwoot_attendance_controls'),('public.chatwoot_mirror_attempts'),('public.chatwoot_attendance_observations'),('public.attendance_handoff_operations')) AS required(relation_name)
    WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid=pg_catalog.to_regclass(required.relation_name) AND c.relrowsecurity AND c.relforcerowsecurity
        AND EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid AND p.polname='attendance_tenant'))
  )
  AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid=pg_catalog.to_regclass('public.automation_events') AND attname='queue_sequence' AND attidentity='a' AND attnum>0 AND NOT attisdropped)
  AND EXISTS (SELECT 1 FROM pg_catalog.pg_index
    WHERE indexrelid=pg_catalog.to_regclass('public.automation_pending_inputs') AND indisvalid)
  AND pg_catalog.has_sequence_privilege('jrc_app',pg_catalog.to_regclass('public.automation_events_queue_sequence_seq'),'USAGE')
  AND NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('public.flow_chatwoot_bindings','operation_revision'),
      ('public.flow_chatwoot_bindings','operation_token'),
      ('public.flow_chatwoot_bindings','operation_expires_at'),
      ('public.flow_chatwoot_bindings','operation_state'),
      ('public.attendance_owners','remote_binding_id')
    ) AS required(relation_name,column_name)
    WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid=pg_catalog.to_regclass(required.relation_name)
        AND a.attname=required.column_name AND a.attnum>0 AND NOT a.attisdropped)
  )
  AND NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('public.flow_chatwoot_bindings','flow_binding_operation_state','c'),
      ('public.flow_chatwoot_bindings','flow_binding_operation_lease','c'),
      ('public.attendance_owners','attendance_owner_remote_binding_fk','f'),
      ('public.attendance_owners','attendance_owner_remote_binding_kind','c')
    ) AS required(relation_name,constraint_name,constraint_type)
    WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
      WHERE c.conrelid=pg_catalog.to_regclass(required.relation_name)
        AND c.conname=required.constraint_name AND c.contype::text=required.constraint_type AND c.convalidated)
  )
  AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc
    WHERE oid=pg_catalog.to_regprocedure('public.lifecycle_pending_count_before_flow_reservation(uuid,uuid,uuid)') AND prosecdef)
  AND EXISTS (SELECT 1 FROM pg_catalog.pg_index
    WHERE indexrelid=pg_catalog.to_regclass('public.attendance_one_live_conversation') AND indisunique AND indisvalid)
  AND EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid=pg_catalog.to_regclass('public.attendance_sessions')
      AND conname='attendance_session_conversation_fk' AND contype='f' AND convalidated)
  AND NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('attendance_session_execution_version_fk','f'),
      ('attendance_session_execution_requires_version','c')
    ) AS required(constraint_name,constraint_type)
    WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
      WHERE c.conrelid=pg_catalog.to_regclass('public.attendance_sessions')
        AND c.conname=required.constraint_name AND c.contype::text=required.constraint_type AND c.convalidated)
  )
  AND NOT EXISTS (
    SELECT 1 FROM (VALUES ('public.attendance_owners'),('public.attendance_sessions')) AS required(relation_name)
    WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid=pg_catalog.to_regclass(required.relation_name) AND c.relrowsecurity AND c.relforcerowsecurity
        AND EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid AND p.polname='attendance_tenant'))
  )
  AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE oid=pg_catalog.to_regprocedure('public.lifecycle_purge_organization(uuid,uuid)') AND prosecdef)
  AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE oid=pg_catalog.to_regprocedure('public.lifecycle_purge_channel(uuid,uuid)') AND prosecdef)
  AND NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('public.messaging_messages','lifecycle_messages_block'),
      ('public.messaging_inbox_events','lifecycle_inbox_block'),
      ('public.messaging_status_events','lifecycle_status_block'),
      ('public.messaging_media','lifecycle_media_block'),
      ('public.automation_executions','lifecycle_automation_block'),
      ('public.automation_bindings','lifecycle_binding_block'),
      ('public.instances','lifecycle_instance_restore_block'),
      ('public.meta_connections','lifecycle_meta_restore_block'),
      ('public.support_tickets','support_ticket_admission'),
      ('public.support_messages','support_message_admission')
      ,('public.commercial_plan_versions','commercial_version_scope')
      ,('public.organization_commercial_plans','commercial_assignment_scope')
    ) AS required(relation_name,trigger_name)
    WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid=pg_catalog.to_regclass(required.relation_name)
        AND t.tgname=required.trigger_name AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal)
  )
  AND NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('public.commercial_plans'),
      ('public.commercial_plan_versions'),
      ('public.organization_commercial_plans'),
      ('public.economic_groups'),
      ('public.economic_group_organizations')
    ) AS required(relation_name)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid = pg_catalog.to_regclass(required.relation_name)
        AND c.relrowsecurity AND c.relforcerowsecurity
        AND EXISTS (
          SELECT 1 FROM pg_catalog.pg_policy p
          WHERE p.polrelid = c.oid
            AND p.polname = 'platform_boundary'
        )
    )
  )
  AS ready`;

export async function probeRequiredRuntimeSchema(query: SchemaProbeQuery): Promise<boolean> {
  const result = await query(requiredObjectsSql);
  return result.rows[0]?.ready === true;
}
