# Initial QR identity enrollment implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task.

**Goal:** New tenant-bound QR inbox connections created by an authenticated administrator enroll their first number automatically.

**Architecture:** Store a finite initial-enrollment intent in the existing RLS-protected connection-health row. Creation may enroll a fresh connected identity; a disconnected instance requires a manage-authorized pair POST to arm the intent. Only explicit creation completion or the background worker may consume it. GETs only observe identity and may pin the expected fingerprint; they never authorize or approve identity. Existing connections receive no intent. Approved identities are never overwritten.

**Tech stack:** TypeScript, Fastify, PostgreSQL/Drizzle, Vitest.

**Spec:** Authorized task in this session supersedes the first-identity manual confirmation in `docs/reference/broker-chatwoot-20260916/docs/superpowers/specs/2026-09-16-broker-chatwoot-integration-design.md`, section 9. Number replacement and delegated pairing restrictions remain in force.

## Global constraints

- No production access, message delivery, pairing against real providers, commits, or pushes.
- Preserve existing edits to NativeJrcSetup.tsx and NativeJrcSetup.test.tsx.
- No credential or raw number is stored in enrollment intents; retain only actor identifiers, context and keyed fingerprints.
- A read-only or pair-only key cannot arm initial enrollment. Authority is revalidated after remote I/O.
- Expired, revoked, changed or consumed intents cannot approve an identity.

## Review focus

- A QR callback may arrive before the provider POST result is persisted.
- An identity may change between provider observation and the final tenant transaction.
- Credential/destination/account/inbox/instance and membership may change while I/O is in flight.
- Legacy unapproved connections and their pending replies must remain unapproved.
- Added persistence must retain forced RLS and lifecycle deletion coverage.

## Task 1: Persistence and initial-enrollment flow

- [x] Write integration regressions for authenticated connected creation, paired creation, GETs, legacy connections and number replacement. Run them and record genuine RED.
- [x] Add migration 0073 with nullable intent/expiry columns on chatwoot_connection_health. No backfill and no new tenant table. Update journal, schema baseline and runtime structural gate.
- [x] Implement a focused initial-enrollment service, called by authenticated creation and pairing. Bound creation lifetime: 24 hours; each pair grant: at most 2 minutes and the provider challenge expiry. Persist provider operation before worker consumption.
- [x] Pin the first connected valid fingerprint without approving from generic health observation. Consume with revision/context checks, current manage authority and verified remote inbox callback/secret.
- [x] Wire creation, native onboarding, pair, and the existing messaging worker. Preserve Meta and all legacy connections.
- [x] Cover channel destination binding, pair/reconnect, opaque idempotency keys and disconnect through the generic facade. A pending initial intent uses the existing control service; other connections retain their prior path.
- [x] Fence later generic instance logout requests under the existing instance SHARE lock, including ALREADY_CONNECTED pair results and accepted ALREADY_DISCONNECTED logouts without provider operation IDs. Preserve idempotent replay.
- [x] Rotate the bounded worker batch before remote I/O so four failed inbox verifications cannot starve a fifth eligible connection. Keep provider-observation timestamps unchanged.
- [x] Run focused RED/GREEN regressions, typecheck and the unit/HTTP/web suite.

## Task 2: Gates and review

- [x] Add PostgreSQL upgrade, RLS, expired/revoked intent and lifecycle regressions.
- [x] Run focused integration plus relevant existing onboarding/health/campaign/lifecycle suites.
- [x] Review the complete diff with a fresh reviewer when a slot is available, address material findings with RED/GREEN regressions, and run git diff --check.

## Execution ledger

- Ruling: Extend the existing health row instead of adding a tenant table; existing forced RLS and lifecycle catalogue/purge paths cover the new fields. Verify those paths with real PostgreSQL.
- Ruling: Keep SUCCEEDED onboarding semantics as a configured inbox binding; identity readiness remains in connection health and the campaign transport contract.
- Ruling: Forward the full principal from native onboarding to preserve the API-key binding and external actor attribution. The legacy connections HTTP route already requires a live OWNER/ADMIN JWT; no previously accepted API-key scope is removed.
- Ruling: `chatwoot_destinations.organization_id` is the primary key. The enrollment context has exactly one destination per organization and validates its revision, account origin and credential version before consuming authority.
- Ruling: Capture both the number of DISCONNECT operations and a SHA256 fingerprint of the durable idempotency-record IDs for the exact tenant/instance disconnect route at creation registration and pair admission. The latter includes accepted no-op logouts that create no provider operation. Both CREATE and PAIR completion recheck the snapshots before and after I/O under the instance SHARE lock. A replay does not create a record or invalidate a later grant. A later authenticated pair can rearm within the creation eligibility period.
- Genuine RED: connected creation and callback-before-pair-response failed without initial approval. Separate regressions reproduced disabled-control enrollment, lost native actor attribution, missing expiry cleanup and approval after explicit disconnect.
- Genuine RED: lost create-response recovery left `inboxId` unbound and could not arm initial enrollment. The authorized pair mutation now binds the reconciled inbox only after normal callback/secret verification.
- Genuine RED: all five facade cases failed (destination binding, pair, reconnect, operator restriction, disconnect). Both direct-instance logout cases also approved incorrectly before the operation fence. The two HTTP cases demonstrated missing authentication forwarding and a forbidden control error becoming HTTP 500.
- GREEN before the final facade additions: seven PostgreSQL files / 97 tests passed, including upgrade preservation, existing health/onboarding/campaign behavior, migrations and runtime-schema readiness. Twenty-seven enrollment cases then passed after facade/lost-create fixes.
- Fresh typecheck passed after the final backend edits. Six unit/HTTP/web files passed 24 tests; the channel HTTP file passed all eight tests after correcting its expected forwarded `authVersion: 0`. The unrelated full suite previously exposed the baseline slice size and an incomplete pair-revocation mock; both were fixed and verified focally.
- Final PostgreSQL GREEN: six files / 89 tests passed in 288.84 seconds (exit 0), including all 31 enrollment cases, the upgrade preservation case, channel-facade isolation and existing health/onboarding/campaign contracts. The 31 enrollment cases include logout before and during fresh provider observation, ALREADY_CONNECTED with no operation ID, explicit rearm after logout and opaque channel idempotency keys.
- Final targeted HTTP GREEN: all eight channel-route tests passed in 23.00 seconds, including full administrator authentication forwarding and HTTP 403 for revoked authority. Other six focused unit/HTTP/web files passed 24 tests. Typecheck and `git diff --check` passed after the final backend changes.
- Review: the parent reviewed the initial context, revocation and first-write CAS guards plus schema/context joins without a material finding. Its compatibility and CREATE-response questions were checked against source and documented above. A new independent reviewer could not be spawned because all agent slots were occupied; the parent was sent the stable final backend for review. A separate broader suite rerun belongs to the parent once concurrent UI work stabilizes.
- No claim of production readiness or a fully rerun global gate is made from the earlier broad test results.
- Independent review RED: a direct instance logout during the first CREATE identity refresh still approved the connection when the provider read lagged and returned connected. The same scenario through the channel facade already stayed fenced. The focused real-PostgreSQL regression recorded one failure and one pass before the fix.
- Independent review correction: register stores the initial DISCONNECT count; CREATE and PAIR both refuse a missing or changed count before/after provider I/O. No role, deadline, migration, provider dispatch or route changed. New administrative POST rearm remains covered.
- Independent review GREEN: all 33 initial-enrollment PostgreSQL cases passed in 52.53 seconds, including both CREATE/logout routes and subsequent explicit rearm. Typecheck and `git diff --check` passed afterward. The parent is reviewing the specific correction before the fresh whole-repository gate.
- Subsequent review RED: an accepted generic `ALREADY_DISCONNECTED` request has no DISCONNECT provider operation, so the operation-count fence alone still allowed CREATE and two concurrent PAIR completions to approve a stale connected provider response. Both PostgreSQL regressions failed; the old-request replay control passed.
- Subsequent correction: the ordered SHA256 request-ID aggregate is restricted to the tenant and exact disconnect route and supplements the operation count. This adds no migration, provider operation, public response change or new lock order. An older internal intent without this fingerprint remains unapproved until a new administrative pair captures it. Replacing an expired request is detected even when the row count stays the same.
- Fairness RED: in a real PostgreSQL fixture with five connections in one tenant, four invalid remote inbox secrets occupied the first four positions on both worker passes and left the fifth valid connection unapproved. The correction atomically selects at most four rows with `FOR UPDATE SKIP LOCKED`, records `lastAttemptedAt` in the internal intent before I/O, and orders subsequent batches by the oldest attempt. It does not refresh `updated_at`, `observed_at` or any delivery/identity status merely because a remote attempt was made.
- Subsequent focal GREEN: all 45 initial-enrollment PostgreSQL cases passed in 35.72 seconds. New coverage includes CREATE/no-op logout, two concurrent PAIR workers, replay, expired-record replacement, tenant/instance isolation, old intent metadata, fifth-connection progress and current suspension/role/key/binding authority after I/O.
- Subsequent adjacent regression GREEN: six PostgreSQL files / 103 tests passed in 91.49 seconds (exit 0): initial identity, upgrade preservation, channel facade isolation, control health, onboarding and campaign intents. Fresh typecheck and `git diff --check` passed afterward. The parent reviewed the ordered tenant/route request hash, final instance/health lock ordering and the separate bounded-attempt metadata/observation timestamps. Both reproduced P2 findings are resolved locally; no remaining fairness finding is claimed from the earlier untested hypothesis.
- The earlier whole-repository 441-file / 3,370-test GREEN predates these no-op/fairness changes and subsequent documentation updates. The parent owns a new combined gate and build after all concurrent sources settle; this plan does not reuse that older result as proof of the final tree.

## Operational limits

- A new creation is eligible for 24 hours. An administrative pair arms a single finite window of at most two minutes, shortened to the actual QR/pairing-code expiry. A fresh administrative POST may rearm before the 24-hour creation deadline; an idempotent replay does not extend a grant.
- Creation of an already connected instance can consume the original authenticated creation intent immediately. A disconnected instance cannot be approved by GET, generic health observation or an unarmed worker.
- A failed or lost remote CREATE response is reconciled using the existing durable connection flow. Creation completion is not retried as authorization from a GET or an unarmed worker. An authenticated administrative pair can resume initial enrollment after reconciliation; expiration or a changed context remains closed.
- Disconnect idempotency-record expiry/cleanup may conservatively invalidate an in-flight grant; missing or changed fingerprint metadata is never ignored. A fresh authorized pair can rearm during the existing creation eligibility period. No-op disconnect responses and old-request replays retain their previous public semantics.
- Legacy unapproved connections receive no intent. A changed first fingerprint permanently revokes the initial intent; approved identities are never replaced automatically. These cases retain explicit administrative confirmation.
- The transport remains unavailable while disconnected, with an unapproved/mismatched identity, invalid callback binding or stale/unverified health. Initial identity enrollment is separate from callback delivery evidence, campaign technical readiness and the observed inbound/outbound delivery test.
- API-key authority is account/tenant bound and revalidated from current database scopes, expiry and binding state. No per-inbox credential is issued. Meta onboarding is unchanged.
- All provider responses and remote account/inbox operations in the tests are synthetic. PostgreSQL tests use isolated local databases only. No production mutation, real QR operation, message, deployment, commit or push was performed.
