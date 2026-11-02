# Dependency security refresh implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the two high-severity dependency findings that stopped image publication while preserving Broker behavior and public contracts.

**Architecture:** Pin the same corrective Zod version in all four existing workspace manifests and update only the already transitive Undici resolution permitted by jsdom. Use npm to maintain the lockfile and install the exact resolved graph. Validate audit, build, generated OpenAPI and existing regression suites without altering business code or security policy.

**Tech Stack:** Existing npm workspaces/lockfile, Node 24.19.0, TypeScript, Vite, Vitest and disposable PostgreSQL fixtures.

**Spec:** Root-approved dependency-only correction on 2026-10-26 after publication run 40340435307 failed `npm audit --audit-level=high`. Zod is requested at 4.6.7 in api/contracts/providers/security; the existing jsdom Undici 8 range permits the corrective patch. Root owns commit, push and release.

## Constraints and selected approach

- Initially own only the four existing Zod dependency manifests, root package-lock and this plan. Root subsequently authorized regeneration of `docs/api/openapi.json` for its separately owned tracing-contract fix, and regeneration of the existing public PDF/provenance assets through their existing generators. Keep the distributed Zod notice version synchronized with the installed artifact while preserving its complete license text. Do not manually change business/API/workflow code, generators, audit thresholds, overrides or dependency major versions.
- Keep Zod shared and exact; do not add Undici as a new direct dependency.
- Use targeted npm resolution/install, never `npm audit fix --force` or broad dependency updates.
- Existing moderate/low findings are outside the blocking gate unless the selected dependency resolution removes them naturally.
- Regenerate OpenAPI after build. Report any canonical diff to root before manual editing or staging; unchanged routes alone do not prove unchanged schemas.
- No production request, deployment, message replay, secret output or commit/push by this task.

## Primary evidence

- [Zod GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5): affected below 4.6.6; corrected in 4.6.6.
- [Undici GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c): the affected 8.x range is corrected in 8.12.2.
- Official npm metadata confirms the requested artifacts and integrity values. Node's configured version satisfies Undici's `>=22.19.0` engine requirement.

## Task 1: Reproduce and update the graph

- [x] Reproduce the audit failure on the committed lockfile and record the actual installed versions separately.
- [x] Pin Zod 4.6.7 in the four workspace manifests with targeted npm install.
- [x] Resolve the corrective Undici patch inside jsdom's existing range and install the lockfile graph.
- [x] Review the package/lock diff to rule out unrelated dependency movement.
- [x] Verify `npm audit --audit-level=high` and installed/locked versions match.

## Task 2: Verify compatibility and hand off

- [x] Run TypeScript and the complete build.
- [x] Generate OpenAPI and inspect the canonical diff; report drift before further changes.
- [x] Run focused contract/HTTP and campaign PostgreSQL regressions against the new graph.
- [x] Run fresh `npm test` with one worker as AGENTS requires and inspect the final exit/counts.
- [x] Run `git diff --check`, capture exact file hashes and leave the approved joint diff for root.

## Execution ledger

- Base/head at start: `dab4b46125a2845bd1e4984f8e302e5f833f9e62`; no tracked modifications existed.
- Accepted audit RED: exit 1, 2 high, 3 moderate, 1 low, 0 critical. Log `.sessions/dependency-security-audit-red-20261026.json`.
- All four original workspace manifests and lock entries specify Zod 4.5.4. The committed HEAD lock and pre-task installed graph both specify Undici 8.10.2. The CI advisory's affected range through 8.12.1 is not evidence that 8.12.1 was installed.
- The upstream fixes were checked against the primary advisory pages rather than inferred from an unrelated latest release. This task adds no mirror tests of dependency version constants; the security audit is the RED/GREEN gate and existing application tests verify compatibility.
- Root retained the minimum corrective Undici 8.12.2 after npm metadata also showed a newer 8.12.3. Targeted npm update selected/retained that newer compatible resolution; an attempted date cutoff did not lower the already selected version. Ruling: correct only the Undici leaf's version/resolved/integrity using official npm metadata, then validate the entire graph with `npm ci` — this avoids a new direct dependency or override and preserves the requested minimum patch. Root explicitly approved this approach.
- Lock review confirms exactly six changed package entries: the four Zod workspace references and the two package leaves. The root manifest, jsdom's existing `^8.9.0` range, every other package entry and dependency major remain unchanged.
- Clean install `npm ci --ignore-scripts` passed: 318 packages added, 325 audited. Install lifecycle scripts were not required for these leaves; no audit or application runtime policy was changed.
- Explicit audit GREEN: `npm audit --audit-level=high` exit 0, 0 high, 0 critical, 3 moderate and 1 low. Log `.sessions/dependency-security-audit-green-20261026.json`. The remaining severities are outside the root-approved blocking scope.
- `npm ls` and direct installed-package reads confirm shared/deduplicated Zod 4.6.7 and Undici 8.12.2, exactly matching the corrected lockfile before any compatibility gate runs.
- Root initially paused the combined build/full-test start to correct a separately owned pre-existing ProblemDetails/OpenAPI correlation-ID mismatch. At that stage the dependency task retained its original six-file ownership and did not edit those contract sources, tests or generated API JSON.
- Root subsequently authorized the canonical generator write and froze its optional UUID `correlationId` schema/regressions. After a clean build, TypeScript and OpenAPI generation all exited 0. The build reports upstream Rollup annotation warnings and the existing chunk-size warning; no policy or warning threshold was changed.
- Structural OpenAPI comparison: 347 operations before/after, with the exact same method/path set. Only 9 optional UUID `correlationId` properties and 16 upstream email-pattern strings changed; required lists and every other schema/route field are unchanged. Report `.sessions/dependency-security-openapi-diff-20261026.json` was sent to root/reviewer before further gates.
- Root's focused contracts/OpenAPI regressions pass: 2 files / 15 tests, exit 0, 19.32 seconds. Log `.sessions/dependency-security-contracts-green-20261026.log`.
- The remaining moderate/low packages (`@vitest/mocker`, `fast-uri`, `fastify`, `vitest`) have the same severities and affected ranges as the pre-task audit. They were not upgraded or masked.
- Campaign PostgreSQL regressions pass against the installed graph: 91 tests, exit 0, 64.02 seconds, using only the root-provisioned disposable local PostgreSQL fixture. Log `.sessions/dependency-security-campaign-pg-green-20261026.log`.
- The first build preceded canonical regeneration. Its PDF assets still matched the previous canonical, so root explicitly authorized the necessary derivative refresh before the final full gate; the stale-provenance guard was not weakened. `export-guide.mjs` and `generate-partner-pdf.py` regenerated only the existing public PDF and its provenance manifest. No generator/text source was edited.
- PDF validation: 24 pages, 34 selected public operations, all pages rendered and visually reviewed, current canonical hash printed, no clipping or overlap observed. Local Poppler reported two font-substitution warnings; the rendered text remained legible without replacement glyphs. The separate external client package retained its own PDF under that task's approved scope.
- Documentation/provenance gates pass: 6 files / 42 tests, exit 0. The full build after refreshing canonical/PDF derivatives also exits 0. Logs `.sessions/dependency-security-documentation-green-20261026.log` and `.sessions/dependency-security-derivatives-build-20261026.log`.
- The post-build browser bundle scan found no findings. The existing third-party-notice verifier then reproduced `Incomplete third-party notice for distributed package: zod`: its source still named 4.5.4. The installed 4.6.7 artifact retains the same MIT text and copyright; synchronize only the BEGIN/END version markers in the distributed notice, preserving all attribution text and the strict verifier.
- Rebuild after the notice refresh passes; the browser bundle scan has zero findings and the strict third-party-notice gate passes all seven distributed packages. The read-only submodule verifier initially hit sandbox `spawnSync git EPERM`, then passed under expanded subprocess execution without changing source or policy. `git diff --check` also passes.
- All runtime/contract/generator and derived assets are frozen for the final one-worker full regression. The separate root-owned tracing plan and this evidence ledger remain subject to final result recording; no release or production result is inferred from these local gates.
- Final full regression passes: `npm test -- --maxWorkers=1 --no-file-parallelism`, heap 768 MiB, 442 files / 3,406 tests, exit 0 (`SUMMARY_EXIT=0`), 1,179.83 seconds. Started at 12:30:37 UTC-03 on 2026-10-26. Log `.sessions/dependency-security-full-npm-20261026.log`. Expanded subprocess execution was used only because the existing Git/PDF fixtures require local subprocesses.
- The fourteen approved joint files, including generated documentation and both plans, have identical SHA-256 hashes before and after the full regression. The final evidence update in this plan is the only subsequent write by this task; the handoff manifest is refreshed afterward. `git diff --check` passes. No commit, push, deployment or production replay was performed.
- Independent read-only review found no actionable blocker in the dependency/contract diff or the refreshed derivatives/notice: the 347-operation set, strictness, required fields, auth and permissions are preserved; all six PDF provenance hashes match; generator and license body text remain unchanged. This review is separate from the local executed gates and does not prove production behavior.
