ALTER TYPE messaging_message_source ADD VALUE IF NOT EXISTS 'EXTERNAL_OBSERVED';
ALTER TABLE messaging_messages DROP CONSTRAINT messaging_messages_direction_source;
ALTER TABLE messaging_messages ADD CONSTRAINT messaging_messages_direction_source CHECK (
 (direction='INCOMING' AND source::text='CONTACT') OR
 (direction='OUTGOING' AND source::text IN ('OPERATOR','AUTOMATION','EXTERNAL_OBSERVED'))
);
--> statement-breakpoint
CREATE TABLE qr_dispatch_attempts (
 organization_id uuid NOT NULL REFERENCES organizations(id),id uuid NOT NULL DEFAULT gen_random_uuid(),
 channel_id uuid NOT NULL,conversation_id uuid NOT NULL,message_id uuid NOT NULL,lease_token uuid NOT NULL,
 lease_expires_at timestamptz NOT NULL,provider_message_id text,
 state text NOT NULL DEFAULT 'DISPATCHED' CHECK(state IN ('DISPATCHED','CONFIRMED','REJECTED','UNKNOWN','ABANDONED')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),abandoned_by uuid,abandonment_reason text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,id),UNIQUE(organization_id,message_id,lease_token),
 FOREIGN KEY(organization_id,channel_id,conversation_id) REFERENCES messaging_conversations(organization_id,channel_id,id),
 FOREIGN KEY(organization_id,conversation_id,message_id) REFERENCES messaging_messages(organization_id,conversation_id,id),
 FOREIGN KEY(organization_id,abandoned_by) REFERENCES memberships(organization_id,user_id),
 CONSTRAINT qr_dispatch_attempts_abandonment_check CHECK((state='ABANDONED')=(abandoned_by IS NOT NULL AND coalesce(length(btrim(abandonment_reason)) BETWEEN 1 AND 500,false))),
 CONSTRAINT qr_dispatch_confirmation CHECK((state='CONFIRMED')=(provider_message_id IS NOT NULL)),
 CHECK(provider_message_id IS NULL OR length(btrim(provider_message_id)) BETWEEN 1 AND 256)
);
CREATE INDEX qr_dispatch_uncertain ON qr_dispatch_attempts(organization_id,conversation_id,state) WHERE state IN ('DISPATCHED','UNKNOWN','ABANDONED');
CREATE TABLE qr_outbound_observations (
 organization_id uuid NOT NULL REFERENCES organizations(id),id uuid NOT NULL DEFAULT gen_random_uuid(),
 channel_id uuid NOT NULL,conversation_id uuid NOT NULL,provider_message_id text NOT NULL CHECK(length(btrim(provider_message_id)) BETWEEN 1 AND 256),
 content jsonb NOT NULL,occurred_at timestamptz NOT NULL,
 disposition text NOT NULL DEFAULT 'RECONCILE' CHECK(disposition IN ('RECONCILE','BROKER_ECHO','EXTERNAL_OBSERVED','ABANDONED')),
 blocking boolean NOT NULL DEFAULT true,message_id uuid,revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 reason text NOT NULL DEFAULT 'QR_ACK_PENDING',abandoned_by uuid,abandonment_reason text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,id),UNIQUE(organization_id,channel_id,provider_message_id),
 FOREIGN KEY(organization_id,channel_id,conversation_id) REFERENCES messaging_conversations(organization_id,channel_id,id),
 FOREIGN KEY(organization_id,conversation_id,message_id) REFERENCES messaging_messages(organization_id,conversation_id,id),
 FOREIGN KEY(organization_id,abandoned_by) REFERENCES memberships(organization_id,user_id),
 CONSTRAINT qr_observation_disposition CHECK(
  (disposition IN ('BROKER_ECHO','EXTERNAL_OBSERVED') AND message_id IS NOT NULL AND NOT blocking)
  OR (disposition='RECONCILE' AND message_id IS NULL)
  OR (disposition='ABANDONED' AND message_id IS NULL AND NOT blocking AND abandoned_by IS NOT NULL AND coalesce(length(btrim(abandonment_reason)) BETWEEN 1 AND 500,false))
 )
);
CREATE INDEX qr_observations_pending ON qr_outbound_observations(organization_id,conversation_id,created_at) WHERE disposition='RECONCILE';
-- A binding resolved before deletion cannot admit a new observation afterward.
-- Existing ledger UPDATEs remain available for ACK/abandonment and safe draining.
CREATE TRIGGER lifecycle_qr_outbound_observations_block BEFORE INSERT ON qr_outbound_observations
 FOR EACH ROW EXECUTE FUNCTION lifecycle_reject_channel_write();
--> statement-breakpoint
-- Preserve pre-ledger uncertainty; no provider ID is inferred from timestamps or content.
INSERT INTO qr_dispatch_attempts(organization_id,channel_id,conversation_id,message_id,lease_token,lease_expires_at,state)
 SELECT m.organization_id,m.channel_id,m.conversation_id,m.id,coalesce(o.lease_token,gen_random_uuid()),coalesce(o.lease_expires_at,now()),
 CASE WHEN m.state='SENDING' THEN 'DISPATCHED' ELSE 'UNKNOWN' END
 FROM messaging_messages m JOIN messaging_channels c ON c.organization_id=m.organization_id AND c.id=m.channel_id
 LEFT JOIN messaging_outbox o ON o.organization_id=m.organization_id AND o.message_id=m.id
 WHERE c.provider='BAILEYS' AND m.direction='OUTGOING' AND m.state IN ('SENDING','UNKNOWN') AND m.upstream_message_id IS NULL;
--> statement-breakpoint
ALTER TABLE qr_dispatch_attempts OWNER TO jrc_migrator;
ALTER TABLE qr_outbound_observations OWNER TO jrc_migrator;
ALTER TABLE qr_dispatch_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE qr_dispatch_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE qr_outbound_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE qr_outbound_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY qr_tenant ON qr_dispatch_attempts TO jrc_app USING(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY qr_tenant ON qr_outbound_observations TO jrc_app USING(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid) WITH CHECK(organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY lifecycle_migrator ON qr_dispatch_attempts TO jrc_migrator USING(true) WITH CHECK(true);
CREATE POLICY lifecycle_migrator ON qr_outbound_observations TO jrc_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON qr_dispatch_attempts,qr_outbound_observations FROM PUBLIC,jrc_auth,jrc_platform;
GRANT SELECT,INSERT,UPDATE ON qr_dispatch_attempts,qr_outbound_observations TO jrc_app;
INSERT INTO lifecycle_purge_catalogue(table_name) VALUES('qr_dispatch_attempts'),('qr_outbound_observations');
--> statement-breakpoint
DO $$ DECLARE original text; patched text; BEGIN
 original=pg_get_functiondef('public.lifecycle_purge_channel(uuid,uuid)'::regprocedure);
 patched=replace(original,'DELETE FROM public.messaging_messages WHERE organization_id=org AND channel_id=channel;',
 'DELETE FROM public.qr_outbound_observations WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.qr_dispatch_attempts WHERE organization_id=org AND channel_id=channel;
  DELETE FROM public.messaging_messages WHERE organization_id=org AND channel_id=channel;');
 IF patched=original THEN RAISE EXCEPTION 'QR_OUTBOUND_PURGE_PATCH_TARGET_MISSING'; END IF;
 EXECUTE patched;
END $$;
--> statement-breakpoint
ALTER FUNCTION lifecycle_pending_count(uuid,uuid,uuid) RENAME TO lifecycle_pending_count_before_qr_outbound;
CREATE FUNCTION lifecycle_pending_count(p_org uuid,p_channel uuid,p_resource uuid)
RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT public.lifecycle_pending_count_before_qr_outbound(p_org,p_channel,p_resource)
 +(SELECT count(*) FROM public.qr_outbound_observations o WHERE o.organization_id=p_org AND (p_channel IS NULL OR o.channel_id=p_channel) AND o.blocking)
 +(SELECT count(*) FROM public.qr_dispatch_attempts a WHERE a.organization_id=p_org AND (p_channel IS NULL OR a.channel_id=p_channel) AND a.state IN ('DISPATCHED','UNKNOWN'));
$$;
ALTER FUNCTION lifecycle_pending_count(uuid,uuid,uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION lifecycle_pending_count(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle_pending_count(uuid,uuid,uuid) TO jrc_lifecycle;
--> statement-breakpoint
-- Authenticated transport facts are ingress, just like CONTACT, even while a
-- subscription is suspended. They do not admit a new Broker send. Preserve the
-- existing function, owner and ACL; ACTIVE and quotas still gate every other
-- resource/admission, while independent lifecycle/source/RLS guards remain.
DO $$ DECLARE original text; patched text; BEGIN
 original=pg_get_functiondef('public.enforce_tenant_operational_limits()'::regprocedure);
 patched=replace(original,
  'IF NEW.direction <> ''OUTGOING'' THEN RETURN NEW; END IF;',
  'IF NEW.direction <> ''OUTGOING'' OR NEW.source::text=''EXTERNAL_OBSERVED'' THEN RETURN NEW; END IF;');
 IF patched=original THEN RAISE EXCEPTION 'QR_OUTBOUND_ADMISSION_PATCH_TARGET_MISSING'; END IF;
 original=patched;
 patched=replace(original,
  'AND direction=''OUTGOING'' AND state IN (''ACCEPTED'',''SENDING'',''UNKNOWN'')',
  'AND direction=''OUTGOING'' AND source::text<>''EXTERNAL_OBSERVED'' AND state IN (''ACCEPTED'',''SENDING'',''UNKNOWN'')');
 IF patched=original THEN RAISE EXCEPTION 'QR_OUTBOUND_PENDING_COUNT_PATCH_TARGET_MISSING'; END IF;
 EXECUTE patched;
END $$;
