# 19 — Matriz de lacunas

| Área | Estado | Evidência atual | Necessário para o alvo |
|---|---|---|---|
| Multi-tenant, memberships e auditoria | IMPLEMENTED | migrations e APIs de organização/plataforma | endurecer cobertura e console global |
| Super admin listar empresas/usuários | PARTIAL | UI/rotas existem; produção apresentou 500 | corrigir contrato, migração e autorização |
| QR/Evolution | IMPLEMENTED | instances, provider accounts e worker | fachada de canais e QR no-store |
| Meta onboarding | PARTIAL | migrations, serviço e rotas | configurar app e homologar ponta a ponta |
| Normalização Meta interativa/contato/localização | MISSING | normalizador não cobre todos | esquemas, testes e UI |
| Templates Meta avançados | PARTIAL | envio básico | mídia, cabeçalhos e botões variáveis |
| Chatwoot externo por tenant | PARTIAL | integração e control APIs | destino generalizado, cofre e SSRF guard |
| JRC gerenciado por inbox | PARTIAL | grants e controlador existem | membership derivada e comandos restritos |
| Agent Bot para caixa existente | IMPLEMENTED | transport/bindings atuais | observabilidade e idempotência ampliadas |
| Flow: ciclo de vida | IMPLEMENTED | 0024/0025, API e canvas | renomear logicamente para automação |
| Flow: mídia e interações WhatsApp | MISSING | catálogo atual limitado | nós nativos e adaptadores |
| Flow: delay/switch/timeout | PARTIAL | JRC possui; Broker não completo | runtime persistente |
| HTTP seguro/subfluxo | MISSING | sem nó canônico | io-worker e políticas |
| Importação n8n | PARTIAL | equivalentes seguros visuais | relatório e suíte de conversão |
| Execução arbitrária n8n | NOT_APPLICABLE | fora do desenho seguro | usar adaptador autorizado, se necessário |
| Typebot incorporado | CONFIG_ONLY | origens configuráveis | decidir licença/integração e contrato |
| Editor visual unificado | PARTIAL | canvas Broker + editor JRC | catálogo e UX alvo |
| Execuções e timeline | PARTIAL | runs existentes | steps/checkpoints/reprocessamento |
| Cofre central de credenciais | MISSING | segredos dispersos | envelope encryption e rotação |
| Workers separados | MISSING | worker compartilhado | messaging/automation/io/scheduler |
| Backup externo testado | MISSING | dump local manual | destino externo e restore drill |
| Object storage de mídia | CONFIG_ONLY | limite/configuração | definir provedor e retenção |
| Rotas duplicadas de configuração | LEGACY | providers/conexões/oficial/integrations | redirects e remoção medida |
| Autorização por grant individual JRC | CONFLICT | difere do vínculo por inbox desejado | migrar para membership da inbox |

## Prioridade

P0: corrigir schema/500, autorização, cofre, backup e observabilidade. P1: fachada de canais, Studio/runtime persistente, mídia/interações e conectores. P2: importadores e integrações opcionais. Nenhum item `PARTIAL` deve ser divulgado como concluído antes do aceite ponta a ponta.

