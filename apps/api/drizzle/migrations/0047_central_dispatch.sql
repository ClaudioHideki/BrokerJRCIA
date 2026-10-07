-- Reuse the receipt/echo ledger without creating a MIRROR_MESSAGE job for central sends.
ALTER TABLE chatwoot_mirror_attempts
 ALTER COLUMN job_id DROP NOT NULL,
 DROP CONSTRAINT chatwoot_mirror_attempts_state_check,
 ADD CONSTRAINT chatwoot_mirror_attempts_state_check CHECK(state IN ('RESERVED','DISPATCHED','CONFIRMED','UNKNOWN','REJECTED')),
 ADD COLUMN transport text NOT NULL DEFAULT 'BROKER_TRANSPORT',
 ADD COLUMN origin text,
 ADD COLUMN credential_version integer,
 ADD COLUMN owner_revision integer,
 ADD COLUMN control_revision integer,
 ADD COLUMN execution_id uuid,
 ADD COLUMN automation_id uuid,
 ADD COLUMN version integer,
 ADD COLUMN ack_message_id bigint CHECK(ack_message_id BETWEEN 1 AND 9007199254740991),
 ADD COLUMN dispatch_proof text,
 ADD COLUMN sender_id bigint CHECK(sender_id BETWEEN 1 AND 9007199254740991),
 ADD COLUMN lease_expires_at timestamptz,
 ADD COLUMN available_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN reconcile_attempts integer NOT NULL DEFAULT 0 CHECK(reconcile_attempts>=0),
 ADD COLUMN error_code text,
 ADD CONSTRAINT central_dispatch_identity CHECK(
  (transport='BROKER_TRANSPORT' AND job_id IS NOT NULL AND state<>'RESERVED') OR
  (transport='CENTRAL_TRANSPORT' AND job_id IS NULL AND origin IS NOT NULL AND origin ~ '^https://[^/?#@]+$'
   AND credential_version IS NOT NULL AND credential_version>0 AND owner_revision IS NOT NULL AND owner_revision>0
   AND control_revision IS NOT NULL AND control_revision>0 AND execution_id IS NOT NULL AND automation_id IS NOT NULL AND version IS NOT NULL AND version>0
   AND dispatch_proof IS NOT NULL AND dispatch_proof ~ '^[A-Za-z0-9_-]{43}$'
   AND (state IN ('RESERVED','REJECTED') OR sender_id IS NOT NULL))),
 ADD CONSTRAINT central_dispatch_execution_fk FOREIGN KEY(organization_id,channel_id,conversation_id,execution_id,automation_id,version)
  REFERENCES automation_executions(organization_id,channel_id,conversation_id,id,automation_id,version);
CREATE UNIQUE INDEX central_dispatch_one_message ON chatwoot_mirror_attempts(organization_id,message_id) WHERE transport='CENTRAL_TRANSPORT';
CREATE INDEX central_dispatch_pending ON chatwoot_mirror_attempts(organization_id,available_at,created_at,id)
 WHERE transport='CENTRAL_TRANSPORT' AND state IN ('RESERVED','DISPATCHED','UNKNOWN');
ALTER TABLE central_runtime_events
 DROP CONSTRAINT central_runtime_events_disposition_check,
 ADD CONSTRAINT central_runtime_events_disposition_check CHECK(disposition IN ('RECEIVED','OBSERVED','ROUTED','IGNORED','FAILED')),
 ADD COLUMN available_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 ADD COLUMN error_code text,
 ADD COLUMN lease_token uuid,
 ADD COLUMN lease_expires_at timestamptz;
