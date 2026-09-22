# 11 — Conector Chatwoot externo

## Escopo

Cada organização pode cadastrar uma instalação Chatwoot aprovada, validar o token no servidor e selecionar uma conta e inbox permitidas. O destino recebe mensagens e pode operar uma automação por Agent Bot.

## Fluxo seguro

1. Administrador informa URL HTTPS e token em formulário protegido.
2. Backend normaliza a origem, bloqueia rede privada e resolve DNS de forma segura.
3. Backend testa `/api/v1/profile` e lista somente contas/inboxes autorizadas.
4. Credencial é cifrada e associada ao tenant; a UI recebe apenas máscara e metadados.
5. Canal é vinculado ao destino por identificadores imutáveis.
6. Eventos usam idempotência, assinatura/correlação e outbox.

## Portal incorporado

O embed é opcional. A autenticação ocorre por handshake servidor-servidor com token curto, audiência, tenant, usuário e nonce. Origem do iframe usa allowlist exata e CSP. Mensagens de janela nunca substituem autorização do backend.

## Compatibilidade

Os endpoints atuais `/v1/integrations/chatwoot` e `/control` permanecem como adaptadores durante a migração. Novas operações convergem para `/v1/destinations` e `/v1/channels/{id}/destination`.

## Falhas esperadas

- token revogado: destino `DEGRADED`, sem perder mensagens da outbox;
- inbox removida: bloquear novas entregas e alertar administrador;
- duplicidade: chave por tenant/canal/evento;
- timeout: repetição exponencial limitada e fila de falhas inspecionável.
