# Incrementos e prioridade

1. H01: health somente dos vínculos ativos, preservar histórico e backlog desativado; regressão SQL real e RLS.
2. AUD-B07: fence de polling contra watermark/revisão de vínculo avançados; regressão de concorrência. Ordenação absoluta continua limitada pela evidência do provider.
3. UX: detalhe de conexão distingue sessão, identidade, vínculo e entrega; ações usam rotas existentes.
4. AUD-B02: atestar binário/fonte e captura durável antes do HTTP; teste crash/restart da origem. Outbox posterior não cobre evento nunca recebido.
5. AUD-B03: KEEP, protocolo/bytes/recibo, recuperação DB+objetos+sessão; não expurgar por ACK declaratório.
6. Grupos: admissão por escopo/catálogo sem desativar proteção; integração Chatwoot e reconciliação UNKNOWN por leitura.
7. B05/B12/B13/B14: logs engine, replay parceiro, orçamento e fairness. Worker parceiro e integration_jobs são domínios diferentes.
8. Conector/LAB2, shell admin/empresa, demais jornadas, OpenAPI/Postman, harness completo e falhas integradas.
9. Benchmark sintético progressivo e piloto50/30dias somente após gates.

Cada incremento exige RED→correção→regressão→revisão. Não usar aprovação de CI de b076 para mudanças posteriores. Produção permanece protegida por recuperação verificável.
