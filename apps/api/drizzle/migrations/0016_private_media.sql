CREATE TABLE messaging_media (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,channel_id uuid NOT NULL,
 source text NOT NULL CHECK(source IN ('QR','META','CHATWOOT')),source_key text NOT NULL CHECK(length(source_key) BETWEEN 1 AND 512),
 kind text NOT NULL CHECK(kind IN ('image','audio','video','document','sticker')),file_name text NOT NULL,mime_type text,
 descriptor jsonb NOT NULL,status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','DOWNLOADING','READY','FAILED')),
 encrypted_data text,byte_size integer CHECK(byte_size BETWEEN 1 AND 16777216),sha256 text,
 attempts integer NOT NULL DEFAULT 0,available_at timestamptz NOT NULL DEFAULT now(),lease_token uuid,lease_expires_at timestamptz,last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id),UNIQUE(organization_id,channel_id,id),UNIQUE(organization_id,channel_id,source,source_key),
 FOREIGN KEY(organization_id,channel_id) REFERENCES messaging_channels(organization_id,id) ON DELETE RESTRICT,
 CHECK((status='READY' AND encrypted_data IS NOT NULL AND byte_size IS NOT NULL AND sha256 IS NOT NULL AND mime_type IS NOT NULL) OR (status<>'READY' AND encrypted_data IS NULL)),
 CHECK((status='DOWNLOADING' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR(status<>'DOWNLOADING' AND lease_token IS NULL AND lease_expires_at IS NULL))
);
ALTER TABLE messaging_media OWNER TO jrc_migrator;
ALTER TABLE messaging_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging_media FORCE ROW LEVEL SECURITY;
CREATE POLICY messaging_media_tenant ON messaging_media TO jrc_app USING(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid);
REVOKE ALL ON messaging_media FROM PUBLIC,jrc_auth;
GRANT SELECT,INSERT,UPDATE ON messaging_media TO jrc_app;
CREATE INDEX messaging_media_download ON messaging_media(organization_id,status,available_at,created_at);
--> statement-breakpoint
ALTER TABLE messaging_messages DROP CONSTRAINT messaging_messages_text_or_template;
ALTER TABLE messaging_messages ADD CONSTRAINT messaging_messages_supported_content CHECK (COALESCE((
 (content->>'type'='TEXT' AND jsonb_typeof(content->'text')='string') OR
 (content->>'type'='TEMPLATE' AND jsonb_typeof(content->'name')='string' AND jsonb_typeof(content->'language')='string' AND jsonb_typeof(content->'variables')='array') OR
 (content->>'type'='MEDIA' AND jsonb_typeof(content->'mediaId')='string' AND content->>'kind' IN ('image','audio','video','document','sticker') AND (NOT(content ? 'caption') OR jsonb_typeof(content->'caption')='string') AND jsonb_typeof(content->'fileName')='string')
),false));
ALTER TABLE messaging_messages ADD COLUMN media_id uuid GENERATED ALWAYS AS (CASE WHEN content->>'type'='MEDIA' THEN (content->>'mediaId')::uuid END) STORED;
ALTER TABLE messaging_messages ADD CONSTRAINT messaging_messages_media_fk FOREIGN KEY(organization_id,channel_id,media_id) REFERENCES messaging_media(organization_id,channel_id,id) ON DELETE RESTRICT;
