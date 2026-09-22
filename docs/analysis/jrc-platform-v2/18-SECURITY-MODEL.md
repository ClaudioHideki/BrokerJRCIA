# 18 — Modelo de segurança

## Identidade e autorização

- Papéis de plataforma (`SUPER_ADMIN`) são separados dos papéis da organização.
- Toda consulta e comando aplica tenant no servidor.
- Acesso JRC gerenciado exige sessão, conta e membership da inbox.
- Tokens de serviço têm audiência, escopo, expiração, rotação e revogação.
- Operações sensíveis exigem reautenticação/MFA conforme política.

Escopos alvo: `channels:read`, `channels:write`, `messages:read`, `messages:send`, `automations:read`, `automations:write`, `executions:read`, `webhooks:manage`, `credentials:manage`, `chatwoot:manage` e `meta:manage`. Chaves antigas mantêm os privilégios atuais; nenhuma recebe escopo novo implicitamente.

## Cofre de credenciais

Credenciais são cifradas por envelope com chave versionada; AAD inclui tenant, tipo e registro. A API permite criar, testar, rotacionar e revogar, mas nunca ler o segredo. Chaves de ambiente ficam fora do Git e rotação possui procedimento auditável.

## HTTP e webhooks

- Permitir apenas HTTPS e portas aprovadas.
- Resolver DNS antes e durante conexão; bloquear loopback, link-local, redes privadas e metadata cloud.
- Fixar limite de redirecionamentos, tamanho, tempo e resposta.
- Assinar webhooks de saída; validar assinatura, timestamp e replay na entrada.
- Tratar URL, cabeçalhos e corpo como dados não confiáveis.

## Sandbox

Código arbitrário permanece desativado até existir isolamento dedicado: processo/container sem privilégios, filesystem efêmero somente leitura, sem socket Docker, rede negada por padrão, CPU/memória/tempo limitados e imagem mínima. SQL arbitrário não integra o catálogo padrão.

Quando habilitado, SQL aceita PostgreSQL/MySQL com credencial isolada, read-only por padrão, parâmetros vinculados, limite de linhas/tempo e auditoria; escrita exige permissão explícita. O sandbox de código não possui filesystem, ambiente, rede ou módulos arbitrários. HTTP passa sempre pelo I/O worker seguro.

## Proteção de dados

- QR, tokens, Authorization, cookies, conteúdo sensível e payload bruto são redigidos.
- Mídia usa URL curta assinada, validação de tipo/tamanho e varredura quando aplicável.
- Auditoria registra ator, tenant, ação, alvo, resultado e campos alterados redigidos.
- CSP, CSRF, CORS e frame ancestors usam origens exatas.
- Retenção e exclusão cobrem mensagens, eventos, execuções e auditoria conforme obrigação aplicável.

## Testes mínimos

Isolamento multi-tenant, matriz RBAC, SSRF/DNS rebinding, replay, rotação, segredo em logs, iframe/origem, idempotência e concorrência de publicação são gates de release.
