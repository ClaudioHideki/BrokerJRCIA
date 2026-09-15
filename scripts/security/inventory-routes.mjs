import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "@babel/parser";

const ROUTE_POLICIES = Object.freeze({
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
