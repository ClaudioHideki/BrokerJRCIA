# Homologação e evidências

Workflow oficial41320633958, SHA b076e05864c168f88eb303177016543c68583ad7: sucesso. Logs confirmam34 testes parceiroQR,3613 unit/HTTP/frontend,6PDF,1526SQL/Redis,5MinIO. São5184 execuções em etapas, não contagem garantida de casos únicos. Build, security:submodule, scanner bundle, npm audit high e assinaturas concluídos.

Teste local TLS antes pendente:4/4 passaram com OpenSSL já existente em .tools/openssl-test-20261029. Não alterou produto ou timeout.

Laboratório local: container jrc-broker-homolog-20261101-pg, localhost15439, postgres16.4 digest fixado,768MiB/1CPU, banco exclusivamente sintético.77 migrations aplicadas fora da produção. Dump custom restaurado em outro banco:161 tabelas,77 entradas de journal e duas linhas sintéticas iguais; fingerprint do ensaio906701dbe62a24d91bf3531c28ded71d. Este hash usa string_agg(hash) e não deve ser comparado a fingerprints com algoritmo distinto.

Esse ensaio não cobre mídia, sessão, chaves, corrupção ou efeitos externos; não homologa restore produtivo. Testes de código do incremento atual e seus logs devem ser anexados antes do commit final. Não houve replay, envio, chamada ou carga real.

Limitação local comprovada: host8GiB,livres~0,8GiB; PostgreSQL descartávelCPU0%/115MiB no recorte. Execução geral local interrompida sem resultado por alterações concorrentes/pressão; não conta como PASS. Testes novos de PG serão consolidados após correção das fixtures e execução serial. Não modificar serviços compartilhados para liberar memória.

Consolidação intermediária do novo código: npm test com10arquivos afetados,79/79 aprovados,27,52s; PG consolidado2arquivos,10/10 aprovados,35,68s; typecheck e build:web exit0; scanner32bundles findings[]. Seleções sobrepostas aos testes dos agentes, não somar como testes únicos. Revisão independente encontrou P2 de vínculo desativado nunca observado; regressão/correção adicional em andamento, esses resultados anteriores não substituem o reteste final.

Revisão independente P2 corrigida via RED PostgreSQL: vínculo DISABLED com health cadastrado e nunca observado não é falha; erros explícitos ainda contam. Agente confirmou9/9SQL e10/10unit. Consolidação final e typecheck seguem no log próprio. Não somar às seleções anteriores.

Consolidação FINAL após revisão:2arquivosPG,14/14aprovados,24,10s,exit0; tsc-b finalexit0. Logpostgres-final-14.log. Scanner32arquivossemfindings. P2 resolvido e retestado. A suítegeral do novoSHA ainda exigeCI; não reutilizar5184execuções de b076 como aprovaçãodesteincremento.
