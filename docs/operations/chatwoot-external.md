# Chatwoot por empresa — controle e operação

## Escopo e evidência

Uma organização Broker corresponde a uma conta em uma instalação Chatwoot.
Instalações diferentes podem usar os mesmos IDs remotos. O destino aprovado,
a organização e a conta fazem parte do vínculo; o número da conta sozinho não
identifica uma empresa. O canal continua `Channel::Api`, com um webhook por inbox.
Não configurar um segundo webhook de conta, AgentBot ou conexão direta do engine.

Esta implementação está em validação local. Consulte
`docs/validation/2026-09-16-execution.md` e a matriz de resultados.
Fixtures locais não comprovam compatibilidade com qualquer versão Chatwoot,
WhatsApp real, alta disponibilidade ou recuperação anterior ao ACK.

## Preparação de homologação (não executada automaticamente)

1. Fazer backup e ensaiar restauração em ambiente isolado. Manter a chave de cifra
   no cofre junto com o procedimento de restauração; ela não pertence ao Git.
2. Aplicar migrações aditivas 0018–0021 pelos comandos existentes. O backfill preserva
   as contas MANAGED e os ciphertexts; não gera prova de compatibilidade.
3. Configurar `PUBLIC_ORIGIN` HTTPS e `INTEGRATION_ENCRYPTION_KEY` conforme o ambiente.
   `CHATWOOT_BASE_URL` é o destino MANAGED opcional. `CHATWOOT_PLATFORM_TOKEN` só
   pode operar nesse destino. Não fornecer esse token a instalações externas.
4. Ativar `CHATWOOT_EXTERNAL_DESTINATIONS_ENABLED` e `CHATWOOT_CONTROL_ENABLED`
   apenas no ambiente piloto. Os padrões são `false`.
5. O administrador da empresa solicita a origem HTTPS, sem token. O administrador
   JRC confere e aprova a revisão exata e as origens de mídia necessárias.
6. Somente então vincular ID da conta e token de um administrador dessa conta.
   Rotação válida aumenta a versão e reinicia as evidências. Rotação rejeitada
   conserva a credencial anterior; revisar o acesso no destino.
7. Emitir chave restrita com `chatwoot:read`, `chatwoot:manage`, `chatwoot:pair` e,
   se necessário, `chatwoot:disconnect`. Não conceder escopos genéricos. O segredo
   é revelado uma vez; revogar e reemitir se for perdido. Guardá-lo só no backend.

Os nomes efetivos das variáveis devem ser conferidos em `.env.example` antes da
ativação. DNS público e TLS válido são obrigatórios para destinos externos; IPs
literais, origens privadas, caminhos, redirects autenticados e rebinding são recusados.
Anexos em origens de mídia aprovadas nunca recebem o token da API.

## API de controle

Prefixo: `/v1/integrations/chatwoot/control`. Autenticação: `X-JRC-API-Key` com uma chave
restrita vinculada, ou sessão JWT autorizada do Broker. Consulte o header efetivo
no OpenAPI. Mutações exigem `Idempotency-Key`. Não enviar organização, conta ou
papel no corpo. O Rails atribui o usuário em `X-JRC-External-Actor` para auditoria.

| Operação | Método/caminho | Efeito |
|---|---|---|
| Contexto | GET `/context` | Confere vínculo e capacidades observadas |
| Onboarding | POST `/onboarding` | Persiste a operação e retorna 202 |
| Progresso | GET `/onboarding/:operationId` | Lê etapa, IDs e resultado |
| Recuperação | POST `/onboarding/:operationId/recover` | RETRY, RECONCILE ou CANCEL autorizados |
| Saúde | GET `/connections/:integrationId/status` | Consulta; não cria QR |
| Pareamento | POST `/connections/:integrationId/pair` | Confere acesso remoto e inicia/reutiliza desafio |
| Identidade | POST `/connections/:integrationId/confirm-identity` | Admin aprova a revisão observada pelo provider |
| Logout | POST `/connections/:integrationId/disconnect` | Desconexão explícita e auditada |
| Agentes | PUT `/connections/:integrationId/agents` | Associa agentes existentes na conta |

Exemplo sanitizado de início:

```json
{
  "name": "Atendimento de homologação",
  "source": { "kind": "EXISTING", "instanceId": "00000000-0000-4000-8000-000000000001" },
  "agentIds": [],
  "replaceExistingWebhook": false
}
```

Conferir os nomes/enums exatos no contrato OpenAPI versionado. Não reaproveitar a
chave idempotente para um input diferente. O progresso sobrevive ao processo;
UNKNOWN exige conciliação por ID/callback. Cancelamento não exclui inbox nem sessão.
Nenhuma transação de banco deve ficar aberta enquanto um backend chama o outro.

## Pareamento e diagnóstico

- QR/pairing code fica apenas em memória da tela autorizada, até expirar. Não
  armazenar em atributos, logs, cache, localStorage ou capturas de tela reais.
- Duas abas compartilham janela curta de pareamento. Repetir uma operação concluída
  não recupera o segredo persistido, pois ele não é armazenado.
- Primeira identidade e substituição exigem administrador. Agente precisa de grant
  específico e identidade anterior aprovada. Troca observada bloqueia o envio e
  preserva a fila até confirmação explícita. Revogação vale na próxima chamada.
- READY indica configuração. CONNECTED indica sessão. OPERATIONAL exige identidade,
  callback assinado na revisão/credencial atual e sucessos de entrada/saída recentes
  posteriores à aprovação da identidade. Sem essas provas: UNVERIFIED.
- Perfil 200 registra acesso administrativo, sem atestar assinatura. Segredo ausente
  registra incompatibilidade. Evidências são datadas e vinculadas à versão da chave.
- `CHATWOOT_CONTEXT_CHANGED`: atualizar e revisar configuração. `IDENTITY_CONFIRMATION_REQUIRED`:
  admin deve conferir número observado. `CHATWOOT_REQUEST_REJECTED`: revisar token/permissões;
  a operação não faz logout do WhatsApp. `UNKNOWN`: conciliar antes de novo POST.

## Homologação e rollback

Executar os três níveis da matriz separadamente. O piloto precisa observar entrada,
saída, anexos, status, duplicatas e queda do Broker **antes** de aceitar o webhook.
Se a versão Chatwoot descartar esse webhook sem retry/catch-up, bloquear liberação
operacional até existir recuperação testada. Não confundir retries internos do
Broker, após o ACK, com recuperação do emissor antes dele.

Para suspender a funcionalidade, desligar as flags de novas superfícies. Não remover
webhook, inbox, fila ou sessão e não desfazer migrações. O worker mantém transporte
existente e proteção de identidade. Revogar uma chave de controle interrompe controle,
sem desligar o número. Reverter para binário anterior ao suporte EXTERNAL só depois
de migrar/esvaziar essas integrações com procedimento autorizado: não apontar jobs
externos silenciosamente ao destino MANAGED.
