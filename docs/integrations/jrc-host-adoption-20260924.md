# Descoberta de caixas existentes para o JRC

Base conciliada: `f8e81df271670348201998890b56654b1c95bb0c`, posterior ao origin/main `b352b8c` consultado em 24/09/2026.

`GET /v1/integrations/chatwoot/control/resources` agora retorna também `connections`. Cada item contém integrationId, inboxId, instanceId e name. São retornadas apenas conexões READY com inbox associada e canal BAILEYS da organização autorizada. A autorização continua exigindo chatwoot:manage e contexto válido; SQL é executado sob RLS. Não há credenciais, QR ou mensagens na resposta.

O host deve confirmar o contexto de empresa/conta/origem/revisão, localizar a inbox API na própria conta e verificar `/connections/:integrationId/status` antes de persistir seu vínculo local. Adotar não significa recriar inbox nem sobrescrever webhook. Conflitos devem ser recusados; repetição da mesma adoção deve ser idempotente.

O teste PostgreSQL cobre descoberta, bloqueio para não administrador e organização distinta; o teste HTTP cobre resposta no-store. O novo atributo é aditivo; clientes antigos podem ignorá-lo.

Ainda não entregue nesta revisão: delegação ao editor de automações (A1/A2), exclusividade coordenada com o motor do host (A3), handoff/retomada conjunta (A4), conversão de jrc_flows e homologação real HTTPS. A chave QR continua sem acesso às APIs de automação.

Nenhuma configuração ou imagem de produção é finalizada antes da jornada com duas empresas: adotar → QR → conectar → receber → fluxo → humano → responder → retomar.

Validação 24/09: typecheck aprovado; controle em PostgreSQL com duas organizações, 6 testes aprovados. Suíte principal: 1.230 aprovações e duas falhas (mock HTTP anterior ao novo atributo e espera assíncrona do editor). Após atualizar o mock, reexecução das duas suítes: 12 testes aprovados. Não apresentar como uma única execução integral verde. Contraparte Rails: 41 exemplos aprovados; Vue: 25 testes aprovados. Homologação HTTPS permanece pendente.

Multiempresa: cada Account do JRC corresponde a uma organização do Broker. Grupo econômico não concede acesso cruzado implícito. Usuários podem participar explicitamente de várias empresas; instâncias representam conexões, não usuários. Não reutilizar a credencial de uma organização em outra.
