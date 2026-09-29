CREATE TABLE support_tickets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organizations(id),
 title text NOT NULL CHECK (length(title) BETWEEN 5 AND 160),
 status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','WAITING_CUSTOMER','RESOLVED')),
 revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
 request_id uuid NOT NULL,
 request_hash text NOT NULL,
 assignee_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 first_response_at timestamptz,
 response_due_at timestamptz NOT NULL,
 resolved_at timestamptz,
 UNIQUE (organization_id,request_id),
 UNIQUE (organization_id,id)
);
CREATE TABLE support_messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL,
 ticket_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 author_kind text NOT NULL CHECK (author_kind IN ('TENANT','PLATFORM')),
 kind text NOT NULL DEFAULT 'REPLY' CHECK (kind IN ('REPLY','EVENT')),
 body text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
 request_id uuid NOT NULL,
 request_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (organization_id,ticket_id) REFERENCES support_tickets(organization_id,id),
 UNIQUE (organization_id,ticket_id,request_id)
);
CREATE INDEX support_queue ON support_tickets(updated_at DESC,id DESC);
CREATE INDEX support_tenant_queue ON support_tickets(organization_id,updated_at DESC,id DESC);
CREATE INDEX support_thread ON support_messages(organization_id,ticket_id,created_at DESC,id DESC);
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['support_tickets','support_messages'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY tenant_boundary ON %I TO jrc_app USING (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid)',tab);
  EXECUTE format('CREATE POLICY platform_boundary ON %I TO jrc_platform USING (true) WITH CHECK (true)',tab);
  EXECUTE format('CREATE POLICY maintenance_boundary ON %I TO jrc_migrator USING (true) WITH CHECK (true)',tab);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,jrc_auth',tab);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON support_tickets TO jrc_app,jrc_platform;
GRANT SELECT,INSERT ON support_messages TO jrc_app,jrc_platform;
-- App has no UPDATE grant on organizations; lock admission in a narrow trigger
-- instead of broadening that grant just to use SELECT ... FOR SHARE.
CREATE FUNCTION support_write_admission() RETURNS trigger LANGUAGE plpgsql
 SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE allowed boolean;
BEGIN
 SELECT status<>'DISABLED' INTO allowed FROM public.organizations WHERE id=NEW.organization_id FOR SHARE;
 IF allowed IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'SUPPORT_ORGANIZATION_DISABLED' USING ERRCODE='23514',CONSTRAINT='support_organization_writable';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION support_write_admission() FROM PUBLIC;
CREATE TRIGGER support_ticket_admission BEFORE INSERT OR UPDATE ON support_tickets
 FOR EACH ROW EXECUTE FUNCTION support_write_admission();
CREATE TRIGGER support_message_admission BEFORE INSERT ON support_messages
 FOR EACH ROW EXECUTE FUNCTION support_write_admission();
INSERT INTO lifecycle_purge_catalogue(table_name) VALUES ('support_messages'),('support_tickets');
