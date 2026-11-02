# Baseline de API, autorização e mídia — 29/10/2026

## Identidade e alcance

Fonte inspecionada: Broker `16a2a371e44de65a901cf1a9405bf4939ee1f213`, na branch local
`codex/broker-experience-20261029`. A análise cobre os handlers e serviços indicados
abaixo; não constitui nova auditoria de todas as rotas nem prova de instalação,
provider, ativo Meta, CCLX ou produção. Nenhuma credencial, mensagem real ou
configuração remota foi criada ou alterada nesta descoberta.

Referências: `AGENTS.md`, `README.md`, desenho
`docs/superpowers/specs/2026-10-05-broker-independente-centrais-design.md`, plano
`docs/superpowers/plans/2026-10-23-public-api-documentation-refresh.md` e código atual.
Documentos anteriores conservam seu valor histórico; seus resultados não são
reexecuções nesta data.

## Papéis e autoridade efetiva

| Perfil de produto | Contrato atual | Autoridade observada |
| --- | --- | --- |
| Administrador de plataforma | `SUPER_ADMIN` | Sessão de plataforma separada; operações administrativas verificam papel, motivo e auditoria. Mutações de browser usam proteção CSRF. Não é um JWT de empresa. |
| Suporte de plataforma | `SUPPORT` | No dispatcher `PlatformService.execute`, permite `list`, `memberships`, `monitor`, `acknowledge`; outras ações exigem `SUPER_ADMIN`. Outros serviços possuem seus próprios gates. |
| Administrador da empresa | `OWNER`, `ADMIN` | Instâncias: leitura/conexão; chaves, webhooks e memberships: gestão. Somente `OWNER` possui `memberships:change_owner` no mapa comum. |
| Operador | `OPERATOR` | Instâncias: leitura/conexão; mensageria JWT permite leitura e ações de escrita comuns. Administração de bot/template exige `OWNER`/`ADMIN`. |
| Leitor | `VIEWER` | Instâncias e mensageria: leitura; escrita comum de mensageria negada. |
| Desenvolvedor/integrador | Sem role específica | Consome credencial técnica com scopes explícitos, ou recebe uma role atual da empresa. Não adquire autoridade global por acessar documentação. |

Fontes: `apps/api/src/http/plugins/authorization.ts`, `authentication.ts`,
`apps/api/src/http/routes/messaging.ts`, `api-keys.ts`, `platform.ts` e
`apps/api/src/modules/platform/service.ts`.

A autenticação comum aceita exatamente uma credencial: Bearer JWT ou
`X-JRC-API-Key`. O JWT é revalidado por versão de autenticação e membership atual
quando os resolvers são instalados no servidor. O tenant vem da identidade;
o corpo/query não escolhe outra organização. Transações de tenant e RLS são
complementados por consultas com `organization_id`, vínculo do recurso e estado
operacional. Isso não transforma um scope de empresa em concessão por inbox.

**Lacuna de granularidade:** nos handlers selecionados de `messaging.ts`, leitura
JWT aceita qualquer membership atual e escrita comum aceita qualquer papel exceto
`VIEWER`. As assinaturas dos serviços de listagem/leitura recebem organização e
recurso, sem identidade do operador para filtrar por inbox atribuída. A chave
genérica também representa a organização inteira. Não afirmar que estas rotas já
implementam o requisito de operador restrito às caixas atribuídas; a política
precisa ser definida e testada antes dessa promessa na interface.

## Scopes e superfície publicada

| Credencial/operação | Gate observado |
| --- | --- |
| Instâncias: consulta | `instances:read` |
| Instâncias: conectar/alterar | `instances:write` mapeado para `instances:connect` no guard comum |
| Gestão de chaves genéricas | `api_keys:manage`; emissão permite os seis scopes genéricos do schema |
| Consulta de mensageria e bytes privados | `messaging:read` |
| Texto individual de parceiro | API key com `messaging:send`; JWT não autoriza esta rota específica |
| Ativar canal parceiro | API key com `instances:write` e `messaging:send` |
| Eventos, endpoints e entregas de webhook | JWT `OWNER`/`ADMIN` ou chave com `webhooks:manage` |
| Controle direto Chatwoot | Chave de emissor próprio com binding e `chatwoot:read/manage/pair/disconnect` |
| Flow delegado | Contrato/sessão/grants próprios; não derivado da chave QR/texto |

`packages/contracts/src/api-keys/schemas.ts` distingue os seis scopes emitidos pelo
issuer genérico dos scopes Chatwoot reconhecidos no tipo público. Não basta editar
uma allowlist de documentação para delegar uma operação administrativa. A emissão
por API key revalida, também na transação, que a chave emissora conserva os scopes
de parceiro solicitados (`modules/api-keys/service.ts`).

`scripts/docs/public-api.mjs` publica quatro perfis: mensageria (7 operações),
eventos (5), instâncias (7), controle Chatwoot vinculado (15). São 19 operações
genéricas e 15 de controle nesta revisão, não meta fixa para as próximas entregas.
O contrato dos dois modos e suas responsabilidades está em
[integration-modes.md](../api/integration-modes.md).

**Publicação não é firewall:** `messaging:read` também passa pelos guards GET
existentes de consulta de templates/status e diagnóstico QR que não integram o
catálogo público genérico. `tests/partner-api-route-policies.test.mjs` identifica
nove GETs de mensageria. A exclusão do catálogo não prova recusa HTTP; documentar
ou restringir expressamente a superfície antes de ampliar a promessa do parceiro.

## Texto, recibos e eventos

`modules/messaging/partner-text.ts` exige canal do mesmo tenant,
`BROKER_TRANSPORT` e provider `BAILEYS`, valida destinatário E164 ou conversa do
canal, realiza takeover humano e grava a outbox. Idempotência inclui tenant,
canal, chave e hash do corpo com a identidade da API key. O despacho revalida
autoridade, complementada pela migration `0071_partner_messaging_authority.sql`.

HTTP 202 representa admissão na fila. `message-state.ts` distingue `ACCEPTED`,
`SENDING`, `SENT`, `DELIVERED`, `READ`, `FAILED`, `UNKNOWN` e impede regressões
como `READ` para `SENT`/`FAILED` ou `DELIVERED` para `SENT`/`FAILED`. `UNKNOWN`
aceita recibo posterior e não autoriza novo envio cego. `qr-events.ts` normaliza
ACKs QR; `repository.ts` persiste recibos e trata recibo anterior ao ACK de envio.
Isso não comprova a política geral de estados do Rails do host.

`modules/integrations/chatwoot-worker.ts` projeta estados de saída com IDs remotos
persistidos, agrega mensagens irmãs e revalida antes do efeito externo.
`chatwoot-client.ts:updateMessageStatus` envia `status` e erro canônico por PATCH.
Aceite local não prova que a versão instalada do Chatwoot aceita esse contrato.

`0070_partner_events.sql` e `modules/partner-events/` fornecem captura durável,
cursor ordenado após commit, entrega com lease e HMAC, retry limitado e retenção.
O contrato registra quatro tipos (`message.received`, `message.created`,
`message.status`, `connection.status`), retenção de 30 dias e cursor expirado 409.
Eventos históricos não devem aparecer como nova mensagem acionável. Revogar API
key não revoga automaticamente o endpoint de webhook; desligamento precisa das
duas revogações. Não foi verificado worker real nesta análise.

## Mídia e armazenamento

Existe backend privado durável S3 compatível; não é uma implementação ausente.
`private-media-config.ts`, `private-media-runtime.ts`, `private-object-store.ts`,
`durable-private-media.ts` e `media-store.ts` implementam configuração por ENV,
objetos cifrados, referências por organização/canal/mídia/operação, integridade,
quota combinada de inline e reservas privadas e reconciliação de PUT `UNKNOWN`.
O padrão é `postgres`; configurar S3 não migra objetos inline históricos.
O perfil atual exige bucket dedicado e controles de segurança verificados pelo
adapter. Produção exige HTTPS; MinIO loopback é perfil explícito de teste.

A API pública oferece GET de mídia, sem upload/envio genérico de parceiro.
Uploads internos de automação não constituem contrato público equivalente.
`messaging.ts` repete os guards de leitura imediatamente antes de liberar bytes
e headers, cobrindo revogação durante I/O. O store privado verifica contexto,
estado e integridade antes/depois da leitura; callers internos podem fornecer
callback de autorização. Não foi reproduzida falha de revogação de bytes.

Permanecem lacunas: autorização por inbox/operador nestas rotas; configuração
administrativa utilizável e representação do valor efetivo; uso/quota reais na
consulta operacional (`readOperationalLimits` devolve `storageBytes: null` e
`aiTokens: null`); contrato explícito de cópia/referência no Active Storage do
host; restore conjunto no ambiente alvo. Não apresentar ENV salvo no frontend
como configuração aplicada ao runtime.

## Verificação e dependências

Suítes existentes para o próximo lote:

| Escopo | Arquivos/gate | Dependência |
| --- | --- | --- |
| Guards, bytes e scopes | `apps/api/tests/http/messaging.test.ts`, `partner-webhooks.test.ts`, `partner-activation.test.ts`; `apps/api/tests/unit/partner-text.test.ts` | Node/dependências locais; serviços sintéticos |
| Contrato e catálogo | `tests/public-api-documentation.test.mjs`, `partner-api-route-policies.test.mjs` | OpenAPI atual e fontes locais |
| Autoridade e recibos | `apps/api/tests/integration/partner-messaging.test.ts`, `partner-authority-fence.test.ts`, `partner-events.test.ts`, `messaging-storage.test.ts` | `TEST_DATABASE_ADMIN_URL` explícita; helper cria banco descartável e aplica migrations sob lock de roles |
| Mídia privada | `private-media-facade.test.ts`, `durable-private-media.test.ts`, `private-media-inventory.test.ts` em integration | PostgreSQL de laboratório com roles |
| Objeto real | `npm run test:storage:ci` / `apps/api/tests/storage/private-media-minio.test.ts` | Binário MinIO fixado e verificado, ENV `TEST_STORAGE_*`, bucket de teste e PostgreSQL |
| Aceite externo | Ida/volta, mídia, recibos, dedupe/restart, isolamento A/B | Versão real CCLX/JRC, BFF, HTTPS/callback autorizado, número/ativo de laboratório e imagem/schema verificados |

Não executar `db:migrate:test` por confiar no nome: ele chama o migrator normal.
Esta análise não executou migrações nem conectou a banco remoto.

## Próximas três entregas pequenas

1. Formalizar política de mensageria por operador/inbox e superfície da chave,
   com RED HTTP de acesso cruzado e revogação; reaproveitar membership/RLS e
   autoridade de recurso sem renomear roles. Aceite: lista, metadados e bytes
   respeitam a mesma concessão.
2. Acrescentar upload e envio de mídia do parceiro com scope/contrato explícitos,
   reutilizando store, outbox e recibos. Aceite: MIME/tamanho/quota, isolamento,
   idempotência, perda de ACK e revogação antes do despacho, sem retry cego.
3. Expor diagnóstico sanitizado de storage e entregas com valor efetivo/escopo,
   ligando às operações existentes. Aceite: uso real, backend indisponível,
   `UNKNOWN`, cursor expirado e configuração que exige reinício são distinguíveis.

Verificação executada nesta entrega documental:

- `node --max-old-space-size=768 node_modules/vitest/vitest.mjs run tests/public-api-documentation.test.mjs tests/partner-api-route-policies.test.mjs --maxWorkers=1`: 2 arquivos, 12 testes aprovados, duração 5,82 s. Verifica catálogo/contratos locais; não chama provider nem consumidor real.
- `git diff --check -- docs/validation/2026-10-29-api-baseline.md docs/api/integration-modes.md`: sem erros. Como os arquivos são novos, a conferência final também deve incluir seu conteúdo no diff staged/review antes de commit.
- Integração PostgreSQL, storage real, provider e homologação externa: não executados neste sublote de descoberta/documentação.
