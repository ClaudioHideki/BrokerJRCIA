# Estado real da plataforma — Broker 2, fase 0

Data: 30/10/2026. Base inspecionada: `BrokerJRCIA-source-audit/.worktrees/image-release-20260924`; HEAD confirmado nesta frente: `d1b66a56fe6d4f9202969784301abdf61490db45`. Inspeção do código em leitura; nenhuma alteração produtiva, replay, carga ou nova consulta ao servidor por esta frente.

## Conclusão

A publicação da Fase 2 tem evidência documental reconciliada. A plataforma possui API, console, filas SQL, isolamento por organização, adapters, automações, custódia declaratória e replay de webhook parceiro. Isso ainda não comprova uma jornada integral de atendimento nem capacidade de 400/900 sessões. O estado global é **PARCIAL**, com bloqueadores internos JRC e provas finais específicas do cliente.

## Hierarquia de provas

| Prova | Evidência | Limite |
|---|---|---|
| Código atual | HEAD acima, arquivos lidos diretamente | Presença de implementação não comprova runtime |
| Testes desta frente | 3 arquivos, 6 testes, exit 0, 10,56 s: chatwoot-health, chatwoot-control-auth, ConnectionHealthSummary | Unitários/jsdom; sem PG, engine ou CCLX |
| Testes anteriores de 30/10 | code-focused-tests.log: 14 arquivos/173 testes; simulator-tests-green.log: 36 testes | Evidência reutilizada, não reexecutada nem somada aos seis |
| CI da release | ci-verificado.log e relatório consolidado; run40997560465, SHA d1b66a | Log anterior verificado pelo executor original; não nova consulta GitHub |
| Publicação | servidor-evidencias.md: API/web por digest e journal77 | Fotografia 30/10 perto de12:06–12:15UTC, não estado em tempo real |
| Jornada funcional | Smoke SQLite com8 eventos e1 mídia; testes de serviços isolados | Não representa ponta a ponta Broker→CCLX real |
| Escala e recuperação | Planos e código de laboratório | 400/900, restore integral e HA ainda NÃO VERIFICADOS |

A fonte das fotografias é `evidencias/baseline-20261030/RELATORIO-CONSOLIDADO.md` e seus anexos. Nenhuma contagem foi apresentada como atualizada nesta fase.

## Situação por domínio

- **API/contratos — PARCIAL:** HTTP Fastify e contratos compartilhados existem; canonical inclui recibos/replay. Perfis públicos, documentação anterior e jornadas de operação ainda precisam reconciliação.
- **Integração Chatwoot — PARCIAL:** vínculo, identidade, callback e evidência de transporte são separados. Campo READY indica configuração, não operação efetiva.
- **Mensageria — PARCIAL:** outbox/leases/idempotência existem. UNKNOWN exige reconciliação; reexecutar como nova mensagem pode duplicar efeito.
- **Origem Evolution — PENDENTE no B02:** retry finito em memória, sem outbox atômica comprovada na origem; equivalência da imagem/fonte ainda não atestada.
- **Custódia — PARCIAL:** recibo declaratório existente, KEEP obrigatório, physicalStorageVerified=false; não há autorização implícita de exclusão.
- **Infraestrutura — PARCIAL:** artefatos de release conferidos anteriormente, backups Dokploy vazios na fotografia; eventual rotina externa não verificada.
- **Operação — PARCIAL:** diagnóstico mistura histórico de falhas com saúde presente; filas e catálogos exigem tratamento por pré-condição.
- **Capacidade — NÃO VERIFICADA:** quantidades de sessões e limites de container não são benchmark.

## Incidentes conhecidos, com tabela correta

A fotografia de 30/10 registra em **integration_jobs** 396 FAILED,4 UNKNOWN,1382 PENDING e3686 SUCCEEDED. A tabela partner_event_deliveries estava vazia. Portanto B12/replay de webhook parceiro não é solução direta para esse backlog.

233 falhas eram GROUP_CENTRAL_SCOPE_CHANGED no agrupamento anterior ao total396;119 exigiam configuração da política de atendimento. Quatro UNKNOWN em SEND_MESSAGE não provam ausência de entrega. Caixa1 conectada apresentava catálogo vencido e zero grupos selecionados. Isso sustenta investigar pré-condições; não autoriza mudança de escopo, seleção de grupos ou replay automático.

## Documentos procurados e contexto

Foram encontrados `docs/auditoria-900/00..14`, anexos e fase-2, parte untracked. O parecer14 corresponde a baseline anterior. Não foram localizados arquivos nomeados GO400, Ready900 ou CEO no checkout e root/output pesquisados com rg --files. Isso significa “não localizado nos locais pesquisados”, não inexistência universal. Não inventar um parecer favorável nem transformar título de auditoria900 em aprovação de900.

## Saída da fase 0

Aceite: inventário rastreável por SHA; piloto pequeno com teste que falhe antes e passe depois; documentação das fronteiras; plano de infraestrutura com execução isolada; jornada de operador testada em browser; diferenças entre testes locais, CI, publicação e produção explicitadas. O piloto não elimina automaticamente os bloqueadores B02/backup/capacidade.
