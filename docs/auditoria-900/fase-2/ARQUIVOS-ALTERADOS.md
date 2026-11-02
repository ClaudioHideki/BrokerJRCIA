# Inventário da candidata Fase 2

Base `9e62ceaf3177979a68bc4985a93e25474de48487`; arquivos da candidata não commitada. Lista exaustiva de código, testes e artefatos versionáveis: **60**.

- `apps/api/drizzle/migrations/0075_media_custody.sql` — novo
- `apps/api/drizzle/migrations/0076_qr_connection_watermark.sql` — novo
- `apps/api/drizzle/migrations/0077_partner_delivery_replay.sql` — novo
- `apps/api/drizzle/migrations/meta/_journal.json` — modificado
- `apps/api/src/app.ts` — modificado
- `apps/api/src/commands/history-import-worker.ts` — modificado
- `apps/api/src/db/audit-corrections-runtime-schema.ts` — novo
- `apps/api/src/db/combined-upgrade.test.ts` — modificado
- `apps/api/src/db/pool-budget.ts` — modificado
- `apps/api/src/db/runtime-schema.test.ts` — modificado
- `apps/api/src/db/runtime-schema.ts` — modificado
- `apps/api/src/db/schema-status.test.ts` — modificado
- `apps/api/src/db/schema.ts` — modificado
- `apps/api/src/http/openapi.ts` — modificado
- `apps/api/src/http/routes/media-custody.ts` — novo
- `apps/api/src/http/routes/partner-webhooks.ts` — modificado
- `apps/api/src/modules/api-keys/service.ts` — modificado
- `apps/api/src/modules/integrations/chatwoot-control-auth.ts` — modificado
- `apps/api/src/modules/media-custody/service.ts` — novo
- `apps/api/src/modules/messaging/qr-connection-order.ts` — novo
- `apps/api/src/modules/messaging/qr-events.ts` — modificado
- `apps/api/src/modules/messaging/qr-service.ts` — modificado
- `apps/api/src/modules/partner-events/replay.test.ts` — novo
- `apps/api/src/modules/partner-events/service.ts` — modificado
- `apps/api/tests/http/api-keys.test.ts` — modificado
- `apps/api/tests/http/media-custody.test.ts` — novo
- `apps/api/tests/http/openapi.test.ts` — modificado
- `apps/api/tests/http/partner-delivery-replay.test.ts` — novo
- `apps/api/tests/integration/central-transport-readiness.test.ts` — modificado
- `apps/api/tests/integration/helpers/exclusive-lab.ts` — novo
- `apps/api/tests/integration/local-attendance-readiness.test.ts` — modificado
- `apps/api/tests/integration/media-custody.test.ts` — novo
- `apps/api/tests/integration/partner-api-readiness.test.ts` — modificado
- `apps/api/tests/integration/partner-delivery-replay.test.ts` — novo
- `apps/api/tests/integration/qr-chatwoot-storage.test.ts` — modificado
- `apps/api/tests/integration/whatsapp-group-automation-schema.test.ts` — modificado
- `apps/api/tests/unit/api-key-service.test.ts` — modificado
- `apps/api/tests/unit/audit-corrections-readiness.test.ts` — novo
- `apps/api/tests/unit/database-pool-budget.test.ts` — modificado
- `apps/api/tests/unit/exclusive-lab.test.ts` — novo
- `apps/api/tests/unit/media-custody-scope.test.ts` — novo
- `apps/api/tests/unit/media-custody.test.ts` — novo
- `apps/api/tests/unit/operational-status.test.ts` — modificado
- `apps/api/tests/unit/qr-connection-order.test.ts` — novo
- `apps/api/tests/unit/qr-events.test.ts` — modificado
- `apps/web/src/pages/ApiKeys.test.tsx` — modificado
- `apps/web/src/pages/ApiKeys.tsx` — modificado
- `docs/api/openapi.json` — modificado
- `docs/operations/database-pool-budget.md` — modificado
- `packages/contracts/src/api-keys/schemas.ts` — modificado
- `packages/contracts/src/index.ts` — modificado
- `packages/contracts/src/media-custody.ts` — novo
- `packages/security/src/redaction/logger.ts` — modificado
- `packages/security/tests/redaction.test.ts` — modificado
- `scripts/docs/assets/guia-api-jrc.json` — modificado
- `scripts/docs/assets/guia-api-jrc.pdf` — modificado
- `scripts/operations/capacity-report.mjs` — modificado
- `scripts/security/inventory-routes.mjs` — modificado
- `tests/capacity-report.test.mjs` — modificado
- `tests/repository-baseline.test.mjs` — modificado

## Alterações anteriores preservadas

- `infra/web/server.mjs` — já modificado antes desta fase; separado no ZIP.
- `tests/documentation-runtime.test.mjs` — já modificado antes desta fase; separado no ZIP.

## Documentação nova desta fase

- `docs/auditoria-900/fase-2/B02-FRONTEIRA-E-DECISAO.md`
- `docs/auditoria-900/fase-2/B03-IMPLEMENTACAO.md`
- `docs/auditoria-900/fase-2/B05-B07-B13-IMPLEMENTACAO.md`
- `docs/auditoria-900/fase-2/B12-IMPLEMENTACAO.md`
- `docs/auditoria-900/fase-2/PLANO-IMPLEMENTACAO.md`
- `docs/auditoria-900/fase-2/REVISAO-B03.md`
- `docs/auditoria-900/fase-2/REVISAO-B05-B07-B13.md`
- `docs/auditoria-900/fase-2/REVISAO-B12.md`

A auditoria original em docs/auditoria-900 continua preservada, sem reescrita retroativa. output/ e tmp/ preexistentes não foram incorporados como implementação.
