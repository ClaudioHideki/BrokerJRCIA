# JRC Evolution origin journal — laboratory increment B02-A

This package is **not installed on an engine**. It is a PostgreSQL adapter, injected integration dispatcher and source-hook preparation, all owned by JRC. B02 remains open. It does not replace any Broker outbox and has no Redis queue, default HTTP client, worker loop, auto-migration or session action.

## Running the isolated tests

Use the repository's existing Node24 and dependencies. Supply `TEST_DATABASE_ADMIN_URL` outside source control, pointing to a dedicated loopback PostgreSQL admin database named with `lab_` or `jrc_test_` prefix. There is deliberately no `DATABASE_URL` fallback.

```sh
node --test --test-concurrency=1 integrations/evolution-origin-journal/tests/unit.test.mjs integrations/evolution-origin-journal/tests/postgres.test.mjs
```

Tests assert `fsync`, `full_page_writes` and the lab receiver's `synchronous_commit` are on. They create only a random `jrc_test_origin_<uuid>` database, install only `jrc_evolution_origin`, then drop only the database this invocation successfully created. They do not run Broker migrations or modify the admin database's schema. All facts are synthetic; generated repeated-digit address fixtures exercise the existing individual-address grammar and are not real contacts. No complete payload is written to a log by production modules. Local test runner logs are git-ignored.

Tests use a transactional synthetic receiver with a unique sourceEventId; there is no real HTTP/WhatsApp/Chatwoot traffic. Restart coverage means a new PostgreSQL connection pool and adapter reading durable rows, plus expired-lease recovery. It is not a process SIGKILL or PostgreSQL host-restart drill.

## Interfaces and responsibility

`installOriginJournal(pool)` is an explicit schema install for the engine's own database. `createOriginJournal({pool, encryptionKey})` accepts a32-byte in-memory AES key; it never reads an application database URL or secret automatically. The key must be retained and recoverable by an authorized host; rotation/re-encryption is not implemented in version1.

The caller must bound pool acquisition, connection, query/lock and statement timeouts. The dispatcher deadline starts **after** a PostgreSQL claim and does not impose a pool/SQL timeout itself. Before installing/enabling, the caller must verify PostgreSQL fsync and full_page_writes are on: the test harness asserts those flags, but the adapter does not independently guard server configuration. Use a dedicated engine role/database and reviewed retention/backups before any enablement. PostgreSQL settings do not independently prove physical storage durability or restore readiness.

- `journal.acceptBatch(binding, envelopes)` validates the exact individual TEXT projection and atomically stores event plus delivery obligation. Same logical key/content returns the existing ID; conflicting content aborts the whole batch. Projection ciphertext uses AES-256-GCM with event/scope/binding associated data; auth state, QR, bearer and quoted/context material are excluded.
- `journal.claim(binding,{leaseMs})` serializes claims per scope. At most one unexpired claim is active in the scope; source order is preserved, and a BLOCKED record stops later records in that scope. Scope contains instance, generation, destination identity and binding revision. All transaction commits force `synchronous_commit=on`.
- `journal.finish(claim,outcome)` persists the fenced outcome and attempt metadata in one transaction. Expired/replaced tokens cannot settle. Retries use the original event ID; exhausted/terminal records retain ciphertext and are BLOCKED, never discarded.
- `createOriginCaptureHook({env,journal,binding}).capture(events)` does nothing unless `env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED === 'true'`. Once enabled, missing journal/capture failure rejects before the caller may enqueue volatile work. Capture admits only individual `notify` text, including numeric or protobuf Long timestamps; append/history, LID-only, groups, protocol/edits, media, QR and credentials remain outside this increment.

Binding objects are host-owned trusted inputs and must remain immutable for the operation. The package accepts opaque destination identity, not arbitrary URLs. A host must install a fresh binding after authorized generation/revision changes; it must never silently redirect old backlog.

## Injected delivery port: not compatible with the legacy ACK yet

`createOriginDispatcher({env,journal,resolveBinding,deliver,maxAttempts,timeoutMs,maxRetryMs}).runOnce(binding)` claims at most one record and calls only the integration port. It never calls a legacy handler, chatbot, provider `sendMessage` or a source-side effect.

The port contract is:

```js
resolveBinding(binding, { signal, deadlineAt }) // current trusted binding
deliver({ id, body, binding, signal, deadlineAt })
// Valid success only after the recipient durably commits the ID and business obligation:
// { status: 200, sourceEventId: id, durablyAccepted: true }
```

The total deadline covers authority before delivery, delivery, and authority after delivery; the same AbortSignal reaches both ports. An authority that resolves after timeout cannot start a late delivery. Ports must respect cancellation and must not follow redirects. The integration recipient must authenticate the source and deduplicate by stable sourceEventId **in the same transaction as its business effect/obligation**, with a receipt returned after commit. That contract is a prerequisite for safe uncertain-outcome retry, not something this package can infer from HTTP status.

**The current Broker QR route returns `200 {status:"accepted"}` and does not implement this exact sourceEventId receipt contract. Passing that response directly to this dispatcher produces RECEIPT_UNCONFIRMED and a retained retry, not DELIVERED. Do not wrap any2xx into `durablyAccepted:true`. A real recipient adapter/receipt contract still needs implementation and review.**

429 scheduling is bounded by `maxRetryMs`; redirects/permanent4xx are retained BLOCKED; timeouts/5xx/invalid receipts remain uncertain and retry the same fact ID until the configured budget. Claims consumed by crashes count toward that budget. There is no generic replay-all or automatic unblocking API.

## Source overlay preparation

`preparePinnedSourceHook(source)` returns a modified string for a future staging copy; it never writes the vendor tree. It checks the full normalized-LF SHA256 of the Baileys service at pinned upstream `fa09d37892cdbb1d65a250155d293d92230c5b30`:

`d920d4fdd3cae90cb0369ad501774388388f28475135562f6977628efa913d0c`

Only CRLF→LF normalization is permitted; other source changes fail closed. It inserts an awaited hook immediately inside `client.ev.process`, before `eventProcessingQueue`. Enabling the source flag without an installed capture object/ownership declaration, or receiving a disabled/invalid capture confirmation, rejects before queueing. Tests parse the **real prepared callback**, strip TypeScript syntax using Node's experimental API, and execute its control flow with the legacy body disabled; they prove order/failure behavior, not the entire engine build.

**Not implemented:** actual engine bootstrap installation; reliable suppression/ownership of the original direct webhook for journal-owned facts; source-to-recipient receipt wiring; engine compilation/image; process/host crash drill; session test; status/history/group/media support; key rotation, purge or operator review UI. The ownership declaration alone is not proof of exclusive delivery. Do not enable the flag in a real engine until those gates pass.

## Attribution

The vendor checkout/gitlink is unchanged. Read `docs/legal/evolution/UPSTREAM.md`, `THIRD_PARTY_NOTICES.md`, and the pinned upstream LICENSE/NOTICE/TRADEMARKS. Source preparation produces a derivative if later applied to a build copy; record JRC patch hashes and preserve attribution/required usage notice. No third-party source or compiled image is distributed by this folder. A future image must explicitly preserve applicable notices and supply source/patch/base/lockfile provenance; source metadata found in the B02 audit is not runtime validation.
