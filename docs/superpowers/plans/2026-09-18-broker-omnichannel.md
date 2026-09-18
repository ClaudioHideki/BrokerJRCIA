# Broker independente + Flows por empresa e caixa

Escopo solicitado em 18/09/2026: manter o módulo nativo JRC e oferecer também
conexões e automações para empresas que usam outros sistemas compatíveis com
Chatwoot. Este pedido retoma o protótipo de Flows do Broker antes adiado.

## Bases preservadas

- Nova worktree/branch: `broker-omnichannel-20260918` / `codex/broker-omnichannel-20260918`.
- Base: `48eb663` (candidato consolidado, incluindo os ajustes de Compose de main).
- Importação das alterações locais de `broker-flows-20260917` sem modificar a origem.
- Painel de configuração nativa importado de `broker-jrc-suite-20260917`.
- Sem dados, credenciais ou números de produção; sem deploy automático.

## Arquitetura e aceite

1. Empresa isolada no Broker: WhatsApp QR e Meta oficial funcionam sem exigir
   Chatwoot. Meta usa autorização/credencial oficial; QR pertence à conexão do
   dispositivo. O módulo nativo JRC continua consumindo a API de controle.
2. Destino Chatwoot por empresa: origem HTTPS aprovada, conta e token verificados,
   várias caixas, credenciais cifradas. Nenhum segredo global para clientes.
3. Flows no Broker: canvas, JSON, rascunhos, versões publicadas imutáveis,
   execução persistente, simulação, histórico e transferência para humano.
   Nós sem executor bloqueiam publicação; não prometer compatibilidade universal
   com n8n/Typebot.
4. Dois transportes do mesmo motor: canal WhatsApp próprio do Broker ou caixa
   remota usando Agent Bot do Chatwoot. Instagram/e-mail continuam conectados
   à instalação Chatwoot; o Broker responde pela API da conversa.
5. Agent Bot por vínculo: assinatura de webhook obrigatória e verificação de
   capacidade da instalação. Conta/caixa/destino/revisão conferidos em cada
   operação. Versões sem assinatura não recebem ativação silenciosa insegura.
6. Uma automação por caixa/conversa. Não substituir outro bot implicitamente.
   Notas privadas, mensagens do próprio bot e eventos repetidos não iniciam
   novo turno. Humano e suspensão da empresa prevalecem. Envios incertos ficam
   identificados, sem repetição que possa duplicar mensagens.
7. Testes por tarefa: grafo/JSON, API, persistência/RLS, retomada, revogação,
   eventos assinados, empresa/caixa incorretas, loop e interrupção humana.
8. Build e imagens locais revisáveis. Registrar digests/testes e limitações
   reais. Preparar publicação por workflow manual, mantendo o deploy separado.

Referência técnica: https://www.chatwoot.com/hc/user-guide/articles/1677497472-how-to-use-agent-bots
e os controllers/listeners/models da instalação local JRC, que expõem segredo
do Agent Bot e assinatura dos eventos.
