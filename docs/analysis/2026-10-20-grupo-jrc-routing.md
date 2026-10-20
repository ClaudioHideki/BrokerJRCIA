# Grupo JRC: isolamento, URAs e distribuição humana

Data: 20/10/2026. Revisão de código e evidências anteriores de homologação.
Não constitui validação completa de produção.

## Decisão de operação informada pelo usuário

Gopure, Construtora e Operadora compartilham cadastro e administração, Suporte,
Financeiro e alguns funcionários. Usar uma organização Broker ligada a uma
Account do Grupo JRC, com três canais/números e três caixas. Cada caixa tem sua
URA e suas permissões. As empresas são unidades operacionais dentro desse tenant,
não três tenants isolados.

| Origem | Caixa e URA | Comercial | Suporte | Financeiro |
| --- | --- | --- | --- | --- |
| Número Gopure | Gopure | Comercial Gopure | Suporte Grupo JRC | Financeiro Grupo JRC |
| Número Construtora | Construtora | Comercial Construtora | Suporte Grupo JRC | Financeiro Grupo JRC |
| Número Operadora | Operadora | Comercial Operadora | Suporte Grupo JRC | Financeiro Grupo JRC |

Usar os IDs reais selecionados do catálogo autorizado, nunca inferir destino
por semelhança de nome. Nenhuma dessas configurações foi aplicada ao servidor
nesta revisão.

Clientes independentes do Broker terão outras organizações, com suas próprias
Accounts/instalações, canais, credenciais e autorizações. Um número de Account
repetido em duas instalações não identifica o mesmo cliente.

## Significado das telas e ciclo desejado

1. A mensagem chega somente à caixa do número chamado. O cadastro pode ser
   compartilhado; a conversa e sua origem continuam específicas da caixa.
2. A conversa é conduzida pela URA dessa caixa, sem atribuição humana antecipada.
3. A opção Comercial usa o time da empresa de origem. Suporte e Financeiro usam
   os respectivos times compartilhados, conservando caixa e número originais.
4. O bot cede o controle, e o atendimento entra na fila humana escolhida.
5. O agente precisa pertencer à Account, à caixa e ao time, estar disponível e
   ter capacidade. Preferir menor carga aberta agregada nas caixas da Account,
   com desempate estável por rodízio. Não contar atendimentos de outro tenant.
6. Sem agente elegível, manter a fila humana e tentar atribuir quando houver
   capacidade. A espera não deve reativar a URA nem enviar menus repetidos.
7. Atribuir faz a conversa aparecer em “Minhas” para o responsável; ela continua
   pertencendo a “Todas” no escopo autorizado. Filtros não são cópias de mensagens.
8. Atribuição de time preserva a origem: Financeiro ou Suporte respondem pelo
   número chamado, mesmo que o agente atenda outras caixas.

O mesmo cliente pode falar com dois números e ter duas conversas independentes.
Não usar um campo global do contato para substituir a origem de cada conversa.
Membros compartilhados usam a mesma identidade, com permissões por caixa e time.
Administradores da Account continuam tendo o escopo administrativo compartilhado.
“Empresa do cliente” no CRM não deve ser confundida com a unidade operacional
proprietária do número. O vínculo caixa/unidade deve ser explícito e acompanhar
a conversa, relatórios e transferência.

Exemplo confirmado pelo usuário: um funcionário nas três caixas pode receber
três clientes, um por empresa, e atender todos na lista “Minhas”. Outros três
clientes continuam sendo distribuídos pela política; não precisam ir ao mesmo
funcionário. Suas permissões de time continuam valendo: pertencer às três caixas
não o torna automaticamente vendedor dos três comerciais.

Operadores não precisam ganhar contas administrativas duplicadas no Broker.
Os módulos dentro do JRC devem delegar somente o escopo da identidade atual;
administrar organizações e credenciais do Broker permanece uma permissão separada.

## Evidência no código

### Broker

- `apps/api/drizzle/migrations/0014_chatwoot_integration.sql`: Account por
  organização, unicidade da instalação + Account e vínculos canal/caixa.
- `apps/api/drizzle/migrations/0025_flow_chatwoot.sql`: vínculo ativo por caixa.
- `apps/api/src/db/tenant-transaction.ts`: transação com role `jrc_app` e
  `app.organization_id` local à transação, usada pelas políticas de isolamento.
- `apps/api/src/modules/attendance/handoff-readiness.ts`: rejeita caixa, canal,
  organização e revisão de credencial incompatíveis antes da transferência.
- `apps/api/src/modules/attendance/handoff-service.ts`: aceita time com
  distribuição conhecida e verifica o humano resultante contra time e caixa.
  Exige autoatribuição geral da caixa desligada; confirma o resultado remoto
  por leitura e não repete escrita com resultado incerto.
- O diretório standalone em `local-directory.ts` valida destinos locais, mas
  uma fila local não prova disponibilidade nem distribuição por menor carga.

### JRC Conversas

Caminhos relativos ao repositório JRC:

- `app/models/jrc_broker_integration.rb`: uma integração nativa por Account e
  organização única por origem Broker.
- `app/models/concerns/assignment_handler.rb`: ao mudar o time, intersecta
  membros da caixa e do time quando `allow_auto_assign` está ativo.
- `app/services/auto_assignment/agent_assignment_service.rb`: seleciona agentes
  online por rodízio. Este é o caminho imediato de atribuição ao mudar o time.
- `app/services/auto_assignment/assignment_service.rb`: rotina de distribuição
  retorna sem executar se `enable_auto_assignment` da caixa estiver desligado.
- `app/jobs/auto_assignment/periodic_assignment_job.rb`: varre caixas com política;
  não elimina a restrição anterior. Uma fila pós-URA sem agente precisa de
  mecanismo compatível de retomada.
- `enterprise/app/services/enterprise/auto_assignment/assignment_service.rb`:
  seleção balanceada depende de política e da capacidade `advanced_assignment`.
- `enterprise/app/services/enterprise/auto_assignment/balanced_selector.rb`:
  conta abertas somente na caixa atual. Não implementa a carga agregada proposta
  para agentes compartilhados entre Gopure, Construtora e Operadora.

Conclusão: a base de multiempresa, caixas e handoff existe. A política completa
“menor carga entre as três caixas + fila retomável após URA” não está comprovada
nem implementada por esses caminhos em conjunto.

Regressão local de 20/10: `assignment_service_spec.rb`,
`agent_assignment_service_spec.rb` e `conversations/assignment_service_spec.rb`:
27 exemplos, zero falhas, em PostgreSQL/Redis locais de teste. Os testes
validam os comportamentos existentes; não certificam a política nova acima.
A primeira tentativa não iniciou exemplos por alias DNS `postgres` ausente;
a execução concluída usou o nome real do container isolado.

## Correções necessárias e seus responsáveis

### P0 — estabilidade JRC/NICO

Os logs de 20/10 confirmam timeout Rack em 15 s, espera por conexão ActiveRecord
e verificações repetidas de permissões do histórico. Desenvolver execução de
planejamento fora da requisição web, estado durável/idempotente por pedido,
recuperação sem repetir chamadas externas incertas e redução de consultas
repetidas dentro da mesma requisição. Preservar revogação de acesso, limites,
recibos e reservas cujo consumo seja desconhecido.

Revisar pools com a concorrência real de Rails, ActionCable e Sidekiq.
Não resolver apenas aumentando timeouts ou removendo reservas.
O chat simplificado do NICO é uma alteração local anterior, ainda sem prova de
implantação na evidência consultada.

### P0 — diagnóstico Broker de tarefas de grupos

Reproduzida uma causa de HTTP 503: operações `GROUP_*` persistidas pelo worker
eram rejeitadas pelo contrato de resposta da listagem. Correção aditiva no enum
compartilhado da API e do frontend, sem aceitar strings arbitrárias, reenviar
mensagens ou alterar estados UNKNOWN.

Regressão HTTP: nove casos falharam com 503 antes da correção. Após a correção,
os seis arquivos focais passaram, totalizando 52 testes, incluindo transferência,
isolamento e leitura por VIEWER. Confirma a causa no teste; a confirmação de que
resolve o incidente instalado exige atualização e leitura do endpoint em produção.
Compilação TypeScript concluída sem erros e OpenAPI regenerado. Sem migração,
novo serviço ou variável de ambiente para esta correção.

### P1 — distribuição humana após URA

Implementar política própria configurável, sem depender de desbloquear recursos
Enterprise: rodízio ou menor carga na Account, teto de atendimentos, critérios de
disponibilidade, desempate, fila e nova tentativa quando capacidade voltar.
Reservar capacidade e atribuição atomicamente para duas conversas simultâneas não
escolherem o mesmo agente ignorando seu limite.

A distribuição só deve consumir conversas com entrega humana confirmada, nunca
conversas em triagem ou sob bot. Revalidar Account, caixa, time, disponibilidade,
permissão e autoridade humana antes da escrita; concorrência com atribuição manual
não pode sobrescrever o operador.

No JRC, reutilizar o domínio de atribuição e seus eventos. No Chatwoot externo,
usar o adaptador Account API e declarar capacidades efetivas: delegar à central
quando suportado, ou implementar coordenação explícita pelo Broker. Não oferecer
menor carga como disponível quando presença/capacidade não puderem ser verificadas.
Outros CRMs exigem adaptadores; integração Chatwoot não comprova compatibilidade
universal.

### P1 — configuração e homologação por caixa

Concluir o vínculo nativo QR/Flow por Account, selecionar três caixas e cinco
times, mostrar agentes elegíveis e motivo de exclusão, e diagnosticar credenciais,
callbacks e política antes da publicação. Um executor de bot por caixa.

Homologação restrita ao contato autorizado, sem ligar bot para todos. Testar:

- Mesma pessoa nas três caixas com URAs e destinos independentes.
- Suporte/Financeiro compartilhados e comerciais separados.
- Agente offline, ocupado, sem vínculo, removido durante espera e indisponibilidade total.
- Dois atendimentos concorrentes respeitando o limite e a carga nas três caixas.
- Humano assumindo enquanto ocorre a transferência; retomada somente explícita.
- Mesmo identificador remoto em tenant B sem leitura/escrita cruzada.
- Texto e mídia nas duas direções e callback repetido sem duplicação.
- QR e Meta através do mesmo contrato normalizado; Meta exige homologação real
  separada de suas capacidades de envio e credenciais.

## Relação com as referências Astra/Evolution já examinadas

As referências são análises locais de fontes selecionadas de 15–16/10, não uma
nova auditoria integral nem alegação de paridade com versões atuais.

| Aprendizado | Aplicação identificada | Limite de evidência |
| --- | --- | --- |
| Ponte por instalação/Account/caixa | Destinos, canais, webhooks, catálogo e handoff no Broker | Texto real de teste chegou e resposta humana foi entregue em 20/10; central externa ainda não homologada |
| LID e histórico separado do evento novo | Identidades pendentes, aliases e importador com worker/checkpoint | Importação exige fonte configurada e possui cobertura limitada; não é espelho integral do telefone |
| Editor de fluxo com executor único | Motor Broker e editor delegado no JRC | Seis opções e entrada inválida simuladas; transferência real completa ainda pendente |
| Observabilidade e outbox | Tarefas duráveis, FAILED/UNKNOWN, reconciliação e saúde degradada | Erros históricos preservados; listagem de grupos corrigida somente localmente nesta rodada |
| Contexto de cliente e radar (Synapse) | Customer360, relações, radar, carteira e cadências no JRC | Planos e testes locais anteriores não comprovam cada jornada implantada |
| Assistente por texto/voz (Jarvis) | NICO, ferramentas autorizadas, prévia e tomada coordenada | Timeout real impede aprovação do ciclo atual; voz não está homologada ponta a ponta |

Chamadas WhatsApp, todos os nodes, mídia/grupos completos, Meta e capacidade de
500 empresas/10 mil conexões permanecem critérios próprios de engenharia e
homologação. Não marcar como completos por existir botão, código ou vídeo de referência.

## Estado desta rodada

- Análise e decisão de Account compartilhada registradas.
- Correção do contrato de tarefas de grupos implementada localmente.
- No candidato JRC, a preparação do NICO passou para job assíncrono, com
  revalidação de acesso e recuperação sem repetir chamadas iniciadas.
- No candidato JRC, foi implementada a distribuição humana opt-in por carga
  agregada na Account, após escolha do time; o frontend oferece configuração
  administrativa com seleção explícita das caixas. A distribuição antiga não
  antecipa a URA nas caixas selecionadas; caixas fora dessa seleção preservam
  o comportamento nativo.
- Regressão geral do Broker: 3.227 aprovados de 3.231 na primeira rodada; os
  quatro casos que excederam tempo passaram na reexecução dos dois arquivos.
  Integração PostgreSQL: 1.196 aprovados, 12 falhas e 33 não executados na
  primeira rodada; os oito arquivos afetados passaram após rechecks dirigidos
  e correções de ordenação/preparação nos testes. Prazos do produto preservados.
- Regressão Rails candidata consolidada: 725 exemplos distintos aprovados entre
  execução integrada e rechecks; escopo de distribuição/nativa com 98 aprovados.
  Isso não substitui a jornada no servidor instalado.
- Nenhum novo bot ativado, mensagem
  enviada, credencial alterada, imagem publicada ou deploy executado nesta rodada.
