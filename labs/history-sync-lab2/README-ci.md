# Broker ↔ LAB2 isolated GitHub Actions laboratory

This harness builds the current LAB2 Rails source with Ruby 3.4.12 and Bundler
2.5.16, then exercises the real HTTP receiver, PostgreSQL, private MinIO and a
real Sidekiq process. It requires a GitHub-hosted Linux runner and Node 24.19.0.
It does not use an old published LAB2 runtime image.

The caller checks out both public repositories. The LAB2 checkout may be nested
inside the Broker workspace, as with Actions checkout `path: lab2-consumer`.
Set `HISTORY_LAB2_CHECKOUT` to that checkout and `HISTORY_LAB2_SHA` to its exact
reviewed 40-character commit. Its origin must be
`ClaudioHideki/jrc-conversas-lab2`, its Git tree must be clean, and its required
Rails/schema/assets files must exist. The harness exports tracked files from
that exact commit into a temporary build context. Only that exported context
gets a laboratory `.dockerignore` overlay so product exclusions of `spec` do
not remove FactoryBot definitions and synthetic media. Neither checkout is
modified.

```bash
node --test labs/history-sync-lab2/ci-harness.test.mjs
bash labs/history-sync-lab2/run-ci.sh --check
bash labs/history-sync-lab2/run-ci.sh all
```

`GITHUB_ACTIONS=true` and `RUNNER_ENVIRONMENT=github-hosted` are required.
Execution also checks Linux, Docker context `default`, the local Unix socket,
unused purpose-scoped container names, and an unused Compose project. Remote
Docker overrides are refused. The default evidence directory is
`artifacts/history-lab2`; the caller may set `HISTORY_LAB_EVIDENCE_DIR`, preferably
to a directory under `RUNNER_TEMP`.

Selections are `all`, `live`, `outbound`, `history`, and `operational`. `all` runs
the following files serially, each with one Vitest worker:

- `chatwoot-live-lab2.test.ts`
- `chatwoot-outbound-media-lab2.test.ts`
- `history-sync-lab2.test.ts`
- `history-sync-operational-lab2.test.ts`

`live` includes both live files. Independent suites continue after a test
failure, recording each exit code and duration in `status.tsv`; any failure
makes the final process fail. A guard/setup failure aborts immediately.

The Compose project is `jrc-history-ci`. PGvector 16 and Redis 7.4.0 use the
existing repository digest pins. MinIO uses the same release, size provenance
and SHA256-verified Linux binary as `scripts/ci/storage-minio.mjs`, packaged in
a scratch image. Rails HTTP binds only `127.0.0.1:54141`; PostgreSQL and MinIO
use dynamically assigned loopback ports. Redis has no published port. The
network is internal; all service labels identify this disposable laboratory.
PostgreSQL has separate Rails and per-test Broker databases. Its trust auth is
confined to this synthetic local service, allowing the existing test-role/RLS
fixtures. PostgreSQL and MinIO use project-owned named volumes, so container
restart does not erase persistence evidence. Exit cleanup removes only this
project and its volumes; it never prunes Docker or touches unrelated data.

The Rails entrypoint performs only explicit `db:schema:load` against
`jrc_history_order_test` and the guarded fixture bucket initializer. Sidekiq
consumes only `low` with concurrency one and an empty schedule in its ephemeral
container. Existing test-only Rails initializer/HTTP data fixtures capture
external webhook/send jobs. No backup, dump, restore, maintenance aggregate,
production endpoint, pairing or physical WhatsApp send is invoked.

The runtime container memory limits total about 3.9 GiB, plus the Node test
process (512 MiB heap cap), Docker/build overhead and the host. Bundle builds
use two jobs. A 60-minute job budget allows cold Ruby/gem/image builds and all
four suites; this is a planning allowance, not a measured runtime guarantee.
`provenance.txt` records the actual CPU count, memory and free disk observed on
the runner alongside both source SHAs. Do not infer runner capacity from these
defaults; the workflow owns any resource admission threshold.

Artifacts are `provenance.txt`, `build.log`, `start.log`, `schema.log`, one log
per selected suite, and `status.tsv`. Failure cleanup adds only the last 200
Rails/Sidekiq log lines, sanitized against generated secret values and
credential-bearing fields. Temporary random credentials live in a mode-0600
environment file outside the evidence directory, are never echoed, and are
removed on exit. Do not upload that temporary directory, Docker inspect output,
or container environment files.

Proof levels remain explicit: provider/source input is synthetic; HTTP Rails,
Sidekiq, SQL and private storage are real when the Actions job passes. A local
guard or syntax pass does not prove container boot, cross-repository E2E,
production custody, or handset delivery. No local Docker execution is required
to run the guard tests.
