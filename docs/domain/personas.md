<!-- jrc-operational-init:v1 -->
# Personas — Broker JRC — Flow por caixa LAB

Papéis de trabalho para orientar a manutenção. Não representam novos perfis RBAC criados nem concessão de acesso. A existência e o alcance de cada papel no produto devem ser conferidos no backend e no ambiente.

| Papel | Necessidade |
| --- | --- |
| Agente/operador | Usa as jornadas e os canais permitidos no seu contexto. |
| Supervisor | Acompanha filas conforme permissões do produto e da empresa. |
| Administrador da empresa | Configura seu tenant, usuários e integrações autorizadas. |
| Mantenedor JRC | Evolui código e contratos preservando o isolamento e as extensões. |

## Limite de acesso

Uma configuração documental não concede acesso a filas, clientes, mídias, empresas ou APIs. Conferir sempre a política real da aplicação e do tenant.
