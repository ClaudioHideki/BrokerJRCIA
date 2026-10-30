-- No backfill: a pre-existing unapproved connection must never acquire initial authority.
ALTER TABLE chatwoot_connection_health
 ADD COLUMN initial_identity_intent jsonb,
 ADD COLUMN initial_identity_expires_at timestamptz,
 ADD COLUMN initial_identity_pair_expires_at timestamptz,
 ADD CONSTRAINT chatwoot_initial_identity_shape CHECK (
  (initial_identity_intent IS NULL AND initial_identity_expires_at IS NULL AND initial_identity_pair_expires_at IS NULL)
  OR (initial_identity_intent IS NOT NULL AND jsonb_typeof(initial_identity_intent)='object'
    AND initial_identity_intent->>'version'='1' AND initial_identity_expires_at IS NOT NULL
    AND identity_enforced AND approved_fingerprint IS NULL
    AND (initial_identity_pair_expires_at IS NULL OR initial_identity_pair_expires_at<=initial_identity_expires_at)));

-- The health table already has forced tenant RLS, lifecycle_migrator policy,
-- a lifecycle_purge_catalogue entry, and channel/organization purge coverage.
