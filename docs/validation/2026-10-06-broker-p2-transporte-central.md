# P2 D — Evidência incremental do transporte central

Base ec38dcb, branch codex/broker-p2-modes-catalog-20261005. Registro de desenvolvimento local; não comprova transporte central ativado, imagem nova ou implantação.

## D1 — Limite autenticado de eventos

Novo decoder interno reutiliza HMAC sobre bytes originais e classificação existente, com contexto persistido e atual idênticos. Exige CENTRAL_TRANSPORT/READY, origem HTTPS normalizada, Account/Inbox e revisões de destino, credencial e propriedade; rejeita divergências também nos objetos aninhados. Organização recebida no payload não governa o escopo.

As identidades de mensagem incluem empresa, canal, integração, origem, Account/Inbox e conversa/message ID. Delivery ID, timestamp e revisão transitória não fazem a mesma mensagem parecer nova. Isso prepara a chave de deduplicação; a deduplicação persistida e suas corridas pertencem a D2.

Somente incoming público de contact, com texto simples e sem anexos, pode virar CONTACT_TEXT. Mensagem estruturada/mídia com legenda não vira turno de texto. UTF-8 inválido é rejeitado sem substituir caracteres. IDs em string só são aceitos no formato decimal canônico e seguro; não se infere identidade de números ambíguos.

Nota privada, resposta humana, bot externo e estado de conversa viram observações de atendimento. Elas não são reenviadas, não executam bot e não autorizam retomada. pending exige leitura canônica/reconciliação posterior. Eco é confirmado apenas pelo mapping persistido com escopo exato; atributo de payload não prova origem Broker.

O decoder não está montado em rota nem libera runtime. Todas as saídas têm mayExecute=false, mayForwardReply=false e requiresCanonicalRead=true. Persistência, autorização, envio único e cutover continuam tarefas seguintes.

## Verificações

| Verificação | Resultado |
| --- | --- |
| TDD inicial | RED por módulo ausente, observado; implementação posterior |
| Decoder + classificador existente | 88 testes aprovados antes da revisão |
| Revisão independente | Uma falha importante: mídia/estrutura com content era classificada como texto; outro achado: UTF-8 inválido substituído silenciosamente |
| Correções da revisão | 5 testes falharam antes da correção; discriminação de conteúdo e decoding fatal corrigidos |
| Focados finais | 94 testes aprovados, 2 arquivos; 64 casos novos do decoder |
| Typecheck/build | Aprovados com as correções |
| Suíte completa final | 271 arquivos, 1.842 testes aprovados; 287,26 s |

Ruling de revisão: a troca silenciosa de caracteres assinados foi tratada como falha de integridade deste adaptador, além da classificação de mídia. Ambas entraram no mesmo passe de correção com RED/GREEN. Compatibilidade da versão instalada, persistência concorrente, envio/reconciliação/cutover e jornada externa não foram julgados pelo reviewer de D1; permanecem pendentes nas tarefas respectivas. Não houve download de logs privados nem nova E2E completa local.

Referência de protocolo: [webhooks oficiais](https://www.chatwoot.com/hc/user-guide/articles/1677693021-how-to-use-webhooks), consultada em 06/10/2026. Isso não valida as capacidades das instalações reais.

## Estado do programa

P2 A/B/C1/C2 têm evidências locais e commits na branch; C1/C2 estão publicados em ec38dcb. D1 é limite interno de eventos; D2–D5 e wizard integral ainda pendentes. Main 4fe35ba e suas imagens contêm correção de segurança/P1, sem os incrementos P2. Servidor e cenários reais continuam separados do laboratório e do CI.
