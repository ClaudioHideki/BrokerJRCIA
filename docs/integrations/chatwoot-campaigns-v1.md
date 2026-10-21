# Chatwoot campaign transport v1

This additive contract supports the JRC campaign engine without introducing another provider send path or changing attendance ownership.

`GET /v1/integrations/chatwoot/control/connections/:integrationId/campaign-transport` returns the scoped binding, protocol `chatwoot-campaigns/v1`, confirmed number suffix, identity revision and readiness/reason. It uses existing cached identity/callback evidence; it never refreshes a provider, changes an executor or grants permission. JRC uses the existing status preflight before creating an outgoing intent.

`GET /v1/integrations/chatwoot/control/connections/:integrationId/conversations/:conversationId/campaign-messages/:messageId` returns `queued`, `sent`, `delivered`, `read`, `failed`, `blocked` or `unknown`. A successful integration job alone is not a provider acknowledgment. Media siblings are aggregated conservatively. Observations and mappings must match the organization, destination revision, Account, conversation and message. Missing evidence means queued, never sent. No recipient/content/credential is returned.

Both routes use the existing `chatwoot:read` authorization and revalidate inside the same tenant transaction. Generic messaging permissions, NICO takeover fencing and RLS remain unchanged. Schemas are in `packages/contracts/src/integrations/campaigns.ts` and the generated OpenAPI.

Sending still uses a signed Chatwoot `message_created` event with a legitimate user and `campaign_id`. It remains `AUTOMATED_REPLY`, allowed by the existing policy only for the selected EXTERNAL executor on BROKER_TRANSPORT. BROKER-owned automations and CENTRAL_TRANSPORT are not silently converted or impersonated. Provider outbox, identity checks, suppression, physical-cycle fencing and webhook deduplication remain authoritative.

No migration or permanent configuration change is introduced. Roll out a compatible API and messaging-worker image together; the web image and Evolution image are unchanged by this delta. Earlier versions return 404 for the new protocol and must be shown as unavailable by the JRC sender selector. Publication and production installation remain separate approval steps.
