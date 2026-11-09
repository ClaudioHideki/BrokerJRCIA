# Flow centralizado com atendimento configurado por caixa

Data: 2026-11-09. Estado: desenho para revisão e aprovação, sem implementação de produto.
Base examinada: `2d30a5a544aa0eae12c208867e4912c369626787`, também observada em `main` no GitHub nesta data.

## 1. Pedido e resultado para o usuário

O administrador cria uma automação ou importa um JSON na página **Flow**, escolhe uma caixa existente e configura, nessa mesma página, os times e os agentes de atendimento correspondentes à URA. Ele não precisa selecionar integração/caixa/agente em cada bloco do editor. Criação/importação, publicação, vínculo, configuração de atendimento e diagnóstico ficam na página Flow. O editor continua responsável pela conversa e sua lógica.

O Broker executa a URA e transfere para a caixa correta do JRC Conversas. As identidades, times e a participação dos agentes continuam pertencendo ao JRC Conversas, sem uma segunda base independente de usuários no Broker. O modelo deve funcionar em caixas diferentes com configurações diferentes.

Decisão proposta pelo implementador: conservar a estrutura, os idiomas e os textos gerais da automação; nos pontos declarados como seleção de departamento/atendente, montar as opções a partir dos times e agentes configurados para a caixa. Os nomes dos atendentes e as mensagens de confirmação usam os destinatários efetivos, evitando texto com nome de uma pessoa e transferência para outra. Este é o detalhe de comportamento que o usuário deve conferir no desenho.

## 2. Abordagem escolhida e alternativas

O usuário escolheu concentrar tudo que envolve Flow e vínculo na página Flow, com atendimento baseado nos times/agentes da caixa. A abordagem é **modelo reutilizável + configuração de atendimento por caixa**, com menus de diretório quando declarados pela automação.

Alternativa considerada: apenas mover os atuais 13 seletores de handoff para uma tela única e continuar copiando IDs para cada bloco. Ela reduz navegação, mas mantém as dependências rígidas e não atende à intenção de selecionar a caixa e usar seus times/agentes. Permanece somente como modo avançado compatível para automações antigas.

Não basta remover a validação que hoje produz `ATTENDANCE_HANDOFF_CONTEXT_CHANGED`. Ela protege contra entrega em outra conta/caixa e deve continuar existindo para destinos estáticos e na confirmação de qualquer destino resolvido.

## 3. Experiência na página Flow

Uma área única com: **Automações**, **Caixas vinculadas** e **Operação**. Não criar uma nova família de páginas para o mesmo fluxo. Uma rota da automação pode continuar existindo para abrir seu editor, sem exigir que o usuário configure vínculos dentro dele.

1. Em Automações, criar ou importar um formato suportado, editar a conversa, salvar, validar e publicar uma versão do modelo. O botão de publicação descreve que o modelo ainda pode precisar de uma configuração de caixa antes de receber entradas.
2. Em Caixas vinculadas, selecionar a automação e uma caixa da empresa. A opção mostra nome, número mascarado e destino JRC Conversas, para não confundir o canal do WhatsApp com a caixa API.
3. Exibir caixas já integradas e disponíveis ao administrador. As demais caixas autorizadas da conta podem aparecer como **sem WhatsApp/integração correspondente**, com a etapa necessária para prepará-las; não inventar um vínculo para uma caixa sem canal. Nunca listar caixas de outra empresa ou conta.
4. Na configuração da caixa, listar os departamentos/rotas declarados pelo modelo. Associar cada departamento ao time correspondente do JRC Conversas uma única vez. Em vez de repetir uma associação por bloco, o formulário agrupa por rota/departamento.
5. Consultar os agentes que pertencem simultaneamente ao time e à caixa. Por padrão, usar os membros elegíveis desse conjunto; permitir uma seleção explícita de subconjunto quando a operação precisar. Não adicionar usuários à caixa silenciosamente. Fornecer acesso à administração de times/agentes no JRC para corrigir cadastros.
6. Mostrar prévia dos menus por idioma, ordem dos departamentos e nomes dos agentes que efetivamente serão oferecidos. Permitir ordenar os itens. Não inferir departamento por ordem numérica de IDs ou por alternância de agentes.
7. Exibir expediente, retorno, opção inválida e destino alternativo configurados no modelo/caixa, sem redefinir valores já aprovados. O expediente da automação permanece com precedência explícita; o novo painel não deve habilitar horários diferentes por conta própria.
8. Verificar a configuração e apresentar **Ativar nesta caixa**. A gravação da configuração e a ativação usam revisões esperadas e são idempotentes. Não ativar parcialmente após falha.
9. Em Operação, mostrar separadamente conexão WhatsApp, identidade, integração com a central, modelo/versão, configuração da caixa, admissão de novas entradas e última evidência de execução/entrega. Uma marca de WhatsApp conectado não pode ser apresentada como prova de que a URA respondeu.

O botão existente de Flow no detalhe do canal passa a abrir esta configuração já filtrada para a caixa. Manter URLs existentes e links de retorno. Evitar duas telas concorrentes de ativação com estados diferentes.

## 4. Modelo de atendimento

O modo de seleção de pessoa exibe os agentes elegíveis para a rota/departamento e resolve uma seleção a um único agente. O modo de transferência direta ao departamento resolve um único time, sem prometer distribuição automática entre pessoas. Em ambos os casos, a operação canônica de handoff existente recebe **um time OU um agente**, como exige o contrato atual.

Quando uma rota não tem candidatos válidos, a ativação é bloqueada com a pendência específica. Uma rota alternativa pode ser usada apenas quando foi configurada explicitamente e validada. Não escolher outro agente por conveniência, não usar o primeiro administrador da conta e não substituir ausentes por usuários de homologação.

Alterações administrativas nos membros dos times/caixas aparecem ao atualizar os destinos e ao preparar novas sessões. Para seleção explícita, novos membros não entram na URA sem serem selecionados. No modo todos elegíveis, novos membros podem aparecer em novas sessões; a interface deve explicar esse comportamento.

## 5. Contratos e armazenamento

Preservar a leitura e execução dos contratos `handoffVersion:1` (central com destino fixo) e `handoffVersion:2` (fila local do Broker). Introduzir um contrato estrito opt-in para handoff por rota lógica da caixa, sem tokens nem IDs humanos fixos no modelo. A numeração final do contrato e nomes internos dos campos ficam a cargo do implementador, sem reutilizar uma versão já publicada com outro significado.

Publicar junto ao modelo um esquema de rotas estáveis: chave, rótulos por idioma, modo de seleção, pontos de entrada/retorno e requisitos de atendimento. Referenciar rotas por chave estável, não por nome traduzido ou posição visual do bloco.

Persistir configuração por organização, canal, integração/caixa e modelo/versão, com revisões imutáveis e uma revisão atual para novas sessões. Deve conter associações rota->time, modo de seleção, subconjunto autorizado quando aplicável, ordem e rótulos necessários. Os IDs reais ficam nessa configuração e em snapshots internos autorizados, não espalhados nos blocos do modelo.

O vínculo e o perfil são escopados à organização autenticada e ao canal canônico. Registrar ator e revisões, sem copiar credenciais para a configuração ou expor valores em export/log. Usar o contexto autenticado da integração já existente para descobrir conta/caixa/credencial atuais.

## 6. Execução e consistência de menus

Uma nova sessão captura a revisão do modelo e da configuração da caixa. Antes de oferecer um menu, obter um snapshot autorizado e limitado dos candidatos reais, incluindo somente nome de exibição e identificadores necessários; não incluir e-mail ou outras informações pessoais no estado do menu.

Persistir no servidor a relação número oferecido->destino e a revisão desse snapshot. Uma resposta "2" deve continuar representando a pessoa oferecida como opção2, mesmo que alguém reordene a configuração enquanto o cliente espera. O motor não deve consultar uma lista atual e aplicar o número antigo a outra pessoa.

Alterações na configuração passam a valer para novas sessões/menus conforme a regra explícita, sem reiniciar conversas humanas ou mudar o destinatário de opções já oferecidas. Revogação de participação/permissão na central é revalidada na transferência e pode impedir a atribuição; não pode ser contornada por um snapshot antigo.

Resolver a rota/snapshot em um destino canônico completo antes do efeito de handoff. Reutilizar as validações e o protocolo existente de atribuição confirmada, posse bot/humano, assinatura/revisões e pausa. O destinatário escolhido é fixado na obrigação de entrega; tentativas repetidas não podem recalcular outra pessoa.

Se o destinatário removido não puder receber a transferência, manter o controle seguro, informar o resultado e seguir a alternativa configurada ou oferecer novamente opções válidas. Não declarar transferência concluída apenas porque o pedido HTTP foi aceito.

Não adicionar consultas remotas dentro de transações longas. Preparar o catálogo antes da transação e conferir novamente os escopos/revisões ao gravar. No despacho, validar o destino e as autorizações atuais pelo mecanismo canônico.

O estado deve respeitar os limites já existentes de texto, opções, valor e estado total. Não cortar silenciosamente agentes ou opções para caber. O implementador define limites/paginação compatíveis e apresenta validação legível quando a configuração não cabe.

## 7. Importação e migração de automações existentes

Criar/importar permanece na página Flow. Aceitar os formatos já suportados e manter os diagnósticos de conversão existentes. Este projeto não promete executar qualquer JSON arbitrário nem acrescenta dependência operacional de Typebot/Bot Bridge.

Automações com destinos fixos continuam funcionando sem migração automática. Oferecer **Usar configuração da caixa** para gerar um novo rascunho/modelo reutilizável preservando a versão publicada. Nunca alterar uma versão imutável ou substituir um robô ativo ao abrir a página.

Para o desenho OIA já suportado, reconhecer os grupos de departamento e seleção de atendente e convertê-los em rotas de diretório, preservando idioma, retorno, opção inválida, expediente e inatividade. Substituir os nomes fixos nas mensagens de confirmação por informações do destino efetivo. Os departamentos podem manter seus textos aprovados e aliases por idioma.

Para grafos em que a conversão de menus/arestas não seja inequívoca, apresentar a pendência agrupada na própria página Flow. Não adivinhar rotas, alterar lógica externa ou ativar uma importação parcialmente convertida. O modo avançado antigo permanece disponível. A primeira entrega cobre criação com o modelo reutilizável e conversão do padrão OIA; novos padrões complexos exigem conversores e evidência próprios.

Subflows usados por um modelo reutilizável precisam declarar as rotas necessárias ou ser rejeitados pela validação com localização do problema; não permitir que um destino estático de outra caixa fique escondido em um subflow.

## 8. Compatibilidade, segurança e papéis

Somente administradores autorizados gerenciam modelos, configurações e vínculos. Agentes não recebem tokens do Broker/JRC. As regras de acesso às caixas continuam no JRC e a listagem do painel é limitada ao contexto da empresa/conta.

Manter validações de destino, credencial, número aprovado, participação dos agentes, política de saudação/atribuição e exclusividade de automação. Para o transporte direto adotado, um AgentBot concorrente continua impedindo ativação; transportes que legitimamente usam um AgentBot Broker conhecido seguem seu contrato próprio, sem abrir exceção genérica.

Diagnósticos de regras locais concorrentes devem indicar o alcance observado. Se a central não permitir consultar uma regra, mostrar **não verificado**, não **aprovado**. Não desligar saudações, regras, times ou AgentBots de toda a conta automaticamente. O usuário deve escolher/aprovar a correção específica da caixa.

Pausar novas entradas continua diferente de retomar uma conversa. O perfil de atendimento não pode reabrir atendimentos nem tomar controle humano por efeito colateral. Os botões operacionais na conversa do JRC são uma entrega distinta e não são implicitamente concluídos por este painel.

## 9. Responsabilidades e arquivos afetados

Broker: contratos em packages/contracts, persistência/migration, serviço de configuração por caixa, resolução de diretório/rota e snapshots de menu, admissão/publicação/vínculo, runtime/efeitos, API e painel Flow. Reaproveitar o catálogo canônico e o cliente que já consulta membros de time/caixa; não criar integração paralela por URL solta.

JRC Conversas: fonte de agentes, times, membros e atendimento humano. Nenhuma alteração de produção é exigida nesta fase de desenho. Se a evolução do editor nativo/contratos exigir atualização do bundle incorporado, atualizar o padrão Grupo JRC/LAB2 e suas provas/manifestos em uma release coordenada, mantendo leitura segura das versões antigas. Não alterar GoPure ou outros clientes.

A configuração por caixa pertence ao mesmo backend que atende tanto o painel Broker quanto a delegação nativa. Não implementar uma segunda verdade em armazenamento local do navegador ou uma API exclusiva da interface web.

## 10. Verificação exigida

- Um modelo vinculado a duas caixas resolve conjuntos diferentes de times/agentes, sem IDs de outra caixa no efeito.
- Menu e handoff apontam para a mesma pessoa; a ordem não muda uma escolha em espera.
- Agente fora da caixa, fora do time, removido ou de outra conta não pode ser selecionado/receber atribuição.
- Falhas de catálogo, mudança de revisão/credencial e configuração concorrente bloqueiam a ativação ou o despacho com mensagem específica, sem gravação parcial.
- Configurar/ativar novamente com a mesma chave não duplica vínculos, saudações, efeitos ou reaberturas.
- Mudanças de perfil não retomam uma conversa humana; o handoff confirmado pausa o bot como antes.
- V1/V2 estáticos e automações antigas continuam legíveis/executáveis; só a migração explícita habilita o novo comportamento.
- OIA mantém português/inglês, departamentos, retorno, opção inválida, expediente e encerramento; quantidade de atendentes passa a refletir a configuração aprovada da caixa, sem usar os agentes do LAB como padrão de produção.
- Listas vazias/longas, nomes iguais, múltiplos times e subflows não produzem destinos ambíguos ou mensagens truncadas.
- Frontend permite criar/importar, configurar caixas e atendimento, revisar pendências e ativar pela página Flow; o editor não exige integração/agente por nó no modo reutilizável.
- Testes de contrato, API, PostgreSQL/concorrência, motor e interface, seguidos de build e npm test/diff checks exigidos pelo repositório. Separar provas locais, CI/imagem e operação real.

## 11. Entrega e implantação

Depois da aprovação do desenho: plano de implementação em etapas, TDD e revisão de código. Fazer primeiro contratos/perfil/snapshots e compatibilidade, depois interface e conversão do modelo, então verificação integrada e documentação operacional.

Não publicar nem implantar uma nova release compartilhada do Broker apenas por aprovar este documento. Preparar commit, imagem imutável, migration e resultado verificável; a implantação compartilhada terá aprovação de release concreta, conforme AGENTS.md. Não alterar serviços de outros clientes ou a imagem GoPure.

## 12. Decisões técnicas propostas

O diretório de pessoas continua no JRC; o painel apenas escolhe participantes autorizados. Os nomes/opções de atendentes nos menus de diretório refletem a caixa; a lógica e textos gerais do Flow são preservados. O vínculo utiliza perfil versionado e snapshots por sessão/menu, não substituição textual de IDs em13 blocos nem remoção das validações atuais. Mudanças não reiniciam atendimento humano.

Não foi escrito código de produto nem alterado um vínculo operacional para produzir este desenho. Pendentes: revisão do builder, conferência do comportamento proposto pelo usuário e aprovação deste documento antes de implementar.
