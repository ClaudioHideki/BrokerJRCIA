# Authenticated campaign queue isolation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admit a separately authenticated campaign for an already proven different physical contact while preserving every uncertain mirror and the barrier on historical human replies.

**Architecture:** Extend the existing shared claim predicate only. A campaign exception requires an exact, currently authorized persisted intent, its authenticated automated-reply observation and an existing canonical physical map. Every UNKNOWN on the same organization/integration must be positively attributable to a SEND_MESSAGE mirror on the same channel for a different physical contact. Normal worker canonical reads, lease checks, local enqueue idempotency and final dispatch authority remain unchanged.

**Tech Stack:** Existing TypeScript/PostgreSQL/RLS, Vitest and disposable integration fixtures. No dependency, API or migration changes.

**Spec:** Root-approved inline design on 2026-10-26, following read-only confirmation of the scheduling barrier. This is additive to `2026-10-23-campaign-canonical-recipient.md`; it does not relax that plan's recipient/identity/authority requirements.

## Approaches and constraints

- Selected: narrowly admit the independent, proven campaign through the same worker and its normal outbox. This preserves uncertain history and cannot release older public replies.
- Rejected: globally ignore UNKNOWN or release all CHATWOOT_REPLY jobs, which could send historical human/bot replies.
- Deferred: reconciliation of a lost mirror response without durable confirmation. The existing reconciliation contract requires confirmed response evidence; no editable marker, retry, status rewrite or manual SQL can replace it in this change.
- No production read/write, message replay, server change, commit or push. Root owns release.
- Keep one RUNNING job per integration, connection ordering and the same predicate in both claim selections.
- Missing/malformed scope or context, non-mirror UNKNOWN, absent/different operation and the same physical contact across any cycle stay blocked.
- Keep human/legacy/bot replies without an exact campaign proof blocked. Unmapped or reassociated campaign routes do not qualify for the exception.
- Use only synthetic fixtures and a new, isolated local PostgreSQL server; never persist customer IDs, numbers, messages or secrets in the plan/tests.

## Review focus

1. All UNKNOWN barriers must be examined; one unrelated mirror cannot hide a second ambiguous or same-contact barrier.
2. Physical contact, not merely the remote conversation ID, partitions the exception across cycles.
3. Observation/intent/map proof includes organization, integration, channel, account, inbox, destination, message, contact/source/phone and compatible local conversation.
4. Admission cannot skip canonical message/content/attachment checks, authority revocation, key locks, expiry, owner/identity revisions or outbox idempotency.
5. Concurrent workers cannot duplicate the campaign or release historical replies; a blocked earlier job must not starve the proven campaign.

## Task 1: Pin and implement the exception

**Files:** Modify `apps/api/src/modules/integrations/chatwoot-worker.ts` and `apps/api/tests/integration/chatwoot-campaign-intents.test.ts`.

- [x] Write PostgreSQL regressions for independent text/image campaigns, concurrent claims, preserved legacy replies and all conservative blockers.
- [x] Observe RED for the valid independent campaign with the production claim implementation.
- [x] Add the minimum exception to the shared predicate; change no worker processing, replay, reconciliation or dispatch code.
- [x] Observe GREEN for campaign intents and existing mirror isolation/cycle/media/attendance regressions.

## Task 2: Verify and hand off

- [x] Obtain independent read-only review and address material findings with RED/GREEN.
- [x] Run TypeScript, `git diff --check` and the full `npm test` required by AGENTS.
- [x] Record exact local evidence and limitations; leave the scoped diff uncommitted for root.

## Execution ledger

- Base: `6b903647d18aa1944417db6c08f807e1a085b8f9`. Worktree reused by explicit root instruction.
- No implementation-plan interface conflict: the exception changes only eligibility; `receiveReply` and subsequent outbox authority continue consuming the same job/intent contract.
- Root approved the short design and immediate TDD execution; no further product-policy decision is delegated to this task.
- The initial run was an infrastructure failure, not accepted RED: the existing app-role fixture removes the administrator password, while the new disposable server initially required SCRAM. Root enabled trust only on that isolated localhost-bound test container; no helper or production setting changed.
- Accepted PostgreSQL RED: 3 functional failures / 32 passing / 53 existing cases skipped. Independent text/image and concurrent campaigns stayed PENDING with zero attempts/outbox, exactly reproducing the scheduling barrier. Log `.sessions/campaign-unknown-isolation-red-functional-20261026.log`, 33.61 seconds.
- Ruling: require the unknown mirror's remote conversation target to match its persisted physical map as well as message/channel/contact — otherwise message context alone could hide an ambiguous remote target. Missing/mismatched targets remain blocked. The independent reviewer agreed with this conservative proof; no new remote calls are introduced.
- Focused PostgreSQL GREEN: 91 campaign-intent tests plus 13 existing mirror-isolation tests, 104/104 passed. Includes 38 new cases, atomic concurrent claims, an unchanged UNKNOWN attempt with no remote response ID, and a preserved older public reply with zero attempts. Log `.sessions/campaign-unknown-isolation-green-20261026.log`, 79.96 seconds.
- Adjacent PostgreSQL GREEN: 47/47 in conversation cycles, media matrix and attendance observations; preserves the reconciliation requirement for confirmed mirror-response evidence. Log `.sessions/campaign-unknown-isolation-adjacent-20261026.log`, 57.95 seconds. Total PostgreSQL coverage in this task: 151 passing cases, actual application role/RLS, disposable databases.
- `npm run typecheck` passed, exit 0. Log `.sessions/campaign-unknown-isolation-typecheck-20261026.log`.
- Independent read-only review found no blocking finding. It verified the two claim callsites, SQL aliases/parentheses, examination of every UNKNOWN, NULL-safe operation guard, map/contact/phone/observation/authority proof and unchanged downstream checks. The current-cycle NULL key is backed by the existing unique physical-conversation index; no redundant successor query was added.
- Full fresh `npm test -- --maxWorkers=1 --no-file-parallelism`: 442 files / 3,405 tests passed, `SUMMARY_EXIT=0`, 955.62 seconds. Node old-space heap was capped at 768 MiB. Log `.sessions/campaign-unknown-isolation-full-npm-20261026.log`. No product or test source changed during this gate.
- Final scoped `git diff --check` passed. No API, UI, priority, schema, dependency, reconciliation, receiveReply, outbox or provider-send code was modified. Existing untracked output/tmp artifacts were preserved.
- These are local source/regression results. This task made no production changes, cleared no UNKNOWN, replayed no message and performed no commit/push/deployment. Root owns the release and subsequent receipt-based verification of the already authorized campaign.
