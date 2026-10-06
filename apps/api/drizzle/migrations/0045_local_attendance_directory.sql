-- Local identities belong to the Broker tenant, never to a synthetic Chatwoot account.
CREATE TABLE local_attendance_teams (
 organization_id uuid NOT NULL REFERENCES organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120 AND name=btrim(name)),
 status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','ARCHIVED')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,id)
);
CREATE TABLE local_attendance_team_members (
 organization_id uuid NOT NULL, team_id uuid NOT NULL, user_id uuid NOT NULL,
 PRIMARY KEY(organization_id,team_id,user_id),
 FOREIGN KEY(organization_id,team_id) REFERENCES local_attendance_teams(organization_id,id),
 FOREIGN KEY(organization_id,user_id) REFERENCES memberships(organization_id,user_id)
);
ALTER TABLE attendance_sessions
 ADD COLUMN local_team_id uuid,
 ADD COLUMN local_agent_id uuid,
 ADD CONSTRAINT attendance_local_team_fk FOREIGN KEY(organization_id,local_team_id) REFERENCES local_attendance_teams(organization_id,id),
 ADD CONSTRAINT attendance_local_agent_fk FOREIGN KEY(organization_id,local_agent_id) REFERENCES memberships(organization_id,user_id),
 ADD CONSTRAINT attendance_local_target_scope CHECK(
  (local_team_id IS NULL OR local_agent_id IS NULL) AND
  (integration_id IS NULL OR (local_team_id IS NULL AND local_agent_id IS NULL))
 );
--> statement-breakpoint
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['local_attendance_teams','local_attendance_team_members'] LOOP
  EXECUTE format('ALTER TABLE %I OWNER TO jrc_migrator',tab);
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY attendance_tenant ON %I TO jrc_app USING(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK(organization_id=NULLIF(current_setting(''app.organization_id'',true),'''')::uuid)',tab);
  EXECUTE format('CREATE POLICY lifecycle_migrator ON %I TO jrc_migrator USING(true) WITH CHECK(true)',tab);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,jrc_auth,jrc_platform',tab);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO jrc_app',tab);
 END LOOP;
END $$;
GRANT DELETE ON local_attendance_team_members TO jrc_app;
INSERT INTO lifecycle_purge_catalogue(table_name) VALUES('local_attendance_team_members'),('local_attendance_teams');
--> statement-breakpoint
-- Projection is tenant-bound and cannot expose password/authentication fields.
CREATE FUNCTION current_local_attendance_members() RETURNS TABLE(user_id uuid,email text,role membership_role)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT m.user_id,u.email,m.role FROM public.memberships m
 JOIN public.users u ON u.id=m.user_id JOIN public.organizations o ON o.id=m.organization_id
 WHERE m.organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid
  AND o.status='ACTIVE' AND m.status='ACTIVE' AND u.status='ACTIVE'
  AND m.role IN ('OWNER','ADMIN','OPERATOR') ORDER BY m.user_id LIMIT 1001
$$;
ALTER FUNCTION current_local_attendance_members() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION current_local_attendance_members() FROM PUBLIC,jrc_auth,jrc_platform;
GRANT EXECUTE ON FUNCTION current_local_attendance_members() TO jrc_app;
--> statement-breakpoint
-- Users-before-memberships matches global identity administration. A preliminary
-- tenant membership check prevents a caller from locking another tenant's user.
CREATE FUNCTION lock_local_attendance_member(target_user uuid) RETURNS TABLE(user_id uuid,email text,role membership_role)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid; selected_email text; selected_status public.user_status; selected_role public.membership_role;
BEGIN
 org=NULLIF(current_setting('app.organization_id',true),'')::uuid;
 IF org IS NULL OR NOT public.tenant_is_active(org) THEN RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.memberships m WHERE m.organization_id=org AND m.user_id=target_user
  AND m.status='ACTIVE' AND m.role IN ('OWNER','ADMIN','OPERATOR')) THEN RETURN; END IF;
 SELECT u.email,u.status INTO selected_email,selected_status FROM public.users u WHERE u.id=target_user FOR SHARE;
 IF selected_status IS DISTINCT FROM 'ACTIVE'::public.user_status THEN RETURN; END IF;
 SELECT m.role INTO selected_role FROM public.memberships m WHERE m.organization_id=org AND m.user_id=target_user
  AND m.status='ACTIVE' AND m.role IN ('OWNER','ADMIN','OPERATOR') FOR SHARE;
 IF selected_role IS NULL THEN RETURN; END IF;
 RETURN QUERY SELECT target_user,selected_email,selected_role;
END $$;
ALTER FUNCTION lock_local_attendance_member(uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION lock_local_attendance_member(uuid) FROM PUBLIC,jrc_auth,jrc_platform;
GRANT EXECUTE ON FUNCTION lock_local_attendance_member(uuid) TO jrc_app;
