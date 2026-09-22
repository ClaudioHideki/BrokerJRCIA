# 20 — Estratégia de migração

## Método

Usar expand-and-contract com releases compatíveis. Nenhuma fase combina mudança destrutiva de schema e remoção de API. Cada fase registra métricas antes da próxima.

## Sequência

1. Congelar contratos atuais e adicionar correlação/telemetria.
2. Confirmar migrations 0001–0025 em todos os ambientes e reconciliar produção.
3. Criar tabelas alvo e views/adaptadores compatíveis.
4. Backfill por lotes idempotentes, com contagem e checksum por tenant.
5. Ativar dupla leitura em pequena porcentagem e comparar resultados.
6. Mudar escrita para serviços canônicos mantendo espelho legado temporário.
7. Migrar UI por feature flag e redirects.
8. Desativar escrita antiga depois de uso zero e período de estabilidade.
9. Remover adaptadores somente em release posterior.

## Automações publicadas

Cada flow publicado é convertido para `automation_version`, preservando ID externo, versão, checksum, binding e estado. Execuções em curso terminam no runtime antigo; novas execuções usam o runtime definido pelo binding. Flows com nó não suportado ficam bloqueados para conversão automática e recebem relatório.

## Canais e destinos

Instances/Evolution e ativos Meta ganham `channel_id` sem perder seus IDs. Integrações Chatwoot viram `destination` + binding. Grants JRC individuais continuam legíveis enquanto o backfill por inbox é conferido.

## Rollback

- Código: reverter para digests registrados, compatíveis com schema expandido.
- Dados: desligar flags e voltar leitura/escrita ao adaptador; evitar `down` destrutivo.
- Workers: pausar consumidor novo, drenar outbox e retomar consumidor antigo.
- UI: desativar flags e manter rotas legadas.

## Gates

Backup externo restaurável, reconciliação sem divergência material, testes multi-tenant, OpenAPI compatível, filas drenáveis e dashboards ativos são obrigatórios antes de mudança de tráfego.
