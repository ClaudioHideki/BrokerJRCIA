# Matriz de aceite - Broker JRC + Chatwoot

Estado inicial de todos os cenários: NAO EXECUTADO. Este documento e um roteiro, não evidência de que os testes passaram.

O executor deve preencher para cada ID: commit, ambiente, comando/ação, resultado, evidência sanitizada e bloqueio. Classificacoes permitidas: `PASS`, `FAIL`, `BLOCKED`, `NOT_RUN`. Não converter BLOCKED em PASS.

| ID | Cenário | Plano | Evidencia exigida |
|---|---|---|---|
| A01 | Fluxo legado MANAGED preservado com flags novas off | B1/B7 | Regressao HTTP e PostgreSQL |
| A02 | Duas organizações, dois servidores e mesmos IDs de conta/inbox | B1/B3 | Mapeamento e mensagens sem cruzamento |
| A03 | Mesma origem/conta não pode ter dois donos | B1 | Constraint e concorrencia no banco |
| A04 | Empresa não aprova sua própria origem externa | B1 | 403 e nenhuma credencial transmitida |
| A05 | SSRF por host privado, redirect, IPv6 e DNS rebinding | B2 | Destino/socket bloqueados antes de token |
| A06 | Mídia em CDN permitida sem herdar token da API | B2/B3 | Captura controlada dos headers |
| A07 | Worker/retry/mídia usam origem do tenant correto | B3 | Falha em A não desvia para B |
| A08 | Runtime externo funciona sem origem global MANAGED | B3 | Boot e chamada controlada |
| A09 | Platform token nunca vai a destino externo | B3 | Fixture HTTP confirma ausência |
| A10 | Rotacao de token preserva conta/inbox e não aceita token inválido | B3 | Versão/ciphertext e acesso antigo/novo |
| A11 | Chave Rails limitada não funciona em instâncias/mensageria genericas | B4 | 403 em rotas fora do escopo |
| A12 | Revogacao, suspensao e troca de destino invalidam acesso | B4/E1 | Proxima mutacao negada |
| A13 | Criação concorrente/repetida não duplica instância/inbox | B5 | Uma operação por idempotency key |
| A14 | Mesmo idempotency key com input diferente retorna 409 | B5 | Contrato HTTP |
| A15 | Restart entre etapas preserva progresso | B5 | IDs remotos e estados persistidos |
| A16 | Timeout após POST remoto entra UNKNOWN, sem reenvio cego | B5 | Contagem de chamadas e conciliacao |
| A17 | Caixa configurada não significa WhatsApp/transportes prontos | B6 | Estados separados e sem falsa evidência |
| A18 | QR expirado/sessão trocada limpa segredo da tela | B6/J3 | Fake timers e navegador |
| A19 | Agente delegado não troca identidade do número | B6/J4 | Despacho bloqueado até admin confirmar |
| A20 | Inbox não API/webhook em uso exige recusa/confirmação | B5 | Sem sobrescrita silenciosa |
| A21 | Assinatura inválida/timestamp antigo/corpo alterado | B7 | Negacao antes de persistir/enviar |
| A22 | Evento repetido, entrada, nota privada e eco | B7 | Sem duplicacao/saida indevida |
| A23 | Broker cai antes de ACK e Chatwoot precisa recuperar entrega | B7/J5 | Retry/catch-up observado; sem isso bloquear homologação confiável |
| A24 | Usuário A tenta endpoints de conta/inbox B | J1/J2 | 403/404 antes da chamada Broker |
| A25 | Credencial cifrada por conta não aparece em serializers/bundle/logs | J1/J3 | Teste de cifra e varredura |
| A26 | Rails não mantem transação aberta na chamada Broker -> Rails | J2/J5 | Contrato entre processos sem deadlock |
| A27 | Grant removido ou agente removido da inbox | J2/J4 | Proxima chamada 403 e QR removido |
| A28 | Nova UI não quebra NICO/Comercial/outros canais | J3/J5 | Regressao e diff delimitado |
| A29 | /jrc e /login continuam não incorporaveis | E2 | Headers reais e teste de navegador |
| A30 | Embed funciona só no ancestor autorizado | E2 | Origins de laboratório permitida/negada |
| A31 | Contexto postMessage falsificado não autentica | E3 | Sem sessão/grant criado |
| A32 | Cookies de terceiros bloqueados e popup negado | E3/E5 | Autorização first-party ou portal seguro |
| A33 | Exchange concorrente/expirado e prova incorreta | E1 | Uma emissão atômica ou negacao |
| A34 | Sessão embed não permite desconectar/enviar/criar usuários | E1/E5 | 403 e ausência de side effects |
| A35 | Dashboard App ausente/deletado não interrompe transporte | E4 | Portal e mensagens continuam |
| A36 | Auto-registro de app e repetição/timeout | E4 | Reconciliação por URL e sem duplicacao |
| A37 | Flags desligadas desativam superficies novas sem logout de números | Todos | Rollback funcional |
| A38 | Texto/imagem/audio/video/documento/sticker suportados nos dois sentidos | B7/J5 | Contrato local e piloto remoto separados |
| A39 | Status de envio acompanha resposta/provider, não apenas HTTP 200 | B7 | IDs e evidências correlacionadas |
| A40 | Fluxo de primeira conexão sem nenhuma conversa aberta | J3/E4 | Portal/tela nativa independentes de Dashboard App |

## Niveis de verificação

**Nivel 1 - local:** testes unitarios, contratos HTTP, PostgreSQL/Redis de laboratório, builds e navegador com provider sintético. Resultado não comprova WhatsApp real.

**Nivel 2 - Chatwoot real em homologação:** conta piloto, API, inbox, agentes, assinatura recebida, callbacks, anexos, headers e recuperacao. Não tocar outras contas/caixas. Todas as operações de escrita devem estar cobertas por autorização do piloto.

**Nivel 3 - telefone autorizado:** administrador le QR de número de teste, confirma identidade e valida entrada/saida/mídia/reconexão. Não colocar QR, telefone completo ou tokens nas evidências. Usar IDs tecnicos sanitizados, horarios e estado.

## Bloqueios de produção

Isolamento tenant falho, vazamento de credencial/QR, origem externa insegura, webhook sem verificação compatível, duplicacao não reconciliavel, troca indevida de número, ausência de recuperacao testada na fronteira anterior ao ACK ou regressão do transporte legado bloqueiam a liberação.

## Rollback

Desligar a feature nova e manter transporte/filas existentes. Antes de voltar binario antigo que só conhece uma origem, pausar/drenar empresas EXTERNAL ou manter worker compatível. Não executar down destrutivo, apagar inbox/histórico ou desconectar números para esconder problema.

## Registro de entrega

Entregar resumo por repositório: branch/HEAD, arquivos alterados, migrações, novos contratos, testes efetivamente executados, evidências sanitizadas, falhas preexistentes, bloqueios externos e procedimento de retorno. Nenhuma promoção automática para produção.
