<!-- jrc-operational-init:v1 -->
# Modelo de dados — Broker JRC

## Fontes e nível da evidência

Documentação inicial com base na árvore local; nenhum banco de clientes foi consultado ou alterado.

Fonte modular: [apps/api/src/modules](../../apps/api/src/modules). Conferir os schemas, repositórios e migrations do módulo alterado; a documentação não cria tabelas.

Identidades de tenant/canal/mensagem, journal/outbox e recibos de mídia devem preservar isolamento, integridade e idempotência. Conferir o contrato e a migration vigente antes de qualquer alteração.

## Fontes de continuação

- [AGENTS.md](<../../AGENTS.md>)
- [README.md](<../../README.md>)
- [CONTINUE-AQUI.md](<../../CONTINUE-AQUI.md>)
- [package.json](<../../package.json>)
- [apps/api/src/modules](<../../apps/api/src/modules>)
- [apps/web/src](<../../apps/web/src>)
- [infra/dokploy/compose.yaml](<../../infra/dokploy/compose.yaml>)
- [docs/implementation/history-operational-host-20261112.md](<../../docs/implementation/history-operational-host-20261112.md>)

## Regras de evolução

- Distinguir schema declarado de schema aplicado.
- Preservar histórico e compatibilidade de contratos; não renumerar uma migration já aplicada.
- Registrar mudanças relevantes e seu impacto no ADR, com critério de aceite e validação autorizada.
