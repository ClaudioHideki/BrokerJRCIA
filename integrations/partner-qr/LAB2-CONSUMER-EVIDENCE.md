# LAB2 actual consumer contract probe — 2026-11-01

This probe executes current Broker Fastify control routes using HTTP injection, then sends their JSON to the unmodified JRC Conversas `JrcBroker::Response` Ruby implementation. Broker authorization/service/facade data are injected synthetic fixtures. It does not boot the Rails application or certify LAB2.

## Exact local sources

- Newer host checkout: `C:/Users/DEV02/Documents/ChatGPT/New project/.worktrees/release-grupojrc-20261022`, HEAD `abc1f7c57f55a7d9871101cd5b70c8b93becc7ca`. Existing modified `.github/workflows/build-ghcr.yml` was untouched. Consumer `app/services/jrc_broker/response.rb` SHA256 `50d088aaae54eb58ed23b97fd721c48316d4f635c1ebf4e84063d5af72e5cd40`.
- Same consumer hash exists in `.worktrees/jrc-nico-broker-20261015` and `.worktrees/jrc-campaign-direct-audience-20261022`.
- Older dedicated QR checkout: `JRCConversas-qr-contract-20260925`, SHA `61b120ab71db8c67484e5de9d5dfae9cbdff9eb2`; older byte hash differs. `JRCConversas-current-audit-20260925` HEAD `239c8358666289846e6e0112ea6c38eccfd956ba`.
- `JRCConversas-development-20261015` HEAD `b58e093dd3a32fe97829a4566660b83ee48b9eca` has no checked-out application files. These are local observations, not verification of the latest remote/released host.

All external repositories were read only. No real Rails containers were started or modified.

## Execute

Build existing Broker workspace dependencies first. Set `TEST_LAB2_RESPONSE_RB` to the explicit authorized consumer source file above, then run:

```text
npx vitest run --config integrations/partner-qr/vitest.lab2.config.mjs
```

The dedicated config keeps host-dependent tests outside the portable generic partner suite. It requires the expected consumer source hash and pinned cached Ruby image `sha256:b375544ab454a24fb8a305ba6f476c9b09b8aa0d99bed645c184d41510552fbb` (Ruby 3.4.4). No image pull or network access is requested. Each subprocess runs a new `--rm --network none --read-only` container, 192MiB, .5CPU, 64pids, all capabilities dropped, no new privileges. Only the specific consumer source and the test-only Ruby bridge are mounted read only. JSON travels via stdin/stdout. No credentials, application environment, Rails DB, session or whole repository is mounted.

The bridge provides only the consumer's exception namespace and `Time.current` compatibility; all response validation/projection is the actual host class. It does not replace or emulate host policies, session, CSRF, reauthorization, DB or PubSub.

## Contract coverage

1. Broker status JSON passes real host integration/inbox/instance binding projection; swapped inbox is refused. CONNECTED with transport UNVERIFIED remains UNVERIFIED.
2. HTTP202 pending pair preserves durable operation ID. Subsequent UNKNOWN progress reaches actual host projection with reconciliationRequired=true. Only one pair command occurs; progress is a read. External actor42 and original idempotency key reach route authorization/facade.
3. A current one-time pairing-code response is accepted; expired challenge and wrong operation ID are refused. Host projection strips provider diagnostics.
4. A synthetic PNG-signature challenge from the actual operation route passes the actual PNG consumer, while invalid PNG bytes are refused. No codec/scannability claim.

Fixture data are synthetic IDs, text and signature bytes. No message is sent and no WhatsApp session is used.

## Remaining actual LAB2 gap

The generic Node `partner-qr/backend.mjs` facade uses `/v1/instances` and a host authorization callback. The actual JRC Conversas Rails integration instead uses `/v1/integrations/chatwoot/control`, `X-JRC-External-Actor`, account/inbox binding, encrypted scoped control credentials, permissions and durable pair-operation polling. Its source contains dedicated client/controller/policy/control/specs; stock Chatwoot lacks these application extensions. The generic suite alone is not evidence that these host extensions are installed or functioning.

Still untested: complete authorized Rails boot/session/token and CSRF behavior; account/inbox grant revocation mid-request; real host DB migrations/credential encryption; full controller/client TLS request exchange with live Broker; Redis/PubSub/browser delivery; onboarding binding; actual inbound/outbound messages and media; reconnect/logout; UNKNOWN recovery across process restarts; current remote SHA/release image and real LAB2 configuration. Those require a separately provisioned isolated actual JRC Conversas environment with synthetic fixtures and explicit end-to-end wiring. Existing local real/shared containers were not used to shortcut that requirement.

No production changes, real credentials/data/numbers, new package, root CI/package/docs edits, commit or push.

## Verification result

Dedicated actual-consumer probe: 4/4 passed, zero skips, 31.81s (`tests/lab2/consumer-run.log`). Existing generic Node/DOM partner suite: 34/34 passed, 5.96s (`tests/lab2/generic-partner-run.log`). `git diff --check -- integrations/partner-qr` returned zero. This is a test-only regression/fixture addition: no production behavior changed, so no new implementation RED/GREEN claim is made.

Connected-source verification: GitHub connector fetched `ClaudioHideki/jrc-conversas-lab2/app/services/jrc_broker/response.rb` from the current default branch `codex/cadastro-mestre-20261002` on this run. Connector blob SHA `2960397a9ac7501baf43cbfaa1881038f24beada` exactly matches `git hash-object` of the local consumer actually executed. Source URL: https://github.com/ClaudioHideki/jrc-conversas-lab2/blob/codex/cadastro-mestre-20261002/app/services/jrc_broker/response.rb . This confirms consumer-file identity with the connected default branch; it does not establish deployed image or full-host/release identity. The broader remote-release verification gap remains.
