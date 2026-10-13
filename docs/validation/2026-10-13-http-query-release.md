# P3 — consultas HTTPS no editor comum

O incremento habilita o nó HTTP com `httpConfigVersion: 1`: GET para endereço HTTPS fixo, parâmetros codificados, credencial selecionada por nome e revisão, destinos permitidos por empresa, timeout até 30 segundos, resposta até 32 KiB e até duas novas tentativas GET. O cofre conserva os segredos; o catálogo mostra somente metadados. A configuração não exige UUID ou JSON manual.

Validação, simulação e publicação compartilham a política atual da credencial. A publicação final usa bloqueio compartilhado; alterações de política usam bloqueio exclusivo e CAS, preservando o segredo. O dispatcher reutiliza IO_HTTP e o transporte canônico, revalida revisão/origem e recusa autenticação vazia. Respostas fictícias só continuam o bloco exato em espera na rodada atual. Grafos históricos sem marcador conservam métodos e semântica UNKNOWN; marcador inválido não vira configuração histórica.

## Revisão e verificações

Revisão independente verificou schema, catálogo paginado por organização/raiz, autoridade atual, política de credenciais, bloqueios/CAS, preservação histórica, transporte, limites de resposta, cinco portas e formulários. O patch congelado tem SHA256 `4317f7f57c4320749c8aa6c2adde595a5852001cb206f0a2ca7c9609366183f3`; os 33 arquivos portáteis foram promovidos somente após conferir hashes de origem e destino. Nenhum achado crítico ou importante ficou aberto nesse corte.

- 56 casos únicos do candidato passaram: 43 contratos/API e 13 interface. Não são uma suite global única ou prova de produção.
- A habilitação foi RED com HTTP UNAVAILABLE, depois GREEN: seis casos afetados em quatro arquivos (catálogo, matriz, motor e formulário).
- Nove casos focais de OpenAPI/inventário passaram na composição canônica.
- Typecheck terminou com código 0; o bundle web integrado foi gerado. A primeira invocação do Vite usou uma opção CLI inválida e não executou build; o comando corrigido terminou com código 0.
- Auditoria canônica regenerada, bundle sem achados e gate sem CRITICAL/HIGH abertos.

Não houve teste de concorrência PostgreSQL desse CAS; a intercalação de revogação/publicação foi determinística em unidade. Os testes das rotas não substituem os cenários reais da central.

## Publicação e instalação

Não há migration, alteração de Compose, ENV ou dependências; a baseline permanece 0052. A release deve usar main, CI e imagens do mesmo SHA. A instalação no servidor e a jornada real foram adiadas pelo usuário. Este incremento não conclui IA, ações/mídia, grupos na central, distribuição entre motores, módulos delegados ou o programa inteiro.
