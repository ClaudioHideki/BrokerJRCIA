# 22 — Decisões e riscos

## Decisões

| Decisão | Motivo |
|---|---|
| Broker é autoridade de canal e automação | evita configuração divergente entre painéis |
| Chatwoot/JRC é autoridade de inbox e atendimento | preserva modelo operacional existente |
| Modelo canônico, não execução arbitrária de JSON | segurança, suporte e previsibilidade |
| Postgres outbox + Redis antes de novo broker | menor complexidade sem evidência de escala contrária |
| Versões publicadas imutáveis | reproduz execução e rollback |
| Credenciais por referência cifrada | impede segredo em definição/UI/log |
| Migração expand-and-contract | permite rollback sem perda |
| Editor Typebot incorporado depende de licença | evitar compromisso técnico/jurídico prematuro |

## Decisões pendentes

- Licença e forma de integração Typebot.
- Limites de retenção de mensagens, eventos, mídia e execuções.
- Provedor de object storage e antivírus de mídia.
- SLOs, volume máximo e critérios que justificariam novo sistema de filas.
- Escopo dos nós CRM/Nico na oferta geral ou específica da JRC.

## Riscos

| Risco | Probabilidade/impacto | Mitigação |
|---|---|---|
| Schema de produção divergente | alta/alta | reconciliar migrations e bloquear deploy incompatível |
| Vazamento multi-tenant | média/crítica | políticas servidor, testes e índices tenant-aware |
| Duplicação de mensagens | média/alta | idempotência, outbox e correlação |
| SSRF por nó HTTP/Chatwoot | alta/crítica | egress restrito, DNS guard e allowlist |
| JSON importado mudar semântica | alta/alta | relatório explícito e homologação antes de publicar |
| Worker único causar contenção | média/alta | filas e serviços separados gradualmente |
| Meta rejeitar configuração | média/alta | ambiente de homologação e checklist do app |
| Dependência de API Chatwoot | média/média | adaptador versionado e contract tests |
| Rollback falhar por migração destrutiva | baixa/crítica | migrations aditivas e restore drill |
| Escopo crescer para clone integral de n8n | alta/alta | catálogo fechado e critérios de produto |

