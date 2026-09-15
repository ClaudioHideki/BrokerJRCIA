# Limites dos sistemas

## Princípio central

O JRC WhatsApp Broker oferece aos clientes um contrato público estável e independente dos detalhes internos da Evolution API, da Meta Cloud API e do Baileys.

## Responsabilidades

| Componente | Responsabilidade própria | Não deve controlar |
|---|---|---|
| JRC Control Plane | Organizações, tenants, usuários, planos, API keys, quotas, instâncias e auditoria | Sessões e protocolos internos dos providers |
| JRC Broker Gateway | API pública versionada, autenticação, autorização, idempotência e rate limit | Contratos internos específicos da Evolution |
| Broker Core | Comandos, eventos e capacidades canônicas | Regras particulares de chatbot e CRM |
| Provider Meta | Tradução para Cloud API, webhooks, templates, mídia e capacidades oficiais | Identidade comercial do produto JRC |
| Provider Baileys | Pareamento, sessão, reconexão e eventos do WhatsApp Web | API pública exposta aos clientes |
| Evolution Engine | Implementação interna atribuída e substituível | Tenants, planos, cobrança ou contrato público JRC |
| JRC Conversas, n8n e Typebot | Atendimento e automações integradas por APIs e eventos | Credenciais internas e persistência do broker |

## Isolamento multicliente

Toda entidade operacional deve pertencer a `organization_id` e `tenant_id`. O tenant é derivado da identidade autenticada; o backend não aceita como autoridade um `tenant_id` arbitrário enviado no corpo da requisição.

## Fronteira com a Evolution API

A integração ocorre por uma camada anticorrupção JRC. Essa camada converte comandos e eventos canônicos e impede que mudanças do contrato interno da Evolution quebrem clientes JRC. O uso da engine deve permanecer rastreável por repositório, commit, licença e avisos aplicáveis.

## Segurança

Tokens da Meta, API keys, segredos de webhooks e sessões Baileys não pertencem ao Git. Em produção, devem ser criptografados, rotacionáveis e acessíveis apenas aos workers autorizados.
