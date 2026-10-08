# Broker independente, Flow e centrais — plano de desenvolvimento

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans para executar os incrementos nesta sessão, tarefa por tarefa. Não delegar automaticamente. Usar checkboxes e evidências por entrega.

**Goal:** Entregar atendimento e automação no Broker independente, JRC Conversas multitenant e Chatwoot externo compatível, incluindo sincronização do aparelho, grupos e trilha de voz.
**Architecture:** Um runtime Broker com adaptadores de transporte e central. Interfaces Flow/QR consomem seus contratos. Propriedade de atendimento e efeitos externos têm operações persistentes e reconciliáveis.
**Tech Stack:** Node 24.19.0, TypeScript, Fastify, PostgreSQL/Drizzle, Redis, React/Vite, Zod, Vitest, Playwright.
**Spec:** [Desenho deste programa](../specs/2026-10-05-broker-independente-centrais-design.md).

## Restrições globais

- Um único executor de bot por caixa.
- RLS e escopo de organização obrigatórios; IDs externos não autorizam acesso.
- Nenhuma chamada externa dentro de transação de banco.
- Não reenviar resultados desconhecidos sem reconciliação.
- Reutilizar implementações existentes e lockfile.
- Nenhum segredo, telefone ou payload real em Git.
- Motor no Broker primeiro; homologação final após interfaces na central.
- Desenvolvimento local, CI e implantação são estados distintos.
- Release de produção exige tarefa explicitamente aprovada.

## Entrega na main por incremento

Decisão do usuário em 06/10/2026: cada incremento concluído e validado deve ser integrado à main, que é a referência do servidor. Reutilizar o checkout atual; não criar branches adicionais para novas etapas nem publicar imagens de entrega a partir de branches de desenvolvimento. Os incrementos P2 já existentes serão integrados após fechar os gates pendentes. Para cada entrega, registrar SHA da main, CI e digests das imagens API/web geradas daquela revisão. O usuário aplica esses digests no Dokploy; código na main, imagem publicada e servidor atualizado são verificações separadas. Um incremento parcial não encerra os critérios pendentes da fase completa.

### Atualização de 08/10/2026

O usuário autorizou acelerar a execução do programa até P10. Frentes independentes são trabalhadas em paralelo, com contratos, locks e migrações compartilhados integrados pelo responsável pelo checkout. A entrega continua diretamente na main e as imagens continuam vinculadas ao SHA testado.

Primeiro corte publicado: main `88215efce00c0c0ccad545add1044ae0773429dd`, [CI aprovado](https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/37784175688) e [imagens aprovadas](https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/37787050397), baseline 0049. Ele acrescenta espera persistida, agenda, importação com credenciais locais, observações de saída do aparelho, pools/diagnóstico e registro offline de homologação. Os manifests API/web foram conferidos no GHCR. A instalação efetiva desta revisão não foi observada pelo agente.

G1, catálogo de grupos, foi publicado na main `386103cd94982680a3a0e08e93231387b3897945`: [CI aprovado](https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/37815849855), [imagens aprovadas](https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/37817442029) e manifests conferidos no GHCR, baseline 0050. A instalação desta revisão não foi observada. S3 durável, eventos de grupos, tratamento de incerteza HTTP e autorização/cutover dos módulos centrais são frentes seguintes. Ver [próximos incrementos P3–P10](2026-10-08-broker-proximos-incrementos-p3-p10.md) e [evidências G1](../../validation/2026-10-08-whatsapp-grupos-g1.md). Os checkboxes históricos abaixo não são um certificado de homologação. P10 exige as jornadas reais e os tenants adicionais adiados pelo usuário; disponibilidade HTTP e testes sintéticos não encerram o programa.

## Foco da revisão

1. Humano responde durante retomada ou I/O: bloquear bot — P1.
2. Mesmo account_id/inbox_id em dois hosts: não cruzar dados — P2.
3. Eco do envio chega antes do retorno HTTP: não duplicar/atribuir humano erroneamente — P4.
4. Central cai após escrita aplicada: não reenviar nem declarar sucesso — P1/P8.
5. Token ou módulo é revogado com tela aberta: próxima ação negada — P2/P9.

## Base e diferença para o plano anterior

Código local observado: eb577ac, branch codex/broker-ura-reset-integration-20261005, com URA/reset integrados localmente.
Baseline de referência do servidor: 135bd952 informado e previamente verificado no CI; conferir digest efetivo antes de promover.
A pasta não versionada backup-135bd952-8415-20896/ deve ser preservada e não incluída em commits.
O inventário remoto e backup Redis ainda não estão fechados.
Não usar contagem histórica de testes como aprovação atual.

Este programa coordena os planos R/U/A de 29/09 e acrescenta os requisitos de 05/10.
Voz e grupos WhatsApp são novas trilhas. Grupos econômicos/administração existentes continuam cobertos em A1–A8.
Primeiro incremento executável detalhado: [P1](2026-10-05-broker-retomada-coordenada.md).

## Sequência e critérios de saída

| Etapa | Dependência | Entrega verificável | Saída |
| --- | --- | --- | --- |
| P0 Base e operação | nenhuma | Inventário, regressões, migrations e plano de restore | Candidato de código identificado; ambiente de teste reproduzível |
| P1 Atendimento | P0 local | Retomada coordenada, diagnóstico e primeira jornada humana | Bot → time → agente → bot sem concorrência |
| P2 Independência e tenants | P1 | Catálogo local/remoto, wizard, isolamento e ambos transportes | Jornada em standalone, JRC A/B e Chatwoot externo |
| P3 Flow completo | P1/P2 | Blocos, JSON, validação, simulação e executor | Cada bloco publicado funciona com falha/timeout tratados |
| P4 Aparelho | P1/P2 | Saída observada, eco e sincronização | Mensagem do aparelho aparece uma vez e interrompe bot quando aplicável |
| P5 Grupos WhatsApp | P2/P4 | Listagem, opt-in, participantes e envio | Grupos selecionados isolados por conexão/empresa |
| P6 Voz | P2 e prova externa | Capacidade por provedor, sessões e interface de chamadas | Chamada real com áudio bidirecional e registro |
| P7 Administração | P0/P2 | Fechar A1–A8 existentes | Papéis, módulos, suporte, limites, exclusões e auditoria comprovados |
| P8 Release Broker | P1–P7 por perfil | CI, contratos, upgrade, restore e piloto do console | BROKER_CORE_VALIDATED, com capacidades explícitas |
| P9 Flow/QR na central | P8 | Interfaces delegadas e cutover de executor | Mesmos fluxos e permissões nos pontos de entrada |
| P10 Homologação final | P9 | Jornada completa do cliente e operação assistida | RELEASE_VALIDATED por versão/provedor/modo |

P6 pode ter prova de viabilidade antecipada; isso não autoriza anunciar voz como pronta.
Release parcial QR/texto pode existir com escopo explícito. Não encerra P5/P6 nem o programa completo.

## P0 — base, recuperação e rastreabilidade

Arquivos existentes: docs/validation/2026-10-05-ura-reset-integrated.md, infra/dokploy/compose.yaml, apps/api/src/db/runtime-schema.ts e docs/validation/broker-first-baseline.md.

- [x] Ler AGENTS, planos anteriores e código local; separar baseline instalado de patches.
- [x] Reexecutar seis arquivos focados: 27 testes locais aprovados em 05/10, sem validação de produção.
- [ ] Reconciliar HEAD local com main remota atual antes de integrar código.
- [ ] Identificar imagens efetivas e digests de Broker API/web/workers, JRC e Evolution; registrar diferença para configuração declarada.
- [ ] Ler journal/hash das migrations com papel apropriado e sem modificar produção. Probe de baseline não substitui o journal.
- [ ] Conferir flags nos processos pertinentes; registrar somente nomes e valores não secretos.
- [ ] Inventariar PostgreSQL, Redis, storage de mídias, sessão Evolution e configuração protegida; provar restauração em laboratório.
- [ ] Tratar rotação das credenciais expostas nas capturas por procedimento próprio, especialmente chaves que cifram dados; não substituir chaves de criptografia sem migração.
- [ ] Reservar migrations após o último journal real; nunca assumir que 0042/0043 locais já estão aplicadas.
- [ ] Concluir pacote de release com diferença de schema e retorno seguro. Usuário opera Dokploy por comandos orientados, sem exigir acesso ao terminal do host.

## P1 — corrigir retomada, controle e diagnóstico

Executar o plano detalhado vinculado. Reutilizar R4/R5/R8 e o handoff local.
Aceite: sessão legada sem attendance_sessions pode iniciar ciclo novo explicitamente; botão não mostra BOT enquanto controle remoto bloqueia; nenhuma mensagem antiga é reproduzida para provar funcionamento.
A primeira automação de teste precisa conter transferência real. A automação de seis blocos anterior apenas imprimia a opção; não prova handoff.

Implementação local verificada: operação durável, coordenação, diagnóstico e interface entregues; 1.732 testes unitários/HTTP/UI, 504 integrações e 37 E2E aprovados (cinco omissões por perfil documentadas). [Registro específico de P1](../../validation/2026-10-05-broker-retomada-coordenada.md). O aceite externo continua pendente e não encerra P0 remoto, P2–P10 ou a homologação final.

## P2 — modos, onboarding e isolamento

Arquivos existentes: packages/contracts/src/attendance-v1.ts, attendance-catalog.ts; apps/api/src/modules/attendance/repository.ts; modules/integrations/chatwoot-{destination,onboarding,compatibility,attendance-service}.ts; apps/web/src/pages/{Integrations,ConnectionDetail,Messaging}.tsx.
Novos módulos propostos: apps/api/src/modules/attendance/local-catalog.ts e destination-adapter.ts, com testes homônimos em tests/unit e tests/integration.

- [ ] TDD: standalone com nenhuma central executa menu, captura e transferência local; central configurada indisponível não é tratada como standalone.
- [ ] Separar escopo local de AttendanceScope remoto, preservando contrato versionado; não preencher IDs fictícios de Account/Inbox.
- [ ] Implementar catálogo/destinos locais sobre usuários e memberships do Broker, fila e atribuição manual; sem algoritmo novo de distribuição automática neste primeiro incremento.
- [ ] Wizard valida conta, caixa, bot, webhook e capacidades com diagnóstico seguro; referência revogada exige remapeamento.
- [ ] Testar instalação A/account1/inbox1 e instalação B/account1/inbox1 com tenants diferentes, inclusive mídia, jobs e troca de organização na UI.
- [ ] Adaptar CENTRAL_TRANSPORT para o mesmo runtime, preservando BOT/HUMAN e origem do envio; remover execução paralela legada por cutover por caixa.
- [ ] Testar duplicata entre webhook de bot e webhook de integração, papéis revogados, replay, assinatura inválida e URLs não autorizadas.
- [ ] Executar integração real com JRC tenant A/B e instalação Chatwoot externa de teste; registrar versão exata suportada.
- [ ] Revisar diff, contratos e testes; commit focado após suíte obrigatória.

## P3 — Flow e importação

Reutilizar planos U1–U7/R6/R7, packages/contracts/src/automation-node-definitions.ts, automations-v1.ts e apps/web/src/pages/AutomationStudio.tsx.

- [ ] Inventariar cada bloco como formulário/contrato/executor/simulador/teste; não disponibilizar só o desenho.
- [ ] Completar menu, pergunta, condição, variável, horário/fuso, silêncio, mídia e fim; testar duas mensagens rápidas e reinício na espera.
- [ ] Completar transferência, nota, etiqueta, atributo e resolução com destinos reais e falhas visíveis.
- [ ] Completar HTTP restrito e IA de atendimento: credencial tenant, timeout, limite de resposta/custo, fallback humano e proteção contra instruções em conteúdo externo.
- [ ] Publicar esquema JSON JRC e exemplos sanitizados. Importar como rascunho; impedir execução de JS arbitrário.
- [ ] Classificar capacidades dos JSON Jade/n8n, converter somente nós compatíveis e exigir remapeamento de referências.
- [ ] Testar export/import preservando semântica, versão desconhecida, ciclos inválidos, grafo inacessível e credencial inexistente.
- [ ] Testar canvas por teclado, zoom/arraste, campos de erros e simulação; comparar trilha do simulador com execução controlada.
- [ ] Validar versão imutável e rollback de binding sem alterar sessões em andamento.

## P4 — sincronizar mensagens enviadas no aparelho

Existentes: apps/api/src/modules/messaging/{qr-events,qr-service,repository}.ts e modules/integrations/chatwoot-worker.ts.
Proposto: modules/messaging/outbound-observation.ts; unit/outbound-observation.test.ts; integration/qr-outbound-observation.test.ts.

- [ ] Escrever testes para fromMe do aparelho, eco do Broker antes/depois do ACK, duplicata e histórico.
- [ ] Persistir saída observada com provider ID, escopo, origem e estado; correlacionar com outbox antes de classificar humano.
- [ ] Espelhar sem reenviar ao WhatsApp; preservar autoria observada sem inventar agente.
- [ ] Incorporar pausa humana confirmada, mídia e eventos fora de ordem.
- [ ] Testar envio pelo Broker, pela central e pelo aparelho na mesma conversa; cada mensagem aparece uma vez em cada histórico esperado.
- [ ] Manter saída incerta em reconciliação e indicar limitação de origem quando provedor não permitir diferenciá-la.

## P5 — grupos WhatsApp

Reutilizar packages/providers/src/evolution/evolution-provider-adapter.ts e mensageria QR.
Propostos: packages/contracts/src/whatsapp-groups.ts; apps/api/src/modules/whatsapp-groups/{service,repository}.ts; apps/api/src/http/routes/whatsapp-groups.ts; apps/web/src/pages/WhatsAppGroups.tsx.

- [ ] Testar consulta de grupos por instância autorizada e credencial exclusivamente no servidor.
- [ ] Modelar grupo e participante, JID opaco, vínculo tenant/número, paginação/limites e observação temporal.
- [ ] Implementar habilitação explícita e bot desligado por padrão; limitar gatilhos para evitar respostas a toda mensagem.
- [ ] Suportar entrada/saída/mídia compatível e mudanças de participantes/permissões.
- [ ] Definir representação na central por adaptador e provar autoria; bloquear recursos não suportados sem misturar grupos e contatos individuais.
- [ ] Homologar dois grupos e duas empresas; saída do número do grupo revoga envio.
- [ ] Executar testes de privacidade, deduplicação, reinício e loop de automação.

## P6 — chamadas WhatsApp

Nova trilha, sem implementação comprovada. Caminhos propostos apenas depois da prova: packages/contracts/src/whatsapp-calls.ts; apps/api/src/modules/whatsapp-calls/; apps/web/src/pages/WhatsAppCalls.tsx.

- [ ] Verificar elegibilidade do número, provedor, versão/edição da central, consentimento e suporte de mídia.
- [ ] Produzir prova de laboratório de uma chamada com áudio nos dois sentidos. Evento de chamada isolado reprova essa prova.
- [ ] Registrar decisão de transporte de voz e contrato do adapter antes de implementar controlador.
- [ ] TDD dos estados: aguardando permissão, tocando, conectando, ativa, encerrada, falha; isolar tenant/agente.
- [ ] Implementar sinalização, browser media, autorização, término, timeout, ocupado e registro. Gravação não entra implicitamente neste escopo.
- [ ] Testar recusa, perda de rede, duas chamadas concorrentes, revogação e histórico em Broker/JRC/Chatwoot compatível.
- [ ] Publicar capacidade por número; número QR sem prova de voz permanece indisponível.
- [ ] Concluir ou declarar bloqueio externo concreto, sem marcar etapa concluída por botão visível.

## P7 — administração e operação

Continuar A1–A8 de 29/09, sem confundir grupos econômicos com grupos WhatsApp.

- [ ] Testar empresas, memberships, grupos econômicos, limites/módulos, suporte, reset e revogação de sessão.
- [ ] Verificar notas privadas e mídias por papel e caixa, inclusive usuário pertencente a mais de uma empresa.
- [ ] Homologar archive/desconexão/exclusão com prévia de impacto e preservação remota.
- [ ] Validar consumo/limites e suspensão nos workers; não aceitar novos efeitos de tenant suspenso.
- [ ] Validar administração privilegiada e auditoria sem acesso global implícito a conversas.

## P8 — candidato do Broker

Escala acrescentada em 06/10: 500 empresas, até 10.000 conexões QR/Meta e perfil de empresa com 250.000 conversas/mês. Executar também o [plano de capacidade e operação](2026-10-06-broker-capacidade-operacao.md). Capacidade demonstrada exige medir conexões ativas, mensagens, mídia, pico e recuperação; o total cadastrado isoladamente não comprova throughput. Antecipar o levantamento e a instrumentação durante P2–P7; executar carga após integrar os caminhos funcionais e antes da expansão comercial.

- [ ] Rodar build, typecheck, unitários, HTTP, PostgreSQL/Redis, E2E, contratos, imagens e controles de release existentes.
- [ ] Testar upgrade de banco vazio e de cópia sanitizada da versão instalada; preservar journal.
- [ ] Provar restore, recuperação de fila e sessão; não prometer exatamente uma entrega em efeito UNKNOWN.
- [ ] Testar indisponibilidade da central/provedor, assinatura inválida, reentrega, retomada de worker e backlog por empresa.
- [ ] Executar matriz do documento de validação e anexar evidências por perfil.
- [ ] Homologar cada entrega funcional no servidor usando a caixa exclusiva de testes; publicar configuração e procedimento de ativação. Componentes internos parciais não encerram a fase nem justificam anunciar operação completa.
- [ ] Medir capacidade e recuperação da infraestrutura e registrar o limite observado por perfil, sem confundir sessão QR simulada com conexão WhatsApp real.
- [ ] Congelar commit/digests, release notes, flags e rollback por comportamento. Não reverter banco cegamente.
- [ ] Preparar comandos revisáveis de Dokploy com mudança mínima; deploy só na tarefa de release aprovada.

## P9 — módulos Flow e QR na central

Comparar código do host com branch codex/global-quick-actions-20260930, commit 80f7305 e imagem efetiva antes de editar. Não usar snapshot antigo como código instalado.

- [ ] Reutilizar Conexões/Flow Rails como interface; retirar execução concorrente por canal com cutover testado.
- [ ] Flow usa catálogo/esquema Broker, sessão delegada curta, scopes de edição/publicação/vínculo separados e revogação.
- [ ] QR usa APIs/grants já existentes, identidade, reconexão e QR temporário; não entrega chave Evolution ao navegador.
- [ ] JRC recebe navegação nativa; Chatwoot externo recebe integração de interface compatível com a versão (Dashboard App/portal quando aplicável).
- [ ] Testar XSS/origem/iframe, troca de conta, token expirado, agente sem grant e logout.
- [ ] Rodar a mesma jornada primeiro pelo Broker e depois inteiramente pela central; resultados/catálogos devem coincidir.

## P10 — homologação final e operação assistida

- [ ] Executar todos os cenários obrigatórios do perfil na jornada que o cliente utilizará.
- [ ] Confirmar recebimento no dispositivo, histórico na central, atribuição, pausa, resolução e retomada.
- [ ] Registrar incidentes, tempos e reprocessamentos durante janela controlada de piloto.
- [ ] Publicar matriz de versões/canais/capacidades, runbook de suporte, onboarding e limitações.
- [ ] Aprovar release apenas com evidência externa; SKIPPED/BLOCKED não é PASS.
- [ ] Revisar perfil após upgrade de Chatwoot/JRC/Evolution; compatibilidade não é permanente.

## Modelo de desenvolvimento recomendado

Recomendação de trabalho, não benchmark realizado neste repositório:
- GPT-6 Astra / Alto: arquitetura, concorrência, multitenancy, migrações e diagnóstico difícil. É a seleção mostrada no print do usuário.
- GPT-6.1 Sol / Alto: implementação cotidiana de tarefas delimitadas e testes; opção para equilibrar uso e tempo.
- Astra em esforço maior somente se a tarefa justificar; não há necessidade de usar esforço máximo em toda edição.
- Modelo do agente de desenvolvimento não define o modelo de IA dos chatbots do produto. URA/menu/transferência são determinísticos.
- [Orientação oficial de seleção](https://developers.openai.com/api/docs/guides/model-selection); [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra). Consultadas em 05/10/2026.

## Registro de avanço

| Entrega | Situação em 05/10 |
| --- | --- |
| Desenho e plano incremental | Produzidos nesta sessão |
| Baseline local focado | 27 testes aprovados, seis arquivos |
| Retomada coordenada nova | Candidato local implementado e verificado; aceite externo pendente |
| Bot real com transferência | Não homologado |
| Mensagens do aparelho / grupos | Lacunas confirmadas no normalizador atual |
| Voz | Depende de prova específica |
| Novas interfaces centrais | Planejadas |
| Nova implantação | Não realizada |
