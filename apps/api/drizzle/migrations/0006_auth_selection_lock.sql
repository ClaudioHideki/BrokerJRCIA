CREATE POLICY refresh_tokens_migrator_auth_insert ON refresh_tokens
  FOR INSERT TO jrc_migrator
  WITH CHECK (
    EXISTS (
      SELECT 1
        FROM memberships
       WHERE memberships.organization_id = refresh_tokens.organization_id
         AND memberships.user_id = refresh_tokens.user_id
         AND memberships.status = 'ACTIVE'
    )
  );
--> statement-breakpoint
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
  result_outcome text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  authenticated_user_id uuid;
  authenticated_role membership_role;
BEGIN
  UPDATE public.login_sessions
     SET consumed_at = selected_at
   WHERE token_hash = selected_token_hash
     AND consumed_at IS NULL
     AND expires_at > selected_at
  RETURNING login_sessions.user_id INTO authenticated_user_id;

  IF authenticated_user_id IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.login_sessions
       WHERE token_hash = selected_token_hash AND consumed_at IS NOT NULL
    ) THEN
      RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::membership_role, 'REUSED'::text;
    ELSE
      RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::membership_role, 'INVALID'::text;
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
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::membership_role, 'INVALID'::text;
    RETURN;
  END IF;

  INSERT INTO public.refresh_tokens
    (id, organization_id, user_id, family_id, token_hash, expires_at)
  VALUES
    (new_refresh_token_id, selected_organization_id, authenticated_user_id,
     new_refresh_family_id, new_refresh_token_hash, new_refresh_expires_at);

  RETURN QUERY SELECT authenticated_user_id, selected_organization_id, authenticated_role, 'SELECTED'::text;
END
$$;
--> statement-breakpoint
ALTER FUNCTION consume_login_selection(text, uuid, timestamptz, uuid, uuid, text, timestamptz)
  OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION consume_login_selection(text, uuid, timestamptz, uuid, uuid, text, timestamptz)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION consume_login_selection(text, uuid, timestamptz, uuid, uuid, text, timestamptz)
  TO jrc_auth;
