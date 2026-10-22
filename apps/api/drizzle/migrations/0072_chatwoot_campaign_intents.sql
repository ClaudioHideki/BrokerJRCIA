CREATE TABLE chatwoot_campaign_intents (
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 id uuid NOT NULL DEFAULT gen_random_uuid(), integration_id uuid NOT NULL, channel_id uuid NOT NULL,
 api_key_id uuid NOT NULL, actor_id text NOT NULL CHECK(actor_id ~ '^[1-9][0-9]{0,15}$'),
 account_id bigint NOT NULL CHECK(account_id>0), inbox_id bigint NOT NULL CHECK(inbox_id>0),
 destination_revision integer NOT NULL CHECK(destination_revision>0), credential_version integer NOT NULL,
 identity_revision integer NOT NULL CHECK(identity_revision>0), owner_revision integer NOT NULL CHECK(owner_revision>=0),
 remote_conversation_id bigint NOT NULL CHECK(remote_conversation_id>0), remote_message_id bigint NOT NULL CHECK(remote_message_id>0),
 campaign_id text NOT NULL CHECK(length(campaign_id) BETWEEN 1 AND 128),
 kind text NOT NULL CHECK(kind IN ('text','image','document','video','audio')), text text NOT NULL CHECK(length(text)<=4096),
 attachment_ids jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(attachment_ids)='array' AND jsonb_array_length(attachment_ids)<=1),
 remote_contact_id bigint NOT NULL CHECK(remote_contact_id>0),recipient_phone text NOT NULL CHECK(recipient_phone ~ '^\+[1-9][0-9]{7,14}$'),
 recipient_source_id text NOT NULL CHECK(length(recipient_source_id) BETWEEN 1 AND 255),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128), request_hash text NOT NULL,
 local_conversation_id uuid, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 PRIMARY KEY(organization_id,id), UNIQUE(organization_id,integration_id,idempotency_key),
 UNIQUE(organization_id,integration_id,remote_message_id),
 FOREIGN KEY(organization_id,integration_id) REFERENCES chatwoot_connections(organization_id,id) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,channel_id) REFERENCES messaging_channels(organization_id,id) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,local_conversation_id) REFERENCES messaging_conversations(organization_id,id) ON DELETE CASCADE
);
ALTER TABLE chatwoot_campaign_intents OWNER TO jrc_migrator;
ALTER TABLE chatwoot_campaign_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE chatwoot_campaign_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY campaign_tenant ON chatwoot_campaign_intents TO jrc_app
 USING(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY lifecycle_migrator ON chatwoot_campaign_intents TO jrc_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON chatwoot_campaign_intents FROM PUBLIC,jrc_app,jrc_auth,jrc_platform,jrc_lifecycle;
GRANT SELECT,INSERT ON chatwoot_campaign_intents TO jrc_app;
GRANT UPDATE(local_conversation_id) ON chatwoot_campaign_intents TO jrc_app;
ALTER TABLE messaging_messages ADD COLUMN campaign_intent_id uuid;

CREATE FUNCTION campaign_intent_authorized(org uuid,intent uuid,bound boolean) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.chatwoot_campaign_intents i
 JOIN public.organizations o ON o.id=i.organization_id AND o.status='ACTIVE'
 JOIN public.api_keys k ON k.organization_id=i.organization_id AND k.id=i.api_key_id AND k.revoked_at IS NULL
  AND (k.expires_at IS NULL OR k.expires_at>now()) AND k.scopes @> ARRAY['chatwoot:manage']::text[]
 JOIN public.chatwoot_control_bindings b ON b.organization_id=k.organization_id AND b.api_key_id=k.id AND b.active
  AND b.account_id=i.account_id AND b.destination_revision=i.destination_revision
 JOIN public.chatwoot_connections c ON c.organization_id=i.organization_id AND c.id=i.integration_id
  AND c.channel_id=i.channel_id AND c.inbox_id=i.inbox_id AND c.status='READY'
 JOIN public.messaging_channels ch ON ch.organization_id=i.organization_id AND ch.id=i.channel_id
  AND ch.provider='BAILEYS' AND ch.transport='BROKER_TRANSPORT' AND ch.deleting_at IS NULL
 JOIN public.instances instance ON instance.organization_id=ch.organization_id AND instance.id=ch.instance_id AND instance.status='CONNECTED' AND instance.archived_at IS NULL
 JOIN public.chatwoot_accounts a ON a.organization_id=i.organization_id AND a.account_id=i.account_id
  AND a.credential_version=i.credential_version AND a.status='READY'
 JOIN public.chatwoot_destinations d ON d.organization_id=i.organization_id AND d.base_url=a.base_url
  AND d.revision=i.destination_revision AND d.approval_status='APPROVED'
 JOIN public.chatwoot_connection_health h ON h.organization_id=i.organization_id AND h.integration_id=i.integration_id
  AND h.identity_revision=i.identity_revision AND h.observed_connected AND h.identity_error IS NULL AND h.access_error IS NULL
  AND h.observed_at>now()-interval '90 seconds'
  AND h.approved_fingerprint=h.observed_fingerprint AND h.observed_fingerprint IS NOT NULL
  AND h.callback_verified_at IS NOT NULL AND h.callback_destination_revision=i.destination_revision AND h.callback_credential_version=i.credential_version
 WHERE i.organization_id=org AND org=NULLIF(current_setting('app.organization_id',true),'')::uuid AND i.id=intent AND i.expires_at>now()
  AND i.owner_revision=coalesce((SELECT own.revision FROM public.attendance_owners own WHERE own.organization_id=i.organization_id AND own.channel_id=i.channel_id),0)
  AND (NOT bound OR EXISTS(SELECT 1 FROM public.chatwoot_conversations cm JOIN public.messaging_conversations cv
   ON cv.organization_id=cm.organization_id AND cv.id=cm.conversation_id
   JOIN public.messaging_contacts contact ON contact.organization_id=cv.organization_id AND contact.id=cv.contact_id
   WHERE cm.organization_id=i.organization_id AND cm.integration_id=i.integration_id AND cm.remote_conversation_id=i.remote_conversation_id
    AND cm.contact_id=i.remote_contact_id AND cm.source_id=i.recipient_source_id AND contact.external_id=substring(i.recipient_phone from 2)
    AND cm.conversation_id=i.local_conversation_id AND cv.channel_id=i.channel_id AND cv.remote_conversation_key IS NULL)))
$$;
ALTER FUNCTION campaign_intent_authorized(uuid,uuid,boolean) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION campaign_intent_authorized(uuid,uuid,boolean) FROM PUBLIC,jrc_auth,jrc_platform,jrc_lifecycle;
GRANT EXECUTE ON FUNCTION campaign_intent_authorized(uuid,uuid,boolean) TO jrc_app;
CREATE FUNCTION campaign_require_message_authority() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF OLD.campaign_intent_id IS NOT NULL AND NEW.campaign_intent_id IS DISTINCT FROM OLD.campaign_intent_id THEN
  RAISE EXCEPTION 'CAMPAIGN_AUTHORITY_IMMUTABLE' USING ERRCODE='42501';
 END IF;
 IF NEW.state='SENDING' AND NEW.campaign_intent_id IS NOT NULL THEN
  PERFORM k.id FROM public.chatwoot_campaign_intents i JOIN public.api_keys k ON k.organization_id=i.organization_id AND k.id=i.api_key_id
   WHERE i.organization_id=NEW.organization_id AND i.id=NEW.campaign_intent_id FOR SHARE OF k;
  IF NOT public.campaign_intent_authorized(NEW.organization_id,NEW.campaign_intent_id,true)
   OR NOT EXISTS(SELECT 1 FROM public.chatwoot_campaign_intents i WHERE i.organization_id=NEW.organization_id AND i.id=NEW.campaign_intent_id
    AND i.local_conversation_id=NEW.conversation_id AND i.channel_id=NEW.channel_id) THEN
   RAISE EXCEPTION 'CAMPAIGN_AUTHORITY_REVOKED' USING ERRCODE='42501';
  END IF;
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION campaign_require_message_authority() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION campaign_require_message_authority() FROM PUBLIC,jrc_app,jrc_auth,jrc_platform,jrc_lifecycle;
CREATE TRIGGER campaign_message_authority BEFORE UPDATE ON messaging_messages FOR EACH ROW EXECUTE FUNCTION campaign_require_message_authority();

INSERT INTO lifecycle_purge_catalogue(table_name) VALUES('chatwoot_campaign_intents');

CREATE FUNCTION campaign_catalogue_ready() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.lifecycle_purge_catalogue WHERE table_name='chatwoot_campaign_intents')
$$;
ALTER FUNCTION campaign_catalogue_ready() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION campaign_catalogue_ready() FROM PUBLIC,jrc_auth,jrc_platform,jrc_lifecycle;
GRANT EXECUTE ON FUNCTION campaign_catalogue_ready() TO jrc_app;
