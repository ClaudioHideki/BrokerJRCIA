# P5 G2 — eventos QR e atualização de caixas existentes

Incremento aditivo sobre `0050_whatsapp_group_catalog`, com migration `0051_whatsapp_group_events`. Não depende de mídia privada C2b. As caixas QR físicas permanecem independentes de JRC Conversas/Chatwoot. Este corte não envia mensagens a grupos nem executa bots de grupos.

O webhook QR autenticado ingere `groups.upsert`, `groups.update` e `group-participants.update`. A identidade do sender PN precisa coincidir com a revisão/HMAC factual atual do canal. O ledger retém somente dados sanitizados: JID do grupo, JIDs participantes, autoria explicitamente presente, ação, metadados permitidos e relógio declarado do provedor. Não persiste o envelope Evolution, apikey, nomes/fotos/descrição ou `participantsData.phoneNumber`; LID não é prova de número telefônico. Deduplicação inclui organização, canal e revisão de identidade.

Remoções e mudanças invalidam conservadoramente o catálogo e seu refresh em voo. Remoção do próprio PN ou LID sem identificação comprovada limpa a seleção do grupo; ADD/UPSERT posterior não a reativa. Disconnect/troca de identidade limpa todas as seleções. Somente o refresh factual G1 reconcilia a participação. O `date_time` do upstream fixado não fornece ordem causal confiável: é conservado como relógio declarado e parte da chave de deduplicação, nunca como prova de frescor.

Observações inbound seguem o contrato canônico que preserva fatos para organizações SUSPENDED/DISABLED sem exclusão durável. Refresh/seleção administrativa continuam exigindo ACTIVE e membership atual OWNER/ADMIN. Canal arquivado, fora do escopo ou sob exclusão durável não admite eventos. RLS, grants restritos, trigger de lifecycle e purge nomeado acompanham as quatro novas tabelas.

Para caixas já conectadas, o botão existente **Atualizar grupos do WhatsApp** verifica e atualiza a configuração Broker da própria instância, sem reset/desconectar. GET/POST/observação PN acontecem fora da transação; locks e grants são revalidados antes dos checkpoints. O ledger grava DISPATCHED antes de um único POST. GET confirma a configuração, inclusive quando o ACK do POST se perde. UNKNOWN sobrevive a reinício/cliques e só faz GET; configuração divergente não autoriza repetição cega. Troca de binding/PN com operação UNKNOWN continua visível e não abandona a operação histórica para fazer novo POST.

O GET `/v1/channels/:id/whatsapp-group-events-configuration` permite leitura pelo OPERATOR atual e retorna apenas estado, revisões, IDs opacos, erro seguro e próxima ação. A UI distingue CONFIRMED da configuração de catálogo factual atual. Não expõe URL privada, Bearer ou chave Evolution. Uma perda de acesso depois do I/O impede publicação do estado ao ator.

Contrato upstream conferido no submódulo Evolution fixado: request de `/webhook/set` usa `byEvents`/`base64`; response `/webhook/find` usa `webhookByEvents`/`webhookBase64`. Ambos são false explicitamente, com lista exata dos seis eventos QR. O parser GET é limitado e retorna somente MATCHING/MISMATCHED/MISSING ou erro sanitizado.

Evidência do candidato antes da promoção:

- RED/GREEN do normalizador, consumidor autenticado, SDK GET/POST, ledger durável, chamada G1, readiness e UI, com falhas funcionais observadas antes da implementação.
- 46 testes de normalização/SDK/HTTP/UI aprovados.
- 80 testes PostgreSQL aprovados em cinco arquivos, incluindo inventários de grants/policies, readiness, upgrade direto 0050 → 0051, preservação do catálogo físico e purge isolado por tenant/canal.
- Typecheck API/Web/contratos/provider do overlay completo aprovado, sem diagnósticos.

Essas verificações não representam CI final, imagem publicada ou homologação real do servidor. Após promover, executar os gates canônicos, registrar o commit/digests da main e validar a caixa autorizada na jornada real.

A revisão independente do patch não encontrou Critical/Important. Na promoção, o novo GET foi acrescentado ao OpenAPI e ao inventário explícito de autorização. A leitura HTTP de anexos também repete os guards depois da leitura para impedir entrega de bytes quando acesso/JWT é revogado durante o I/O, com RED/GREEN comportamental de 27 testes HTTP. Candidatos de mídia privada e Flow continuam fora desta migration.

Gates do código canônico local em 09/10: `npm test` aprovou 297 arquivos e 2330 testes; a suíte PostgreSQL/Redis aprovou 99 arquivos e 763 testes com um worker. Os limites de 120 segundos foram passados somente na execução local, sem alterar os padrões do CI. Build, OpenAPI, bundle, contratos e `npm audit --audit-level=high` também passaram, sem vulnerabilidades. Os ajustes dos inventários de migration/readiness e do contrato QR foram verificados primeiro em suites focais. Essa evidência ainda não representa publicação deste incremento ou homologação de G2 no servidor.
