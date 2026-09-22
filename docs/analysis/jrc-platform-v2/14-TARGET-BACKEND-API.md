# 14 — Backend e API alvo

## Recursos canônicos

| Recurso | Operações principais |
|---|---|
| `/v1/channels` | listar, criar, detalhar, estado, parear, desconectar |
| `/v1/channels/{id}/destination` | vincular, validar, remover destino |
| `/v1/automations` | CRUD de rascunho, validar, simular |
| `/v1/automations/{id}/versions` | listar, publicar, ativar, desativar |
| `/v1/executions` | buscar, detalhar timeline, cancelar, retomar e repetir autorizado |
| `/v1/automation-nodes` | tipos, versões, schemas e capacidades |
| `/v1/credentials` | criar/rotacionar/testar/revogar sem revelar segredo |
| `/v1/destinations` | instalações Chatwoot/JRC/HTTP autorizadas |
| `/hooks/{token}` | inbound genérico com token armazenado por hash |
| `/v1/hooks/meta` | verificação e eventos assinados |
| `/v1/hooks/chatwoot` | eventos assinados e idempotentes |

## Padrões obrigatórios

- Envelope de erro estável com `code`, `message`, `correlationId` e campos inválidos.
- Paginação por cursor em logs, execuções e mensagens.
- `Idempotency-Key` em comandos de criação, envio e pareamento.
- ETag/versão otimista em rascunhos e vínculos.
- OpenAPI descreve esquemas, papéis, limites e exemplos sanitizados.
- Jobs retornam `202` com recurso de acompanhamento quando não são imediatos.

## Compatibilidade

`/v1/flows` continua funcional como fachada para automações durante duas versões de produto. Campos incompatíveis retornam aviso de depreciação. Métricas de uso determinam a remoção. Rotas atuais de Meta e Chatwoot delegam aos novos serviços antes de serem redirecionadas na UI.

## Serviços internos

`ChannelService`, `AutomationService`, `ExecutionService`, `CredentialVault`, `DestinationService`, `EventRouter`, `OutboxDispatcher` e adaptadores de provedor devem depender de interfaces explícitas, evitando acesso cruzado direto a tabelas.
