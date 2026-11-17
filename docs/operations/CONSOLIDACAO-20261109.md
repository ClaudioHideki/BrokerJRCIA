# Consolidação dos produtos JRC — candidata de 09/11/2026

## Composição
A candidata integra a marca do dispositivo d1ae956, a configuração guiada e75a952 e os perfis reutilizáveis por caixa dd34c7f. Preserva as revisões de ownership, fence/UNKNOWN e autorização transacional. LAB2 é o núcleo do omnichannel; GLPI continua exclusivo da extensão Branef. O laboratório URA contribui para o mesmo Broker, sem originar uma engine paralela.

## Migration 0086
O SQL provisório automation_box_routing foi registrado como 0086, depois de 0085_guided_setup. As migrations históricas não foram renumeradas. O migrador normal aplica a sequência em banco isolado/CI; o teste não instala SQL pendente por fora. Readiness agora exige RLS obrigatório, proprietário, privilégios limitados e triggers imutáveis/lifecycle das duas tabelas. A atualização contém novas tabelas, sem transformação destrutiva de mensagens ou sessões.

## Compatibilidade e reversão
Contratos antigos continuam aceitos: expectedProfileRevision é opcional para modelos antigos, obrigatório na ativação de um perfil V3. O retorno de binário deve ser tratado como operação explícita: versões anteriores não interpretam templates V3. Não apagar as tabelas nem seus registros para voltar o binário. Preservar versões em uso e interromper admissões V3 antes de uma reversão autorizada; investigar operações UNKNOWN antes de qualquer replay. Este documento não executa reversão nem mudanças produtivas.

## Fechamento da delegação
GET/PUT /v1/delegated-flows/:id/channels/:channelId/box-routing usam sessão opaca, leitura flow:read e gravação flow:edit, escopo do grafo e da caixa, validação de sessão antes/depois de cada transação. O ator vem da sessão (usuário Broker ou credencial delegada), nunca do navegador. O JRC encaminha somente version/teamId na consulta. A interface nativa configura times/agentes e captura a revisão publicada antes de preparar o fence. Ativar valida o mesmo perfil e confirma seu active_revision junto ao ownership, inclusive no transporte central.

## Evidências e limites
Teste RED de conta consultada antes da restauração da sessão e GREEN após fix. Testes RED de transporte/bind e allowlist Rails antes da inclusão, GREEN após correção. Testes de PostgreSQL cobrem perfil por caixa, CAS, outra inbox e sessão revogada; exigem CI/infra isolada, não representam sessão WhatsApp real. Nenhuma captura, envio ou pareamento real autorizado por este incremento. Backup/dump/restore permanecem excluídos.
