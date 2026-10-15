# Operação coordenada NICO, Broker e JRC — desenho aprovado

A recomendação apresentada e aceita pelo usuário em 15/10/2026 orienta este candidato.

## Objetivo e limites

O Broker conduz o chatbot e os transportes sob sua gestão. O JRC autoriza operadores e aplica regras de negócio. O NICO interpreta pedidos e executa somente ferramentas autorizadas pelos serviços do JRC. IA de atendimento é uma etapa do Flow, sem um segundo respondedor independente.

O operador consegue consultar e criar registros enquanto o bot atende. Para enviar pelo NICO em conversa automatizada, vê a prévia e confirma assumir a conversa; o Broker confirma a pausa antes do envio. Não há retomada automática.

## Entregas

1. Corrigir janelas recentes de mensagens no NICO, preservando filtros e escopo.
2. Atualizar estado bot/humano junto ao histórico no console Broker, protegendo navegação e mutações concorrentes.
3. Coordenar tomada por conversa, confirmação, recibos e resultados incertos.
4. Completar ações de mídia/etiqueta/atributo/nota/resolução e timeout do Flow.
5. Compor e distribuir QR/Flow e controle de executor para o JRC atual.
6. Ampliar ferramentas NICO por módulo e comprovar perfis standalone, JRC multitenant e Chatwoot externo.
7. Homologar canais, storage, reconexão, recuperação e capacidade por perfil.

O programa P0–P10 continua sendo o acompanhamento completo; este primeiro plano detalha as correções independentes iniciais.

## Contratos existentes preservados

- OperatorSession.public_history: até 30 mensagens públicas incoming/outgoing, apresentadas em ordem cronológica.
- ToolExecutor.conversation_sample_messages: até 5 mensagens públicas incoming/outgoing.
- ToolExecutor.read_conversation: até 30 mensagens públicas da conversa autorizada.
- CustomerTurnJob.customer_context e ContextBuilder.build: até 40 mensagens públicas com os filtros próprios de cada caminho.
- Ordenação por ID descendente substitui, em vez de acrescentar a, ordenação padrão; a reversão continua apresentando a janela cronologicamente por ID.
- O claim de turno conserva a estratégia de consumir a entrada mais recente, evitando ficar preso na primeira entrada superseded.
- A consulta Broker usa ConversationViewSchema e MessagesResponseSchema. Resposta fora da conversa/caixa solicitada é rejeitada.
- Troca de tenant/conversa invalida consulta em andamento.
- Uma consulta iniciada antes de uma tomada humana não desfaz o modo confirmado localmente.
- Nenhuma atualização de histórico envia mensagens ou muda o modo no servidor.

## Isolamento e operação

Bases: Broker 0620ecd0c03ec22252f8518d3a76b6414f6d6cf0; JRC b58e093dd3a32fe97829a4566660b83ee48b9eca.

Por instrução de 15/10, usar codex/nico-broker-coordenado-20261015 em ambos os repositórios e gerar imagens de candidato por SHA. Preservar main, branch de produção do JRC e digests instalados. Promover e instalar são operações separadas da publicação do candidato.

Sem segredos ou dados reais nos testes. Sem mudanças de permissões de Accounts produtivas. Sem ativação de delegação NICO paralela. Resultado incerto é reconciliado antes de qualquer repetição.

## Critérios de aceite da estabilização

- Regressões falham no código original ao exceder os limites das janelas e passam após a correção.
- Mensagens privadas, outras conversas e outras Accounts não aparecem no contexto selecionado.
- Atualizar histórico reflete mudança remota BOT/HUMAN sem perder rascunho.
- Resposta atrasada não altera outra conversa nem desfaz tomada humana confirmada.
- Testes dos módulos alterados e checks obrigatórios dos repositórios registrados.
- Relatório distingue código, CI, imagem candidata e instalação. Homologação real continua sendo necessária para as novas jornadas.

## Informações para a homologação posterior

Ambiente isolado/domínio, Accounts/caixas A e B, Chatwoot externo de teste, ativos Meta quando disponíveis e configuração privada de storage/capacidade. Não são pré-requisitos das regressões locais iniciais.

