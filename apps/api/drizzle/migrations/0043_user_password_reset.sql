-- Password changes invalidate every authentication capability of the global user.
-- Generation zero preserves untouched accounts' pre-migration tokens.
ALTER TABLE public.users ADD COLUMN auth_version integer NOT NULL DEFAULT 0 CHECK (auth_version >= 0);
ALTER TABLE public.login_sessions ADD COLUMN auth_version integer NOT NULL DEFAULT 0 CHECK (auth_version >= 0);
ALTER TABLE public.refresh_tokens ADD COLUMN auth_version integer NOT NULL DEFAULT 0 CHECK (auth_version >= 0);
ALTER TABLE public.chatwoot_embed_authorizations ADD COLUMN auth_version integer NOT NULL DEFAULT 0 CHECK (auth_version >= 0);
ALTER TABLE public.chatwoot_embed_sessions ADD COLUMN auth_version integer NOT NULL DEFAULT 0 CHECK (auth_version >= 0);
CREATE POLICY embed_authorizations_auth_revoke ON public.chatwoot_embed_authorizations FOR UPDATE TO jrc_migrator USING(true) WITH CHECK(true);
CREATE POLICY embed_sessions_auth_revoke ON public.chatwoot_embed_sessions FOR UPDATE TO jrc_migrator USING(true) WITH CHECK(true);
GRANT SELECT(auth_version), UPDATE(password_hash) ON public.users TO jrc_platform;
--> statement-breakpoint
-- One row lock orders password reset, login, selection, refresh and tenant switch.
CREATE FUNCTION public.lock_user_authentication(target_user_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE current_version integer;
BEGIN
  IF session_user <> 'jrc_auth' THEN RAISE EXCEPTION 'direct authentication session required' USING ERRCODE='42501'; END IF;
  SELECT auth_version INTO current_version FROM public.users
    WHERE id=target_user_id FOR UPDATE;
  RETURN current_version;
END $$;
ALTER FUNCTION public.lock_user_authentication(uuid) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION public.lock_user_authentication(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_user_authentication(uuid) TO jrc_auth;
--> statement-breakpoint
CREATE FUNCTION public.create_login_selection(target_user_id uuid, selection_hash text, selection_expires_at timestamptz, expected_auth_version integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE current_version integer;
BEGIN
  current_version := public.lock_user_authentication(target_user_id);
  IF current_version IS NULL OR expected_auth_version IS NULL OR current_version <> expected_auth_version
    OR NOT EXISTS (SELECT 1 FROM public.users WHERE id=target_user_id AND status='ACTIVE') THEN RETURN false; END IF;
  INSERT INTO public.login_sessions(user_id,token_hash,expires_at,auth_version)
    VALUES(target_user_id,selection_hash,selection_expires_at,current_version);
  RETURN true;
END $$;
ALTER FUNCTION public.create_login_selection(uuid,text,timestamptz,integer) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION public.create_login_selection(uuid,text,timestamptz,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_login_selection(uuid,text,timestamptz,integer) TO jrc_auth;
REVOKE INSERT ON public.login_sessions FROM jrc_auth;
--> statement-breakpoint
CREATE FUNCTION public.revoke_user_authentication(target_user_id uuid, revoked_at_time timestamptz)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE next_version integer;
BEGIN
  IF session_user <> 'jrc_platform' THEN RAISE EXCEPTION 'direct platform session required' USING ERRCODE='42501'; END IF;
  IF revoked_at_time IS NULL THEN RAISE EXCEPTION 'revocation time required' USING ERRCODE='22004'; END IF;
  UPDATE public.users SET auth_version=auth_version+1 WHERE id=target_user_id RETURNING auth_version INTO next_version;
  IF next_version IS NULL THEN RAISE EXCEPTION 'user not found' USING ERRCODE='P0002'; END IF;
  UPDATE public.login_sessions SET consumed_at=COALESCE(consumed_at,revoked_at_time) WHERE user_id=target_user_id;
  UPDATE public.refresh_tokens SET revoked_at=COALESCE(revoked_at,revoked_at_time) WHERE user_id=target_user_id;
  UPDATE public.chatwoot_embed_authorizations SET state='DENIED' WHERE approved_by=target_user_id AND state='APPROVED';
  UPDATE public.chatwoot_embed_sessions SET revoked_at=COALESCE(revoked_at,revoked_at_time) WHERE user_id=target_user_id;
  RETURN next_version;
END $$;
ALTER FUNCTION public.revoke_user_authentication(uuid,timestamptz) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION public.revoke_user_authentication(uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.revoke_user_authentication(uuid,timestamptz) TO jrc_platform;
--> statement-breakpoint
DROP FUNCTION public.consume_login_selection(text,uuid,timestamptz,uuid,uuid,text,timestamptz);
CREATE FUNCTION consume_login_selection(
  selected_token_hash text,
  selected_organization_id uuid,
  selected_at timestamptz,
  new_refresh_token_id uuid,
  new_refresh_family_id uuid,
  new_refresh_token_hash text,
  new_refresh_expires_at timestamptz
)
RETURNS TABLE (
  result_user_id uuid,
  result_organization_id uuid,
  result_role membership_role,
  result_outcome text,
  result_auth_version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  authenticated_user_id uuid;
  current_version integer;
  authenticated_role membership_role;
BEGIN
  SELECT user_id INTO authenticated_user_id FROM public.login_sessions WHERE token_hash=selected_token_hash;
  current_version := public.lock_user_authentication(authenticated_user_id);
  IF current_version IS NULL THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::membership_role, 'INVALID'::text, NULL::integer;
    RETURN;
  END IF;
  UPDATE public.login_sessions
     SET consumed_at = selected_at
   WHERE token_hash = selected_token_hash
     AND auth_version = current_version
     AND consumed_at IS NULL
     AND expires_at > selected_at
  RETURNING login_sessions.user_id INTO authenticated_user_id;

  IF authenticated_user_id IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.login_sessions
       WHERE token_hash = selected_token_hash AND consumed_at IS NOT NULL
    ) THEN
      RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::membership_role, 'REUSED'::text, NULL::integer;
    ELSE
      RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::membership_role, 'INVALID'::text, NULL::integer;
    END IF;
    RETURN;
  END IF;

  SELECT memberships.role
    INTO authenticated_role
    FROM public.memberships
    JOIN public.organizations
      ON organizations.id = memberships.organization_id
     AND organizations.status = 'ACTIVE'
    JOIN public.users
      ON users.id = memberships.user_id
     AND users.status = 'ACTIVE'
   WHERE memberships.user_id = authenticated_user_id
     AND memberships.organization_id = selected_organization_id
     AND memberships.status = 'ACTIVE'
   FOR UPDATE OF memberships, organizations, users;

  IF authenticated_role IS NULL THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::membership_role, 'INVALID'::text, NULL::integer;
    RETURN;
  END IF;

  INSERT INTO public.refresh_tokens
    (id, organization_id, user_id, family_id, token_hash, expires_at, auth_version)
  VALUES
    (new_refresh_token_id, selected_organization_id, authenticated_user_id,
     new_refresh_family_id, new_refresh_token_hash, new_refresh_expires_at, current_version);

  RETURN QUERY SELECT authenticated_user_id, selected_organization_id, authenticated_role, 'SELECTED'::text, current_version;
END
$$;
--> statement-breakpoint
ALTER FUNCTION consume_login_selection(text, uuid, timestamptz, uuid, uuid, text, timestamptz)
  OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION consume_login_selection(text, uuid, timestamptz, uuid, uuid, text, timestamptz)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION consume_login_selection(text, uuid, timestamptz, uuid, uuid, text, timestamptz)
  TO jrc_auth;

--> statement-breakpoint
DROP FUNCTION public.switch_refresh_organization(text,uuid,uuid,uuid,timestamptz,uuid,uuid,text,timestamptz);
CREATE FUNCTION switch_refresh_organization(
  source_token_hash text,
  expected_user_id uuid,
  expected_organization_id uuid,
  selected_organization_id uuid,
  switched_at timestamptz,
  new_refresh_token_id uuid,
  new_refresh_family_id uuid,
  new_refresh_token_hash text,
  new_refresh_expires_at timestamptz
)
RETURNS TABLE (
  result_user_id uuid,
  result_organization_id uuid,
  result_role membership_role,
  result_outcome text,
  result_auth_version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  source_organization_id uuid;
  current_version integer;
  source_auth_version integer;
  source_family_id uuid;
  source_user_id uuid;
  source_expires_at timestamptz;
  source_revoked_at timestamptz;
  source_replaced_by_id uuid;
  source_user_status public.user_status;
  source_membership_status public.membership_status;
  source_organization_status public.organization_status;
  selected_role public.membership_role;
BEGIN
  SELECT refresh_tokens.organization_id, refresh_tokens.family_id, refresh_tokens.user_id
    INTO source_organization_id, source_family_id, source_user_id
    FROM public.refresh_tokens
   WHERE refresh_tokens.token_hash = source_token_hash;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::public.membership_role, 'INVALID'::text, NULL::integer;
    RETURN;
  END IF;

  current_version := public.lock_user_authentication(source_user_id);
  IF current_version IS NULL THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::public.membership_role, 'INVALID'::text, NULL::integer;
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      source_organization_id::text || ':' || source_family_id::text,
      1788436807
    )
  );

  SELECT refresh_tokens.organization_id,
         refresh_tokens.family_id,
         refresh_tokens.user_id,
         refresh_tokens.auth_version,
         refresh_tokens.expires_at,
         refresh_tokens.revoked_at,
         refresh_tokens.replaced_by_id,
         users.status,
         memberships.status,
         organizations.status
    INTO source_organization_id,
         source_family_id,
         source_user_id,
         source_auth_version,
         source_expires_at,
         source_revoked_at,
         source_replaced_by_id,
         source_user_status,
         source_membership_status,
         source_organization_status
    FROM public.refresh_tokens
    JOIN public.users ON users.id = refresh_tokens.user_id
    JOIN public.memberships
      ON memberships.organization_id = refresh_tokens.organization_id
     AND memberships.user_id = refresh_tokens.user_id
    JOIN public.organizations ON organizations.id = refresh_tokens.organization_id
   WHERE refresh_tokens.token_hash = source_token_hash
   FOR UPDATE OF refresh_tokens, users, memberships, organizations;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::public.membership_role, 'INVALID'::text, NULL::integer;
    RETURN;
  END IF;

  IF source_user_id <> expected_user_id
     OR source_organization_id <> expected_organization_id THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::public.membership_role, 'SOURCE_MISMATCH'::text, NULL::integer;
    RETURN;
  END IF;

  IF source_revoked_at IS NOT NULL OR source_replaced_by_id IS NOT NULL THEN
    UPDATE public.refresh_tokens
       SET revoked_at = COALESCE(refresh_tokens.revoked_at, switched_at)
     WHERE refresh_tokens.organization_id = source_organization_id
       AND refresh_tokens.family_id = source_family_id;
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::public.membership_role, 'REUSED'::text, NULL::integer;
    RETURN;
  END IF;

  IF source_auth_version <> current_version
     OR source_expires_at <= switched_at
     OR source_user_status <> 'ACTIVE'
     OR source_membership_status <> 'ACTIVE'
     OR source_organization_status <> 'ACTIVE' THEN
    UPDATE public.refresh_tokens
       SET revoked_at = COALESCE(refresh_tokens.revoked_at, switched_at)
     WHERE refresh_tokens.organization_id = source_organization_id
       AND refresh_tokens.family_id = source_family_id;
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::public.membership_role, 'INVALID'::text, NULL::integer;
    RETURN;
  END IF;

  SELECT memberships.role
    INTO selected_role
    FROM public.memberships
    JOIN public.organizations
      ON organizations.id = memberships.organization_id
     AND organizations.status = 'ACTIVE'
    JOIN public.users
      ON users.id = memberships.user_id
     AND users.status = 'ACTIVE'
   WHERE memberships.organization_id = selected_organization_id
     AND memberships.user_id = source_user_id
     AND memberships.status = 'ACTIVE'
   FOR UPDATE OF memberships, organizations, users;

  IF selected_role IS NULL THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::public.membership_role, 'PRESERVE_SOURCE'::text, NULL::integer;
    RETURN;
  END IF;

  UPDATE public.refresh_tokens
     SET revoked_at = COALESCE(refresh_tokens.revoked_at, switched_at)
   WHERE refresh_tokens.organization_id = source_organization_id
     AND refresh_tokens.family_id = source_family_id;

  INSERT INTO public.refresh_tokens
    (id, organization_id, user_id, family_id, token_hash, expires_at, auth_version)
  VALUES
    (new_refresh_token_id, selected_organization_id, source_user_id,
     new_refresh_family_id, new_refresh_token_hash, new_refresh_expires_at, current_version);

  RETURN QUERY
    SELECT source_user_id, selected_organization_id, selected_role, 'SWITCHED'::text, current_version;
END
$$;
--> statement-breakpoint
ALTER FUNCTION switch_refresh_organization(
  text, uuid, uuid, uuid, timestamptz, uuid, uuid, text, timestamptz
) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION switch_refresh_organization(
  text, uuid, uuid, uuid, timestamptz, uuid, uuid, text, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION switch_refresh_organization(
  text, uuid, uuid, uuid, timestamptz, uuid, uuid, text, timestamptz
) TO jrc_auth;

--> statement-breakpoint
-- Tenant code may validate a user's generation without reading user credentials or other tenants.
-- No user row lock: approval/exchange preserve their original generation, so concurrent resets
-- cannot upgrade stale authority, nor introduce an authorization-row/user-row lock cycle.
CREATE FUNCTION public.current_tenant_authentication_valid(target_user_id uuid, expected_auth_version integer)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT session_user='jrc_app' AND EXISTS (
    SELECT 1 FROM public.users u
    JOIN public.memberships m ON m.user_id=u.id
    JOIN public.organizations o ON o.id=m.organization_id
    WHERE u.id=target_user_id AND u.auth_version=expected_auth_version AND u.status='ACTIVE'
      AND m.organization_id=NULLIF(current_setting('app.organization_id',true),'')::uuid
      AND m.status='ACTIVE' AND o.status='ACTIVE'
  )
$$;
ALTER FUNCTION public.current_tenant_authentication_valid(uuid,integer) OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION public.current_tenant_authentication_valid(uuid,integer) FROM PUBLIC,jrc_auth,jrc_platform;
GRANT EXECUTE ON FUNCTION public.current_tenant_authentication_valid(uuid,integer) TO jrc_app;
