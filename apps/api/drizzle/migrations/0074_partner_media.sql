-- Keep the legacy automation identity and give public partner uploads a
-- disjoint namespace. No API-key FK: deleting a key must retain this evidence.
CREATE FUNCTION partner_media_upload_identity_valid(identity jsonb, source_key text) RETURNS boolean
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT COALESCE((
  (NOT identity ? 'uploadKind'
   AND identity->>'rootAutomationId' ~ '^[a-f0-9-]{36}$'
   AND identity->>'idempotencyKey' ~ '^[a-f0-9-]{36}$'
   AND identity->>'sha256' ~ '^[a-f0-9]{64}$'
   AND source_key=(identity->>'rootAutomationId')||':'||(identity->>'idempotencyKey'))
  OR
  (jsonb_typeof(identity)='object' AND identity->>'uploadKind'='PARTNER'
   AND jsonb_typeof(identity->'apiKeyId')='string'
   AND identity->>'apiKeyId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   AND jsonb_typeof(identity->'idempotencyKey')='string'
   AND identity->>'idempotencyKey' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   AND jsonb_typeof(identity->'sha256')='string' AND identity->>'sha256' ~ '^[a-f0-9]{64}$'
   AND jsonb_typeof(identity->'requestHash')='string' AND identity->>'requestHash' ~ '^[a-f0-9]{64}$'
   AND jsonb_typeof(identity->'mimeType')='string'
   AND identity->>'mimeType'=ANY(ARRAY['image/png','image/jpeg','audio/mpeg','audio/aac','audio/ogg','audio/mp4','video/mp4','video/3gpp','application/pdf','text/plain'])
   AND jsonb_typeof(identity->'byteSize')='number'
   AND (identity->>'byteSize') ~ '^[1-9][0-9]{0,7}$'
   AND CASE WHEN (identity->>'byteSize') ~ '^[1-9][0-9]{0,7}$' THEN (identity->>'byteSize')::integer BETWEEN 1 AND 16777216 ELSE false END
   AND identity-ARRAY['uploadKind','apiKeyId','idempotencyKey','sha256','requestHash','mimeType','byteSize']='{}'::jsonb
   AND source_key='partner:'||(identity->>'apiKeyId')||':'||(identity->>'idempotencyKey'))
 ),false)
$$;
ALTER FUNCTION partner_media_upload_identity_valid(jsonb,text) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION partner_media_upload_identity_valid(jsonb,text) FROM PUBLIC,jrc_auth,jrc_platform,jrc_lifecycle;
GRANT EXECUTE ON FUNCTION partner_media_upload_identity_valid(jsonb,text) TO jrc_app;
ALTER TABLE messaging_media DROP CONSTRAINT messaging_media_upload_identity;
ALTER TABLE messaging_media ADD CONSTRAINT messaging_media_upload_identity
 CHECK(source<>'UPLOAD' OR partner_media_upload_identity_valid(descriptor,source_key));

-- This fence protects old as well as current workers, including repeat SENDING
-- updates. Removing media:send leaves existing partner text authority intact.
CREATE OR REPLACE FUNCTION partner_require_message_authority() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.state<>'SENDING' OR NEW.authorizing_api_key_id IS NULL THEN RETURN NEW; END IF;
 PERFORM partner_key.id FROM public.api_keys partner_key
  WHERE partner_key.organization_id=NEW.organization_id AND partner_key.id=NEW.authorizing_api_key_id
   AND partner_key.revoked_at IS NULL
   AND (partner_key.expires_at IS NULL OR partner_key.expires_at>clock_timestamp())
   AND partner_key.scopes @> CASE WHEN NEW.content->>'type'='MEDIA'
    THEN ARRAY['messaging:send','media:send']::text[] ELSE ARRAY['messaging:send']::text[] END FOR SHARE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'PARTNER_CREDENTIAL_REVOKED' USING ERRCODE='42501';
 END IF;
 -- LockRows may wait after evaluating the predicate. The key SHARE is now
 -- held, so this fresh wall-clock check needs no additional row lock.
 IF NOT EXISTS(SELECT 1 FROM public.api_keys partner_key
  WHERE partner_key.organization_id=NEW.organization_id AND partner_key.id=NEW.authorizing_api_key_id
   AND (partner_key.expires_at IS NULL OR partner_key.expires_at>clock_timestamp())) THEN
  RAISE EXCEPTION 'PARTNER_CREDENTIAL_REVOKED' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION partner_require_message_authority() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION partner_require_message_authority() FROM PUBLIC,jrc_app,jrc_auth,jrc_platform,jrc_lifecycle;
