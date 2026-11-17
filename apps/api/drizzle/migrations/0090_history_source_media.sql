-- Additive private upload identity. Existing automation/partner identities and
-- public upload contracts remain unchanged. Does not admit captures or enable a worker.
ALTER TABLE history_sync_record_results ADD COLUMN recipient_kind text,ADD COLUMN peer_jid text;
ALTER TABLE history_sync_record_results ADD CONSTRAINT history_sync_result_peer CHECK(
 (recipient_kind IS NULL AND peer_jid IS NULL) OR (recipient_kind IS NOT NULL AND peer_jid IS NOT NULL AND
  ((recipient_kind='INDIVIDUAL' AND peer_jid ~ '^([1-9][0-9]{7,14}@s[.]whatsapp[.]net|[0-9]{1,30}@lid)$')
   OR (recipient_kind='GROUP' AND peer_jid ~ '^[0-9]+(-[0-9]+)?@g[.]us$'))));
CREATE INDEX history_sync_result_peers ON history_sync_record_results(organization_id,run_id,recipient_kind,peer_jid) WHERE peer_jid IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION history_media_upload_identity_valid(value jsonb,source_key text,reference_id uuid)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT CASE WHEN jsonb_typeof(value)='object' THEN COALESCE(
   value->>'uploadKind'='HISTORY' AND value->>'referenceId'=reference_id::text
   AND value->>'runId' ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
   AND value->>'captureScopeKey' ~ '^[a-f0-9]{64}$' AND value->>'sha256' ~ '^[a-f0-9]{64}$'
   AND jsonb_typeof(value->'mimeType')='string' AND length(value->>'mimeType') BETWEEN 1 AND 255
   AND jsonb_typeof(value->'byteSize')='number' AND value->>'byteSize' ~ '^[1-9][0-9]{0,7}$'
   AND (value->>'byteSize')::numeric<=16777216
   AND source_key='history:'||(value->>'captureScopeKey')||':'||(value->>'runId')||':'||reference_id::text
   AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(value) k)
     =ARRAY['byteSize','captureScopeKey','mimeType','referenceId','runId','sha256','uploadKind']::text[],false)
 ELSE false END
$$;
ALTER FUNCTION history_media_upload_identity_valid(jsonb,text,uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION history_media_upload_identity_valid(jsonb,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION history_media_upload_identity_valid(jsonb,text,uuid) TO jrc_app;
ALTER TABLE messaging_media DROP CONSTRAINT messaging_media_upload_identity;
ALTER TABLE messaging_media ADD CONSTRAINT messaging_media_upload_identity CHECK(source<>'UPLOAD'
 OR partner_media_upload_identity_valid(descriptor,source_key)
 OR history_media_upload_identity_valid(descriptor,source_key,id));
-- Rollback is binary rollback with history capture/worker disabled; retain rows
-- and this additive identity. Reinstalling the old CHECK would reject retained history.
