# JRC Evolution origin journal — laboratory increment B02-A

This package is **not installed on an engine**. It supplies a PostgreSQL adapter, integration dispatcher, explicit fixed-endpoint HTTP transport, finite laboratory worker/bootstrap and source-hook preparation, all owned by JRC. B02 remains open. It does not replace any Broker outbox and has no Redis queue, default network destination, auto-migration or session action.

## Running the isolated tests

Use the repository's existing Node24 and dependencies. Supply `TEST_DATABASE_ADMIN_URL` outside source control, pointing to a dedicated loopback PostgreSQL admin database named with `lab_` or `jrc_test_` prefix. There is deliberately no `DATABASE_URL` fallback.

```sh
npm run build
node --test --test-concurrency=1 integrations/evolution-origin-journal/tests/unit.test.mjs integrations/evolution-origin-journal/tests/postgres.test.mjs integrations/evolution-origin-journal/tests/transport.test.mjs integrations/evolution-origin-journal/tests/crash.test.mjs integrations/evolution-origin-journal/tests/broker-crash.test.mjs integrations/evolution-origin-journal/tests/ownership.test.mjs
```

Tests assert `fsync`, `full_page_writes` and the lab receiver's `synchronous_commit` are on. They create only a random `jrc_test_origin_<uuid>` database, install only `jrc_evolution_origin`, then drop only the database this invocation successfully created. They do not run Broker migrations or modify the admin database's schema. All facts are synthetic; generated repeated-digit address fixtures exercise the existing individual-address grammar and are not real contacts. No complete payload is written to a log by production modules. Local test runner logs are git-ignored.

The original PostgreSQL tests use a transactional synthetic receiver and fresh connection pools. The added transport tests use actual loopback HTTP sockets. Added crash tests fork real child Node processes and SIGKILL them after source-adapter COMMIT, claim COMMIT, and synthetic HTTP recipient COMMIT before ACK. Separate broker-crash.test.mjs imports the built actual Broker route/service/tenant transaction, migrates a second isolated receiver database, and holds its ACK after real message/receipt COMMIT before killing the source worker. Recovery waits for actual lease expiry; it does not edit lease timestamps. These are not engine-binary, WhatsApp, Chatwoot or PostgreSQL host-restart drills.

## Interfaces and responsibility

`installOriginJournal(pool)` is an explicit schema install for the engine's own database. `createOriginJournal({pool, encryptionKey})` accepts a32-byte in-memory AES key; it never reads an application database URL or secret automatically. The key must be retained and recoverable by an authorized host; rotation/re-encryption is not implemented in version1.

The caller must bound pool acquisition, connection, query/lock and statement timeouts. The dispatcher deadline starts **after** a PostgreSQL claim and does not impose a pool/SQL timeout itself. Before installing/enabling, the caller must verify PostgreSQL fsync and full_page_writes are on: the test harness asserts those flags, but the adapter does not independently guard server configuration. Use a dedicated engine role/database and reviewed retention/backups before any enablement. PostgreSQL settings do not independently prove physical storage durability or restore readiness.

- `journal.acceptBatch(binding, envelopes)` validates the exact individual TEXT projection and atomically stores event plus delivery obligation. Same logical key/content returns the existing ID; conflicting content aborts the whole batch. Projection ciphertext uses AES-256-GCM with event/scope/binding associated data; auth state, QR, bearer and quoted/context material are excluded.
- `journal.claim(binding,{leaseMs})` serializes claims per scope. At most one unexpired claim is active in the scope; source order is preserved, and a BLOCKED record stops later records in that scope. Scope contains instance, generation, destination identity and binding revision. All transaction commits force `synchronous_commit=on`.
- `journal.finish(claim,outcome)` persists the fenced outcome and attempt metadata in one transaction. Expired/replaced tokens cannot settle. Retries use the original event ID; exhausted/terminal records retain ciphertext and are BLOCKED, never discarded.
- `createOriginCaptureHook({env,journal,binding}).capture(events)` does nothing unless `env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED === 'true'`. Once enabled, missing journal/capture failure rejects before the caller may enqueue volatile work. Capture admits only individual `notify` text, including numeric or protobuf Long timestamps; append/history, LID-only, groups, protocol/edits, media, QR and credentials remain outside this increment.

Binding objects are host-owned trusted inputs and must remain immutable for the operation. The package accepts opaque destination identity, not arbitrary URLs. A host must install a fresh binding after authorized generation/revision changes; it must never silently redirect old backlog.

## Delivery ports and explicit laboratory bootstrap

`createOriginHttpTransport({endpoint,binding,bearerToken,...})` pins one trusted full `/v1/webhooks/whatsapp/:id` URL and the complete binding fingerprint. The endpoint channel must equal `binding.destinationId`. No event or subsequent binding supplies a URL. HTTPS is required except explicitly opted-in loopback HTTP laboratory tests. Existing per-channel Bearer authentication remains mandatory. The client has a 30-second configuration ceiling, a shared abort/deadline, a 64-KiB request bound and configurable response bound up to 64 KiB. Redirects are returned without following them. Network/response-limit errors expose only sanitized codes.

Each POST serializes the journal body once, hashes those exact UTF-8 bytes with SHA256, and supplies `x-jrc-origin-event-id` plus `x-jrc-origin-content-sha256`. It accepts responsibility transfer only for matching `{sourceEventId,durablyAccepted:true,status:'accepted'|'duplicate'}`. A bare legacy ACK stays uncertain. The real Broker receiver implementation is a separate change owned by the parent task; broker-crash.test.mjs verifies it through actual authenticated HTTP, real PostgreSQL and sender SIGKILL in the disposable lab.

`createOriginLabBootstrap({env,journal,binding,resolveBinding,transport,dispatch,worker})` assembles capture, fixed transport, dispatcher and serial finite worker. Construction does not start work; `start()` runs at most `worker.maxIterations` passes and `stop()` wakes polling and waits for the bounded in-flight pass. The host must still bound database acquisition/queries as described above. It neither installs schema nor registers itself on an engine. Both bootstrap and raw capture hook report `deliveryOwnership:'UNPROVEN'`, which the existing enabled-source overlay rejects before volatile enqueue. Capture persistence alone cannot assert suppression of the original webhook paths.

The bootstrap also exposes `webhookGuard`, built from the same immutable binding/endpoint and trusted authority. `createOriginWebhookOwnershipGuard` independently checks pre/post binding authority, then an exact structured row from `journal.lookupCommittedOwnership`: event ID, scope, provider identity, binding fingerprint and canonical source-body hash. A raw boolean is rejected. A normal PostgreSQL Pool read outside the append transaction cannot observe its uncommitted row; real-PG tests pause before actual COMMIT and prove this visibility boundary. Same provider identity with a mismatching body fails closed. Unrelated destinations, unsupported facts and absent journal identities retain legacy delivery; this narrow decision is not proof that every supported source notify was captured.

`preparePinnedWebhookOwnership(source)` hashes the actual upstream webhook controller (normalized-LF SHA256 `8d7dd73a3d658cca0a827fdf97f674446c33fc8372fa9f89462921215c5df090`) and returns a staging string. It awaits separate local/global destination decisions outside the upstream catch blocks, suppresses only an exact owned destination/fact, and preserves other integrations. Tests execute the actual prepared controller and actual generic event-manager fanout together. The vendor source is never written. The overlay has no automatic registration or engine-construction claim. The controller loses notify/append provenance, so an absent row must preserve unsupported legacy cases; future construction must carry source provenance to assert full ownership. Engine flag stays UNPROVEN.

Decision failures are isolated per destination: the generated helper skips that delivery and emits only a static `ORIGIN_WEBHOOK_GUARD_FAILED` diagnostic. It never falls back to sending the owned webhook. The other local/global branch and later generic Pusher/Kafka fanout continue. This event-emitter path grants no receipt or custody; the journal obligation remains. Actual-controller/manager regression tests exercise both failure directions and ensure diagnostic output contains no error text, destination or body.

`createOriginDispatcher({env,journal,resolveBinding,deliver,maxAttempts,timeoutMs,maxRetryMs}).runOnce(binding)` claims at most one record and calls only the integration port. It never calls a legacy handler, chatbot, provider `sendMessage` or a source-side effect.

The port contract is:

```js
resolveBinding(binding, { signal, deadlineAt }) // current trusted binding
deliver({ id, body, binding, signal, deadlineAt })
// Valid success only after the recipient durably commits the ID and business obligation:
// { status: 200, sourceEventId: id, durablyAccepted: true }
```

The total deadline covers authority before delivery, delivery, and authority after delivery; the same AbortSignal reaches both ports. An authority that resolves after timeout cannot start a late delivery. Ports must respect cancellation and must not follow redirects. The integration recipient must authenticate the source and deduplicate by stable sourceEventId **in the same transaction as its business effect/obligation**, with a receipt returned after commit. That contract is a prerequisite for safe uncertain-outcome retry, not something this package can infer from HTTP status.

**The legacy Broker QR response `200 {status:"accepted"}` does not satisfy this receipt contract. Passing it directly to this dispatcher produces RECEIPT_UNCONFIRMED and a retained retry. Do not wrap any2xx into `durablyAccepted:true`. Only the correlated opt-in receiver path, committed with its durable business effect, can transfer responsibility.**

429 scheduling is bounded by `maxRetryMs`; redirects/permanent4xx are retained BLOCKED; timeouts/5xx/invalid receipts remain uncertain and retry the same fact ID until the configured budget. Claims consumed by crashes count toward that budget. There is no generic replay-all or automatic unblocking API.

## Source overlay preparation

`preparePinnedSourceHook(source)` returns a modified string for a future staging copy; it never writes the vendor tree. It checks the full normalized-LF SHA256 of the Baileys service at pinned upstream `fa09d37892cdbb1d65a250155d293d92230c5b30`:

`d920d4fdd3cae90cb0369ad501774388388f28475135562f6977628efa913d0c`

Only CRLF→LF normalization is permitted; other source changes fail closed. It inserts an awaited hook immediately inside `client.ev.process`, before `eventProcessingQueue`. Enabling the source flag without an installed capture object/ownership declaration, or receiving a disabled/invalid capture confirmation, rejects before queueing. Tests parse the **real prepared callback**, strip TypeScript syntax using Node's experimental API, and execute its control flow with the legacy body disabled; they prove order/failure behavior, not the entire engine build.

**Not implemented:** actual engine bootstrap installation; complete ownership including notify/append provenance; engine compilation/image; engine/host crash drill; session test; status/history/group/media support; key rotation, purge or operator review UI. The transport-to-real-Broker receipt path is now covered by an authenticated local HTTP/PostgreSQL/sender-crash test. Selective local/global webhook suppression is tested against the prepared pinned source, but that does not establish complete installed engine ownership. A laboratory Node-process crash is narrower than an engine crash. Do not enable the flag in a real engine until those gates pass.

## Executable engine staging composition

`createOriginEngineComposition` adds an opaque capability minted after source COMMIT and AsyncLocalStorage provenance across queue registration. The actual callback creates a deeply frozen allowlisted snapshot synchronously on arrival, before readiness or queued work can yield. Notify and append retain their original meaning after upstream normalization or caller mutation. A supported notify without matching captured content and committed ownership cannot fall back to legacy HTTP. `preparePinnedEngineSources` pins the complete construction/source/base/event-controller seams and routes the composed webhook through its registered host, independent of later process.env changes.

`withOriginEngineLabHost` is an explicit laboratory API. It attaches readiness before actual ChannelController returns, checks database settings/schema and instance binding, then gates actual createClient before auth-state access. Capture/registration is serialized per instance to preserve arrival order over slow COMMITs. The production ownership installer does not exist; enabled construction without a registered lab host rejects and ownership stays UNPROVEN.

On host exit, new instance/capture/readiness admission closes first. A new
`createClient` readiness call cannot continue into auth access while closing.
Already-admitted capture uses its private readiness path so it can finish its
durable obligation during drain. Ownership remains attached
while admitted capture, the pinned upstream `eventProcessingQueue` and registered
fanouts settle. The callback registers its queue without returning the promise;
the upsert handler also calls `sendDataWebhook` without awaiting it. The reviewed
base-channel seam therefore registers the actual `eventManager.emit` promise
against the attached instance before any earlier sink can delay its webhook.
Queue settlement alone does not prove fanout settlement. Captured async context
allows already-admitted work to register its fanout during drain; unrelated new
fanout is rejected while closing. Unattached providers retain legacy behavior.
Only then does the host stop its worker and retire the instance. A weak tombstone
rejects later callbacks/readiness/re-attachment of that retired object even when
the process opt-in is absent. A fresh instance can reuse the released name in a
new explicit host. A rejected queue settles cleanup; it is not converted into a
successful capture. An indefinitely pending database/legacy operation can still
hold graceful shutdown: the host's existing caller timeout/cancellation obligation
remains, and this drain is not a hard shutdown deadline.

The lifecycle regression is self-contained and needs neither PostgreSQL nor a
full engine build:

```sh
node --max-old-space-size=128 --test --test-concurrency=1 integrations/evolution-origin-journal/tests/engine-host-lifecycle.test.mjs
```

`node build/stage-engine.mjs` creates a disposable ignored source tree with hashes, complete191-file upstream src, reviewed overlays, runtime allowlist, schema, lockfile and legal notices. Production main.ts is the build entry; the complete source is still typechecked. The parent release report distinguishes the successful pre-review full source build from the final compiled-class regression following the flag bypass fix. Do not use this stage as an approved production image.

New tests `provenance.test.mjs`, `engine.test.mjs`, `staging.test.mjs` and `engine-crash.test.mjs` are native node:test and require root esbuild, not Docker. The crash fixture uses complete compiled upstream classes with explicit synthetic auth/WhatsApp/Prisma/chatbot dependencies and a substituted legacy adapter, plus actual Broker HTTP/PG. Its substituted upsert handler preserves the real fire-and-forget call to `sendDataWebhook`; test observers wait explicitly with `drainFanouts`, without adding an await inside the engine handler. The lifecycle regression blocks an actual earlier EventManager sink, observes queue settlement and then releases the real webhook path. These tests prove those boundaries, not a real WhatsApp/session or final engine-image runtime.

There is no reviewed derivative engine Dockerfile or production bootstrap in this
package. The staging tree is a source/typecheck input, not a complete image build
context: it does not copy Prisma schemas/client-generation scripts, public/manager
assets or the upstream Docker startup helpers. The unchanged upstream Dockerfile
does not install this host, and its startup performs database deployment. A future
image recipe must explicitly materialize the required pinned inputs, generate its
own Prisma client, build the final source/runtime, preserve legal/provenance files,
and exercise the final entrypoint with the journal disabled by default. The source
database, binding/key authority, worker lifecycle, ownership and supported-event
coverage need separate laboratory proof before any activation. See the scoped
2026-11-02 checkpoint in `docs/broker-jrc-conclusao/15-ENGINE-HOST-20261102.md`.

## Attribution

The vendor checkout/gitlink is unchanged. Read `docs/legal/evolution/UPSTREAM.md`, `THIRD_PARTY_NOTICES.md`, and the pinned upstream LICENSE/NOTICE/TRADEMARKS. Source preparation produces a derivative if later applied to a build copy; record JRC patch hashes and preserve attribution/required usage notice. No third-party source or compiled image is distributed by this folder. A future image must explicitly preserve applicable notices and supply source/patch/base/lockfile provenance; source metadata found in the B02 audit is not runtime validation.
