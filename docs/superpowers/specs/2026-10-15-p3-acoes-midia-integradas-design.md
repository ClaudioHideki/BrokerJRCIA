# P3 — cinco ações e mídia integradas

Estado: desenho aprovado pelo coordenador em 15/10/2026. Implementação Broker liberada após o commit `3b15ef6648e708e97d5c59a1b7aa625f491559fc` (0061/0062/native bind). O contrato funcional e os bloqueios B1–B6 abaixo são autossuficientes; artefatos locais do candidato servem apenas como referência de composição, não como dependência de CI ou revisão.

## Bloqueios encontrados no candidato e critérios de correção

| Achado | Defeito observado na leitura do candidato | Critério de correção |
| --- | --- | --- |
| B1 | Mídia central muda sua tentativa para DISPATCHED e o guard genérico passa a rejeitar a própria leitura/confirmação por haver efeito pendente. | Autoridade específica à intenção persistida, sem excluir outras tentativas; confirmação do fato separada da continuação. |
| B2 | Nota privada outgoing de User é classificada como intervenção humana, inclusive a nota criada pelo próprio Flow. | Recibo autenticado e correlacionado distingue a nota própria; metadata autodeclarada nunca libera o motor. |
| B3 | Resolve gera evento interruptivo e o ACK perdido não tem recibo remoto conclusivo. | Resolve integra o protocolo transacional e encerra o ciclo após prova; leitura de status isolada não prova execução. |
| B4 | Editor delegado não recebe catálogo/mídia completos; referências dos cinco nós não são limitadas aos grants da caixa. | Fachadas normal/delegada equivalentes, escopo root/subflow e reautorização antes/depois de I/O. |
| B5 | Estado standalone é persistido, mas não aparece no atendimento; resolve não atualiza o estado canônico da sessão. | Projeção privada autorizada e conclusão atômica de receipt/sessão/execução/outbox. |
| B6 | `remote_id bigint` retorna string pelo driver PG, enquanto tipos/código remoto presumem number. | Normalização segura na fronteira DB e teste com linha PG real, recusando arredondamento. |

Esses achados descrevem o candidato anterior. Sua correção só é concluída pelos gates correspondentes do plano, com evidência registrada em documentação versionada. Migration 0058 já existe e não deve ser reaplicada; alterações adicionais usam a reserva 0063.

## Resultado e decisões aprovadas

Entregar etiqueta, atributo de conversa, nota interna, resolver atendimento e mídia privada no mesmo editor/motor/transportes existentes, com uso por nome/tipo/arquivo e confirmação durável. A API normal e o editor delegado/nativo precisam oferecer a mesma jornada respeitando seus grants. Nada de IDs técnicos ou credenciais como entrada de produto.

O coordenador confirmou: **Resolver e encerrar termina o ciclo atual**. O recibo confirmado precede `attendance_sessions=RESOLVED` e `automation_executions=COMPLETED`; não há próximo envio automático. O novo nó é terminal na configuração e no canvas. Erros definitivos permanecem visíveis; incerteza permanece pendente de reconciliação, sem um ramo que envie outra mensagem. Um novo inbound confiável segue a política existente de novo ciclo/reabertura e não reexecuta o backlog antigo. Versões e markers históricos não são reinterpretados.

As cinco entradas ficam indisponíveis durante a integração e são liberadas automaticamente no corte funcional depois dos gates, respeitando capabilities por caixa/perfil. Não haverá feature permanentemente escondida após os gates.

Contrato v2 aprovado pelo coordenador: novos `conversationEffectVersion:2` e `mediaEffectVersion:2`. Etiqueta, atributo, nota e mídia têm portas success/error/timeout; error/timeout somente quando há certeza de que nenhum efeito foi despachado. UNKNOWN é estado durável pendente, apresentado no diagnóstico com reconciliação, sem porta executável e sem novo POST. Resolve não tem portas de continuação: sucesso encerra, falha definitiva fica terminal e incerteza aguarda prova. Leitura v1 é preservada; nenhuma definição antiga é convertida ou passa a executar por presença parcial de campos.

## Estratégia de integração

Reutilizar o candidato por deltas é a opção escolhida: preserva seus contratos/validação/storage e permite corrigir as corridas. Aplicar o patch antigo inteiro perderia input timeout, NICO, Fleet e P9. Reescrever tudo descartaria código útil sem resolver melhor as fronteiras distribuídas.

Revalidação de hashes em15/10, após0061/0062:19 arquivos novos,13 compartilhados divergentes,9 ainda iguais à base composta e migration0058 já idêntica ao resultado. Nunca executar os scripts antigos de composição sobre a árvore ativa. Preservar0058,0060,0061 e0062; qualquer DDL adicional será migration nova, número confirmado com root. Patch candidato SHA256: `88e4fbd0dd3f988ced7797d32a84abde755ed1666c9b0bdbe35c1960ff172574`.

Separar seis unidades existentes no candidato: recursos/catálogos, autoridade/persistência, dispatcher de ações, adaptador central, ponte de mídia e composição. Acrescentar um módulo pequeno de prova/correlação para eventos próprios; não adicionar outro motor ou worker.

## Estado, despacho e confirmação

- A intenção usa a outbox existente, identifica organização/canal/conversa/execução/versão/ciclo, revisions atuais, recurso/revisão e proof aleatório. Toda fronteira revalida tenant ativo, canal não excluído, grants, modo humano,0062, owner/binding e versão.
- PREPARED é anterior a I/O mutador. DISPATCHED/UNKNOWN nunca são repetidos por prazo. A confirmação persiste o fato mesmo se o operador tomou a conversa durante I/O; a retomada do motor é uma decisão separada, sujeita à autoridade atual.
- A confirmação não pode depender de `runtimeAuthorityAllows` genérico quando esse guard inclui a própria tentativa como pendência. Uma função específica recebe o ID da intenção e verifica sua correlação persistida. Ela exclui somente aquela tentativa e os ecos autenticados comprovados dela; continua bloqueando todas as outras pendências, HUMAN e NICO OPEN. O gate global não recebe um booleano de bypass.
- Mídia QUEUED não é entrega: messaging/central/QR/Meta fornece recibo de transporte. A ponte só confirma após SENT/DELIVERED/READ com referência válida; falha definitiva sem despacho pode concluir error. ACK tardio grava o fato sem reviver execução cancelada.
- Integração com0062: se NICO cancela mensagem ACCEPTED antes de qualquer dispatch e remove o outbox de transporte, a ponte deve gravar REJECTED/CANCELED mesmo sem autoridade para continuar o Flow. Não deixar o outbox automático UNKNOWN manter DRAINING eternamente por trabalho comprovadamente não despachado. Havendo tentativa DISPATCHED/UNKNOWN, conservar a incerteza e exigir prova.
- A identidade da espera IO inclui outboxId/attempt, não somente nodeId, para callback ou simulação antiga não satisfazer a repetição do mesmo nó/subflow. Preservar a identidade/deadline input introduzidos em0061 e o CAS de settlement atual, inclusive a exceção estreita de handoff.

## B1–B3: ecos próprios e recibos remotos

Adotar extensão autenticada `jrc-conversation-effects/2` para **tag, attribute, note e resolve**, evoluindo o addon candidato. Metadata de webhook, status resolved, etiqueta presente e conteúdo igual não constituem prova. A ausência dessa capacidade torna essas quatro operações indisponíveis no perfil CENTRAL; nenhum fallback silencioso para endpoints stock substitutivos.

Rotas propostas, sob Account autenticada:

- GET `jrc_flow_effects/capabilities?inbox_id=...`: operações efetivas, protocolo, catálogo e suporte a revisão de controle.
- GET `conversations/:display_id/jrc_flow_effects/context`: Account/Inbox/contact/displayId, revisão monotônica de controle humano, estado/assignee/team e capability/profile generation.
- POST `conversations/:display_id/jrc_flow_effects`: organização/operação/proof, Inbox, contato, revisão esperada de controle, operação, recurso/revisão quando aplicável e `value_json` limitado.
- GET `conversations/:display_id/jrc_flow_effects/:operation_id`: recibo autenticado/correlacionado, sem repetir mutação.

Controller valida User/token/membership/Account e Inbox atuais, trava Conversation e recurso, verifica revisão esperada, executa ação e grava receipt em uma transação. Tag adiciona uma etiqueta; atributo faz merge de uma chave tipada; nota usa MessageBuilder normal com private=true; resolve escreve resolved explícito. Receipt é único Account+org+operation, imutável, com hash de requisição/proof, escopo, ação, revision antes/depois e Message ID opcional. Replay de mesmo conteúdo retorna o mesmo fato; conteúdo/proof diferentes retornam409.

**Dependência de autoridade remota:** a revisão humana deve mudar atomicamente com mensagens humanas públicas/privadas, atribuição/equipe/status e tomada NICO; todas essas escritas usam o mesmo lock de Conversation que o endpoint. Não usar timestamp atualizado, hash de estado corrente ou metadata autodeclarada como substituto dessa revisão. O adaptador deste mecanismo será coordenado com os módulos JRC; reutilizar um epoch existente somente após provar essa cobertura. Sem a cobertura, capabilities não declara a operação suportada. Nada de HTTP ao Broker sob lock Rails.

Callback de nota/resolve correlacionado a intenção DISPATCHED entra em fila de verificação, não vira exceção humana definitiva. O reconciliador faz GET autenticado fora de transação; somente receipt validado autoriza classificar como efeito próprio. Enquanto a prova falta, a fila bloqueia novos efeitos. Nota comum/NICO, callback com proof falso, outro ator/Account/ciclo ou operação desconhecida mantém a interrupção humana normal. Callback duplicado é idempotente; callback próprio atrasado não altera a revisão humana nem reabre ciclo encerrado.

## Hash entre Node e Ruby e IDs remotos

Não comparar hashes de JSON reserializado em linguagens diferentes. Enviar `value_json` como string JSON escalar limitada; Ruby valida/decodifica o valor e usa seus bytes UTF-8 originais para o hash. Tag usa `null`, atributo usa JSON do escalar tipado, note usa JSON da string e resolve usa `"RESOLVED"`. O Broker nunca envia objetos/arrays como atributo deste protocolo.

Material do SHA256, sem newline final: linhas `jrc-conversation-effects/2`, organizationId, operationId, accountId, inboxId, remoteConversationId, remoteContactId, expectedControlRevision, operation, resourceId ou string vazia, resourceRevision ou string vazia e SHA256(bytes UTF8 de value_json). IDs/revisions são decimais positivos canônicos (revision admite0), sem coerção. Proof é verificado por hash próprio e não exposto em logs. Golden vectors Node/Ruby cobrem Unicode, aspas, newline, false, zero, negativos, frações e expoentes.

Na fronteira PG, converter int8 string para number somente após validar inteiro positivo seguro. `ActionResourceRow.remoteId` não pode ser declarado number por cast sobre linha string. Aplicar a mesma regra a senderId, remoteConversationId e recibos. Valores acima de MAX_SAFE_INTEGER são recusados.

## Standalone e resolução terminal

Etiquetas/atributos/notas locais continuam tenant+canal+conversa. Entregar projeção operacional no detalhe do atendimento: etiquetas com nome, atributos tipados e notas privadas paginadas, separadas de mensagens públicas. Nenhuma nota entra no messaging_outbox.

Resolver escreve o estado local e encerra sessão/execução/outbox na mesma transação do receipt. Para central, receipt remoto confirmado é a condição anterior ao encerramento local. Reconciliação após crash repete somente a conclusão local idempotente. Nova entrada confiável segue a política de roteamento atual; regressão precisa provar que a espera/execução encerrada não é ressuscitada.

## Escopo, upload e UI

- `automation_definition_scopes` e grants da sessão limitam channelId, catálogo, recurso e mídia em root/subflows/publicadas, tanto antes quanto depois de I/O. Tenant RLS sozinho não autoriza outra Inbox da mesma empresa.
- Injetar dependências em ambos os serviços, normal/delegado. Expor fachadas de catálogo, criação/edição de recurso local conforme perfil, listagem/revogação de mídia e upload binário existente. Cliente UI recebe transporte explícito normal ou BFF; não usa listChannels global dentro do editor nativo.
- Upload separado do envelope do grafo, máximo16MiB além dos limites por tipo/MIME/assinatura atuais. Manter auth/control16KiB e grafo2.200.000 bytes. Preservar fachada INLINE/C2, quotas, reautorização, idempotência, lifecycle e pins publicados; nenhum base64 no grafo ou URL pública arbitrária.
- Ao trocar tenant/root/caixa, abortar leitura e limpar seleção; resposta atrasada não pode preencher contexto novo. Simulação não usa rede, só aceita resposta para a espera exata. Resolver mostra `Resolver e encerrar`, sem porta que sugira um próximo envio ignorado.
- Grupos permanecem limitados à política atual. Não habilitar cinco ações ou captura em grupo apenas porque a paleta global mudou.

## Gates e dependências de entrega

Corrigir B1–B6 com regressões RED antes do código; PG como jrc_app, Rails real e HTTP sintético com registro de chamadas fora de transação. Provar label/attribute concorrente sem perda de edição humana, note privada antes/depois do ACK, resolve terminal, mídia com eco próprio antes/depois do ACK, takeover em cada fronteira, perda de resposta sem segundo POST, quotas/C2 incerto, pins e revogação, IDs iguais entre tenants/caixas, UI com respostas atrasadas e input0061 preservado.

O addon Rails e o BFF devem entrar no artefato/installer do JRC atual, preservando QR e manifesto de66 paths do outro agente. Reserva de paths e revisão do contrato são anteriores à implementação. O candidato externo real e a produção não fazem parte desta aprovação. Concluir funcionalidades/gates primeiro; então liberar catálogo, documentação/OpenAPI e revisão final do coordenador.
