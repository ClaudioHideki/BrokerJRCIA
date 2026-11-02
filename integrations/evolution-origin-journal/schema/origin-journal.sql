BEGIN;
SET LOCAL synchronous_commit = on;
CREATE SCHEMA IF NOT EXISTS jrc_evolution_origin;
CREATE TABLE IF NOT EXISTS jrc_evolution_origin.events (
  id uuid PRIMARY KEY,
  source_sequence bigserial UNIQUE NOT NULL,
  scope_key char(64) NOT NULL,
  event_key char(64) NOT NULL,
  binding_fingerprint char(64) NOT NULL,
  body_hash char(64) NOT NULL,
  payload_ciphertext bytea NOT NULL,
  payload_iv bytea NOT NULL CHECK (octet_length(payload_iv)=12),
  payload_tag bytea NOT NULL CHECK (octet_length(payload_tag)=16),
  key_version integer NOT NULL CHECK (key_version=1),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','CLAIMED','DELIVERED','BLOCKED')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count>=0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  lease_until timestamptz,
  last_category text,
  last_http_status integer CHECK (last_http_status BETWEEN 100 AND 599),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(scope_key,event_key),
  CHECK ((state='CLAIMED')=(lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS origin_events_pending ON jrc_evolution_origin.events(scope_key,source_sequence) WHERE state<>'DELIVERED';
CREATE TABLE IF NOT EXISTS jrc_evolution_origin.attempts (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES jrc_evolution_origin.events(id),
  number integer NOT NULL CHECK (number>0),
  lease_token uuid NOT NULL UNIQUE,
  outcome text NOT NULL DEFAULT 'CLAIMED' CHECK (outcome IN ('CLAIMED','DELIVERED','RETRY','BLOCKED','LEASE_EXPIRED')),
  category text,
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  duration_ms integer CHECK (duration_ms>=0),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  UNIQUE(event_id,number)
);
COMMIT;
