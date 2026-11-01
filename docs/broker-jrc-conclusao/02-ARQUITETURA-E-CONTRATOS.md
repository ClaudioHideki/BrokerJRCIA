# Arquitetura e contratos

Chatwoot ↔ API/conector Broker ↔ Evolution/Baileys privada ↔ WhatsApp. Meta é provider separado. Fastify/TypeScript, PostgreSQL durável, Redis auxiliar, workers, React/Vite e storage privado existentes.

Parceiro, organização, loja, canal, instância, inbox e engine são entidades distintas. Preservar RLS, membership, grants e revisão de vínculo. LAB2 não é fork CCLX. Um controlador e um proprietário de envio por sessão/inbox.

Ver matriz de APIs e arquitetura em ../broker-jrc-2-redesign-homologacao/03-ARQUITETURA-TECNICA.md e ../auditoria-900/07-MATRIZ-APIS.md. Esses inventários precisam reconciliação com o próximo SHA; não equivalem a endpoints novos. Nenhuma nova rota pública prevista neste incremento.

B07 trata a corrida polling/webhook; H01 trata diagnóstico e não altera autorização de envio. UNKNOWN continua resultado incerto e não autoriza retry.

AUD-B02: metadadosOCI/in-totoSLSAv0.2 do digest auditado apontam para cd800f2976e1e5b682fbf86a01ee4d85ae61f370. Comparação selecionada src/prisma/package/lock/Dockerfile comfa09não mostrou diferenças. Isso não é rebuild reproduzível nem prova do processoimplantado. A Promisevolátil anterior ao webhook continua semjournalatômico. Evidênciaeprimeiroincremento em evidencias/b02-source-20261101.md. Nenhum patchengine aplicado.
