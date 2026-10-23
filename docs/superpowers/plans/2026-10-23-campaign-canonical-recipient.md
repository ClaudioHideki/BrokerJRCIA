# Campaign recipient source from the canonical conversation

**Approved scope:** Resolve campaigns for a contact that legitimately has several ContactInbox links in the same inbox, without deleting or merging any link. The parent approved using a sanitized canonical conversation `contact_inbox` object and preserving every tenant, account, inbox, contact, phone and source check.

**Contract:** An authenticated conversation GET may expose `contact_inbox: { id, contact_id, inbox_id, source_id }`, extracted from that conversation by the host. All IDs are positive integers; `source_id` is an opaque nonempty string of at most 255 characters. Never derive a phone from it or choose by prefix, link order or recency. Match exactly one contact link by inbox and source, then retain the canonical phone separately. For older hosts without this object, accept only the existing unambiguous single-link case. Multiple links without canonical route evidence remain blocked.

**Implementation:** Extend only the private Chatwoot conversation parser, reuse one campaign recipient validator in reservation and worker dispatch admission, and compare the resulting source/contact/phone to the persisted reservation and physical map. Keep the public reserve/receipt contract, immutable intent, identity/owner revisions, authority revocation and uncertain-send barriers unchanged. No migration is needed.

- [x] RED on real PostgreSQL for three links, order-independent exact selection, missing metadata, duplicate exact links, foreign route parent IDs and source changes between reservation/callback/worker.
- [x] GREEN with the minimum shared recipient validation; preserve the legacy single-link behavior.
- [x] Run focused campaign/client regressions and TypeScript. Coordinate the complete gate with the parent after the parallel JRC changes stabilize.

## Execution evidence

- Corrected PostgreSQL RED: 12 failed / 1 passed / 39 skipped in 22.88 seconds. A separate RED for the canonical conversation ID returned by GET failed as expected (1 failed / 52 skipped). The first experimental run had an outbox-fixture column typo and is not the accepted RED evidence.
- Private client parser RED: 6 failed / 1 passed / 7 skipped; the existing parser discarded the canonical route and silently discarded malformed route evidence.
- Campaign PostgreSQL GREEN: all 53 tests passed in 34.25 seconds. The new cases cover multiple legitimate links, exact order-independent selection, legacy absence-only fallback, explicit null/foreign parents/source, duplicate exact source, reservation replay, and changed conversation/contact/inbox/source evidence before dispatch. Text and image messages retain their existing immutable intent and media checks.
- Adjacent PostgreSQL GREEN: worker isolation, media matrix and conversation cycles, 3 files / 37 tests passed in 54.21 seconds.
- Adjacent client/unit/HTTP GREEN: 5 files / 46 tests passed in 19.51 seconds. TypeScript typecheck passed. Private logs are under `.sessions/campaign-canonical-*20261023.log`.
- Independent read-only review reported no blocking finding. A normal contact GET omits ContactInbox IDs; the exact inbox/source match is unique, while the conversation route supplies its parent IDs. No source-prefix or array-order heuristic is used.
- The parent owns the fresh complete gate and release after the parallel JRC serializer and sender corrections stabilize. These are local results; no production message or deployment was executed by this task.

**Limits:** No production reads or writes, browser, ENV, real messages, data cleanup, commit, push or deployment in this task. Generic Chatwoot 3.x/4.x hosts must prove the new optional field before using multiple same-inbox links. Existing host GETs that omit it retain the single-link fallback.

## Parent release verification and attachment configuration

- The full local suite passed: 442 files / 3,402 tests, with one worker. This proves local regression only, not message delivery.
- Production inspection found that an already approved external destination could not edit attachment origins through the administration UI. The backend already supports revision-bound reapproval with SUPER_ADMIN, CSRF and audit checks. The UI now exposes that existing operation for approved destinations and preloads their current origins; tenant users and read-only administrators still cannot edit it. No API, credential, destination address or migration changes are introduced by this UI correction.
- Corrected UI RED: 1 failed / 13 passed; GREEN: all 14 tests passed. The first fixture omitted the external-destinations feature flag and is not accepted RED evidence. Tests preserve existing origins, verify the exact revision/body and deny non-platform/non-manager editing.
- Runtime sender validation must additionally resolve the current physical conversation using the existing authenticated attendance read before creating a campaign message. Selecting a newer local conversation alone does not authorize changing the Broker's conversation cycle. Human-cycle and uncertain-send barriers remain unchanged.
