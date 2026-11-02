-- Additive source clock, isolated from message delivery state and public instance schemas.
ALTER TABLE instances ADD COLUMN connection_observed_at timestamptz;
ALTER TABLE instances ADD COLUMN connection_binding_fingerprint text
  CHECK (connection_binding_fingerprint IS NULL OR connection_binding_fingerprint ~ '^[a-f0-9]{64}$');
ALTER TABLE instances ADD CONSTRAINT instances_connection_clock_scope
  CHECK (connection_observed_at IS NULL OR connection_binding_fingerprint IS NOT NULL);
