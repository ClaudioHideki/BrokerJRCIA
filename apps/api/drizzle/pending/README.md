# Routing por caixa: integração pendente

O SQL nesta pasta é um incremento não publicado. Não faz parte do journal nem da release executável.

A coordenação em 09/11/2026 confirmou `0085_guided_setup` em outra candidata. Ao consolidar sobre a base funcional atual do Broker, verificar o próximo número livre, mover este SQL para a sequência e registrá-lo no journal. Nunca renumerar migrations aplicadas. Atualizar o baseline/probe estrutural da release final e rodar PostgreSQL/CI do SHA consolidado.

Os testes de integração aplicam este SQL somente em um banco isolado criado pelo harness quando as tabelas ainda não existem. Nenhum serviço produtivo deve aplicar arquivos desta pasta automaticamente. Sem as tabelas com RLS, os novos perfis retornam `FLOW_BOX_SCHEMA_PENDING`; modelos legados permanecem no contrato anterior.
