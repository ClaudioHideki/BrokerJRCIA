# 09 — Canais Meta e QR

## Fachada única de canais

O painel deve apresentar `Canal` como agregado único, preservando provedores distintos. QR/Evolution e Meta Cloud API continuam com credenciais, webhooks e ciclos de vida separados.

### Estados independentes

| Dimensão | Exemplos |
|---|---|
| Transporte | `DISCONNECTED`, `PAIRING`, `CONNECTED`, `DEGRADED` |
| Provedor | `PENDING`, `READY`, `RESTRICTED`, `BLOCKED` |
| Automação | `NONE`, `DRAFT`, `ACTIVE`, `PAUSED`, `ERROR` |
| Atendimento humano | `NONE`, `PROVISIONING`, `READY`, `ERROR` |

Um selo “conectado” não pode ocultar falha de automação ou de inbox.

## QR Code

- A API cria ou reutiliza uma sessão pelo adaptador Evolution.
- O QR é efêmero, nunca entra em log, analytics ou cache compartilhado; respostas usam `Cache-Control: no-store`.
- A sessão deve expirar e permitir nova tentativa sem criar conexões duplicadas.
- Existe no máximo um pairing ativo por canal. Chamadas concorrentes reutilizam a mesma sessão ou retornam estado determinístico.
- Se a identidade observada divergir da esperada, o canal entra em `IDENTITY_MISMATCH`/`IDENTITY_CHANGE_PENDING` e falha fechado; apenas um administrador pode aprovar a troca.
- Desconectar ou substituir exige papel administrativo do Broker.

## Meta Cloud API

- Embedded Signup associa WABA, número e permissões à organização autenticada.
- `META_APP_ID`, segredo, configuration ID, versão Graph, chave de criptografia e verify token são configuração obrigatória do ambiente.
- Tokens ficam cifrados com chave separada e nunca retornam ao navegador.
- Webhooks validam assinatura, verify token, replay e associação ao tenant.
- Normalização alvo inclui texto, mídia, template, botão/interactive, contato e localização.

## Aceitação

1. Criar canal QR, parear e receber/enviar mensagem.
2. Vincular o canal a uma inbox autorizada e publicar automação.
3. Concluir Embedded Signup, receber webhook Meta e enviar mensagem/template.
4. Exibir as quatro dimensões de estado e histórico de falhas.
5. Bloquear operação cruzada entre organizações.

## Templates Meta

O envio atual é `PARTIAL`. O alvo separa gestão e envio: listar, criar rascunho, editar, enviar para análise, sincronizar status, cadastrar amostra de cabeçalho de mídia, variáveis de corpo e botões, e somente então enviar template aprovado. Cada capacidade depende do que a Graph API e a conta homologada permitirem.
