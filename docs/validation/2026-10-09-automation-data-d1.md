# P3 D1 — blocos de dados no motor e editor canônicos

Incremento do programa aprovado; não encerra P3, P9 ou P10.

## Comportamento entregue

O Studio passa a criar `data-set`, `data-rename`, `data-pick`, `data-merge`, `data-map`, `data-filter`, `json-parse`, `json-stringify` e `expression` com formulários tipados e portas `success`/`error`. O operador escolhe explicitamente valor literal ou variável; zero, false, listas e objetos conservam seu tipo. As operações de expressão são delimitadas, sem executar código livre.

Novos blocos usam `configVersion: 2`. Grafos publicados sem esse marcador conservam seus parsers, portas e comportamento histórico. Um marcador inválido gera diagnóstico; não recai silenciosamente na semântica antiga. Editor, validação, simulação e execução usam os mesmos contratos, com limites de JSON/referências e erros sanitizados.

O teste de PostgreSQL publica e vincula uma versão, persiste os valores em espera, substitui o worker e retoma a versão fixada apesar de um rascunho alterado. Evento duplicado não repete a execução; outra organização não acessa seus registros. O teste não despacha mensagens externas.

## Verificação da composição em 09/10/2026

- `npm run build`: aprovado, incluindo TypeScript e bundle web.
- Três arquivos focais canônicos de contrato, executor e formulário: 26 testes aprovados.
- `npm test -- --maxWorkers=2`: 300 arquivos e 2.385 testes aprovados, sem falhas; duração 345,66 s.
- PostgreSQL real isolado: persistência D1 e inventário de migrations, 24 testes aprovados em dois arquivos; duração 13,81 s.
- Bundle sem achados; contratos públicos, sete notices de terceiros e fronteira Evolution aprovados.
- Duas revisões independentes do incremento sem achados críticos ou importantes. Os quinze destinos conferem com o mapa de promoção revisado.

Os ciclos RED/GREEN focais precederam a integração. Testes de navegador seguem no CI; publicação e imagens devem corresponder ao mesmo SHA da main. Não há migration nova nem variáveis de ambiente obrigatórias neste incremento: a baseline permanece `0051_whatsapp_group_events`.

## Limites do aceite

A jornada real destes blocos no WhatsApp e nas centrais ainda precisa ser homologada. A confirmação de readiness e estrutura de banco não comprova resposta entregue. Subfluxos, ações/mídia, IA, armazenamento privado, execução de grupos e interfaces delegadas possuem incrementos próprios. Nenhum candidato dessas frentes foi incluído nesta entrega D1.
