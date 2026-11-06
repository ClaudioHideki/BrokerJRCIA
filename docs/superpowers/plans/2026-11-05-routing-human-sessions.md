# Human attendance is not channel automation

**Implementation scope:** Increment of 2026-11-05, candidate based on 48dd406. Correct only GET routing-context evidence. No transition, state, job, UI or public response changes. The delegated implementer performed no commit, push or deployment; the primary agent handles the user's authorized release after independent review and exact-SHA CI.

**Design:** HUMAN_ACTIVE and ADMIN_PAUSED sessions do not independently prove automation. Keep every existing bot/owner/binding/execution/outbox/wait/job/message guard. Mirror/echo delivery uncertainty does not independently block authorized shared reading; its ledger state and all takeover/resume/dispatch guards remain intact. Every read remains scoped to organization and channel. Unknown/incomplete canonical mappings remain closed. The only production change is the session-state predicate in the existing SELECT.

- [x] RED unit SQL mock: 29 tests, 6 expected failures / 23 pass for human/paused sessions, independent delivery uncertainty and canonical UNKNOWN. The mock evaluates the session predicate and models existing independent stores; it does not prove PostgreSQL syntax.
- [x] Prepare PostgreSQL integration regressions: 14 total cases in chatwoot-routing-context.test.ts (13 new), including the real NONE transition, unchanged mirror UNKNOWN/echo ledgers, canonical/routing negatives and existing automation outbox UNKNOWN. Run only in root CI because local PostgreSQL is excluded by the memory constraint.
- [x] Minimal SELECT-only implementation; preserve legacy unsafe states and public schema. Document reading versus mutation admission in docs/api/shared-inbox-routing.md.
- [x] Focused unit + HTTP tests: 34/34 pass, one worker, heap192. API + references typecheck heap192 exit0; production source frozen for independent review.

Verification commands:

```
node --max-old-space-size=192 node_modules/vitest/vitest.mjs run apps/api/tests/unit/chatwoot-routing-context.test.ts apps/api/tests/http/chatwoot-control.test.ts --maxWorkers=1 --no-file-parallelism
node --max-old-space-size=192 node_modules/typescript/bin/tsc -b apps/api --pretty false
git diff --check
```

The SQL-boundary unit mock demonstrates RED/GREEN for the emitted predicate; PostgreSQL integration execution remains pending CI. This change makes no claim that UNKNOWN delivery succeeded or failed and causes no replay or ledger mutation.
