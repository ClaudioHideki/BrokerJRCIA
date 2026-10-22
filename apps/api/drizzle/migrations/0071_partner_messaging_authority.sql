-- Keep the authorizing identity even if a key is deleted: absence must deny
-- dispatch, never convert a partner send into an unscoped operator send.
ALTER TABLE messaging_messages ADD COLUMN authorizing_api_key_id uuid;

-- Older workers do not know this column, but must mark a message SENDING before
-- provider I/O. Keep revocation enforcement at that shared database boundary so
-- mixed-version deployments and application rollback cannot bypass authority.
-- Deliberately recheck SENDING -> SENDING too: it is another dispatch boundary.
CREATE FUNCTION partner_require_message_authority() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.state<>'SENDING' OR NEW.authorizing_api_key_id IS NULL THEN RETURN NEW; END IF;
 PERFORM partner_key.id FROM public.api_keys partner_key
  WHERE partner_key.organization_id=NEW.organization_id AND partner_key.id=NEW.authorizing_api_key_id
   AND partner_key.revoked_at IS NULL
   AND (partner_key.expires_at IS NULL OR partner_key.expires_at>clock_timestamp())
   AND partner_key.scopes @> ARRAY['messaging:send']::text[] FOR SHARE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'PARTNER_CREDENTIAL_REVOKED' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION partner_require_message_authority() OWNER TO jrc_migrator;
REVOKE ALL ON FUNCTION partner_require_message_authority() FROM PUBLIC,jrc_app,jrc_auth,jrc_platform,jrc_lifecycle;
CREATE TRIGGER partner_message_authority BEFORE UPDATE OF state ON messaging_messages
 FOR EACH ROW EXECUTE FUNCTION partner_require_message_authority();
