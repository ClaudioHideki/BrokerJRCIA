CREATE TYPE organization_status AS ENUM ('ACTIVE', 'SUSPENDED', 'DISABLED');
CREATE TYPE user_status AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE membership_role AS ENUM ('OWNER', 'ADMIN', 'OPERATOR', 'VIEWER');
CREATE TYPE membership_status AS ENUM ('ACTIVE', 'DISABLED');
--> statement-breakpoint
CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL,
  status organization_status NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organizations_slug_unique UNIQUE (slug)
);
--> statement-breakpoint
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  status user_status NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_unique UNIQUE (email),
  CONSTRAINT users_email_normalized CHECK (email = lower(btrim(email)))
);
--> statement-breakpoint
CREATE TABLE memberships (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role membership_role NOT NULL,
  status membership_status NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memberships_pkey PRIMARY KEY (organization_id, user_id)
);
--> statement-breakpoint
CREATE TABLE login_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT login_sessions_token_hash_unique UNIQUE (token_hash)
);
--> statement-breakpoint
CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  family_id uuid NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replaced_by_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refresh_tokens_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT refresh_tokens_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT refresh_tokens_membership_fk FOREIGN KEY (organization_id, user_id)
    REFERENCES memberships(organization_id, user_id) ON DELETE CASCADE,
  CONSTRAINT refresh_tokens_replacement_fk FOREIGN KEY (organization_id, replaced_by_id)
    REFERENCES refresh_tokens(organization_id, id) DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  prefix text NOT NULL,
  key_hmac text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_keys_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT api_keys_org_name_unique UNIQUE (organization_id, name),
  CONSTRAINT api_keys_prefix_global_unique UNIQUE (prefix)
);
--> statement-breakpoint
CREATE TABLE security_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  request_id uuid,
  identity_digest text,
  ip_digest text,
  outcome text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid,
  request_id uuid,
  outcome text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_logs_org_id_unique UNIQUE (organization_id, id)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ensure_organization_has_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_organization_id uuid;
  target_organization_ids uuid[];
BEGIN
  IF TG_TABLE_NAME = 'organizations' THEN
    target_organization_ids := ARRAY[COALESCE(NEW.id, OLD.id)];
  ELSIF TG_OP = 'INSERT' THEN
    target_organization_ids := ARRAY[NEW.organization_id];
  ELSIF TG_OP = 'DELETE' THEN
    target_organization_ids := ARRAY[OLD.organization_id];
  ELSE
    target_organization_ids := ARRAY[OLD.organization_id, NEW.organization_id];
  END IF;

  FOR target_organization_id IN
    SELECT DISTINCT organization_id
      FROM unnest(target_organization_ids) AS candidate(organization_id)
     WHERE organization_id IS NOT NULL
     ORDER BY organization_id
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended(target_organization_id::text, 1246318642)
    );
  END LOOP;

  FOR target_organization_id IN
    SELECT DISTINCT organization_id
      FROM unnest(target_organization_ids) AS candidate(organization_id)
     WHERE organization_id IS NOT NULL
     ORDER BY organization_id
  LOOP
    IF EXISTS (SELECT 1 FROM public.organizations WHERE id = target_organization_id)
       AND NOT EXISTS (
         SELECT 1
           FROM public.memberships
          WHERE organization_id = target_organization_id
            AND role = 'OWNER'
            AND status = 'ACTIVE'
       ) THEN
      RAISE EXCEPTION 'organization must retain at least one active OWNER'
        USING ERRCODE = '23514', CONSTRAINT = 'organizations_require_owner';
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER memberships_require_owner
AFTER INSERT OR UPDATE OR DELETE ON memberships
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_organization_has_owner();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER organizations_require_owner
AFTER INSERT OR UPDATE ON organizations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_organization_has_owner();
