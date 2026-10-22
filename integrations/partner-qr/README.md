# JRC Partner QR — adaptador independente para CCLX

Pacote ESM sem dependências de execução, destinado ao **backend autorizado do host** e ao seu frontend. Node.js 24 ou superior. Não instala, altera nem certifica uma instalação CCLX/Chatwoot. O contrato específico da sessão, das permissões, do banco e do PubSub do CCLX precisa ser ligado e homologado pelo mantenedor do host.

## Arquitetura e instalação

```text
Painel no CCLX -> endpoint SAME ORIGIN do CCLX -> autorização/CSRF do host
              -> chave obtida no servidor -> HTTPS da API JRC
```

1. Copie esta pasta para um componente de backend Node do host. `backend.mjs` importa apenas `safe-http.mjs` e módulos nativos do Node. Não é necessário `npm install` para executar o adaptador.
2. Implemente os hooks de sessão, CSRF, permissões e cofre descritos abaixo. **Não exponha o handler antes disso.** Uma aplicação Rails não executa módulos Node dentro do processo Ruby: use um BFF Node autorizado, atrás da mesma origem e da autenticação do host, ou porte este contrato para um controller Rails com os mesmos controles e testes. Este pacote não instala tal controller.
3. Monte o handler em um caminho dedicado, por exemplo `/host/jrc-qr`. O servidor HTTP do host deve impor limites de conexão, cabeçalhos, tempo de requisição, rate limiting e auditoria sanitizada por ator/conta.
4. Publique como assets apenas `panel.mjs` e `panel.css`; nunca publique os hooks de backend, variáveis de ambiente, cofre ou chave JRC.
5. No frontend autenticado, monte o painel em um elemento exclusivo e chame `destroy()` ao fechar, trocar conta/tenant/inbox, expirar a sessão ou desmontar a tela. Destruir limpa QR, código, timers, requisições e intenções em memória.

Não copiar o protótipo do ZIP para produção. O painel deste pacote chama o adaptador real; os testes usam um upstream HTTP sintético declarado.

## Contrato obrigatório do backend

```js
import { createPartnerQrHandler } from './partner-qr/backend.mjs';
import { hostAuth, hostCsrf, hostPermissions, hostVault } from './ccLX-host-hooks.mjs';

export const qrHandler = createPartnerQrHandler({
  brokerOrigin: process.env.JRC_BROKER_ORIGIN, // https://api-jrc-autorizada.example
  basePath: '/host/jrc-qr',
  async authorize(req, { operation, instanceId }) {
    const session = await hostAuth.verifySession(req);
    if (!session) return null;
    const scope = await hostPermissions.qrScope(session, { operation, instanceId });
    if (!scope) return null;
    return {
      allow: true,
      tenantRef: scope.serverTenantRef,
      allowedInstanceIds: scope.instanceIds,
      allowedProviderAccountIds: scope.providerAccountIds,
      csrfVerified: req.method === 'POST' ? await hostCsrf.verify(req, session) : false,
    };
  },
  async resolveCredentials(grant) {
    return { apiKey: await hostVault.tenantBrokerKey(grant.tenantRef) };
  },
});
```

`ccLX-host-hooks.mjs` acima **não faz parte do pacote**. É um ponto de integração obrigatório com a implementação real do host; não há exemplo que aprove usuários automaticamente.

- `authorize` é executado em toda requisição, recebe a operação e o ID solicitado e deve verificar sessão atual, conta ativa, associação à inbox e permissão para aquela operação. Não inferir permissão por nome de papel exibido no menu.
- `tenantRef` vem de um mapeamento do servidor. Nunca obtê-lo de corpo, query, chave enviada pelo navegador ou cabeçalho de tenant não validado.
- `allowedInstanceIds` e `allowedProviderAccountIds` são arrays explícitos de UUIDs Broker. Arrays vazios não concedem acesso. Somente um administrador autorizado a todos os recursos da empresa deve receber `'*'` explicitamente. As listas são filtradas por esse escopo e uma operação sobre outro ID é recusada antes da chamada JRC.
- Uma criação exige conta de provedor autorizada. O host deve persistir a associação da nova instância com conta/inbox/tenant antes de liberar seu uso a operadores restritos; para esses operadores, não autorize criação sem implementar esse fluxo. O pacote não escreve no banco do CCLX.
- POST exige `csrfVerified: true`. O hook precisa verificar o token real da sessão, enviado no cabeçalho `X-CSRF-Token`; retornar `true` sem validar **não constitui proteção CSRF**. Ausência, `false` e falha negam a mutação.
- `resolveCredentials` consulta o cofre por contexto já autorizado, no servidor. A chave deve possuir `instances:read` e `instances:write` para este módulo. Não é um token Chatwoot nem chave global Evolution.
- Funções ausentes, grants incompletos e retornos não autorizados são recusados. Não há modo anônimo. Não registre req/res completos: podem conter cookies, CSRF e QR transitório.

O handler é uma função `(req, res)` de `node:http`. Use-o somente no prefixo configurado; outros caminhos recebem 404. A chave JRC, cookies do host, Authorization do usuário e IDs de organização não são devolvidos/encaminhados como um proxy genérico.

## Operações permitidas

| Endpoint do adaptador | API JRC efetiva | Observação |
|---|---|---|
| GET `/providers` | GET `/v1/provider-accounts?provider=BAILEYS&limit=100` | Escolha explícita de conta QR autorizada; aceita cursor/limit. |
| GET `/instances` | GET `/v1/instances?limit=100` | Somente BAILEYS e IDs autorizados; aceita cursor/limit. |
| POST `/instances` | POST `/v1/instances` | Corpo local `{name,providerAccountId}`; backend fixa `provider:BAILEYS`. |
| GET `/instances/:id/status` | GET `/v1/instances/:id/status` | Estado atual, sem pressupor entrega de mensagens. |
| POST `/instances/:id/pair` | POST `/v1/instances/:id/connect` | `{}` ou `{pairingHint}`; não interpreta redirects. |
| POST `/instances/:id/reconnect` | POST `/v1/instances/:id/connect` | Reutiliza o contrato de conexão existente; não desconecta automaticamente. |
| POST `/instances/:id/disconnect` | POST `/v1/instances/:id/disconnect` | `{}`; confirmação explícita no painel e permissão no host. |

As mutações em instâncias existentes primeiro consultam GET `/v1/instances/:id` e conferem BAILEYS e ID. POST encaminha a mesma `Idempotency-Key` recebida do host; o handler não cria outra intenção nem repete comandos automaticamente. Headers arbitrários não são encaminhados.

Nome: 1–120 caracteres; pairingHint: 1–64; idempotência: 1–255; corpo JSON: 4 KiB; resposta: 2.1 MB; leitura do corpo: 5 s; upstream: 10 s por requisição do adaptador (configurável `timeoutMs`, 100–30000). A jornada de preflight + comando compartilha esse timeout. JSON inválido, campos extras e overrides de tenant/origem/chave são recusados. Listagens chegam a 100 itens por página.

## Transporte e resposta

A origem é configuração fixa do servidor: HTTPS, DNS público, porta padrão, sem caminho, usuário/senha, query ou fragmento. A implementação padrão resolve DNS em cada chamada, recusa respostas mistas/privadas, fixa o IP no socket TLS, valida o certificado, não reutiliza socket e não segue redirects. O navegador não escolhe destino nem caminho upstream.

`transport` é um ponto de injeção **confiável do servidor**, usado nos testes para conectar um upstream HTTP local sintético. Nunca derive essa função ou o destino de uma requisição do navegador; substituí-la pode remover as proteções DNS/TLS padrão.

Respostas são projetadas para metadados QR estritamente necessários, com `Cache-Control:no-store`. Ações QR aceitam apenas PNG base64 canônico com assinatura PNG, tamanho limitado e validade futura; códigos são texto. REDIRECT/EMBEDDED_SIGNUP não são exibidos nem seguidos por este módulo QR. Erros externos e exceções dos hooks não são devolvidos como diagnósticos brutos.

HTTP 202/pending confirma uma operação pendente, não conexão. 409 exige conferência; timeout/perda de resposta pode ter ocorrido depois do efeito remoto. Não rotular como “falhou, pode repetir com outra chave”. Revogar uma chave de API não desconecta automaticamente uma sessão WhatsApp já existente.

## Montagem do painel

```js
import { mountQRCodePanel } from '/assets/jrc-partner-qr/panel.mjs';
// Carregue /assets/jrc-partner-qr/panel.css como stylesheet do host.
const panel = mountQRCodePanel(document.querySelector('#qr-da-inbox'), {
  apiBase: '/host/jrc-qr', // caminho SAME ORIGIN; URL absoluta é recusada
  csrfToken: () => hostSession.currentCsrfToken(),
  pollIntervalMs: 4000,
  maxPolls: 30,
});
await panel.ready;
// Ao fechar/trocar a conta/inbox ou expirar a sessão:
panel.destroy();
```

O painel usa a sessão do host (`credentials:same-origin`), não possui campo para chave JRC e não usa `innerHTML` para dados. Não existe busca automática de nova credencial, conexão ou reconexão. O polling consulta somente status, no máximo 120 segundos configurados; erro/limite encerra o ciclo e deixa uma ação manual. QR expirado é removido. A primeira listagem percorre no máximo dez páginas; grandes instalações precisam restringir o escopo do usuário no host.

Após mutação não confirmada, o painel preserva a chave de idempotência da mesma intenção em memória e impede mudar para outra intenção sem conferência. Isso não é um ledger durável do CCLX: para preservar tentativas entre recargas/reinícios, o mantenedor precisa armazenar a intenção/resultado no backend do host. Não recarregue para contornar uma pendência. A UI trata uma ação solicitada e uma conexão confirmada como estados distintos.

## Ponto de integração PubSub e mensageria

Nenhum contrato de PubSub/Redis/SSE específico do CCLX foi presumido. Quando o backend do host receber um evento autenticado e autorizado, poderá publicar no canal correto de conta/inbox e o componente proprietário chamar `panel.refresh()`. Esse hook deve apenas atualizar leitura; nunca transformar um evento em reconexão ou envio automático.

O consumidor de mensagens é um módulo separado: deve validar HMAC JRC sobre corpo bruto, deduplicar `eventId` em inbox durável, mapear canal/conversa, impedir loops de espelhamento e fazer autorização CCLX. Não está implementado neste pacote. O painel QR, por si, não faz mensagens aparecerem na inbox CCLX e não substitui o conector de mensagens já existente.

## Validação e limites de entrega

Na raiz do checkout Broker, com as dependências de desenvolvimento já existentes:

```text
npx vitest run --config integrations/partner-qr/vitest.config.mjs --maxWorkers=1
```

Os testes exercitam Node HTTP real contra upstream sintético e DOM JSDOM: autorização/CSRF/IDs, allowlist de rotas/corpos, idempotência, projeção de segredo, DNS proibido, redirecionamento, timeout, limites, renderização e cleanup. Não usam número, chave ou instância de produção. Eles não equivalem a instalação no CCLX nem homologação externa.

Antes de ativar no host, comprovar: hooks reais de sessão/CSRF; operador da inbox A negado para B; tenant A negado para B; QR e reconexão controlada; expiração/logout/troca de conta; conflito/timeout com mesma intenção; logs sem segredos; origens e CSP do host com `img-src data:` para PNG; e mensageria separada com ida e volta. Nenhum deploy é autorizado por este README.

Remoção: desmonte o painel, retire seus assets e a rota do host, e remova o mapeamento/segredo no cofre conforme retenção aprovada. Isso não apaga instâncias no Broker, não desconecta números e não exclui dados do CCLX.
