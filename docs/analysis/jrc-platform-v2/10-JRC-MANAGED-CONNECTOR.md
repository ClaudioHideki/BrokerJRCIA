# 10 — Conector gerenciado JRC Conversas

## Objetivo

Permitir que um usuário do JRC Conversas consulte e pareie o canal da inbox à qual pertence, enquanto a administração do provedor, tenant e automação permanece no Broker.

## Autorização efetiva

Toda chamada deve comprovar, no servidor:

1. sessão válida do usuário;
2. associação do usuário à conta;
3. associação do usuário à inbox (`InboxMember`);
4. associação registrada entre conta/inbox e organização/canal do Broker;
5. escopo e expiração do token de serviço JRC → Broker.

### Permitido ao membro da inbox

- consultar estado sanitizado;
- iniciar ou renovar pareamento QR;
- consultar expiração e instruções do pareamento.

### Restrito ao administrador do Broker

- desconectar ou substituir conexão;
- alterar provedor, organização ou automação;
- consultar/alterar credenciais;
- configurar Meta, destinos externos ou limites;
- conceder acesso administrativo.

## Contrato

O JRC Conversas chama um endpoint servidor-servidor assinado. O Broker resolve tenant e canal pelo grant persistido. O navegador recebe somente estado operacional e QR efêmero. `postMessage` pode informar mudança visual, mas nunca autentica ou concede acesso.

## Ajustes sobre o legado

O modelo atual de grants individuais é `PARTIAL`: ele comprova vínculo, porém adiciona administração manual e permite rotas sensíveis no mesmo controlador. A migração deve criar grant por inbox, derivar membros de `InboxMember`, separar comandos administrativos e manter leitura compatível durante a transição.
