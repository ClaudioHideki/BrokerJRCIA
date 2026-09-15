CREATE POLICY refresh_tokens_migrator_auth_read ON refresh_tokens
  FOR SELECT TO jrc_migrator
  USING (true);
--> statement-breakpoint
CREATE POLICY refresh_tokens_migrator_auth_update ON refresh_tokens
  FOR UPDATE TO jrc_migrator
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint
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
  result_outcome text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  source_organization_id uuid;
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
  SELECT refresh_tokens.organization_id, refresh_tokens.family_id
    INTO source_organization_id, source_family_id
    FROM public.refresh_tokens
   WHERE refresh_tokens.token_hash = source_token_hash;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::public.membership_role, 'INVALID'::text;
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
         refresh_tokens.expires_at,
         refresh_tokens.revoked_at,
         refresh_tokens.replaced_by_id,
         users.status,
         memberships.status,
         organizations.status
    INTO source_organization_id,
         source_family_id,
         source_user_id,
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
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::public.membership_role, 'INVALID'::text;
    RETURN;
  END IF;

  IF source_user_id <> expected_user_id
     OR source_organization_id <> expected_organization_id THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::public.membership_role, 'SOURCE_MISMATCH'::text;
    RETURN;
  END IF;

  IF source_revoked_at IS NOT NULL OR source_replaced_by_id IS NOT NULL THEN
    UPDATE public.refresh_tokens
       SET revoked_at = COALESCE(refresh_tokens.revoked_at, switched_at)
     WHERE refresh_tokens.organization_id = source_organization_id
       AND refresh_tokens.family_id = source_family_id;
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::public.membership_role, 'REUSED'::text;
    RETURN;
  END IF;

  IF source_expires_at <= switched_at
     OR source_user_status <> 'ACTIVE'
     OR source_membership_status <> 'ACTIVE'
     OR source_organization_status <> 'ACTIVE' THEN
    UPDATE public.refresh_tokens
       SET revoked_at = COALESCE(refresh_tokens.revoked_at, switched_at)
     WHERE refresh_tokens.organization_id = source_organization_id
       AND refresh_tokens.family_id = source_family_id;
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::public.membership_role, 'INVALID'::text;
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
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::public.membership_role, 'PRESERVE_SOURCE'::text;
    RETURN;
  END IF;

  UPDATE public.refresh_tokens
     SET revoked_at = COALESCE(refresh_tokens.revoked_at, switched_at)
   WHERE refresh_tokens.organization_id = source_organization_id
     AND refresh_tokens.family_id = source_family_id;

  INSERT INTO public.refresh_tokens
    (id, organization_id, user_id, family_id, token_hash, expires_at)
  VALUES
    (new_refresh_token_id, selected_organization_id, source_user_id,
     new_refresh_family_id, new_refresh_token_hash, new_refresh_expires_at);

  RETURN QUERY
    SELECT source_user_id, selected_organization_id, selected_role, 'SWITCHED'::text;
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
