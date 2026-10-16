export const qrIdentityRuntimeSql=`NOT EXISTS(SELECT 1 FROM (VALUES
 ('qr_identity_scopes'),('qr_contact_aliases'),('qr_identity_pending_events')) AS required(table_name)
 WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.'||required.table_name)
  AND c.relrowsecurity AND c.relforcerowsecurity AND pg_catalog.pg_get_userbyid(c.relowner)='jrc_migrator'
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid AND p.polname='qr_identity_tenant'
    AND p.polcmd='*' AND p.polroles=ARRAY[(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='jrc_app')])
  AND NOT EXISTS(SELECT 1 FROM (VALUES ('SELECT'),('INSERT'),('UPDATE')) AS access(privilege)
    WHERE NOT pg_catalog.has_table_privilege('jrc_app',c.oid,access.privilege))
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl WHERE acl.grantee=0)
  AND NOT pg_catalog.has_table_privilege('jrc_auth',c.oid,'SELECT')
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid AND t.tgname='qr_identity_channel_admission' AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal)))
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid=pg_catalog.to_regclass('public.qr_identity_pending_events') AND conname='qr_identity_pending_shape' AND convalidated)
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_index WHERE indexrelid=pg_catalog.to_regclass('public.qr_identity_pending_due') AND indisvalid)
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=pg_catalog.to_regclass('public.qr_identity_scopes') AND attname='binding_fingerprint' AND attnotnull AND attnum>0 AND NOT attisdropped)`;
