CREATE TABLE operational_heartbeats (
 organization_id uuid NOT NULL REFERENCES organizations(id), component text NOT NULL
   CHECK(component IN ('MESSAGING_WORKER','AUTOMATION_WORKER','AUTOMATION_IO_WORKER','SCHEDULER')),
 instance_id text NOT NULL CHECK(length(instance_id) BETWEEN 1 AND 120),
 status text NOT NULL DEFAULT 'UP' CHECK(status IN ('UP','DEGRADED')),
 detail_code text, observed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,component,instance_id)
);
CREATE INDEX operational_heartbeats_recent ON operational_heartbeats(organization_id,component,observed_at DESC);
CREATE TABLE automation_reconciliations (
 organization_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), execution_id uuid NOT NULL,
 outbox_id uuid NOT NULL, actor_id uuid NOT NULL, outcome text NOT NULL
   CHECK(outcome IN ('CONFIRMED_SENT','CONFIRMED_NOT_SENT','UNRESOLVED')),
 evidence_code text NOT NULL CHECK(length(evidence_code) BETWEEN 1 AND 80),
 provider_reference text, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,id),
 FOREIGN KEY(organization_id,execution_id) REFERENCES automation_executions(organization_id,id),
 FOREIGN KEY(organization_id,outbox_id) REFERENCES automation_outbox(organization_id,id),
 CHECK(provider_reference IS NULL OR length(provider_reference)<=300)
);
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['operational_heartbeats','automation_reconciliations'] LOOP
  EXECUTE format('ALTER TABLE %I OWNER TO jrc_migrator',t);
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY operational_tenant ON %I TO jrc_app USING (organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK (organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid)',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,jrc_auth,jrc_platform',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON operational_heartbeats TO jrc_app;
GRANT SELECT,INSERT ON automation_reconciliations TO jrc_app;
--> statement-breakpoint
CREATE FUNCTION record_operational_heartbeat(p_organization uuid,p_component text,p_instance text,p_status text DEFAULT 'UP',p_detail text DEFAULT NULL)
RETURNS void LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
 INSERT INTO public.operational_heartbeats(organization_id,component,instance_id,status,detail_code)
 VALUES(p_organization,p_component,p_instance,p_status,p_detail)
 ON CONFLICT(organization_id,component,instance_id) DO UPDATE
 SET status=excluded.status,detail_code=excluded.detail_code,observed_at=now()
$$;
ALTER FUNCTION record_operational_heartbeat(uuid,text,text,text,text) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION record_operational_heartbeat(uuid,text,text,text,text) FROM PUBLIC,jrc_auth,jrc_platform;
GRANT EXECUTE ON FUNCTION record_operational_heartbeat(uuid,text,text,text,text) TO jrc_app;
CREATE FUNCTION operational_worker_organizations(after_id uuid DEFAULT NULL,batch_size integer DEFAULT 100)
RETURNS TABLE(organization_id uuid) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT o.id FROM public.organizations o
 WHERE (after_id IS NULL OR o.id>after_id) AND o.status<>'DISABLED'
   AND (EXISTS(SELECT 1 FROM public.automation_definitions d WHERE d.organization_id=o.id)
     OR EXISTS(SELECT 1 FROM public.messaging_channels c WHERE c.organization_id=o.id))
 ORDER BY o.id LIMIT LEAST(GREATEST(batch_size,1),1000)
$$;
ALTER FUNCTION operational_worker_organizations(uuid,integer) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION operational_worker_organizations(uuid,integer) FROM PUBLIC,jrc_auth,jrc_platform;
GRANT EXECUTE ON FUNCTION operational_worker_organizations(uuid,integer) TO jrc_app;
