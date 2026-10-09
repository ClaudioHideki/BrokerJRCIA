-- 0052: durable private media with compatibility for historical inline assets.
-- Existing v1 ciphertext and plaintext hashes remain untouched and readable.
ALTER TABLE messaging_media ADD COLUMN storage_backend text NOT NULL DEFAULT 'INLINE_V1'
 CHECK(storage_backend IN ('INLINE_V1','PRIVATE_OBJECT'));
ALTER TABLE messaging_media ADD COLUMN private_object_id uuid;
DO $$ DECLARE c text; BEGIN
 SELECT conname INTO c FROM pg_constraint WHERE conrelid='messaging_media'::regclass
  AND contype='c' AND pg_get_constraintdef(oid) LIKE '%encrypted_data%';
 IF c IS NULL THEN RAISE EXCEPTION 'PRIVATE_MEDIA_INLINE_SHAPE_NOT_FOUND'; END IF;
 EXECUTE format('ALTER TABLE messaging_media DROP CONSTRAINT %I',c);
 SELECT conname INTO c FROM pg_constraint WHERE conrelid='messaging_media'::regclass
  AND contype='c' AND pg_get_constraintdef(oid) LIKE '%status%' AND pg_get_constraintdef(oid) NOT LIKE '%lease%';
 IF c IS NULL THEN RAISE EXCEPTION 'PRIVATE_MEDIA_STATUS_SHAPE_NOT_FOUND'; END IF;
 EXECUTE format('ALTER TABLE messaging_media DROP CONSTRAINT %I',c);
END $$;
ALTER TABLE messaging_media ADD CONSTRAINT messaging_media_status_check
 CHECK(status IN ('PENDING','DOWNLOADING','STORING','READY','FAILED'));
ALTER TABLE messaging_media ADD CONSTRAINT messaging_media_storage_shape CHECK(
 (storage_backend='INLINE_V1' AND private_object_id IS NULL
  AND ((status='READY' AND encrypted_data IS NOT NULL AND byte_size IS NOT NULL AND sha256 IS NOT NULL AND mime_type IS NOT NULL)
   OR(status<>'READY' AND encrypted_data IS NULL)))
 OR(storage_backend='PRIVATE_OBJECT' AND private_object_id IS NOT NULL AND encrypted_data IS NULL
  AND byte_size IS NOT NULL AND sha256 IS NOT NULL AND sha256 ~ '^[a-f0-9]{64}$' AND mime_type IS NOT NULL)
);

CREATE TABLE media_private_objects (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL,channel_id uuid NOT NULL,media_id uuid NOT NULL,
 profile text NOT NULL CHECK(profile ~ '^[a-z][a-z0-9-]{0,63}$'),
 destination_fingerprint text NOT NULL CHECK(destination_fingerprint ~ '^[a-f0-9]{64}$'),
 plain_byte_size integer NOT NULL CHECK(plain_byte_size BETWEEN 1 AND 16777216),
 plain_sha256 text NOT NULL CHECK(plain_sha256 ~ '^[a-f0-9]{64}$'),
 cipher_byte_length integer NOT NULL CHECK(cipher_byte_length BETWEEN 1 AND 29826232),
 cipher_sha256 text NOT NULL CHECK(cipher_sha256 ~ '^[a-f0-9]{64}$'),
 mime_type text NOT NULL,kind text NOT NULL CHECK(kind IN ('image','audio','video','document','sticker')),file_name text NOT NULL,
 state text NOT NULL DEFAULT 'STAGED' CHECK(state IN ('STAGED','READY','DELETING','DELETED','REJECTED')),
 staging_ciphertext text,reserved_bytes integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,channel_id,id),UNIQUE(organization_id,channel_id,media_id),UNIQUE(organization_id,channel_id,media_id,id),
 FOREIGN KEY(organization_id,channel_id,media_id) REFERENCES messaging_media(organization_id,channel_id,id),
 CHECK((state='STAGED' AND staging_ciphertext IS NOT NULL) OR(state<>'STAGED' AND staging_ciphertext IS NULL)),
 CHECK((state IN ('STAGED','READY','DELETING') AND reserved_bytes=plain_byte_size)
  OR(state IN ('REJECTED','DELETED') AND reserved_bytes=0))
);
ALTER TABLE messaging_media ADD CONSTRAINT messaging_media_private_object_fk
 FOREIGN KEY(organization_id,channel_id,id,private_object_id) REFERENCES media_private_objects(organization_id,channel_id,media_id,id)
 DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE media_private_operations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,channel_id uuid NOT NULL,object_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('PUT','DELETE')),
 state text NOT NULL DEFAULT 'PREPARED' CHECK(state IN ('PREPARED','DISPATCHED','CONFIRMED','UNKNOWN','REJECTED')),
 dispatched_at timestamptz,lease_token uuid,lease_expires_at timestamptz,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),last_error_code text CHECK(last_error_code ~ '^[A-Z][A-Z0-9_]{0,95}$'),
 deletion_id uuid REFERENCES lifecycle_deletions(id),authorization_lease uuid,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(object_id,kind),FOREIGN KEY(organization_id,channel_id,object_id) REFERENCES media_private_objects(organization_id,channel_id,id),
 CHECK((kind='PUT' AND id=object_id AND deletion_id IS NULL AND authorization_lease IS NULL)
  OR(kind='DELETE' AND deletion_id IS NOT NULL AND authorization_lease IS NOT NULL)),
 CHECK((lease_token IS NULL)=(lease_expires_at IS NULL)),
 CHECK(state<>'DISPATCHED' OR(dispatched_at IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at>dispatched_at))
);
CREATE INDEX media_private_operations_work ON media_private_operations(organization_id,state,updated_at,id);

-- Operational recovery must still discover facts belonging to a DISABLED tenant.
CREATE FUNCTION media_private_worker_organizations(p_after uuid,p_limit integer) RETURNS TABLE(organization_id uuid)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT p.organization_id FROM public.media_private_operations p WHERE p.kind='PUT'
  AND p.state IN ('PREPARED','DISPATCHED','UNKNOWN') AND(p_after IS NULL OR p.organization_id>p_after)
  ORDER BY p.organization_id LIMIT LEAST(GREATEST(p_limit,1),1000);
$$;
ALTER FUNCTION media_private_worker_organizations(uuid,integer) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION media_private_worker_organizations(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION media_private_worker_organizations(uuid,integer) TO jrc_app;

-- Narrow tenant-bound answer, without granting app UPDATE/locks on organizations
-- or SELECT on the persisted nominative deletion authorization.
CREATE FUNCTION media_private_channel_open(p_org uuid,p_channel uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE organization_status text; deleting timestamptz;
BEGIN
 IF session_user<>'jrc_app' OR p_org IS DISTINCT FROM NULLIF(current_setting('app.organization_id',true),'')::uuid THEN
  RAISE EXCEPTION 'PRIVATE_MEDIA_TENANT_REQUIRED' USING ERRCODE='42501';
 END IF;
 SELECT status INTO organization_status FROM public.organizations WHERE id=p_org FOR SHARE;
 SELECT deleting_at INTO deleting FROM public.messaging_channels WHERE organization_id=p_org AND id=p_channel FOR SHARE;
 RETURN organization_status='ACTIVE' AND FOUND AND deleting IS NULL
  AND NOT EXISTS(SELECT 1 FROM public.lifecycle_deletions WHERE organization_id=p_org AND status<>'COMPLETED'
   AND(kind='ORGANIZATION' OR messaging_channel_id=p_channel));
END $$;
ALTER FUNCTION media_private_channel_open(uuid,uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION media_private_channel_open(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION media_private_channel_open(uuid,uuid) TO jrc_app;

ALTER TABLE media_private_objects OWNER TO jrc_migrator;
ALTER TABLE media_private_operations OWNER TO jrc_migrator;
ALTER TABLE media_private_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_private_objects FORCE ROW LEVEL SECURITY;
ALTER TABLE media_private_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_private_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY media_private_tenant ON media_private_objects TO jrc_app
 USING(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY media_private_tenant ON media_private_operations TO jrc_app
 USING(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid AND kind='PUT');
CREATE POLICY media_private_lifecycle ON media_private_objects TO jrc_lifecycle USING(true) WITH CHECK(true);
CREATE POLICY media_private_lifecycle ON media_private_operations TO jrc_lifecycle USING(true) WITH CHECK(kind='DELETE');
CREATE POLICY lifecycle_migrator ON media_private_objects TO jrc_migrator USING(true) WITH CHECK(true);
CREATE POLICY lifecycle_migrator ON media_private_operations TO jrc_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON media_private_objects,media_private_operations FROM PUBLIC,jrc_auth,jrc_platform;
GRANT SELECT,INSERT,UPDATE ON media_private_objects,media_private_operations TO jrc_app;
GRANT SELECT,UPDATE ON media_private_objects TO jrc_lifecycle;
GRANT SELECT,INSERT,UPDATE ON media_private_operations TO jrc_lifecycle;
CREATE TRIGGER lifecycle_private_media_objects_block BEFORE INSERT ON media_private_objects
 FOR EACH ROW EXECUTE FUNCTION lifecycle_reject_channel_write();
CREATE TRIGGER lifecycle_private_media_put_block BEFORE INSERT ON media_private_operations
 FOR EACH ROW WHEN(NEW.kind='PUT') EXECUTE FUNCTION lifecycle_reject_channel_write();

CREATE FUNCTION media_private_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='media_private_objects' THEN
  IF ROW(NEW.id,NEW.organization_id,NEW.channel_id,NEW.media_id,NEW.profile,NEW.destination_fingerprint,NEW.plain_byte_size,NEW.plain_sha256,
   NEW.cipher_byte_length,NEW.cipher_sha256,NEW.mime_type,NEW.kind,NEW.file_name)
   IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.channel_id,OLD.media_id,OLD.profile,OLD.destination_fingerprint,OLD.plain_byte_size,OLD.plain_sha256,
   OLD.cipher_byte_length,OLD.cipher_sha256,OLD.mime_type,OLD.kind,OLD.file_name)
   OR(NEW.staging_ciphertext IS NOT NULL AND NEW.staging_ciphertext IS DISTINCT FROM OLD.staging_ciphertext) THEN
   RAISE EXCEPTION 'PRIVATE_MEDIA_IDENTITY_IMMUTABLE' USING ERRCODE='23514';
  END IF;
 ELSE
  IF ROW(NEW.id,NEW.organization_id,NEW.channel_id,NEW.object_id,NEW.kind,NEW.deletion_id,NEW.authorization_lease)
   IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.channel_id,OLD.object_id,OLD.kind,OLD.deletion_id,OLD.authorization_lease)
   OR(OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at)
   OR(OLD.state IN ('CONFIRMED','REJECTED') AND NEW.state<>OLD.state)
   OR(OLD.state='UNKNOWN' AND NEW.state NOT IN ('UNKNOWN','CONFIRMED')) THEN
   RAISE EXCEPTION 'PRIVATE_MEDIA_OPERATION_IMMUTABLE' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION media_private_immutable() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION media_private_immutable() FROM PUBLIC;
CREATE TRIGGER media_private_objects_immutable BEFORE UPDATE ON media_private_objects FOR EACH ROW EXECUTE FUNCTION media_private_immutable();
CREATE TRIGGER media_private_operations_immutable BEFORE UPDATE ON media_private_operations FOR EACH ROW EXECUTE FUNCTION media_private_immutable();

CREATE FUNCTION media_private_delete_authorized() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d public.lifecycle_deletions%ROWTYPE;
BEGIN
 IF session_user<>'jrc_lifecycle' THEN RAISE EXCEPTION 'LIFECYCLE_FORBIDDEN' USING ERRCODE='42501'; END IF;
 SELECT * INTO d FROM public.lifecycle_deletions WHERE id=NEW.deletion_id FOR UPDATE;
 IF NOT FOUND OR d.organization_id<>NEW.organization_id OR d.lease_token IS DISTINCT FROM NEW.authorization_lease
  OR d.lease_expires_at<=clock_timestamp() OR d.lease_expires_at IS NULL OR d.status NOT IN ('CLEANING_EXTERNAL','REMOVING_DATA')
  OR(d.kind='CHANNEL' AND d.messaging_channel_id IS DISTINCT FROM NEW.channel_id) THEN
  RAISE EXCEPTION 'LIFECYCLE_LEASE_LOST' USING ERRCODE='23514';
 END IF;
 IF(d.actor_kind='PLATFORM' AND NOT EXISTS(SELECT 1 FROM public.platform_users WHERE id=d.actor_id AND active AND role='SUPER_ADMIN'))
  OR(d.actor_kind='TENANT' AND NOT EXISTS(SELECT 1 FROM public.memberships m JOIN public.users u ON u.id=m.user_id
   WHERE m.organization_id=d.organization_id AND m.user_id=d.actor_id AND m.status='ACTIVE' AND u.status='ACTIVE' AND m.role IN ('OWNER','ADMIN'))) THEN
  RAISE EXCEPTION 'LIFECYCLE_ACTOR_REVOKED' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION media_private_delete_authorized() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION media_private_delete_authorized() FROM PUBLIC;
CREATE TRIGGER media_private_delete_guard BEFORE INSERT ON media_private_operations FOR EACH ROW WHEN(NEW.kind='DELETE') EXECUTE FUNCTION media_private_delete_authorized();
INSERT INTO lifecycle_purge_catalogue(table_name) VALUES('media_private_objects'),('media_private_operations');

ALTER FUNCTION lifecycle_cancel_safe_work(uuid,uuid) RENAME TO lifecycle_cancel_safe_work_before_private_media;
CREATE FUNCTION lifecycle_cancel_safe_work(p_org uuid,p_channel uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM public.lifecycle_cancel_safe_work_before_private_media(p_org,p_channel);
 PERFORM 1 FROM public.media_private_objects WHERE organization_id=p_org AND(p_channel IS NULL OR channel_id=p_channel) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.media_private_operations WHERE organization_id=p_org AND(p_channel IS NULL OR channel_id=p_channel) ORDER BY id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.media_private_operations WHERE organization_id=p_org AND(p_channel IS NULL OR channel_id=p_channel)
  AND(state IN ('DISPATCHED','UNKNOWN') OR lease_token IS NOT NULL)) THEN
  RAISE EXCEPTION 'LIFECYCLE_PENDING_WORK' USING ERRCODE='23514',CONSTRAINT='lifecycle_pending_work';
 END IF;
 UPDATE public.media_private_objects o SET state='REJECTED',reserved_bytes=0,staging_ciphertext=NULL,updated_at=now()
  FROM public.media_private_operations p WHERE p.object_id=o.id AND o.organization_id=p_org AND(p_channel IS NULL OR o.channel_id=p_channel)
   AND p.kind='PUT' AND p.state='PREPARED' AND p.dispatched_at IS NULL;
 UPDATE public.media_private_operations SET state='REJECTED',last_error_code='RESOURCE_DELETING',revision=revision+1,updated_at=now()
  WHERE organization_id=p_org AND(p_channel IS NULL OR channel_id=p_channel) AND kind='PUT' AND state='PREPARED' AND dispatched_at IS NULL;
 UPDATE public.messaging_media m SET status='FAILED',last_error='RESOURCE_DELETING',updated_at=now()
  FROM public.media_private_objects o WHERE m.organization_id=p_org AND m.private_object_id=o.id AND o.state='REJECTED';
END $$;
ALTER FUNCTION lifecycle_cancel_safe_work(uuid,uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION lifecycle_cancel_safe_work(uuid,uuid) FROM PUBLIC;

ALTER FUNCTION lifecycle_pending_count(uuid,uuid,uuid) RENAME TO lifecycle_pending_count_before_private_media;
CREATE FUNCTION lifecycle_pending_count(p_org uuid,p_channel uuid,p_resource uuid) RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT public.lifecycle_pending_count_before_private_media(p_org,p_channel,p_resource)
  +(SELECT count(*) FROM public.media_private_operations p WHERE p.organization_id=p_org AND(p_channel IS NULL OR p.channel_id=p_channel)
    AND(p.state IN ('DISPATCHED','UNKNOWN') OR p.lease_token IS NOT NULL OR(p.kind='DELETE' AND p.state<>'CONFIRMED')))
  +(SELECT count(*) FROM public.media_private_objects o WHERE o.organization_id=p_org AND(p_channel IS NULL OR o.channel_id=p_channel)
    AND o.state IN ('READY','DELETING') AND EXISTS(SELECT 1 FROM public.lifecycle_deletions d WHERE d.organization_id=p_org AND d.status<>'COMPLETED'
     AND(d.kind='ORGANIZATION' OR d.messaging_channel_id=o.channel_id)));
$$;
ALTER FUNCTION lifecycle_pending_count(uuid,uuid,uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION lifecycle_pending_count(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle_pending_count(uuid,uuid,uuid) TO jrc_lifecycle;

ALTER FUNCTION lifecycle_validate_purge(uuid,uuid,text) RENAME TO lifecycle_validate_purge_before_private_media;
CREATE FUNCTION lifecycle_validate_purge(p_deletion uuid,p_lease uuid,p_kind text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid; channel uuid; lease_deadline timestamptz;
BEGIN
 -- The existing validator locks the deletion row before checking actor/cleanup.
 -- Its historical now() check alone does not survive a wait beyond the lease.
 org=public.lifecycle_validate_purge_before_private_media(p_deletion,p_lease,p_kind);
 SELECT messaging_channel_id,lease_expires_at INTO channel,lease_deadline FROM public.lifecycle_deletions WHERE id=p_deletion;
 IF EXISTS(SELECT 1 FROM public.media_private_objects WHERE organization_id=org AND(p_kind='ORGANIZATION' OR channel_id=channel)
  AND state NOT IN ('DELETED','REJECTED')) OR EXISTS(SELECT 1 FROM public.media_private_operations WHERE organization_id=org
   AND(p_kind='ORGANIZATION' OR channel_id=channel) AND(state IN ('DISPATCHED','UNKNOWN') OR lease_token IS NOT NULL OR(kind='DELETE' AND state<>'CONFIRMED'))) THEN
  RAISE EXCEPTION 'LIFECYCLE_PENDING_WORK' USING ERRCODE='23514',CONSTRAINT='lifecycle_pending_work';
 END IF;
 -- Evaluate the real clock after acquiring the existing lock and after ledger
 -- checks, immediately before the caller is permitted to remove tenant data.
 IF lease_deadline IS NULL OR lease_deadline<=clock_timestamp() THEN
  RAISE EXCEPTION 'LIFECYCLE_OPERATION_NOT_READY' USING ERRCODE='23514',CONSTRAINT='lifecycle_operation_not_ready';
 END IF;
 RETURN org;
END $$;
ALTER FUNCTION lifecycle_validate_purge(uuid,uuid,text) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION lifecycle_validate_purge(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle_validate_purge(uuid,uuid,text) TO jrc_lifecycle;
DO $$ DECLARE original text; patched text; BEGIN
 original=pg_get_functiondef('public.lifecycle_purge_channel(uuid,uuid)'::regprocedure);
 patched=replace(original,'DELETE FROM public.messaging_media WHERE organization_id=org AND channel_id=channel;',
 'DELETE FROM public.media_private_operations WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.media_private_objects WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.messaging_media WHERE organization_id=org AND channel_id=channel;');
 IF patched=original THEN RAISE EXCEPTION 'PRIVATE_MEDIA_PURGE_PATCH_TARGET_MISSING'; END IF;
 EXECUTE patched;
END $$;
