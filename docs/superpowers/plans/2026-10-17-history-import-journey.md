# R2 — composição local da jornada de histórico

Fonte Broker: branch codex/nico-broker-coordenado-20261015, baseb45003e7.
Escopo autorizado: desenvolvimento e testes locais sintéticos. Sem chamadas reais,
novos acessos, publicação ou ativação operacional. Upstream Evolution imutável.

## Etapa3a — writer histórico na mesma transação

Extrair persistContactEvent para módulo compartilhado, preservando o algoritmo
atual e retornando imported/duplicate. persistQrHistoryPage recebe somente a
TenantTransaction e registros validados; bloqueia instância/canal na mesma ordem
do ingresso, preserva IDs/direções/datas e não agenda bot nem sending outbox.
LID só é resolvido por alias confirmado no scope atual do tenant/instância.
LID desconhecido/conflitante não pode virar ordinal importado.

## Etapa3b — port e aplicação confiável

Criar port privado com capability(serverScope), createSnapshot(serverScope,
selection) e readPage(snapshotHandle,ordinal). O servidor resolve organização,
messaging_channel, binding, revisão e fingerprint. Nunca aceitar manifesto,
digests, páginas ou autoridade fornecidos pelo navegador como prova da origem.
Fetch externo fica fora do lock; assertCurrentScope revalida e mantém os fences
na transação do commit. Fonte fake só em testes, nunca no runtime de produção.
Ausência de fonte real deve produzir capability indisponível, sem início fictício.

## Etapa3c — API e UI

- Reutilizar `ChannelRouteOptions` e `resolveCurrentRole` em cada request:
  gerenciamento atual exige JWT e papel atual OWNER/ADMIN, sem novo papel.
- ID público QR é instance ID; ledger exige messaging_channels.id. Resolver como
  operation-profile; não confiar no messagingChannelId enviado pelo cliente.
- Cliente envia seleção e chave idempotente. Resposta pública só contém estado,
  contagens e identificação da operação; não expõe manifesto interno completo.
- Injeção segue apps/api/src/app.ts e http/routes/channels.ts. Contratos Zod
  compartilhados em packages/contracts; cliente em apps/web/src/channels/api.ts.
- Painel em pages/ChannelDetail.tsx; reutilizar proteção de troca de tenant e
  recuperação/cancelamento de CentralChannelSetup/ChannelDeletion.

## Provas antes de habilitar

HTTP: JWT/roles atuais, API key recusada, tenant e ID público→ID real, fonte ausente,
manifesto de cliente recusado, binding alterado entre fetch/commit, replay/restart,
progresso e cancelamento concorrente. UI: troca de tenant/canal, resposta atrasada,
capability indisponível e recuperação de operação. Integração real só pode ser
declarada quando a fonte comprovar o snapshot imutável.

Pontos existentes confirmados por inspeção: app.ts BuildAppOptions.channels e
registro encapsulado; routes/channels.ts manage; channels-v1/channel-operation-profile;
ChannelDetail canManage e remount por organização/revisão/canal. Não criar endpoint
que certifique completude com paginação offset do Evolution atual.
