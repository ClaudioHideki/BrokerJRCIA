# Read-only routing context for shared inboxes

`GET /v1/integrations/chatwoot/control/routing-context?integrationIds=<UUID,...>`

This machine endpoint uses the installed Control API key with `chatwoot:read`. It accepts 1–100 unique integration IDs. Portal JWTs cannot call it. The key's current organization, account and approved destination revision are revalidated before and after the single routing query. Every requested mapping must exist in that tenant; foreign or missing IDs produce 404. Responses use `Cache-Control: no-store`.

The version 1 response contains `organizationId`, `accountId`, `destinationRevision`, `checkedAt`, and `data`. Each row contains `integrationId`, `channelId`, `inboxId`, `ownerRevision`, `bindingRevision`, and one state:

- `NONE`: the canonical channel/mapping is consistent and no configured or live routing remains. A newly provisioned channel can prove this without an ownership row.
- `ROUTED`: a bot pointer, automation binding, admitted bot session/execution/job, pending or uncertain automation work, or retained remote bot reference exists.
- `UNKNOWN`: the channel/mapping or ownership snapshot cannot establish absence.

A remote binding marked `DISABLED`/`IDLE` still blocks `NONE` while `bot_id` is retained. The remote detach operation clears that live reference only after confirmation. Completed records and audit history are preserved; they do not independently imply active routing.

`HUMAN_ACTIVE` and `ADMIN_PAUSED` attendance sessions do not independently indicate channel automation. With a consistent `NONE` owner, cleared bot pointers and no other routing evidence, these sessions permit shared reading even while Chatwoot mirror receipts remain `UNKNOWN` or delivery observations remain `ECHO_PENDING`/`RECONCILE`. Those delivery records retain their exact state; this GET neither settles nor replays them. Existing automation outbox/job/execution and remote routing-binding uncertainty guards remain in force.

This endpoint supplies evidence for conversation visibility after the central application's permission and membership checks. Takeover, resume, dispatch and delivery availability retain their own admission and reconciliation guards. A `NONE` reading result grants no permission to mutate or send and makes no claim that an uncertain delivery succeeded or failed.

The endpoint reads database state only. It does not call transport status, write connection health or audit rows, create sessions, send messages, change membership, or enable assignment. The channel card's display status/name remains unchanged; an absent automation name is not a proof of absence.

The central application intersects this evidence with existing conversation permissions and inbox membership. Its additive `mine_or_shared` list scope includes own/participating work plus work in authorized inboxes whose local and Broker routing authorities prove absence. Restrictive custom roles retain their individual scope. Missing/old endpoints, failed requests and invalid or stale context produce no shared grant; existing `me`, `all` and individual assignment contracts remain unchanged. No cross-request absence cache is used.
