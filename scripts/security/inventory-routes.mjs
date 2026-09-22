import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "@babel/parser";

const ROUTE_POLICIES = Object.freeze({
  'GET /v1/operations/health': policy('apps/api/src/http/routes/observability.ts','JWT_CURRENT_MEMBERSHIP','CURRENT_MEMBER',true,'READ_ONLY','SANITIZED_OPERATIONAL_CODES_ONLY','RLS_CURRENT_ORGANIZATION_HEALTH_AND_QUEUES'),
  'POST /hooks/{token}': policy('apps/api/src/http/routes/automation-webhooks.ts', 'OPAQUE_TOKEN_OPTIONAL_HMAC_TIMESTAMP', 'ACTIVE_BOUND_AUTOMATION',
    true, 'UNIQUE_EVENT_ID_AND_AUTOMATION_EVENT_KEY', 'TOKEN_PATH_REDACTED_NO_STORE', 'SECURITY_DEFINER_HASH_LOOKUP_THEN_RLS_ORGANIZATION'),
  ...Object.fromEntries(['GET /v1/webhooks','POST /v1/webhooks','DELETE /v1/webhooks/{id}'].map(route=>[route,policy(
    'apps/api/src/http/routes/automation-webhooks.ts','JWT_CURRENT_MEMBERSHIP','OWNER_ADMIN',true,
    route.startsWith('GET')?'READ_ONLY':'IDEMPOTENCY_OR_REVOCATION','TOKEN_RETURNED_ON_CREATE_ONLY','RLS_CURRENT_ORGANIZATION_BINDING_CREDENTIAL',
  )])),
  ...Object.fromEntries(['GET /v1/credentials','GET /v1/credentials/{id}'].map(route=>[route,policy(
    'apps/api/src/http/routes/credentials.ts','JWT_CURRENT_MEMBERSHIP','CURRENT_MEMBER',true,'READ_ONLY','METADATA_ONLY_NO_SECRET_READ','RLS_CURRENT_ORGANIZATION_CREDENTIAL',
  )])),
  ...Object.fromEntries(['POST /v1/credentials','PUT /v1/credentials/{id}','DELETE /v1/credentials/{id}','POST /v1/credentials/{id}/test'].map(route=>[route,policy(
    'apps/api/src/http/routes/credentials.ts','JWT_CURRENT_MEMBERSHIP','OWNER_ADMIN',true,'IDEMPOTENCY_OR_OPTIMISTIC_REVISION','ENVELOPE_ENCRYPTED_NO_SECRET_RESPONSE','RLS_CURRENT_ORGANIZATION_CREDENTIAL',
  )])),
  'POST /v1/automation-imports': policy('apps/api/src/http/routes/automation-imports.ts','JWT_CURRENT_MEMBERSHIP','OWNER_ADMIN',true,
    'IDEMPOTENCY_KEY_DRAFT_ONLY','ENCRYPTED_ORIGINAL_CREDENTIALS_STRIPPED','RLS_CURRENT_ORGANIZATION_IMPORT_ARTIFACT'),
  'GET /v1/automation-nodes': policy('apps/api/src/http/routes/automations.ts', 'JWT_CURRENT_MEMBERSHIP', 'CURRENT_MEMBER',
    true, 'READ_ONLY', 'NONE', 'STATIC_EXECUTABLE_NODE_CATALOG'),
  ...Object.fromEntries([
    'GET /v1/automations/status', 'GET /v1/automations', 'GET /v1/automations/{id}',
    'GET /v1/automations/migrations/legacy',
    'GET /v1/automations/{id}/versions', 'GET /v1/automations/{id}/bindings',
    'GET /v1/executions', 'GET /v1/executions/{id}',
  ].map(route => [route, policy('apps/api/src/http/routes/automations.ts', 'JWT_CURRENT_MEMBERSHIP', 'CURRENT_MEMBER',
    true, 'READ_ONLY', 'NONE', 'RLS_CURRENT_ORGANIZATION_AUTOMATION_VERSION_BINDING_EXECUTION')])) ,
  ...Object.fromEntries([
    'POST /v1/automations', 'PUT /v1/automations/{id}', 'POST /v1/automations/{id}/validate',
    'POST /v1/automations/migrations/legacy', 'POST /v1/automations/migrations/legacy/{id}/cutover',
    'POST /v1/automations/migrations/legacy/{id}/rollback',
    'POST /v1/automations/{id}/simulate', 'POST /v1/automations/{id}/publish',
    'POST /v1/automations/{id}/bindings', 'PATCH /v1/automations/{id}/bindings/{bindingId}',
    'POST /v1/executions/{id}/cancel', 'POST /v1/executions/{id}/retry', 'POST /v1/executions/{id}/resume', 'POST /v1/executions/{id}/reconcile',
  ].map(route => [route, policy('apps/api/src/http/routes/automations.ts', 'JWT_CURRENT_MEMBERSHIP', 'OWNER_ADMIN',
    true, route.includes('/simulate') || route.includes('/validate') ? 'NO_EXTERNAL_EFFECT' : 'IDEMPOTENCY_OR_OPTIMISTIC_REVISION',
    'NONE', 'RLS_CURRENT_ORGANIZATION_IMMUTABLE_VERSION_DURABLE_EXECUTION_OUTBOX')])) ,
  ...Object.fromEntries([
    'GET /v1/flows', 'GET /v1/flows/status', 'GET /v1/flows/channels', 'GET /v1/flows/library',
    'GET /v1/flows/{id}', 'GET /v1/flows/{id}/export', 'GET /v1/flows/{id}/runs',
    'GET /v1/flows/chatwoot/inboxes', 'GET /v1/flows/{id}/chatwoot/runs', 'POST /v1/flows/{id}/validate',
  ].map(route => [route, policy('apps/api/src/http/routes/flows.ts', 'JWT_CURRENT_MEMBERSHIP', 'CURRENT_MEMBER',
    true, 'READ_ONLY', 'NONE', 'RLS_CURRENT_ORGANIZATION_FEATURE_AND_APPROVED_REMOTE_DESTINATION')])),
  ...Object.fromEntries([
    'POST /v1/flows', 'PUT /v1/flows/{id}', 'POST /v1/flows/{id}/publish',
    'POST /v1/flows/{id}/bind', 'POST /v1/flows/{id}/unbind', 'POST /v1/flows/import-preview',
    'POST /v1/flows/{id}/simulate', 'POST /v1/flows/{id}/chatwoot/bind', 'POST /v1/flows/chatwoot/{id}/disable',
  ].map(route => [route, policy('apps/api/src/http/routes/flows.ts', 'JWT_CURRENT_MEMBERSHIP', 'OWNER_ADMIN',
    true, 'NO_BLIND_MUTATION_REPLAY_REVISION_OR_BINDING_RECONCILIATION', 'NONE', 'RLS_CURRENT_ORGANIZATION_FEATURE_AND_BINDING')])),
  'POST /v1/flows/chatwoot/{id}/events': policy('apps/api/src/http/routes/flows.ts', 'HMAC_TIMESTAMP_RAW_BODY', 'BOUND_AGENT_BOT',
    true, 'UNIQUE_BINDING_MESSAGE_ID', 'NONE', 'RLS_ACCOUNT_INBOX_DESTINATION_CREDENTIAL_FEATURE_REVISION'),
  'GET /v1/integrations/chatwoot/embed-apps/{id}': policy(
    'apps/api/src/http/routes/chatwoot-embed.ts', 'JWT_CURRENT_MEMBERSHIP', 'OWNER_ADMIN',
    true, 'READ_ONLY', 'NONE', 'RLS_APPROVED_CURRENT_ACCOUNT_DESTINATION',
  ),
  'POST /v1/integrations/chatwoot/embed-apps/{id}/install': policy(
    'apps/api/src/http/routes/chatwoot-embed.ts', 'JWT_CURRENT_MEMBERSHIP', 'OWNER_ADMIN',
    true, 'PERSISTED_LEASE_UNKNOWN_RECONCILE_EXACT_URL', 'NONE', 'RLS_ACCOUNT_DESTINATION_CREDENTIAL_REVISION_BEFORE_POST',
  ),
  'GET /v1/integrations/chatwoot/connections/{id}/operator-grants': policy(
    'apps/api/src/http/routes/chatwoot-control.ts', 'JWT_CURRENT_MEMBERSHIP', 'OWNER_ADMIN',
    true, 'READ_ONLY', 'NONE', 'RLS_CURRENT_ORGANIZATION_CONNECTION_MEMBERS_PROJECTION',
  ),
  'POST /v1/integrations/chatwoot/embed-apps': policy(
    'apps/api/src/http/routes/chatwoot-embed.ts', 'JWT_CURRENT_MEMBERSHIP', 'OWNER_ADMIN',
    true, 'UNIQUE_ORGANIZATION_DESTINATION_REVISION', 'NONE', 'RLS_APPROVED_CURRENT_ACCOUNT_DESTINATION',
  ),
  'GET /v1/embed/apps/{id}/policy': policy(
    'apps/api/src/http/routes/chatwoot-embed.ts', 'PUBLIC_OPAQUE_APP_ID', 'APPROVED_ORIGIN_ONLY',
    true, 'READ_ONLY', 'NONE', 'SERVER_LOOKUP_RLS_ACTIVE_APP_ACCOUNT_DESTINATION',
  ),
  'POST /v1/embed/authorizations': policy(
    'apps/api/src/http/routes/chatwoot-embed.ts', 'PUBLIC_CHALLENGE_RATE_LIMITED', 'START_WITHOUT_AUTHENTICATION_GRANT',
    true, 'NEW_REQUEST_120_SECONDS', 'PUBLIC_REQUEST_ID_ONLY', 'SERVER_LOOKUP_RLS_ACTIVE_APP_ACCOUNT_DESTINATION',
  ),
  'GET /v1/embed/authorizations/{id}': policy(
    'apps/api/src/http/routes/chatwoot-embed.ts', 'JWT_CURRENT_MEMBERSHIP', 'CURRENT_CONNECTION_GRANTS',
    true, 'READ_ONLY', 'NONE', 'RLS_PENDING_REQUEST_CURRENT_ACCOUNT_DESTINATION_GRANTS',
  ),
  ...Object.fromEntries(['approve', 'deny'].map(action => [`POST /v1/embed/authorizations/{id}/${action}`, policy(
    'apps/api/src/http/routes/chatwoot-embed.ts', 'JWT_CSRF_EXACT_ORIGIN', 'CURRENT_CONNECTION_GRANTS',
    true, 'PENDING_REQUEST_ROW_LOCK', 'NONE', 'RLS_PENDING_REQUEST_CURRENT_ACCOUNT_DESTINATION_GRANTS',
  )])),
  'POST /v1/embed/authorizations/{id}/exchange': policy(
    'apps/api/src/http/routes/chatwoot-embed.ts', 'SHA256_VERIFIER_TIMING_SAFE_RATE_LIMITED', 'EXPLICIT_APPROVAL_CURRENT_GRANTS',
    true, 'ATOMIC_SINGLE_CONSUMPTION', 'OPAQUE_FIVE_MINUTE_SESSION_NO_STORE', 'RLS_APPROVED_UNEXPIRED_REQUEST_USER_GRANTS_IDENTITY',
  ),
  'GET /v1/embed/connections/{id}/status': policy(
    'apps/api/src/http/routes/chatwoot-embed.ts', 'OPAQUE_SHORT_SESSION_HASH_LOOKUP', 'SESSION_READ_GRANT_CURRENT_MEMBERSHIP',
    true, 'READ_ONLY_PROVIDER_STATUS', 'NONE', 'RLS_SESSION_ACCOUNT_DESTINATION_CREDENTIAL_IDENTITY_REVISION',
  ),
  'POST /v1/embed/connections/{id}/pair': policy(
    'apps/api/src/http/routes/chatwoot-embed.ts', 'OPAQUE_SHORT_SESSION_HASH_LOOKUP', 'SESSION_PAIR_GRANT_APPROVED_IDENTITY',
    true, 'IDEMPOTENCY_KEY_AND_SHARED_PAIR_WINDOW', 'TEMPORARY_PAIRING_ACTION_NO_STORE', 'RLS_CURRENT_SESSION_GRANT_BEFORE_DISPATCH_AFTER_RESPONSE',
  ),
  'GET /v1/integrations/chatwoot/control/connections/{integrationId}/status': policy(
    'apps/api/src/http/routes/chatwoot-control.ts', 'JWT_OR_BOUND_CONTROL_KEY', 'CURRENT_MEMBERSHIP_OR_CHATWOOT_READ',
    true, 'READ_ONLY_PROVIDER_STATUS', 'NONE', 'RLS_ACCOUNT_REVISION_CONNECTION_GRANT',
  ),
  'POST /v1/integrations/chatwoot/control/connections/{integrationId}/pair': policy(
    'apps/api/src/http/routes/chatwoot-control.ts', 'JWT_OR_BOUND_CONTROL_KEY', 'CHATWOOT_PAIR_AND_FIRST_BINDING_ADMIN',
    true, 'IDEMPOTENCY_KEY_AND_SHARED_PAIR_WINDOW', 'NONE', 'RLS_CURRENT_CONNECTION_GRANT_AND_PROVIDER_IDENTITY',
  ),
  'POST /v1/integrations/chatwoot/control/connections/{integrationId}/disconnect': policy(
    'apps/api/src/http/routes/chatwoot-control.ts', 'JWT_OR_BOUND_CONTROL_KEY', 'CURRENT_MEMBERSHIP_OR_CHATWOOT_DISCONNECT',
    true, 'IDEMPOTENCY_KEY', 'NONE', 'RLS_CURRENT_CONNECTION_ADMIN_OR_SERVICE',
  ),
  'POST /v1/integrations/chatwoot/control/connections/{integrationId}/confirm-identity': policy(
    'apps/api/src/http/routes/chatwoot-control.ts', 'JWT_OR_BOUND_CONTROL_KEY', 'CURRENT_MEMBERSHIP_OR_CHATWOOT_MANAGE',
    true, 'IDEMPOTENCY_KEY_AND_OBSERVATION_REVISION', 'NONE', 'RLS_ADMIN_PROVIDER_OBSERVED_IDENTITY',
  ),
  'PUT /v1/integrations/chatwoot/control/connections/{integrationId}/agents': policy(
    'apps/api/src/http/routes/chatwoot-control.ts', 'JWT_OR_BOUND_CONTROL_KEY', 'CURRENT_MEMBERSHIP_OR_CHATWOOT_MANAGE',
    true, 'IDEMPOTENCY_KEY_NO_UNCERTAIN_WRITE_REPLAY', 'NONE', 'RLS_VALIDATED_ACCOUNT_AGENTS',
  ),
  'POST /v1/integrations/chatwoot/control/onboarding': policy(
    'apps/api/src/http/routes/chatwoot-control.ts', 'JWT_OR_BOUND_CONTROL_KEY', 'CURRENT_MEMBERSHIP_OR_CHATWOOT_MANAGE',
    true, 'PERSISTENT_IDEMPOTENCY_KEY_CANONICAL_HASH', 'NONE', 'RLS_ACTIVE_ORGANIZATION_ACCOUNT_AND_DESTINATION_REVISION',
  ),
  'GET /v1/integrations/chatwoot/control/onboarding/{operationId}': policy(
    'apps/api/src/http/routes/chatwoot-control.ts', 'JWT_OR_BOUND_CONTROL_KEY', 'CURRENT_MEMBERSHIP_OR_CHATWOOT_READ',
    true, 'NOT_APPLICABLE', 'NONE', 'RLS_ACTIVE_ORGANIZATION_OPERATION_AND_INTEGRATION_GRANT',
  ),
  'POST /v1/integrations/chatwoot/control/onboarding/{operationId}/recover': policy(
    'apps/api/src/http/routes/chatwoot-control.ts', 'JWT_OR_BOUND_CONTROL_KEY', 'CURRENT_MEMBERSHIP_OR_CHATWOOT_MANAGE',
    true, 'IDEMPOTENCY_KEY_CANONICAL_HASH', 'NONE', 'RLS_ACTIVE_ORGANIZATION_ACCOUNT_AND_DESTINATION_REVISION',
  ),
  'GET /v1/integrations/chatwoot/control/context': policy(
    'apps/api/src/http/routes/chatwoot-control.ts', 'JWT_OR_BOUND_CONTROL_KEY', 'CURRENT_MEMBERSHIP_OR_CHATWOOT_READ',
    true, 'NOT_APPLICABLE', 'NONE', 'RLS_ACTIVE_ORGANIZATION_ACCOUNT_AND_DESTINATION_REVISION',
  ),
  'GET /v1/integrations/chatwoot/control/resources': policy(
    'apps/api/src/http/routes/chatwoot-control.ts', 'JWT_OR_BOUND_CONTROL_KEY', 'CURRENT_MEMBERSHIP_OR_CHATWOOT_MANAGE',
    true, 'NOT_APPLICABLE', 'NONE', 'RLS_SANITIZED_AVAILABLE_QR_RESOURCES',
  ),
  'GET /v1/integrations/chatwoot/control/onboarding': policy(
    'apps/api/src/http/routes/chatwoot-control.ts', 'JWT_OR_BOUND_CONTROL_KEY', 'CURRENT_MEMBERSHIP_OR_CHATWOOT_MANAGE',
    true, 'NOT_APPLICABLE', 'NONE', 'RLS_CURRENT_ACCOUNT_REVISION_OPERATIONS',
  ),
  'POST /v1/integrations/chatwoot/control-credentials': policy(
    'apps/api/src/http/routes/chatwoot-control.ts', 'JWT_CURRENT_MEMBERSHIP', 'OWNER_ADMIN',
    true, 'IDEMPOTENCY_KEY_NO_SECRET_REPLAY', 'NONE', 'RLS_ACTIVE_ORGANIZATION_APPROVED_ACCOUNT',
  ),
  'PUT /v1/integrations/chatwoot/connections/{id}/operator-grants': policy(
    'apps/api/src/http/routes/chatwoot-control.ts', 'JWT_CURRENT_MEMBERSHIP', 'OWNER_ADMIN',
    true, 'IDEMPOTENCY_KEY_CANONICAL_HASH', 'NONE', 'RLS_ACTIVE_ORGANIZATION_CURRENT_MEMBERSHIP_AND_CONNECTION',
  ),
  'GET /v1/integrations/chatwoot/destination': policy(
    'apps/api/src/http/routes/integrations.ts', 'JWT_CURRENT_MEMBERSHIP', 'OWNER_ADMIN_OPERATOR_VIEWER',
    true, 'NOT_APPLICABLE', 'NONE', 'RLS_ORGANIZATION_ONLY',
  ),
  'PUT /v1/integrations/chatwoot/destination': policy(
    'apps/api/src/http/routes/integrations.ts', 'JWT_CURRENT_MEMBERSHIP', 'OWNER_ADMIN',
    true, 'SAME_ORIGIN_AND_MODE_NO_CHANGE', 'NONE', 'RLS_ORGANIZATION_AND_DESTINATION_NOT_IN_USE',
  ),
  'POST /v1/platform/organizations/{id}/chatwoot/destination/approve': policy(
    'apps/api/src/http/routes/platform.ts', 'PLATFORM_COOKIE_CSRF_EXACT_ORIGIN', 'SUPER_ADMIN_AUDITED',
    true, 'REVIEWED_DESTINATION_REVISION', 'NONE', 'DEDICATED_PLATFORM_ROLE_AND_DESTINATION_REVISION',
  ),
  ...Object.fromEntries(
    ["GET /v1/integrations/chatwoot", "GET /v1/integrations/chatwoot/jobs"].map(
      (route) => [
        route,
        policy(
          "apps/api/src/http/routes/integrations.ts",
          "JWT_CURRENT_MEMBERSHIP",
          "OWNER_ADMIN_OPERATOR_VIEWER",
          true,
          "NOT_APPLICABLE",
          "NONE",
          "RLS_ORGANIZATION_ONLY",
        ),
      ],
    ),
  ),
  ...Object.fromEntries(
    [
      "PUT /v1/integrations/chatwoot/account",
      "POST /v1/integrations/chatwoot/connections",
      "PATCH /v1/integrations/chatwoot/connections/{id}",
      "GET /v1/integrations/chatwoot/connections/{id}/agents",
      "POST /v1/integrations/chatwoot/connections/{id}/agents",
      "POST /v1/integrations/chatwoot/connections/{id}/reconcile",
      "POST /v1/integrations/chatwoot/connections/{id}/retry",
      "GET /v1/integrations/chatwoot/inboxes",
      "GET /v1/integrations/chatwoot/sources",
      "POST /v1/integrations/chatwoot/jobs/{id}/reconcile",
      "POST /v1/integrations/chatwoot/jobs/{id}/retry",
      "POST /v1/messaging/instances/{id}/activate",
    ].map((route) => [
      route,
      policy(
        "apps/api/src/http/routes/integrations.ts",
        "JWT_CURRENT_MEMBERSHIP",
        "OWNER_ADMIN",
        true,
        "PERSISTED_BINDING_AND_JOB_STATE",
        "NONE",
        "RLS_ORGANIZATION_ACCOUNT_INBOX_AND_CHANNEL_VERIFIED",
      ),
    ]),
  ),
  "POST /v1/integrations/chatwoot/{id}/events": policy(
    "apps/api/src/http/routes/integrations.ts",
    "CHATWOOT_HMAC_TIMESTAMP_RAW_BODY",
    "NOT_APPLICABLE_WEBHOOK",
    true,
    "UPSTREAM_EVENT_ID_DEDUPE",
    "NONE",
    "STORED_BINDING_SIGNATURE_ACCOUNT_INBOX_AND_RLS",
  ),
  "POST /v1/messaging/channels/{id}/text": policy(
    "apps/api/src/http/routes/messaging.ts",
    "JWT_WITH_ACTIVE_MEMBERSHIP",
    "OWNER_ADMIN_OPERATOR",
    true,
    "REQUIRED",
    "NONE",
    "RLS_ORGANIZATION_CHANNEL_CONVERSATION_AND_CONTACT_POLICY_BEFORE_OUTBOX",
  ),
  "GET /v1/messaging/media/{id}": policy(
    "apps/api/src/http/routes/messaging.ts",
    "JWT_WITH_ACTIVE_MEMBERSHIP",
    "OWNER_ADMIN_OPERATOR_VIEWER",
    true,
    "NOT_APPLICABLE",
    "NONE",
    "RLS_ORGANIZATION_ENCRYPTED_MEDIA_ATTACHMENT_ONLY",
  ),
  "POST /v1/messaging/messages/{id}/retry": policy(
    "apps/api/src/http/routes/messaging.ts",
    "JWT_WITH_ACTIVE_MEMBERSHIP",
    "OWNER_ADMIN",
    true,
    "SAFE_FAILURE_STATE_ONLY",
    "NONE",
    "RLS_ORGANIZATION_AND_SAFE_OUTBOX_STATE",
  ),
  ...Object.fromEntries(
    [
      "GET /v1/platform/organizations/{id}/chatwoot",
      "PUT /v1/platform/organizations/{id}/chatwoot/account",
      "POST /v1/platform/organizations/{id}/chatwoot/connections",
      "PATCH /v1/platform/organizations/{id}/chatwoot/connections/{resourceId}",
      "GET /v1/platform/organizations/{id}/chatwoot/connections/{resourceId}/agents",
      "POST /v1/platform/organizations/{id}/chatwoot/connections/{resourceId}/agents",
      "POST /v1/platform/organizations/{id}/chatwoot/connections/{resourceId}/reconcile",
      "POST /v1/platform/organizations/{id}/chatwoot/connections/{resourceId}/retry",
      "GET /v1/platform/organizations/{id}/chatwoot/inboxes",
      "GET /v1/platform/organizations/{id}/chatwoot/jobs",
      "GET /v1/platform/organizations/{id}/chatwoot/sources",
      "POST /v1/platform/organizations/{id}/chatwoot/jobs/{resourceId}/reconcile",
      "POST /v1/platform/organizations/{id}/chatwoot/jobs/{resourceId}/retry",
      "POST /v1/platform/organizations/{id}/chatwoot/provision",
      "POST /v1/platform/organizations/{id}/chatwoot/provision/reconcile",
      "POST /v1/platform/organizations/{id}/chatwoot/provision/resume",
    ].map((route) => [
      route,
      policy(
        "apps/api/src/http/routes/platform.ts",
        route.startsWith("GET")
          ? "PLATFORM_SESSION_COOKIE"
          : "PLATFORM_COOKIE_CSRF_EXACT_ORIGIN",
        route.startsWith("GET")
          ? "SUPER_ADMIN_SUPPORT_AUDITED"
          : "SUPER_ADMIN_AUDITED",
        true,
        "PERSISTED_BINDING_AND_JOB_STATE",
        "NONE",
        "DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS",
      ),
    ]),
  ),
  "GET /v1/platform/auth/config": policy(
    "apps/api/src/http/routes/platform.ts",
    "NONE",
    "NOT_APPLICABLE_PRE_AUTH",
    false,
    "NOT_APPLICABLE",
    "NONE",
    "PUBLIC_MFA_POLICY_ONLY",
  ),
  "GET /v1/instances/{id}/workspace": policy(
    "apps/api/src/http/routes/instance-workspace.ts",
    "JWT_CURRENT_MEMBERSHIP",
    "OWNER_ADMIN_OPERATOR_VIEWER",
    true,
    "NOT_APPLICABLE",
    "NONE",
    "RLS_ORGANIZATION_AND_RESOURCE_ID_BEFORE_PROVIDER",
  ),
  "PUT /v1/instances/{id}/settings": policy(
    "apps/api/src/http/routes/instance-workspace.ts",
    "JWT_CURRENT_MEMBERSHIP",
    "OWNER_ADMIN_ACTIVE_ORGANIZATION_AUDITED",
    true,
    "NOT_APPLICABLE",
    "NONE",
    "RLS_ORGANIZATION_AND_RESOURCE_ID_BEFORE_PROVIDER",
  ),
  ...Object.fromEntries(
    [
      [
        "POST /v1/platform/auth/login",
        "CONFIGURED_PASSWORD_MODE_EXACT_ORIGIN",
        "PLATFORM_IDENTITY",
      ],
      [
        "GET /v1/platform/auth/session",
        "PLATFORM_SESSION_COOKIE",
        "PLATFORM_IDENTITY",
      ],
      [
        "POST /v1/platform/auth/logout",
        "PLATFORM_COOKIE_CSRF_EXACT_ORIGIN",
        "PLATFORM_IDENTITY",
      ],
      [
        "GET /v1/platform/organizations",
        "PLATFORM_SESSION_COOKIE",
        "SUPER_ADMIN_SUPPORT_AUDITED",
      ],
      [
        "POST /v1/platform/organizations",
        "PLATFORM_COOKIE_CSRF_EXACT_ORIGIN",
        "SUPER_ADMIN_AUDITED",
      ],
      [
        "PATCH /v1/platform/organizations/{id}",
        "PLATFORM_COOKIE_CSRF_EXACT_ORIGIN",
        "SUPER_ADMIN_AUDITED",
      ],
      [
        "GET /v1/platform/organizations/{id}/memberships",
        "PLATFORM_SESSION_COOKIE",
        "SUPER_ADMIN_SUPPORT_AUDITED",
      ],
      [
        "PUT /v1/platform/organizations/{id}/memberships",
        "PLATFORM_COOKIE_CSRF_EXACT_ORIGIN",
        "SUPER_ADMIN_AUDITED",
      ],
      [
        "GET /v1/platform/organizations/{id}/monitor",
        "PLATFORM_SESSION_COOKIE",
        "SUPER_ADMIN_SUPPORT_AUDITED",
      ],
      [
        "POST /v1/platform/organizations/{id}/support-acknowledgment",
        "PLATFORM_COOKIE_CSRF_EXACT_ORIGIN",
        "SUPER_ADMIN_SUPPORT_AUDITED",
      ],
    ].map(([route, auth, role]) => [
      route,
      policy(
        "apps/api/src/http/routes/platform.ts",
        auth,
        role,
        true,
        "NOT_APPLICABLE",
        "NONE",
        "DEDICATED_PLATFORM_ROLE_EXPLICIT_RLS_NO_CONTENT",
      ),
    ]),
  ),
  ...Object.fromEntries(
    [
      "GET /v1/meta-onboarding",
      "POST /v1/meta-onboarding/start",
      "POST /v1/meta-onboarding/complete",
      "POST /v1/meta-onboarding/{id}/revoke",
      "POST /v1/meta-onboarding/{id}/refresh",
      "POST /v1/meta-onboarding/{id}/register",
    ].map((route) => [
      route,
      policy(
        "apps/api/src/http/routes/meta-onboarding.ts",
        "JWT_CURRENT_MEMBERSHIP",
        "OWNER_ADMIN",
        true,
        route.endsWith("/complete")
          ? "ONE_TIME_TENANT_USER_STATE"
          : "NOT_APPLICABLE",
        "NONE",
        "RLS_ORGANIZATION_ASSETS_VERIFIED_BY_META",
      ),
    ]),
  ),
  "GET /v1/organization/operations": policy(
    "apps/api/src/http/routes/tenant-operations.ts",
    "JWT_CURRENT_MEMBERSHIP",
    "OWNER_ADMIN_OPERATOR_VIEWER",
    true,
    "NOT_APPLICABLE",
    "NONE",
    "RLS_ORGANIZATION_LIMITS",
  ),
  "GET /v1/organization/overview": policy(
    "apps/api/src/http/routes/tenant-operations.ts",
    "JWT_CURRENT_MEMBERSHIP",
    "OWNER_ADMIN_OPERATOR_VIEWER",
    true,
    "NOT_APPLICABLE",
    "NONE",
    "RLS_ORGANIZATION_AGGREGATES_NO_CONTENT",
  ),
  "POST /v1/auth/login": policy(
    "apps/api/src/http/routes/auth.ts",
    "NONE",
    "NOT_APPLICABLE_PRE_AUTH",
    false,
    "NOT_APPLICABLE",
    "NOT_APPLICABLE",
    "NOT_APPLICABLE_PRE_AUTH",
  ),
  "POST /v1/auth/select-organization": policy(
    "apps/api/src/http/routes/auth.ts",
    "SELECTION_TOKEN",
    "NOT_APPLICABLE_PRE_AUTH",
    false,
    "NOT_APPLICABLE",
    "NOT_APPLICABLE",
    "SELECTION_TOKEN_MEMBERSHIP_REVALIDATED",
  ),
  "POST /v1/auth/refresh": policy(
    "apps/api/src/http/routes/auth.ts",
    "REFRESH_TOKEN",
    "NOT_APPLICABLE_PRE_AUTH",
    false,
    "NOT_APPLICABLE",
    "NOT_APPLICABLE",
    "REFRESH_TOKEN_TENANT_BOUND",
  ),
  "POST /v1/auth/logout": policy(
    "apps/api/src/http/routes/auth.ts",
    "REFRESH_TOKEN",
    "NOT_APPLICABLE_PRE_AUTH",
    false,
    "NOT_APPLICABLE",
    "NOT_APPLICABLE",
    "REFRESH_TOKEN_FAMILY_BOUND",
  ),
  "POST /v1/console/auth/select-organization": policy(
    "apps/api/src/http/routes/console-auth.ts",
    "SELECTION_TOKEN_AND_EXACT_ORIGIN",
    "NOT_APPLICABLE_PRE_AUTH",
    false,
    "NOT_APPLICABLE",
    "NOT_APPLICABLE",
    "SELECTION_TOKEN_MEMBERSHIP_REVALIDATED",
  ),
  "POST /v1/console/auth/restore": policy(
    "apps/api/src/http/routes/console-auth.ts",
    "REFRESH_COOKIE_CSRF_AND_EXACT_ORIGIN",
    "NOT_APPLICABLE_PRE_AUTH",
    false,
    "NOT_APPLICABLE",
    "NOT_APPLICABLE",
    "REFRESH_TOKEN_TENANT_BOUND",
  ),
  "POST /v1/console/auth/switch-organization": policy(
    "apps/api/src/http/routes/console-auth.ts",
    "JWT_REFRESH_COOKIE_CSRF_AND_EXACT_ORIGIN",
    "ACTIVE_MEMBERSHIP",
    false,
    "NOT_APPLICABLE",
    "NOT_APPLICABLE",
    "SOURCE_AND_TARGET_MEMBERSHIPS_REVALIDATED",
  ),
  "POST /v1/console/auth/logout": policy(
    "apps/api/src/http/routes/console-auth.ts",
    "EXACT_ORIGIN_WITH_OPTIONAL_REFRESH_COOKIE_CSRF",
    "NOT_APPLICABLE_PRE_AUTH",
    false,
    "NOT_APPLICABLE",
    "NOT_APPLICABLE",
    "REFRESH_TOKEN_FAMILY_WHEN_PRESENT",
  ),
  "POST /v1/api-keys": policy(
    "apps/api/src/http/routes/api-keys.ts",
    "JWT_OR_JRC_API_KEY",
    "api_keys:manage",
    true,
    "NOT_APPLICABLE",
    "NOT_APPLICABLE",
    "ACTIVE_ORGANIZATION_CONTEXT",
  ),
  "GET /v1/api-keys": policy(
    "apps/api/src/http/routes/api-keys.ts",
    "JWT_OR_JRC_API_KEY",
    "api_keys:manage",
    true,
    "NOT_APPLICABLE",
    "NOT_APPLICABLE",
    "RLS_ORGANIZATION_FILTER",
  ),
  "DELETE /v1/api-keys/{id}": policy(
    "apps/api/src/http/routes/api-keys.ts",
    "JWT_OR_JRC_API_KEY",
    "api_keys:manage",
    true,
    "NOT_APPLICABLE",
    "NOT_APPLICABLE",
    "RLS_ORGANIZATION_AND_RESOURCE_ID",
  ),
  ...Object.fromEntries(
    ["GET /v1/channels", "GET /v1/channels/{id}", "GET /v1/channels/{id}/automation"].map((route) => [
      route,
      policy(
        "apps/api/src/http/routes/channels.ts",
        "JWT_CURRENT_MEMBERSHIP",
        "OWNER_ADMIN_OPERATOR_VIEWER",
        true,
        "READ_ONLY",
        "NONE",
        "RLS_ORGANIZATION_AND_CANONICAL_CHANNEL_ID",
      ),
    ]),
  ),
  "GET /v1/channels/{id}/status": policy(
    "apps/api/src/http/routes/channels.ts",
    "JWT_CURRENT_MEMBERSHIP",
    "OWNER_ADMIN_OPERATOR_VIEWER",
    true,
    "READ_PROVIDER_STATUS",
    "NONE",
    "RLS_ORGANIZATION_AND_CANONICAL_CHANNEL_ID_BEFORE_PROVIDER",
  ),
  "PATCH /v1/channels/{id}": policy(
    "apps/api/src/http/routes/channels.ts",
    "JWT_CURRENT_MEMBERSHIP",
    "OWNER_ADMIN_OPERATOR",
    true,
    "ATOMIC_CHANNEL_IDENTITY_UPDATE",
    "NONE",
    "RLS_ORGANIZATION_AND_CANONICAL_CHANNEL_ID",
  ),
  "POST /v1/channels": policy(
    "apps/api/src/http/routes/channels.ts",
    "JWT_CURRENT_MEMBERSHIP",
    "OWNER_ADMIN_OPERATOR",
    true,
    "IDEMPOTENCY_KEY_DELEGATED_TO_PROVIDER_WORKFLOW",
    "PAIRING_RESPONSE_EPHEMERAL_NO_STORE",
    "RLS_ORGANIZATION_PROVIDER_ACCOUNT_AND_CHANNEL",
  ),
  "POST /v1/channels/{id}/pair": policy(
    "apps/api/src/http/routes/channels.ts",
    "JWT_CURRENT_MEMBERSHIP",
    "OWNER_ADMIN_OPERATOR",
    true,
    "IDEMPOTENCY_KEY_AND_SHARED_PAIR_WINDOW",
    "PAIRING_RESPONSE_EPHEMERAL_NO_STORE",
    "RLS_ORGANIZATION_AND_CANONICAL_CHANNEL_ID_BEFORE_PROVIDER",
  ),
  ...Object.fromEntries(
    ["POST /v1/channels/{id}/reconnect", "POST /v1/channels/{id}/disconnect"].map((route) => [
      route,
      policy(
        "apps/api/src/http/routes/channels.ts",
        "JWT_CURRENT_MEMBERSHIP",
        "OWNER_ADMIN_OPERATOR",
        true,
        "IDEMPOTENCY_KEY_DELEGATED_TO_PROVIDER_WORKFLOW",
        "PAIRING_RESPONSE_EPHEMERAL_NO_STORE",
        "RLS_ORGANIZATION_AND_CANONICAL_CHANNEL_ID_BEFORE_PROVIDER",
      ),
    ]),
  ),
  "PUT /v1/channels/{id}/automation": policy(
    "apps/api/src/http/routes/channels.ts",
    "JWT_CURRENT_MEMBERSHIP",
    "OWNER_ADMIN_OPERATOR",
    true,
    "ATOMIC_REPLACE_PUBLISHED_AUTOMATION_BINDING",
    "NONE",
    "RLS_ORGANIZATION_CHANNEL_AUTOMATION_AND_VERSION",
  ),
  "PUT /v1/channels/{id}/destination": policy(
    "apps/api/src/http/routes/channels.ts",
    "JWT_CURRENT_MEMBERSHIP",
    "OWNER_ADMIN_OPERATOR",
    true,
    "DESTINATION_RECONCILIATION",
    "NONE",
    "RLS_ORGANIZATION_CHANNEL_ACCOUNT_AND_INBOX",
  ),
  "POST /v1/instances": policy(
    "apps/api/src/http/routes/instances.ts",
    "JWT_OR_JRC_API_KEY",
    "instances:connect",
    true,
    "REQUIRED",
    "NONE",
    "RLS_PROVIDER_ACCOUNT_AND_ORGANIZATION",
  ),
  "GET /v1/instances": policy(
    "apps/api/src/http/routes/instances.ts",
    "JWT_OR_JRC_API_KEY",
    "instances:read",
    true,
    "NOT_APPLICABLE",
    "NONE",
    "RLS_ORGANIZATION_FILTER_AND_TENANT_CURSOR",
  ),
  "GET /v1/instances/{id}": policy(
    "apps/api/src/http/routes/instances.ts",
    "JWT_OR_JRC_API_KEY",
    "instances:read",
    true,
    "NOT_APPLICABLE",
    "NONE",
    "RLS_ORGANIZATION_AND_RESOURCE_ID",
  ),
  "POST /v1/instances/{id}/connect": policy(
    "apps/api/src/http/routes/instances.ts",
    "JWT_OR_JRC_API_KEY",
    "instances:connect",
    true,
    "REQUIRED",
    "EPHEMERAL_FIRST_RESPONSE_ONLY",
    "RLS_ORGANIZATION_AND_RESOURCE_ID_BEFORE_PROVIDER",
  ),
  "GET /v1/instances/{id}/status": policy(
    "apps/api/src/http/routes/instances.ts",
    "JWT_OR_JRC_API_KEY",
    "instances:read",
    true,
    "NOT_APPLICABLE",
    "NONE",
    "RLS_ORGANIZATION_AND_RESOURCE_ID_BEFORE_PROVIDER",
  ),
  "POST /v1/instances/{id}/disconnect": policy(
    "apps/api/src/http/routes/instances.ts",
    "JWT_OR_JRC_API_KEY",
    "instances:connect",
    true,
    "REQUIRED",
    "NONE",
    "RLS_ORGANIZATION_AND_RESOURCE_ID_BEFORE_PROVIDER",
  ),
  "GET /v1/provider-accounts": policy(
    "apps/api/src/http/routes/provider-accounts.ts",
    "JWT_OR_JRC_API_KEY",
    "instances:read",
    true,
    "NOT_APPLICABLE",
    "NONE",
    "RLS_ORGANIZATION_FILTER_AND_TENANT_CURSOR",
  ),
  "GET /v1/messaging/channels": policy(
    "apps/api/src/http/routes/messaging.ts",
    "JWT_WITH_ACTIVE_MEMBERSHIP",
    "OWNER_ADMIN_OPERATOR_VIEWER",
    true,
    "NOT_APPLICABLE",
    "NONE",
    "RLS_ORGANIZATION_FILTER",
  ),
  "GET /v1/messaging/channels/{id}/templates": policy(
    "apps/api/src/http/routes/messaging.ts",
    "JWT_WITH_ACTIVE_MEMBERSHIP",
    "OWNER_ADMIN_OPERATOR_VIEWER",
    true,
    "NOT_APPLICABLE",
    "NONE",
    "RLS_ORGANIZATION_AND_CHANNEL_ID_BEFORE_META",
  ),
  "GET /v1/messaging/channels/{id}/conversations": policy(
    "apps/api/src/http/routes/messaging.ts",
    "JWT_WITH_ACTIVE_MEMBERSHIP",
    "OWNER_ADMIN_OPERATOR_VIEWER",
    true,
    "NOT_APPLICABLE",
    "NONE",
    "RLS_ORGANIZATION_AND_CHANNEL_ID",
  ),
  "GET /v1/messaging/conversations/{id}/messages": policy(
    "apps/api/src/http/routes/messaging.ts",
    "JWT_WITH_ACTIVE_MEMBERSHIP",
    "OWNER_ADMIN_OPERATOR_VIEWER",
    true,
    "NOT_APPLICABLE",
    "NONE",
    "RLS_ORGANIZATION_AND_CONVERSATION_ID",
  ),
  "POST /v1/messaging/channels/{id}/messages": policy(
    "apps/api/src/http/routes/messaging.ts",
    "JWT_WITH_ACTIVE_MEMBERSHIP",
    "OWNER_ADMIN_OPERATOR",
    true,
    "REQUIRED",
    "NONE",
    "RLS_ORGANIZATION_CHANNEL_CONVERSATION_AND_CONTACT_POLICY_BEFORE_OUTBOX",
  ),
  "PATCH /v1/messaging/channels/{id}/automation": policy(
    "apps/api/src/http/routes/messaging.ts",
    "JWT_WITH_ACTIVE_MEMBERSHIP",
    "OWNER_ADMIN",
    true,
    "NOT_APPLICABLE",
    "NONE",
    "RLS_ORGANIZATION_CHANNEL_AND_SERVER_ORIGIN_ALLOWLIST",
  ),
  "PATCH /v1/messaging/conversations/{id}/mode": policy(
    "apps/api/src/http/routes/messaging.ts",
    "JWT_WITH_ACTIVE_MEMBERSHIP",
    "OWNER_ADMIN_OPERATOR",
    true,
    "NOT_APPLICABLE",
    "NONE",
    "RLS_ORGANIZATION_AND_CONVERSATION_ID",
  ),
  "GET /v1/webhooks/meta": policy(
    "apps/api/src/http/routes/meta-webhooks.ts",
    "META_VERIFY_TOKEN_QUERY",
    "NOT_APPLICABLE_WEBHOOK",
    false,
    "NOT_APPLICABLE",
    "VERIFIED_META_CHALLENGE_PLAINTEXT",
    "SERVER_VERIFY_TOKEN_MATCH",
  ),
  "POST /v1/webhooks/meta": policy(
    "apps/api/src/http/routes/meta-webhooks.ts",
    "META_HMAC_SHA256_RAW_BODY",
    "NOT_APPLICABLE_WEBHOOK",
    true,
    "UPSTREAM_EVENT_ID_DEDUPE",
    "NONE",
    "SERVER_ASSET_BINDING_AND_RLS_CHANNEL_MATCH",
  ),
});

function policy(
  handlerFile,
  authentication,
  permission,
  tenantRls,
  idempotency,
  challengeExposure,
  ownershipCheck,
) {
  return {
    handlerFile,
    authentication,
    permission,
    tenantRls,
    idempotency,
    challengeExposure,
    ownershipCheck,
  };
}

function sourcePath(path) {
  return path.replaceAll(/\{([^}]+)\}/gu, ":$1");
}

export function handlerLine(source, method, path) {
  const target = sourcePath(
    path.startsWith("/v1/platform/") ? path.slice("/v1/platform".length) : path,
  );
  const file = parse(source, { sourceType: "module", plugins: ["typescript"] });
  let line = null;
  function constantString(node, bindings) {
    if (node?.type === "StringLiteral") return node.value;
    if (node?.type === "Identifier") return bindings.get(node.name);
    if (node?.type === "BinaryExpression" && node.operator === "+") {
      const left = constantString(node.left, bindings);
      const right = constantString(node.right, bindings);
      if (typeof left === "string" && typeof right === "string") return left + right;
    }
    return undefined;
  }
  function visit(node, inherited = new Map()) {
    if (!node || typeof node !== "object") return;
    const bindings = ["Program", "BlockStatement"].includes(node.type)
      ? new Map(inherited) : inherited;
    if (node.type === "VariableDeclaration" && node.kind === "const") {
      for (const declaration of node.declarations) {
        if (declaration.id.type === "Identifier") {
          bindings.set(declaration.id.name, constantString(declaration.init, bindings));
        }
      }
    }
    if (
      node.type === "CallExpression" &&
      node.callee?.type === "MemberExpression" &&
      node.callee.property?.name === method.toLowerCase() &&
      constantString(node.arguments[0], bindings) === target
    ) {
      line = node.callee.property.loc.start.line;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach((child) => visit(child, bindings));
      else if (
        value &&
        typeof value === "object" &&
        typeof value.type === "string"
      )
        visit(value, bindings);
    }
  }
  visit(file);
  if (line === null)
    throw new Error(`Route handler not found: ${method} ${path}`);
  return line;
}

function resolveLocalReference(openapi, candidate, label, seen = new Set()) {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    typeof candidate.$ref !== "string"
  )
    return candidate;
  if (!candidate.$ref.startsWith("#/"))
    throw new Error(`${label} uses an unsupported external reference`);
  if (seen.has(candidate.$ref))
    throw new Error(`${label} contains a circular reference`);
  const segments = candidate.$ref
    .slice(2)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  let resolved = openapi;
  for (const segment of segments) {
    if (
      resolved === null ||
      typeof resolved !== "object" ||
      !Object.hasOwn(resolved, segment)
    ) {
      throw new Error(`${label} reference not found: ${candidate.$ref}`);
    }
    resolved = resolved[segment];
  }
  return resolveLocalReference(
    openapi,
    resolved,
    label,
    new Set([...seen, candidate.$ref]),
  );
}

function requestSchemas(openapi, operation) {
  const values = (operation.parameters ?? []).map((candidate, index) => {
    const parameter = resolveLocalReference(
      openapi,
      candidate,
      `parameters[${index}]`,
    );
    return `${parameter.in}:${parameter.name}`;
  });
  const requestBody = resolveLocalReference(
    openapi,
    operation.requestBody,
    "requestBody",
  );
  for (const contentType of Object.keys(requestBody?.content ?? {})) {
    values.push(`body:${contentType}`);
  }
  return values.sort();
}

function responseSchemas(operation) {
  return Object.entries(operation.responses ?? {})
    .flatMap(([status, response]) => {
      const contentTypes = Object.keys(response.content ?? {});
      return contentTypes.length === 0
        ? [`${status}:NO_BODY`]
        : contentTypes.map((type) => `${status}:${type}`);
    })
    .sort();
}

function cacheHeaders(operation) {
  const values = new Set();
  for (const response of Object.values(operation.responses ?? {})) {
    for (const header of Object.keys(response.headers ?? {}))
      values.add(header);
  }
  return [...values].sort();
}

export async function buildRouteInventory({
  rootDirectory = process.cwd(),
  openapi,
}) {
  const sourceCache = new Map();
  const inventory = [];
  for (const [path, pathItem] of Object.entries(openapi.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      const normalizedMethod = method.toUpperCase();
      const key = `${normalizedMethod} ${path}`;
      const routePolicy = ROUTE_POLICIES[key];
      if (!routePolicy)
        throw new Error(`Missing explicit route policy: ${key}`);
      let source = sourceCache.get(routePolicy.handlerFile);
      if (source === undefined) {
        source = await readFile(
          resolve(rootDirectory, routePolicy.handlerFile),
          "utf8",
        );
        sourceCache.set(routePolicy.handlerFile, source);
      }
      inventory.push({
        method: normalizedMethod,
        path,
        authentication: routePolicy.authentication,
        permission: routePolicy.permission,
        tenantRls: routePolicy.tenantRls,
        idempotency: routePolicy.idempotency,
        requestSchemas: requestSchemas(openapi, operation),
        responseSchemas: responseSchemas(operation),
        cacheHeaders: cacheHeaders(operation),
        challengeExposure: routePolicy.challengeExposure,
        handlerFile: routePolicy.handlerFile,
        handlerLine: handlerLine(source, normalizedMethod, path),
        ownershipCheck: routePolicy.ownershipCheck,
      });
    }
  }
  if (inventory.length !== Object.keys(ROUTE_POLICIES).length) {
    throw new Error("OpenAPI route count differs from explicit route policies");
  }
  return inventory.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.method.localeCompare(right.method),
  );
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  const rootDirectory = process.argv[2] ?? process.cwd();
  const openapi = JSON.parse(
    await readFile(resolve(rootDirectory, "docs/api/openapi.json"), "utf8"),
  );
  const inventory = await buildRouteInventory({ rootDirectory, openapi });
  process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
}
