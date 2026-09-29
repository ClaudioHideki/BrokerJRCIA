# Execução do plano de produto — 29/09/2026

Este registro descreve o incremento implementado no checkout de desenvolvimento, com as evidências disponíveis em 29/09/2026. Não declara concluído o plano completo nem comprova atualização do servidor.

Base auditada no início da execução: `a060fc182bbc10f0acf399e5a9dc537aaa63dceb`, confirmada em `origin/main` por fetch naquela etapa. Branch de trabalho: `codex/broker-product-completion-20260929`. Autorização: solicitação do usuário “execute o plano”. A promoção desta branch, a CI remota, a publicação de imagens e o deploy deste incremento ainda não estão comprovados neste registro.

## Escopo implementado

### Flow: edição, disponibilidade e execução

- Rascunhos podem ser consultados e, por proprietário/administrador de empresa ativa com o módulo habilitado, criados, editados, importados e simulados com `AUTOMATION_RUNTIME_V2_ENABLED=false`.
- O status distingue pausa global, empresa inativa, módulo desabilitado, papel sem permissão e dependência indisponível. A listagem não transforma a pausa global em um 503 genérico.
- Publicação, ativação de vínculo e transição do runtime legado verificam a disponibilidade no servidor. API, worker de mensagens, execução, I/O e scheduler respeitam a pausa; entrada V2 pendente não é silenciosamente concluída sem executar o bot.
- A publicação exige schema/Redis disponíveis e os quatro componentes de execução com heartbeat `UP` de até 45 segundos. A consulta de dependências tem prazo de dois segundos e não mantém uma transação do tenant aberta durante a consulta externa.
- O simulador aceita uma sequência de respostas para menu, captura, condição e transferência. Não executa HTTP, SQL, IA, sandbox ou espera real; sinaliza a necessidade de homologação ao chegar a esses efeitos.
- O teste nativo em PostgreSQL percorre rascunho, revisão, publicação, vínculo e execução persistida, incluindo isolamento, evento repetido e retomada por um novo worker. O transporte nesse teste é controlado.

O passo a passo e os limites estão em [Flow: disponibilidade e teste](../operations/flow-disponibilidade-e-teste.md). Catálogo completo, formulários avançados e equivalência de workflows externos continuam pendentes.

### Conexões, central e exclusão

- As jornadas de empresa e administração tornam mais explícitas a conexão WhatsApp, a central de atendimento, a caixa de destino e a automação. Configuração de destino não é prova de entrega WhatsApp.
- Há ações e confirmação de exclusão definitiva de conexão e empresa, com prévia de impacto e operação persistente. Desconectar, arquivar, desvincular uma central e excluir têm efeitos distintos.
- A exclusão passa por bloqueio, limpeza externa e remoção de dados. Falha na limpeza ou autorização revogada exige atenção; não resulta em sucesso fictício. A operação utiliza lease e autorização persistida, executada pelo serviço exclusivo `lifecycle-worker`.
- A role `jrc_lifecycle` é separada de API, autenticação e administração. Não é superusuária e não ignora RLS. As funções de purge verificam o contexto da operação; o runtime comum não recebe permissão geral de exclusão.
- Account, Inbox e histórico existentes no JRC Conversas/Chatwoot externo não são apagados automaticamente pela exclusão no Broker. A exclusão local também não promete apagar uma WABA na Meta.

As migrações deste incremento são `0032_lifecycle_deletion.sql` e `0033_support_tickets.sql`, executadas pela manutenção antes de iniciar os novos serviços. A criação das roles foi incorporada ao `runMigrations`, usando `infra/app/postgres/init-roles.sql`; não depende apenas da inicialização de um volume PostgreSQL vazio.

O outro repositório e o servidor de produção não foram alterados. O pacote da central deve seguir o [handoff do conector](../operations/jrc-conversas-connector-handoff.md).

## Evidência parcial de segurança

Testes executados com falha antes e sucesso após a correção:

- HTTP: redirects com corpo entre origens recusados; cabeçalhos customizados removidos nas mudanças de origem; prazo cobre DNS.
- SQL: endereços privados e respostas DNS mistas recusados; opções de URL que alteram TLS recusadas; conexão usa IP resolvido e valida o hostname original.
- Credenciais: transação encerrada antes do teste externo; teste de revisão antiga não marca segredo novo como validado; limite de concorrência local e orçamento por empresa no Redis.
- Ingresso: limite antes de parsing/consulta ao banco, chaves HMAC, isolamento por família de webhook, falha fechada e Retry-After.
- OpenAPI: rotas exclusivas de sessão JWT não anunciam chave de API; configuração pública do login administrativo documentada sem sessão.

Os testes focais de rede usam dependências controladas. O PostgreSQL real foi utilizado nas jornadas explicitamente indicadas abaixo. Isso não é pentest de produção nem homologação dos providers externos.

## Evidência de validação disponível

Resultados comunicados pelo executor principal após as últimas correções desta frente. As linhas são lotes de execução; não devem ser somadas como total de testes únicos.

| Validação | Resultado comprovado | Alcance |
|---|---|---|
| Flow focal | 9 arquivos, 46 testes aprovados | Disponibilidade, gates, serviço, rotas e interface relacionados ao incremento |
| Jornada nativa Flow em PostgreSQL isolado | 2 testes aprovados | Persistência e execução nativa; transporte externo controlado |
| Suporte em PostgreSQL isolado | 3 testes aprovados | Persistência, isolamento e comportamento dos chamados |
| Regressões de isolamento | 26 testes aprovados | Casos cobertos pelo lote; não equivale à revisão de todas as rotas existentes |
| Inventário de interface | 45 testes aprovados | Contratos e cobertura de interface do lote |
| E2E desktop e mobile | 2 cenários aprovados, com axe | Jornadas e acessibilidade dos cenários automatizados |
| Typecheck e build | Aprovados | Compilação local do código integrado nesta rodada |
| Suíte unitária completa | 222 arquivos, 1.418 testes aprovados | Execução completa local após a revisão final |
| Integração completa PostgreSQL/Redis | 52 arquivos, 298 testes aprovados | PostgreSQL 16.4 e Redis 7.4.3 locais e descartáveis; inclui migrações, lifecycle, suporte e isolamento |
| Suíte E2E completa | 31 cenários aprovados, 5 dispensados pelas condições desktop/mobile existentes | Login, QR sintético, Flow até publicação/vínculo, central, suporte, permissões e navegação |
| Gate de segurança da release | 207 rotas, zero achados no gate | Escopo das verificações automatizadas; não equivale a pentest nem ausência de toda vulnerabilidade |
| Contratos, bundle e avisos de licença | Aprovados | Validações locais da distribuição |

A revisão cruzada de autorização, isolamento e lifecycle foi concluída e suas correções passaram no lote PostgreSQL final. Após a suíte E2E, a retomada da exclusão pelo preview e o reset de estado entre conexões receberam dois testes adicionais de interface, com falha antes e sucesso depois da correção; o lote focal passou 13 testes e o build foi repetido. `npm audit --audit-level=high` retornou zero vulnerabilidades conhecidas. O ambiente local usa Node 24.16.0; a CI usa a versão fixada 24.19.0, PostgreSQL 16.4 e Redis 7.4.0 em Linux. Os dois testes de resolução e inicialização do código compilado passaram com as dependências locais de teste, após aplicar todas as migrações em um banco vazio. O Docker local não estava disponível, portanto imagem/restore não foram declarados aprovados localmente. Nenhum desses resultados comprova imagem publicada ou deploy em produção.

## Operação e configuração

`JRC_LIFECYCLE_PASSWORD` é nova e obrigatória no Compose: usar senha exclusiva aleatória com pelo menos 32 caracteres hexadecimais. A manutenção provisiona a senha da role e o `lifecycle-worker` usa a mesma variável. Não reutilizar credencial de API ou a senha de superusuário.

Opções com padrão no Compose:

```dotenv
LIFECYCLE_WORKER_INTERVAL_MS=3000
PUBLIC_INGRESS_IP_LIMIT_PER_MINUTE=6000
PUBLIC_INGRESS_RESOURCE_LIMIT_PER_MINUTE=6000
SUPPORT_RESPONSE_HOURS=24
AUTOMATION_RUNTIME_V2_ENABLED=false
```

O primeiro limite é por origem IP e família de webhook; o segundo é por recurso dentro dessa família. Ajustar por tráfego medido e IPs compartilhados do provider. São somados entre réplicas por Redis. Usar `TRUSTED_PROXY_CIDRS` somente para proxies controlados que removem cabeçalhos de origem não confiáveis. O limite de teste de credencial é 10/minuto por empresa, além de 1 simultâneo por empresa e 8 simultâneos por processo. Respostas 429/503 de webhook devem ser retomadas pelo emissor.

O suporte nativo começa com chamados e histórico textual. `/suporte` atende a empresa e `/jrc/suporte` atende a equipe JRC. Leitor consulta; operador, administrador e proprietário podem abrir/responder; a equipe JRC atribui a si e altera estado. Réplica de solicitação mantém a chave e não duplica o chamado/resposta. Uma resposta da empresa reabre o chamado e o devolve à fila JRC. A atribuição é preservada no histórico. A primeira resposta tem prazo configurável em horas corridas (1–720); esse prazo não implementa calendário de expediente nem define contrato comercial de SLA. A consulta mostra 50 chamados por página e 100 mensagens por página. Há limite de 50 aberturas por empresa em 24 horas. Anexos e avisos por e-mail/WhatsApp continuam fora deste incremento; o acompanhamento ocorre dentro do Broker. O conteúdo dos chamados é removido com a empresa pelo mesmo procedimento de purge autorizado.

Grupos econômicos continuam sendo agrupamentos administrativos. Não concedem acesso automático às empresas nem implementam faturamento consolidado.

O [roteiro de release no Dokploy](../operations/release-broker-product-20260929.md) descreve a ordem de publicação, configuração, migração e verificação. ENV com digests antigos continua executando aqueles artefatos mesmo que o Compose seja obtido da `main`.

## Pendências explícitas do plano completo

- Fechar E2E completo, testes PostgreSQL finais de lifecycle e revisão cruzada antes de promover o incremento. Registrar commit e digests reais quando existir release aprovado.
- Correlacionar o requestId da captura antiga com o log do servidor. Não houve acesso aos logs privados de produção nesta frente.
- Homologar QR/Meta/JRC Conversas com canal, conta e credenciais autorizados: ida e volta, nota privada, duplicidade de webhook, retomada e falha de provider. Domínio configurado e status `UP` não provam entrega.
- Implementar e validar o pacote da central no repositório responsável, incluindo autenticação/BFF, escopo de Account/Inbox, revogação e versão compatível. O Broker não instalou módulo na central nem alterou aquele repositório.
- Completar matriz por nó, formulários avançados, credenciais, limites e equivalência n8n/Typebot com fixtures sintéticas dos casos reais. Importar JSON como rascunho não comprova equivalência de execução.
- Completar anexos/notificações de suporte, medição comercial e requisitos de grupos, sem anunciar cobrança automática ou SLA contratado.
- Executar carga, concorrência, ordenação da outbox por turno, justiça por empresa, drenagem e recuperação de engines. O teste nativo atual despacha sequencialmente e não certifica ordenação de efeitos por múltiplas réplicas. Não há capacidade de milhares de sessões comprovada por este incremento.
- Planejar rotação das credenciais compartilhadas anteriormente usando migração/keyring onde houver dados cifrados; não substituir chaves de cifra indiscriminadamente.

O servidor e seus volumes não foram reiniciados ou excluídos nestas verificações locais. A atualização de `main`, das imagens e do ambiente deve receber evidência própria no registro de release.
