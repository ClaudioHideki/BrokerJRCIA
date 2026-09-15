CREATE TYPE messaging_conversation_mode AS ENUM ('BOT', 'HUMAN');
CREATE TYPE messaging_consent_status AS ENUM ('UNKNOWN', 'OPTED_IN', 'OPTED_OUT');
CREATE TYPE messaging_message_direction AS ENUM ('INCOMING', 'OUTGOING');
CREATE TYPE messaging_message_source AS ENUM ('CONTACT', 'OPERATOR', 'AUTOMATION');
CREATE TYPE messaging_message_state AS ENUM (
  'ACCEPTED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'UNKNOWN'
);
CREATE TYPE messaging_bot_job_status AS ENUM (
  'PENDING', 'RUNNING', 'COMPLETED', 'UNKNOWN', 'PAUSED', 'FAILED'
);
CREATE SEQUENCE messaging_message_order_seq AS bigint;
--> statement-breakpoint
CREATE TABLE messaging_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  provider_account_id uuid NOT NULL,
  phone_number_id text NOT NULL,
  waba_id text NOT NULL,
  credential_reference text NOT NULL,
  bot_public_id text,
  bot_origin_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messaging_channels_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT messaging_channels_org_phone_unique UNIQUE (organization_id, phone_number_id),
  CONSTRAINT messaging_channels_provider_account_fk
    FOREIGN KEY (organization_id, provider_account_id)
    REFERENCES provider_accounts(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT messaging_channels_bot_pair CHECK (
    (bot_public_id IS NULL AND bot_origin_reference IS NULL)
    OR (bot_public_id IS NOT NULL AND bot_origin_reference IS NOT NULL)
  ),
  CONSTRAINT messaging_channels_credential_reference_nonempty
    CHECK (btrim(credential_reference) <> '')
);
--> statement-breakpoint
CREATE TABLE messaging_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  display_name text,
  consent_status messaging_consent_status NOT NULL DEFAULT 'UNKNOWN',
  consent_updated_at timestamptz,
  suppressed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messaging_contacts_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT messaging_contacts_org_external_unique UNIQUE (organization_id, external_id),
  CONSTRAINT messaging_contacts_external_nonempty CHECK (btrim(external_id) <> '')
);
--> statement-breakpoint
CREATE TABLE messaging_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  mode messaging_conversation_mode NOT NULL DEFAULT 'BOT',
  bot_public_id text,
  bot_origin_reference text,
  typebot_session_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messaging_conversations_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT messaging_conversations_org_channel_id_unique UNIQUE (organization_id, channel_id, id),
  CONSTRAINT messaging_conversations_participants_unique
    UNIQUE (organization_id, channel_id, contact_id),
  CONSTRAINT messaging_conversations_channel_fk
    FOREIGN KEY (organization_id, channel_id)
    REFERENCES messaging_channels(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT messaging_conversations_contact_fk
    FOREIGN KEY (organization_id, contact_id)
    REFERENCES messaging_contacts(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT messaging_conversations_bot_pair CHECK (
    (bot_public_id IS NULL AND bot_origin_reference IS NULL)
    OR (bot_public_id IS NOT NULL AND bot_origin_reference IS NOT NULL)
  ),
  CONSTRAINT messaging_conversations_session_owner CHECK (
    typebot_session_id IS NULL OR bot_public_id IS NOT NULL
  )
);
--> statement-breakpoint
CREATE TABLE messaging_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  direction messaging_message_direction NOT NULL,
  source messaging_message_source NOT NULL,
  upstream_message_id text,
  content jsonb NOT NULL,
  state messaging_message_state NOT NULL,
  canonical_error_code text,
  idempotency_key text,
  idempotency_body_hash text,
  requires_opt_in boolean NOT NULL DEFAULT false,
  sequence_number bigint NOT NULL DEFAULT nextval('messaging_message_order_seq'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messaging_messages_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT messaging_messages_org_channel_id_unique UNIQUE (organization_id, channel_id, id),
  CONSTRAINT messaging_messages_org_conversation_id_unique
    UNIQUE (organization_id, conversation_id, id),
  CONSTRAINT messaging_messages_org_sequence_unique UNIQUE (organization_id, sequence_number),
  CONSTRAINT messaging_messages_conversation_fk
    FOREIGN KEY (organization_id, channel_id, conversation_id)
    REFERENCES messaging_conversations(organization_id, channel_id, id) ON DELETE RESTRICT,
  CONSTRAINT messaging_messages_direction_source CHECK (
    (direction = 'INCOMING' AND source = 'CONTACT')
    OR (direction = 'OUTGOING' AND source IN ('OPERATOR', 'AUTOMATION'))
  ),
  CONSTRAINT messaging_messages_idempotency_pair CHECK (
    (idempotency_key IS NULL AND idempotency_body_hash IS NULL)
    OR (idempotency_key IS NOT NULL AND idempotency_body_hash IS NOT NULL)
  ),
  CONSTRAINT messaging_messages_text_or_template CHECK (
    (content->>'type' = 'TEXT' AND jsonb_typeof(content->'text') = 'string')
    OR (
      content->>'type' = 'TEMPLATE'
      AND jsonb_typeof(content->'name') = 'string'
      AND jsonb_typeof(content->'language') = 'string'
      AND jsonb_typeof(content->'variables') = 'array'
    )
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX messaging_messages_idempotency_unique
  ON messaging_messages (organization_id, channel_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX messaging_messages_upstream_unique
  ON messaging_messages (organization_id, channel_id, upstream_message_id)
  WHERE upstream_message_id IS NOT NULL;
CREATE INDEX messaging_messages_conversation_order
  ON messaging_messages (organization_id, conversation_id, sequence_number DESC);
--> statement-breakpoint
CREATE TABLE messaging_inbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  event_key text NOT NULL,
  message_id uuid,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messaging_inbox_events_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT messaging_inbox_events_dedupe_unique UNIQUE (organization_id, channel_id, event_key),
  CONSTRAINT messaging_inbox_events_channel_fk
    FOREIGN KEY (organization_id, channel_id)
    REFERENCES messaging_channels(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT messaging_inbox_events_message_fk
    FOREIGN KEY (organization_id, channel_id, message_id)
    REFERENCES messaging_messages(organization_id, channel_id, id) ON DELETE RESTRICT,
  CONSTRAINT messaging_inbox_events_key_nonempty CHECK (btrim(event_key) <> '')
);
--> statement-breakpoint
CREATE TABLE messaging_status_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  upstream_message_id text NOT NULL,
  state messaging_message_state NOT NULL,
  canonical_error_code text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messaging_status_events_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT messaging_status_events_dedupe_unique
    UNIQUE (organization_id, channel_id, upstream_message_id, state),
  CONSTRAINT messaging_status_events_channel_fk
    FOREIGN KEY (organization_id, channel_id)
    REFERENCES messaging_channels(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT messaging_status_events_supported_state CHECK (
    state IN ('SENT', 'DELIVERED', 'READ', 'FAILED')
  )
);
--> statement-breakpoint
CREATE TABLE messaging_outbox (
  organization_id uuid NOT NULL,
  message_id uuid NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  retry_safe boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messaging_outbox_pkey PRIMARY KEY (organization_id, message_id),
  CONSTRAINT messaging_outbox_message_fk
    FOREIGN KEY (organization_id, message_id)
    REFERENCES messaging_messages(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT messaging_outbox_lease_pair CHECK (
    (lease_token IS NULL AND lease_expires_at IS NULL)
    OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT messaging_outbox_attempt_nonnegative CHECK (attempt_count >= 0)
);
CREATE INDEX messaging_outbox_claim_order
  ON messaging_outbox (organization_id, available_at, message_id)
  WHERE lease_token IS NULL;
--> statement-breakpoint
CREATE TABLE messaging_bot_jobs (
  organization_id uuid NOT NULL,
  message_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  status messaging_bot_job_status NOT NULL DEFAULT 'PENDING',
  lease_token uuid,
  lease_expires_at timestamptz,
  canonical_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messaging_bot_jobs_pkey PRIMARY KEY (organization_id, message_id),
  CONSTRAINT messaging_bot_jobs_message_fk
    FOREIGN KEY (organization_id, conversation_id, message_id)
    REFERENCES messaging_messages(organization_id, conversation_id, id) ON DELETE CASCADE,
  CONSTRAINT messaging_bot_jobs_conversation_fk
    FOREIGN KEY (organization_id, conversation_id)
    REFERENCES messaging_conversations(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT messaging_bot_jobs_lease_pair CHECK (
    (status = 'RUNNING' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'RUNNING' AND lease_token IS NULL AND lease_expires_at IS NULL)
  )
);
CREATE INDEX messaging_bot_jobs_claim_order
  ON messaging_bot_jobs (organization_id, created_at, message_id)
  WHERE status = 'PENDING';
--> statement-breakpoint
ALTER TABLE messaging_channels OWNER TO jrc_migrator;
ALTER TABLE messaging_contacts OWNER TO jrc_migrator;
ALTER TABLE messaging_conversations OWNER TO jrc_migrator;
ALTER TABLE messaging_messages OWNER TO jrc_migrator;
ALTER TABLE messaging_inbox_events OWNER TO jrc_migrator;
ALTER TABLE messaging_status_events OWNER TO jrc_migrator;
ALTER TABLE messaging_outbox OWNER TO jrc_migrator;
ALTER TABLE messaging_bot_jobs OWNER TO jrc_migrator;
ALTER TYPE messaging_conversation_mode OWNER TO jrc_migrator;
ALTER TYPE messaging_consent_status OWNER TO jrc_migrator;
ALTER TYPE messaging_message_direction OWNER TO jrc_migrator;
ALTER TYPE messaging_message_source OWNER TO jrc_migrator;
ALTER TYPE messaging_message_state OWNER TO jrc_migrator;
ALTER TYPE messaging_bot_job_status OWNER TO jrc_migrator;
ALTER SEQUENCE messaging_message_order_seq OWNER TO jrc_migrator;
REVOKE ALL ON TYPE messaging_conversation_mode, messaging_consent_status,
  messaging_message_direction, messaging_message_source, messaging_message_state,
  messaging_bot_job_status FROM PUBLIC;
GRANT USAGE ON TYPE messaging_conversation_mode, messaging_consent_status,
  messaging_message_direction, messaging_message_source, messaging_message_state,
  messaging_bot_job_status TO jrc_app;
GRANT USAGE ON SEQUENCE messaging_message_order_seq TO jrc_app;
--> statement-breakpoint
ALTER TABLE messaging_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging_channels FORCE ROW LEVEL SECURITY;
ALTER TABLE messaging_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging_contacts FORCE ROW LEVEL SECURITY;
ALTER TABLE messaging_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging_conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE messaging_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE messaging_inbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging_inbox_events FORCE ROW LEVEL SECURITY;
ALTER TABLE messaging_status_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging_status_events FORCE ROW LEVEL SECURITY;
ALTER TABLE messaging_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE messaging_bot_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging_bot_jobs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY messaging_channels_tenant_isolation ON messaging_channels TO jrc_app
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY messaging_contacts_tenant_isolation ON messaging_contacts TO jrc_app
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY messaging_conversations_tenant_isolation ON messaging_conversations TO jrc_app
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY messaging_messages_tenant_isolation ON messaging_messages TO jrc_app
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY messaging_inbox_events_tenant_isolation ON messaging_inbox_events TO jrc_app
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY messaging_status_events_tenant_isolation ON messaging_status_events TO jrc_app
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY messaging_outbox_tenant_isolation ON messaging_outbox TO jrc_app
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY messaging_bot_jobs_tenant_isolation ON messaging_bot_jobs TO jrc_app
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
--> statement-breakpoint
REVOKE ALL ON messaging_channels, messaging_contacts, messaging_conversations,
  messaging_messages, messaging_inbox_events, messaging_status_events,
  messaging_outbox, messaging_bot_jobs
  FROM PUBLIC, jrc_app, jrc_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON messaging_channels, messaging_contacts,
  messaging_conversations, messaging_messages, messaging_inbox_events,
  messaging_outbox, messaging_bot_jobs, messaging_status_events TO jrc_app;
