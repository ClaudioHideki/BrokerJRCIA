# Evolution como referência operacional do Broker JRC

## Escopo e evidência

O usuário pediu o fluxo de uso da Evolution com identidade visual e contratos
JRC, isolamento por empresa, administração da plataforma, Flow integrado e
preservação dos dashboards e relatórios. As imagens fornecidas mostram a
Evolution 2.3.7: cartões de instância, pareamento, conversas, configurações,
proxy, eventos e integração Chatwoot. A presença de uma opção não comprova seu
funcionamento no ambiente nem uma capacidade equivalente no Broker.

Referência de código preservada: `upstream/evolution-api`, commit
`fa09d37892cdbb1d65a250155d293d92230c5b30`, versão 2.3.7.
O código de integração da referência está em
`src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts`.
Ele configura o cliente Chatwoot e, com `autoCreate`, cria ou localiza a caixa
e configura o callback. No Broker a criação precisa manter a organização,
Account, destino, instância e caixa correspondentes; o nome não concede acesso.

## Inventário funcional

| Área da referência | Implementação JRC encontrada | Conclusão e trabalho |
| --- | --- | --- |
| Instâncias e pareamento | Instâncias, canais, operações idempotentes, QR/código e adaptação de estado | Já há backend e telas. Concluir a matrícula automática do primeiro número em novas conexões autorizadas, com contexto e expiração. A troca de número existente continua exigindo revisão. |
| Excluir conexão | Serviço lifecycle, prévia de impacto, worker de limpeza externa e expurgo por canal | A candidata expõe o botão nos cartões da empresa e do administrador, com confirmação simples. Sessão QR e dados exclusivos do Broker são removidos; histórico/caixa remota e ativos Meta são preservados. Resultado incerto não autoriza repetir exclusão. Sem exclusão real na validação. |
| Dashboard da conexão | `InstanceWorkspace`, perfil e contagens reais, campos indisponíveis nulos | A candidata usa o componente na visão geral da conexão principal, com `providerReference.instanceId`, sem confundir IDs do canal e da instância. Navegação conferida em prévia local com dados simulados. |
| Configurações WhatsApp | `InstanceWorkspaceService`, contrato de sete campos e adaptador Evolution workspace | Os sete campos agora são acessíveis na aba Configurações WhatsApp, com rascunho preservado entre abas, gravação explícita e permissão OWNER/ADMIN. A validação visual local não comprova aplicação numa sessão real. |
| Conversas e mídia | Mensageria canônica, fila, adaptadores de texto/mídia, projeção e resposta Chatwoot | Validar entrada e saída reais por tipo. A chave de parceiro só permite os contratos publicados; mídia externa ainda exige um contrato específico. Não expor chave do motor ao navegador. |
| Chatwoot/JRC Conversas | Conta/destino, criação/vínculo de caixa, saúde, callback, filas e controle nativo | Concluir descoberta autenticada e registro automático das caixas no JRC. Uma configuração de conta atende várias caixas. Caixa desconectada aparece com motivo, sem ser tratada como pronta para envio. |
| Typebot / Flow | Editor, versões, publicação, bindings, executor e transferência humana JRC | O Flow ocupa a área de automação da conexão. Não ativar bot ao conectar o WhatsApp. Um executor por conversa e comandos coordenados de transferência/retomada. |
| Eventos | Eventos duráveis, webhooks de parceiro assinados, cursor e histórico de operações | O histórico operacional não é a lista de entregas de webhook. Mapear cada evento e payload publicado e testar assinatura, duplicação, ordem e reentrega. |
| WebSocket / RabbitMQ / SQS | Não foi comprovada uma superfície equivalente por empresa no Broker | São trabalhos adicionais de contrato, transporte e operação. Não adicionar interruptores sem adapter, persistência, credencial protegida e testes. Webhook JRC continua sendo o contrato atual do parceiro. |
| Proxy | A referência oferece configuração de proxy; não foi comprovado endpoint/tela JRC equivalente por conexão | Implementar como recurso separado se necessário, com escopo de instância, segredo protegido e controles de rede. Não reutilizar credencial global nem presumir proxy ativo pelas imagens. |
| Grupos e histórico | Catálogo, projeção de grupos, configuração de eventos e importação com checkpoints | Preservar seleção e escopo. Importação de histórico não inicia bot e não garante cópia completa do celular. Administração de participantes é uma capacidade adicional. |
| Mensagens especiais | A referência possui localização, contato, reação, enquete, lista e botões | Cada tipo requer contrato JRC, armazenamento/projeção, validação, despacho e testes no canal compatível. A presença da rota na Evolution não disponibiliza o recurso no Broker. |
| Chamadas | Na referência fixada, `offerCall` possui a chamada real comentada e resultado fixo | Não anunciar conversação de voz por causa de um botão ou desse retorno. Rejeitar chamada e oferecer transporte de áudio em tempo real são capacidades diferentes. |

## Navegação e responsabilidades

A empresa trabalha com suas conexões e os recursos suportados por elas: visão
geral, configurações WhatsApp, eventos, atendimento, Flow e histórico/grupos.
O administrador da plataforma mantém empresas, provedores, capacidade, limites,
saúde e suporte com escopo auditado. A seleção visual da empresa não substitui
o isolamento das consultas e comandos no servidor.

Uma conexão funcional deve distinguir sessão WhatsApp, destino de atendimento,
automação e entrega. A interface deve apresentar a ação relevante e a causa
específica de uma indisponibilidade. Relatórios, auditoria e dashboards globais
permanecem disponíveis.

## Entrega corrente e gates

As mudanças de matrícula inicial, isolamento de filas, descoberta de caixas,
motivos de remetente e simplificação de exclusão são desenvolvimento local.
Os resultados e sua revisão estão nos planos de execução desta data. A nova
navegação por conexão será verificada por componente, permissões e backend real
disponível; não implica que os transportes e tipos restantes já foram criados.

Antes da publicação: regressão da fonte estável, typecheck, build, contratos,
revisão e imagens imutáveis. Depois da implantação: migração 0073, mesma versão
nos workers, conexão de homologação e observação de entrada/saída, mídia,
retomada e isolamento. O pareamento da caixa de teste foi adiado pelo usuário.

## Limite da inspeção da Evolution em produção

A autorização atual permite somente a instância Welton_Alves. A inspeção é de
leitura; outras instâncias não podem ser alteradas. A conectividade e as
configurações dessa instância não comprovam o estado das conexões do Broker.

Referências públicas primárias:

- https://github.com/evolution-foundation/evolution-api/tree/fa09d37892cdbb1d65a250155d293d92230c5b30
- https://github.com/evolution-foundation/evolution-api/blob/fa09d37892cdbb1d65a250155d293d92230c5b30/src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts

## Análise REA executada nesta revisão

Ferramenta local: `rea-agents` **6.5.0**, análise estática com os fontes tratados
como texto inerte. Nenhum código da aplicação de referência foi executado.
O inventário Evolution tem 433 arquivos; foram selecionados 15 nesta rodada:
seis de instâncias/configurações e nove de Chatwoot/Typebot, incluindo telas,
rotas, controllers e serviços. Não houve falha de parse. O digest do artefato
inventariado é `15e8c18c23f9171ba6238b8bcc06af5774d36b7fab040feac60cd6522d90a99b`.

- Instâncias/configurações: evidência
  `ev_e8addc1131e003cb8b6deda27d4ee43591f33d334e3b0c949bc9fdaa4d4a70c0`,
  2.434 nós semânticos e 1.664 relações.
- Chatwoot/Typebot: evidência
  `ev_c2cd2c55bdfeec7012326360cc043b5a62fbd5dab18e51408876a8f82ef452cf`,
  11.760 nós e 8.184 relações.
- Adaptadores JRC: quatro arquivos selecionados de um inventário de sete em
  `packages/providers/src/evolution`, evidência
  `ev_4164f0c0d13991c8f9e8dd01df960651163a08c0f5b920abe95bf718ce4aa02d`,
  2.409 nós e 1.972 relações.

Os dois traces por propriedade (`syncFullHistory` e `autoCreate`) retornaram
**ambiguous**, cada um com três correspondências e relações entre camadas não
resolvidas. A cobertura é **partial**; isso não significa ausência de recurso,
equivalência de comportamento nem caminho executado. A matriz de contratos
[independente](2026-10-23-evolution-api-contract-matrix.md) complementa o REA
com leitura explícita dos adaptadores, schemas, handlers e testes localizados.
Os grafos volumosos ficaram fora da árvore de publicação.

Para esta arquitetura, ampliar o adaptador que já usa a Evolution preserva um
motor único e evita duplicar sessões Baileys. Cada capacidade acrescentada ainda
precisa atravessar o contrato JRC, o isolamento da empresa, a persistência e os
recibos de entrega, a API de parceiro, a interface e a homologação correspondente.
O REA auxilia o rastreamento; não copia nem valida essas etapas automaticamente.
