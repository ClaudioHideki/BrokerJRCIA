CREATE TYPE provider_kind AS ENUM ('BAILEYS', 'META');
CREATE TYPE instance_status AS ENUM (
  'PROVISIONING',
  'CREATED',
  'PROVISIONING_FAILED',
  'CONNECTING',
  'AWAITING_ACTION',
  'CONNECTED',
  'DISCONNECTING',
  'DISCONNECTED',
  'ERROR'
);
CREATE TYPE provider_operation_status AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN');
CREATE TYPE idempotency_status AS ENUM ('IN_PROGRESS', 'COMPLETED', 'FAILED');
--> statement-breakpoint
CREATE TABLE provider_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider provider_kind NOT NULL,
  name text NOT NULL,
  external_reference text,
  credential_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_accounts_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT provider_accounts_org_provider_unique UNIQUE (organization_id, provider),
  CONSTRAINT provider_accounts_org_name_unique UNIQUE (organization_id, name)
);
--> statement-breakpoint
CREATE TABLE instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  provider_account_id uuid NOT NULL,
  name text NOT NULL,
  upstream_instance_key text NOT NULL,
  external_reference text,
  status instance_status NOT NULL DEFAULT 'PROVISIONING',
  capabilities jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT instances_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT instances_org_name_unique UNIQUE (organization_id, name),
  CONSTRAINT instances_upstream_instance_key_unique UNIQUE (upstream_instance_key),
  CONSTRAINT instances_provider_account_fk FOREIGN KEY (organization_id, provider_account_id)
    REFERENCES provider_accounts(organization_id, id) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE provider_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  operation_type text NOT NULL,
  status provider_operation_status NOT NULL DEFAULT 'PENDING',
  attempt_count integer NOT NULL DEFAULT 0,
  canonical_error_code text,
  reconciliation_required boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_operations_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT provider_operations_instance_fk FOREIGN KEY (organization_id, instance_id)
    REFERENCES instances(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT provider_operations_attempt_count_nonnegative CHECK (attempt_count >= 0)
);
--> statement-breakpoint
CREATE TABLE connection_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  challenge_type text NOT NULL,
  algorithm text NOT NULL,
  ciphertext text NOT NULL,
  nonce text NOT NULL,
  auth_tag text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT connection_challenges_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT connection_challenges_instance_fk FOREIGN KEY (organization_id, instance_id)
    REFERENCES instances(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT connection_challenges_operation_fk FOREIGN KEY (organization_id, operation_id)
    REFERENCES provider_operations(organization_id, id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  route text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  operation_id uuid,
  status idempotency_status NOT NULL DEFAULT 'IN_PROGRESS',
  response_metadata jsonb NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_records_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT idempotency_records_org_route_key_unique
    UNIQUE (organization_id, route, idempotency_key),
  CONSTRAINT idempotency_records_operation_fk FOREIGN KEY (organization_id, operation_id)
    REFERENCES provider_operations(organization_id, id) ON DELETE RESTRICT
);
