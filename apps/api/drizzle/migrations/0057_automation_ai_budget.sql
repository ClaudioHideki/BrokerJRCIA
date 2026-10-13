CREATE TABLE automation_ai_monthly_budgets (
 organization_id uuid NOT NULL REFERENCES organizations(id), month date NOT NULL CHECK(extract(day from month)=1),
 held_micros bigint NOT NULL DEFAULT 0 CHECK(held_micros>=0), charged_micros bigint NOT NULL DEFAULT 0 CHECK(charged_micros>=0),
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,month)
);
CREATE TABLE automation_ai_reservations (
 organization_id uuid NOT NULL, outbox_id uuid NOT NULL, month date NOT NULL,
 credential_id uuid NOT NULL, credential_revision integer NOT NULL CHECK(credential_revision>0),
 model text NOT NULL CHECK(length(model) BETWEEN 1 AND 200),
 input_micros_per_million bigint NOT NULL CHECK(input_micros_per_million>=0),output_micros_per_million bigint NOT NULL CHECK(output_micros_per_million>=0),
 reserved_micros bigint NOT NULL CHECK(reserved_micros>=0), observed_micros bigint CHECK(observed_micros BETWEEN 0 AND reserved_micros),
 input_tokens bigint CHECK(input_tokens>=0), output_tokens bigint CHECK(output_tokens>=0),
 status text NOT NULL CHECK(status IN ('UNKNOWN','SETTLED','NOT_DISPATCHED')),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,outbox_id),
 FOREIGN KEY(organization_id,outbox_id) REFERENCES automation_outbox(organization_id,id) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,credential_id) REFERENCES automation_credentials(organization_id,id),
 FOREIGN KEY(organization_id,month) REFERENCES automation_ai_monthly_budgets(organization_id,month),
 CHECK((status='UNKNOWN' AND observed_micros IS NULL AND input_tokens IS NULL AND output_tokens IS NULL)
 OR (status='SETTLED' AND observed_micros IS NOT NULL AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL)
 OR (status='NOT_DISPATCHED' AND observed_micros=0 AND input_tokens IS NULL AND output_tokens IS NULL))
);
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['automation_ai_monthly_budgets','automation_ai_reservations'] LOOP
  EXECUTE format('ALTER TABLE %I OWNER TO jrc_migrator',t);
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY automation_ai_tenant ON %I TO jrc_app USING (organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK (organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid)',t);
  EXECUTE format('CREATE POLICY lifecycle_migrator ON %I TO jrc_migrator USING(true) WITH CHECK(true)',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,jrc_auth,jrc_platform',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON automation_ai_monthly_budgets,automation_ai_reservations TO jrc_app;
INSERT INTO lifecycle_purge_catalogue(table_name) VALUES('automation_ai_monthly_budgets'),('automation_ai_reservations');
