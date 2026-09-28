# A1/A2 — contrato para o editor de Flow delegado ao JRC Conversas

Estado em 25/09/2026: desenho de implementação, **sem sessão delegada ativa**. Este documento registra as verificações nos checkouts Broker e JRC Conversas e os pré-requisitos para expor o editor aos usuários da central. O teste `automation-delegation-boundary.test.ts` fixa a fronteira atual: a chave de controle de QR recebe `403` nas rotas Flow do Broker.

## Fronteira atual

- O JRC mantém `JrcBrokerIntegration` por `Account`, com `encrypted_control_key` para o controle de QR. `JrcBroker::Client` envia essa chave no header `X-JRC-API-Key`; `JrcBrokerPolicy` consulta `AccountUser`, `InboxMember` e grant de pareamento. Esse grant não significa permissão de editar Flow.
- O JRC possui `JrcFlowsController`, editor e motor **locais**. Escrita exige administrador da Account. `JrcRemoteFlowsController` também usa o modelo/motor Flow local e não abre o grafo do Broker.
- As rotas `/v1/automations` do Broker aceitam apenas JWT de usuário Broker e consultam seu papel atual. Chaves de API, inclusive `CHATWOOT_CONTROL`, são recusadas para leitura e escrita.
- `automation_definitions` é isolada por `organization_id`, mas não contém Account/Inbox. Somente `automation_bindings` aponta para canal. Rascunho sem binding, ou definição com múltiplos bindings, não tem um dono de Inbox inferível. Dar a uma sessão delegada acesso à organização inteira exporia rascunhos de outras caixas.
- A relação operacional esperada é uma organização Broker para uma Account JRC, com várias Inboxes. A correspondência precisa ser verificada no banco em cada operação; não deve ser presumida a partir de IDs fornecidos pelo navegador.

## Contrato mínimo a congelar antes das rotas

1. **Credencial de serviço Flow distinta da chave QR.** O Broker emite uma credencial `flow:delegate` vinculada a organização, destino Chatwoot aprovado, Account externa, revisão do destino e origem HTTPS. Ela não tem escopos `chatwoot:*` ou `instances:*`. O JRC a guarda cifrada no servidor em campo/registro separado; nunca a entrega ao navegador. Revogar a credencial invalida imediatamente todas as sessões dependentes. A emissão exige administrador Broker e auditoria. Não se deve ampliar a chave `CHATWOOT_CONTROL` existente.
2. **Dono da definição por Inbox.** Uma tabela de escopo ou coluna equivalente liga cada definição delegável a `(organization_id, destination_id, account_id, inbox_id)`, com unicidade por definição. Criar um rascunho pela central cria esse vínculo na mesma transação. Listar, abrir, salvar, validar, simular, publicar, consultar versões e arquivar filtra por esse vínculo **dentro da transação**. Um Flow global já existente só entra no editor delegado após adoção explícita com prévia dos bindings; nunca se infere o dono pelo primeiro binding encontrado.
3. **Sessão curta por usuário, Account, Inbox e papel.** No JRC, a entrada no editor parte de uma Inbox real da Account ativa. Rails verifica usuário autenticado, `AccountUser` atual, Account ativa, feature Flow, Inbox pertencente à Account e permissão de gerenciar Flow. Na primeira entrega, manter escrita restrita ao administrador da Account, conforme `JrcFlowsController`; qualquer papel adicional exige regra explícita e teste. O Broker associa um ID opaco de sessão a esse contexto e expira em poucos minutos. Sessão não concede acesso genérico a `/v1/automations`.
4. **Revalidação em toda leitura e escrita.** A UI do editor chama um BFF Rails da mesma origem, sem token Broker no JavaScript. A cada request, Rails reconsulta AccountUser/Inbox e o papel atual. O Broker revalida credencial Flow, destino/revisão, escopo da definição e sessão; para revogação de usuário/Inbox sem janela de tolerância, faz introspecção autenticada no JRC a cada operação. Falha de introspecção bloqueia a operação. Revalidar após chamadas remotas antes de devolver material sensível. Não basta verificar apenas quando a sessão é criada.
5. **Rotas e cliente separados.** Criar uma fachada delegada `/v1/integrations/jrc-flows/...` com contratos em `packages/contracts` e OpenAPI. Ela usa o mesmo serviço/grafo/versionamento do Broker, mas exige o escopo Account/Inbox. O BFF JRC adapta as respostas para o editor embutido. As rotas JWT atuais do Broker permanecem para o console. Não usar iframe com JWT de administrador ou cookie de terceiro.
6. **Ativação de caixa após A3.** A1/A2 pode permitir criar, editar, testar e publicar uma versão. Vincular e ativar na Inbox depende do owner único de automação por caixa e fence/drain de A3; até lá, a UI deve dizer que a versão publicada ainda não está ativa no atendimento.

## Sequência de implementação revisável

1. Migration e serviço Broker para credencial Flow e escopo da definição; índices/constraints por organização. Migration JRC para guardar a credencial separadamente. Fluxo administrativo de emissão/rotação/revogação, sem exposição de segredo no browser.
2. Endpoint de introspecção JRC autenticado por credencial independente, retornando somente Account, Inbox, usuário, papel atual e decisão; o Broker compara com o grant/sessão e destino que tem no banco. Proibir redirects e validar a origem configurada.
3. Fachada Broker delegada com sessão curta e filtros transacionais em **todas** as operações de definição; BFF Rails com CSRF, `Current.account` e política reexecutada por request. Tratar concorrência e revisão de draft da mesma forma que o console.
4. Editor JRC com o grafo do Broker. Manter o Flow local identificado como legado durante migração, sem apresentar dois motores ativos na mesma Inbox.
5. Só após isso, A3 (owner/fence) e A4 (handoff/retomada), com migração dos `jrc_flows` locais por prévia, corte e rollback.

## Testes de aceite obrigatórios

- Duas Accounts em organizações Broker distintas: usuário da Account A não lista, abre, salva ou publica definição da B, inclusive trocando IDs na URL/body.
- Duas Inboxes da mesma Account: sessão da Inbox 1 não acessa rascunho, versão, binding ou execução da Inbox 2. Nova definição já nasce com dono persistido.
- Remoção de `AccountUser`, troca de papel, remoção de `InboxMember` quando aplicável, desativação da Account/feature, revogação da credencial Flow e rotação do destino bloqueiam a próxima leitura **e** escrita, mesmo com sessão ainda não expirada.
- Chave QR continua recebendo `403` em lista, leitura, criação, edição e publicação Flow. Credencial Flow não chama pareamento/desconexão QR.
- Sessão vencida, nonce repetido, Account/Inbox divergentes, falha de introspecção e mudança de revisão do destino não alcançam `AutomationService`. Auditoria distingue ator JRC, Account, Inbox e credencial de serviço sem registrar segredo ou grafo sensível.
- HTTPS de ponta a ponta: criar rascunho no JRC, editar o mesmo grafo no Broker, publicar, verificar versão e negar acesso após revogação. A ativação/execução na Inbox fica condicionada a A3/A4.

Nenhuma dessas jornadas positivas foi implementada ou homologada por este incremento. O teste de negativa existente prova apenas que as chaves QR atuais não atravessam a fronteira Flow.
