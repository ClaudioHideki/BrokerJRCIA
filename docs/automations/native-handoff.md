# URA nativa → atendimento humano: incremento 1

Base: `135bd952d0b782d33b22c8f5f88492586dee6f08`. Este incremento é código candidato,
sem publicação, ativação de feature flag ou homologação de uma central real.
Não depende de n8n. Os demais blocos indisponíveis continuam indisponíveis.

## Contrato e criação

O Studio permite escolher a caixa da empresa e **um time ou um agente** do catálogo
real da central. A configuração `handoffVersion: 1` contém a referência da
integração, revisão do destino, Account, Inbox e revisão de credencial; não contém
segredos nem permite escolher outra empresa. IDs remotos nunca são autoridade.
A API resolve novamente tenant/canal/destino aprovado e valida o alvo. Um agente
precisa pertencer à caixa; um time precisa existir na mesma Account.

A escolha é exclusiva porque Chatwoot ignora `team_id` quando `assignee_id` está
presente. O POST de time omite `assignee_id`, inclusive `null`.

Publicação, vínculo e reativação pelo serviço de Automações consultam o catálogo
fora da transação de banco e conferem novamente as revisões locais antes de gravar.
Os caminhos alternativos de atribuição de bot/cutover usam a mesma autoridade de
vínculo, com validação local do grafo e escopo; o aceite desses caminhos não atesta
prontidão remota. O worker sempre revalida antes de executar.

Pré-requisitos observáveis:

- Integração e Account prontas, destino aprovado e credencial atual
- Caixa API com saudação e atribuição automática explicitamente desativadas
- Consulta de Agent Bot suportada e nenhum Agent Bot concorrente
- Para destino time, atribuição automática do time explicitamente desativada
- Conversa canônica inicialmente `pending`, sem time/agente e com mapeamento atual
- Um único executor Broker, módulo/plano/empresa ativos e versões/revisões atuais

A simulação mostra o menu e o destino solicitado. `HANDOFF_PENDING` simulado não
significa transferência remota. Catálogo vencido exige atualizar e selecionar o
destino novamente. Grafos históricos permanecem legíveis e versões publicadas não
são reescritas. Uma publicação ou nova ativação contendo handoff legado sem destino
é bloqueada; a execução já existente pausa o bot e registra ação necessária, sem
fabricar confirmação remota.

## Efeito persistente e prioridade humana

A migration aditiva `0042_native_handoff_operations` cria um registro por outbox,
com RLS, FKs compostas, participação no lifecycle e prova de schema. A entrega
repetida não cria outra mutação. A reserva do outbox já é `UNKNOWN` antes da chamada;
um crash antes do registro do handoff é recuperado como falha acionável e pausa
local, sem POST.

O worker espera os efeitos de texto anteriores chegarem a `SENT`, `DELIVERED` ou
`READ` no transporte; aceite/enfileiramento do Broker não é entrega. Há prazo para
espera por transporte/mapeamento. Resultado incerto anterior não é reenviado.

Antes de atuar, o bot é pausado e suas esperas/saídas ainda não despachadas são
canceladas. A sequência remota é:

1. Confirmar conversa/escopo/políticas/alvo e registrar `OPEN_DISPATCHED`
2. Pedir status `open` e confirmar canonicamente que continua sem time/agente
3. Revalidar catálogo, controle e revisões; registrar `ASSIGNMENT_DISPATCHED`
4. Atribuir o único destino e ler a conversa novamente
5. Confirmar `open` + destino exato + Account/Inbox/conversa corretos, preservando
   `HUMAN_ACTIVE` caso o callback já tenha observado o humano

Não há mutação remota depois da atribuição. Nunca há retorno automático a BOT.
Uma ação humana explícita no console, inclusive HUMAN→HUMAN, incrementa a revisão
e interrompe a operação. Mensagem pública/privada humana ou controle diferente do
esperado tem prioridade. Revisões de owner, binding, sessão, credencial e destino,
revogação, suspensão e cancelamento invalidam o trabalho antigo.

O callback assíncrono de abertura é tratado como **estado esperado**, não como
prova de autoria: somente `open`, explicitamente sem agente e sem time, no mesmo
escopo/ciclo, durante lease válido e com revisão de controle original intacta.
Isso não silencia mensagens humanas nem atribuições.

## Incerteza e conciliação

Timeout, resposta perdida e restart após uma mutação conservam `UNKNOWN`. A
conciliação automática é somente leitura; nunca repete POST nem continua a etapa
seguinte depois de uma abertura incerta. O estado só vira `APPLIED`/outbox `SENT`
quando uma leitura canônica confirma o resultado completo solicitado.

O registro `confirmed_by` diferencia `DISPATCH_READBACK` de
`CANONICAL_RECONCILIATION`. Se a abertura ficou incerta e um operador concluiu a
atribuição exata na central, a leitura pode confirmar o **resultado alcançado**;
isso não afirma que o worker enviou a atribuição. Apenas abertura ou destino
incompatível continuam incertos. Controles de reconciliação manual genéricos não
podem inventar sucesso nem liberar retry para handoff.

Limite operacional: revogação de escopo/credencial, controle humano incompatível
ou resultado remoto diferente podem manter o registro incerto e bloquear o
lifecycle até uma investigação. Não há neste incremento um botão de descarte
forçado/abandono de resultado incerto nem uma retomada coordenada automática.

## Limite de concorrência da central

A API padrão Chatwoot não oferece compare-and-set de atribuição. Releituras e
revisões detectam mudanças antes/depois dos efeitos, mas não eliminam a janela
entre o último GET e o POST. Uma abertura manual idêntica à abertura esperada é
indistinguível. O estado humano local nunca é revertido por confirmação tardia.
Não anunciar “exatamente uma vez” ou ausência absoluta de corrida remota.

Referências de contrato: [assign conversation](https://developers.chatwoot.com/api-reference/conversation-assignments/assign-conversation)
e [controller upstream](https://github.com/chatwoot/chatwoot/blob/develop/app/controllers/api/v1/accounts/conversations/assignments_controller.rb).
Cada fork/instalação ainda precisa homologar seus formatos e comportamento.

## Ativação e rollback

`AUTOMATION_RUNTIME_V2_ENABLED` permanece com default `false`. Este código não
altera a configuração de produção. Para uma release separada: backup, migration
0042, schema/readiness, workers, caixa de homologação, duas empresas isoladas e
prova HTTPS de menu→time/agente com pausa precisam ser verificados.

Rollback de aplicação: pausar o runtime antes de retornar a uma imagem antiga e
não entregar grafos novos a um executor que só conhece handoff legado. Não desfazer
a migration por rollback destrutivo. Preservar operações incertas para investigação.

Os testes sintéticos usam clientes HTTP falsos e PostgreSQL real isolado; não
comprovam login, tokens, permissões, callbacks HTTPS ou atribuição da central real.
