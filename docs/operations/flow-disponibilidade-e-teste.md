# Flow: disponibilidade, criação e validação

O controle tem três camadas: permissão do usuário, módulo habilitado na empresa ativa e execução habilitada na instalação. A flag `AUTOMATION_RUNTIME_V2_ENABLED` deve ter o mesmo valor na API, no worker de mensagens e nos workers de automação, integrações e agendamento. Seu padrão é `false`.

## O que cada estado permite

| Estado | Consultar | Criar/editar/importar rascunho e simular conversa | Publicar/ativar |
|---|---|---|---|
| Administrador/proprietário, empresa ativa, módulo habilitado, runtime pausado | Sim | Sim | Não |
| Administrador/proprietário, empresa ativa, módulo habilitado, runtime e dependências disponíveis | Sim | Sim | Sim |
| Empresa suspensa/desativada ou módulo desabilitado | Sim, enquanto o usuário ainda tiver acesso à empresa | Não | Não |
| Leitor | Sim | Não | Não |
| Runtime habilitado, dependência indisponível | Sim | Sim | Não |

`GET /v1/automations/status` retorna `enabled` (flag global), `canRead`, `canEdit`, `canSimulate`, `canPublish` e uma lista de `reasons`. A listagem de rascunhos não exige o runtime ativo. As permissões são verificadas novamente no servidor; um botão habilitado não concede autorização.

O vínculo pela tela do canal e a migração/cutover do Flow legado verificam a mesma disponibilidade. A migração por CLI também exige `AUTOMATION_RUNTIME_V2_ENABLED=true` e módulo habilitado na empresa; deve ser executada apenas durante a transição validada. A consulta ao histórico de migração e o rollback continuam disponíveis para recuperação.

As razões são `AUTOMATION_RUNTIME_DISABLED`, `ORGANIZATION_NOT_ACTIVE`, `AUTOMATION_MODULE_DISABLED`, `AUTOMATION_PERMISSION_REQUIRED` e `AUTOMATION_DEPENDENCY_UNAVAILABLE`. Várias razões podem estar presentes ao mesmo tempo. Rede, erro real da API ou schema incompatível podem continuar produzindo erro operacional, identificado pelo requestId; não diagnostique todo erro como flag desabilitada.

## Criar um bot de atendimento

1. Na administração da empresa, mantenha a empresa ativa e habilite o módulo de automações. Entre no workspace como proprietário ou administrador.
2. Abra **Automações → Nova automação**, dê um nome e use **Criar e abrir editor**. Um JSON pode ser importado como rascunho. Recursos incompatíveis continuam exigindo adaptação antes da publicação.
3. No editor, monte o caminho **Início → Mensagem → Menu → Captura → Condição → Mensagem → Transferência**. Dê nomes compreensíveis aos blocos e selecione seus destinos em **Próximos passos**.
4. No menu, configure uma opção por linha no formato `1|Atendimento` e `2|Encerrar`. Informe a variável `opcao`. Conecte a opção 1 à captura e a opção 2 ao bloco Fim.
5. Na captura, pergunte “Qual seu nome?” e salve na variável `nome`. Na condição, escolha o campo `nome` e a comparação **Está preenchido**. Conecte o resultado positivo à mensagem “Olá, {{nome}}” e depois à transferência humana.
6. Salve o rascunho e use **Validar**. Complete destinos e campos obrigatórios apontados pelo editor.
7. Use **Testar**, com uma mensagem inicial. O painel mostra a mensagem e o menu. Em **Próxima resposta**, envie `1`, depois um nome sintético. Confira pergunta, variável capturada e transferência. Use **Reiniciar teste** para outra tentativa.
8. Com as dependências disponíveis e runtime habilitado, publique. A versão publicada é imutável; editar o rascunho não altera execuções já iniciadas.
9. Em **Conexões WhatsApp**, abra o canal desejado, vincule a versão publicada e confira a central de atendimento configurada para receber a transferência.

O simulador executa a lógica pura e aceita até 30 respostas. Ele não envia WhatsApp, não acessa HTTP/SQL/IA/sandbox e não executa esperas reais. Em um bloco de I/O ou temporizador, mostra que a verificação deve continuar em homologação. Testar no editor não prova o funcionamento de credenciais ou entrega externa.

## Diagnóstico e ativação em homologação

Antes de ativar, confirme o schema, Redis e os quatro componentes em **Saúde operacional**: worker de mensagens, worker de automação, worker de integrações e scheduler. Para publicar, cada heartbeat precisa estar `UP` e ter no máximo 45 segundos. Workers de automação pausados pela flag reportam `DEGRADED`. Uma empresa recém-criada pode precisar de um primeiro rascunho ou canal e uma rodada da varredura para aparecer no monitoramento.

A verificação de dependências tem limite de dois segundos. Sem resposta nesse prazo, a publicação fica bloqueada e os rascunhos continuam acessíveis. A pausa global ou do módulo preserva os jobs de entrada V2 pendentes; eles não são concluídos silenciosamente como se o bot tivesse respondido.

Use a mesma imagem validada e o mesmo ENV em todos os serviços. `JRC_API_IMAGE` e `JRC_WEB_IMAGE` fixados por digest continuam presos àquele artefato mesmo com o Compose obtido da branch main. Atualizar o código Git não substitui automaticamente os digests.

Em homologação, com telefone e dados de teste:

- Envie uma mensagem, percorra menu e captura, confira apenas uma resposta por etapa e transferência à caixa correta.
- Reenvie o mesmo evento de webhook com a mesma identificação e confira que não há execução ou resposta duplicada.
- Reinicie o worker durante uma captura pendente; responda após sua volta e confira que retoma a execução e a versão originais.
- Desabilite o módulo da empresa e confirme que a fila de automação para de ser reivindicada. Reabilite e confira a retomada. O desligamento bloqueia novos trabalhos; um efeito externo já iniciado precisa de conclusão/reconciliação e não pode ser desfeito por uma flag.
- Confira a resposta pública do atendente e confirme que nota privada não vai ao WhatsApp. Essa validação pertence também à ponte com a central e requer ambiente real.

Não imprima o ENV inteiro nos logs. Para um erro da captura antiga, procure o requestId exato no log da API; este incremento não acessou esses logs nem alterou a instalação de produção.

## Evidência automatizada e limites

Os testes de disponibilidade cobrem rascunhos offline, bloqueios por empresa/módulo/papel e workers pausados. A simulação cobre menu, captura, condição e parada em I/O sem chamada de rede. O teste PostgreSQL `automation-native-journey.test.ts` cobre criação, revisão, publicação, vínculo, isolamento entre empresas, evento duplicado, retomada de estado persistido com um novo worker e despacho único de tarefas. O transporte externo nesse teste é controlado; ele não comprova envio por Meta/Evolution nem atendimento real no Chatwoot.

O catálogo completo de nós, os formulários avançados de HTTP/SQL/IA e equivalência de fluxos importados continuam dependendo da respectiva matriz de compatibilidade e testes com integrações. Disponibilidade do editor não significa suporte integral a todo workflow externo.

O teste nativo usa despacho sequencial. Ele não certifica ordenação entre múltiplos workers concorrentes: a ordenação da outbox por turno e a serialização dos efeitos da mesma execução precisam de teste específico antes de ampliar réplicas.
