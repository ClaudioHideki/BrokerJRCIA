# Kit CCLX e dependências

CCLX consome APIs JRC tenant-scoped ou usa integração direta Chatwoot, com um proprietário de envio/espelhamento por inbox. Engine privada; nunca entregar chave globalEvolution. LAB2 é primeirohost real e não prova compatibilidade universalChatwoot.

Módulo deve usar BFF/delegação curta, membership/grant,CSRF,CSP,origem,revogação duranteI/O. Reutilizar rotas efetivas; integrar sem duplicar caixas/histórico. Dependem exclusivamenteCCLX: versão/fork,permissões,ambiente,esquemas/regraslegadas e aprovação do piloto. Durabilidade,segurança e testes internos continuam responsabilidadeJRC.

OpenAPI/Postman existentes precisam ser sincronizados ao SHA consolidado após os incrementos. SimuladorSQLite histórico tem36testes/8eventos no smoke; não representa harnessPG/S3/engine completo. Código em ../broker-jrc-2-redesign-homologacao/evidencias/baseline-20261030/simulador/.

Nenhum token real deve constar no kit. Exemplos usam placeholders. Pendentes: receptorPG/S3 com workerreal,ACKperdido,idempotência,downloadnovamente/hash e falhas integradas.
