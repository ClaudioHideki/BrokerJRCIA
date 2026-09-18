# Prontidão da próxima imagem do JRC Broker

Revisão: `067477b` da branch `codex/broker-omnichannel-20260918`.

## Decisão de liberação

O candidato está apto a gerar uma imagem de homologação com:

- empresas isoladas, Super Admin e usuários por organização;
- WhatsApp QR via Evolution e WhatsApp oficial via Meta Cloud API;
- destinos JRC Conversas ou Chatwoot por empresa;
- associação de um Agent Bot por caixa;
- editor JRC Flows, JSON JRC, versões, sessões, histórico e teste;
- blocos de início, mensagem, captura, menu numerado, condição, variável,
  transferência humana e fim;
- execução do Flow no canal próprio ou em uma caixa Chatwoot/JRC;
- Typebot publicado por API, restrito às respostas textuais compatíveis.

O candidato não deve ser descrito como paridade completa com n8n ou Typebot.
Ainda não existe adaptador de runtime n8n. O importador n8n traduz somente nós
compatíveis e bloqueia os demais. O editor Typebot não está incorporado. Saídas
Typebot incompatíveis, como ações de navegador e inputs não textuais, são
interrompidas de forma explícita.

## Lacunas para o escopo ampliado

| Recurso solicitado | Estado | Trabalho antes de declarar completo |
| --- | --- | --- |
| Menu e opções no WhatsApp | Implementado como texto numerado | Homologar em número QR e Meta reais |
| Botões/listas interativas nativas | Não implementado no Flow | Contratos, normalização QR/Meta, fallback e testes |
| JSON JRC | Implementado | Homologar exportação, reimportação e publicação |
| JSON n8n arbitrário | Não executado | Criar adaptador n8n por webhook/API, credenciais por empresa, sessões, timeout e idempotência |
| Typebot publicado | Conector textual implementado | Configurar origem/token por empresa e homologar runtime real |
| Editor Typebot dentro do Broker | Não incorporado | Definir licença e integração; não copiar o editor sem autorização |
| Mídia em Flows | Transporte possui mídia, motor Flow é textual | Adicionar nós e regras por canal |
| Contatos, localização e respostas interativas Meta | Não cobertos pelo normalizador do Flow | Implementar contratos e webhooks correspondentes |
| Templates Meta avançados | Suporte parcial | Variáveis de cabeçalho/botões e homologação dos templates |
| Embedded Signup Meta | Implementado no código | Configurar e homologar o app real da JRC |

## Imagens que precisam ser publicadas

As duas imagens pertencem ao Broker e devem usar a mesma revisão:

- `ghcr.io/claudiohideki/brokerjrcia-api:<commit>`: API, worker, migrações e motor;
- `ghcr.io/claudiohideki/brokerjrcia-web:<commit>`: painel e canvas.

O workflow `Build reviewed SaaS images` é manual. Executar na revisão aprovada
com `publish=true`, conferir todas as verificações e registrar os dois digests
`sha256`. Nunca misturar API de uma revisão com Web de outra.

## Configuração obrigatória no Dokploy

Preservar todos os segredos existentes e configurar:

```text
CHATWOOT_EXTERNAL_DESTINATIONS_ENABLED=true
CHATWOOT_CONTROL_ENABLED=true
CHATWOOT_EMBED_ENABLED=false
MESSAGING_WORKER_SHARDS=1
MESSAGING_WORKER_SHARD=0
```

Para o aplicativo Meta da JRC:

```text
META_APP_ID=
META_APP_SECRET=
META_SIGNUP_CONFIG_ID=
META_GRAPH_VERSION=
META_TOKEN_ENCRYPTION_KEY=
META_WEBHOOK_VERIFY_TOKEN=
```

`META_TOKEN_ENCRYPTION_KEY` deve conter exatamente 32 bytes em base64 e ser
guardada com o backup. Trocar essa chave depois invalida tokens cifrados já
armazenados. `META_CREDENTIALS_JSON={}` e `META_ASSET_BINDINGS_JSON={}` podem
continuar vazios quando todas as novas conexões usam Embedded Signup.

Para Typebot, registrar somente origens HTTPS aprovadas e limitar cada entrada
às organizações autorizadas:

```json
{
  "typebot-jrc": {
    "origin": "https://RUNTIME-TYPEBOT",
    "accessToken": "TOKEN-SE-EXIGIDO",
    "organizationIds": ["UUID-DA-EMPRESA"]
  }
}
```

Não existe variável n8n no candidato porque o adaptador n8n ainda não existe.

## Preparação externa do aplicativo Meta

Antes do piloto real, a JRC precisa concluir no painel Meta:

1. empresa e aplicativo pertencentes à JRC;
2. Facebook Login for Business e configuração de Embedded Signup;
3. domínio HTTPS, política de privacidade e exclusão de dados;
4. permissões `whatsapp_business_management` e
   `whatsapp_business_messaging`, com acesso exigido para produção;
5. callback de webhook do Broker e token de verificação correspondente;
6. assinatura dos eventos da WABA;
7. número de teste/produção registrado, método de pagamento e revisão da WABA;
8. teste completo de autorização, entrada, saída, status e revogação.

## Configuração por empresa

1. Criar/ativar a organização no Super Admin e habilitar Flows.
2. Cadastrar proprietários e limites.
3. Escolher um transporte:
   - QR: criar conexão, ler QR e aguardar `Conectada`;
   - Meta: executar Embedded Signup e resolver todas as pendências;
   - caixa existente: cadastrar origem, Account ID e token da instalação.
4. Aprovar o destino Chatwoot externo e verificar capacidades.
5. Selecionar a inbox e associar o Agent Bot assinado.
6. Criar/importar, validar, testar e publicar o Flow.
7. Vincular o Flow ao canal ou à inbox. Uma automação por destino.
8. Testar transferência humana e confirmar que o bot não responde depois dela.

## Banco, backup e migração

- PostgreSQL, Redis e Evolution já fazem parte do Compose; não criar serviços
  duplicados no projeto.
- O banco precisa conter as migrações `0024_flows` e `0025_flow_chatwoot`.
- O bloco de menu de `067477b` não adiciona migração.
- Antes da troca dos digests, gerar `pg_dump -Fc` e copiar o arquivo para um
  destino fora do volume do Compose. Um dump mantido somente no mesmo volume
  não protege contra perda desse volume.
- Validar o dump com `pg_restore -l`.
- Executar a migração pelo container API/migrate e exigir sucesso antes dos
  testes funcionais.

## Ordem de publicação

1. Confirmar CI verde na revisão exata.
2. Criar backup externo e registrar os digests atuais para rollback.
3. Rodar manualmente `Build reviewed SaaS images` com `publish=true`.
4. Copiar os digests publicados de API e Web.
5. Atualizar somente `JRC_API_IMAGE` e `JRC_WEB_IMAGE` no Dokploy.
6. Conferir as variáveis acima e fazer Deploy.
7. Confirmar todos os seis containers saudáveis.
8. Aplicar migrações, se a revisão introduzir novas migrações.
9. Validar `/health`, `/ready`, login tenant e login Super Admin.
10. Executar a matriz de aceite abaixo.

## Aceite obrigatório no servidor

- Super Admin lista todas as empresas e usuários.
- Proprietário enxerga apenas a própria empresa.
- QR é exibido, conecta e recebe uma mensagem real.
- Meta autoriza uma conta de teste, recebe webhook assinado e responde.
- JRC Conversas/Chatwoot lista as inboxes após Account ID e token válidos.
- Flow com menu percorre duas opções, opção inválida e transferência humana.
- O mesmo Flow funciona por Agent Bot em uma inbox de teste.
- Typebot inicia e continua uma sessão textual real, se configurado.
- Reinício do worker preserva a sessão e não duplica respostas.
- Logs não apresentam `401`, `500` ou `503` persistentes nas rotas utilizadas.
- Rollback para os digests anteriores foi documentado antes do piloto.

## Segurança operacional

Credenciais exibidas em conversa, captura ou histórico devem ser rotacionadas
antes da liberação definitiva. Não colocar segredos no Git, no JSON exportado
do Flow ou em parâmetros de linha de comando. Dashboard App permanece desligado
até uma homologação separada de autorização e compatibilidade.
