# Broker JRC: capacidade, contrato e prova operacional

Revisão de código em 22/10/2026. A referência Evolution está fixada em
`fa09d37892cdbb1d65a250155d293d92230c5b30`. Código presente não é prova de
capacidade da imagem instalada nem de entrega num número em produção.

| Recurso | Base do Broker / motor | Acesso do parceiro e trabalho restante |
| --- | --- | --- |
| Criar, parear, reconectar, estado e desconectar QR | Rotas de instância, isolamento de organização, idempotência e adaptador Evolution | Perfil público Conexões. Reconectar usa `/connect`; pacote `integrations/partner-qr` exige autenticação/permissões do host. |
| Texto individual | Fila canônica, status observado e despacho pelo provedor | Perfil público Mensageria com `messaging:send`; 202 é fila. Provar percurso WhatsApp/CCLX em homologação. |
| Imagem, áudio, vídeo, documento, figurinha | Adaptador `evolution/messaging.ts` implementa download e `sendMedia`/`sendSticker`; console e integração direta usam contratos próprios | Não estão liberados pela chave genérica de texto. Exigem contrato de upload/download privado por chave, cotas, idempotência e testes ponta a ponta. Não trocar a permissão para JWT/ADMIN por uma chave ampla. |
| Campanha sequencial | Agendador e campanha no JRC; motor faz envios individuais | A ponte de intenção/recibo da campanha precisa acompanhar a revisão JRC/Broker correspondente. Lista da campanha não equivale à lista nativa de transmissão do WhatsApp. |
| Grupos | Catálogo, seleção, ingestão, projeção na central e automação de texto existentes no Broker | Rotas do console têm escopo próprio. Acesso por chave, administração de participantes e demais recursos não são presumidos. Conferir grupo, vínculo e revisão antes de qualquer efeito. |
| Histórico | Importador e worker próprios, com classificação de origem e checkpoints | Não prometer cópia integral automática do WhatsApp. Disponibilidade depende do histórico fornecido pelo motor e da origem autorizada. Eventos importados não devem acionar novo bot. |
| Contatos | Identidade canônica em mensagens e contagem no workspace do provedor | Cadastro/busca/importação genéricos por API exigem contratos próprios; criar uma conversa por telefone não implementa catálogo completo de contatos. |
| Localização, cartões de contato, reação, enquete, lista/botões | A referência Evolution contém funções dedicadas em `sendMessage.router.ts` | Não há equivalência automática na API JRC. Cada tipo exige schema, armazenamento/projeção, despacho, tratamento de retorno e capacidade validada por canal/versão. |
| Chamadas | `offerCall` da referência fixada em `whatsapp.baileys.service.ts` tem chamadas reais comentadas e retorna `{id:'123',...}` | Não é uma chamada de voz funcional. Requer transporte de voz efetivo e homologado; não expor stub como sucesso. `rejectCall/msgCall` são configurações, não capacidade de conversar por voz. |
| Tempo real | Eventos persistidos, webhook assinado e polling por cursor nesta revisão; monitoramento operacional no console | O CCLX precisa verificar assinatura, deduplicar e ligar sua inbox/outbox durável ao Pub/Sub. Tecnologia da fila ainda não informada. |
| Flows / URA | Editor, simulador, publicação, versões e executor canônico no Broker | Gestão pelo console e credenciais específicas de Flow. A chave de QR/texto não instala editor no CCLX nem autoriza todas as operações. Validar vínculo, catálogo remoto, handoff e executor único. |
| Meta oficial | Onboarding, assinatura de webhook e integração Meta existentes | Depende de ativos/permissões/aprovações e teste com número oficial de homologação. Perfil de envio genérico desta revisão é QR/texto; não presumir acesso a templates e mídia Meta. |

## Modelo para o CCLX

Uma organização Broker `Casa do Construtor CCLX`, com contas de provedor e limites
provisionados pela JRC. Seus administradores usam o console; seu backend usa uma
chave da organização. Uma instância por número, associada pelo CCLX à Account/caixa
e aos agentes autorizados. Um agente pode ter várias caixas; um número pode servir
vários agentes. A autorização não pode depender de nome digitado no navegador.

O módulo QR pede operações ao backend do CCLX; a chave não vai para o navegador.
O adaptador de mensagens traduz IDs e eventos, persiste deduplicação e publica na
fila local. Nenhum acesso direto ao banco ou Redis de outra empresa é necessário.

Para Flow, começar pelo editor no console Broker e um canal de homologação.
Incorporar o editor ao CCLX é uma instalação adicional, dependente dos pontos de
extensão da versão exata. Retomada do bot e atribuição humana devem usar comando
coordenado com revisão e executor único; não criar um segundo caminho de envio.

## Ordem operacional

1. Corrigir saúde das caixas: identidade, callback, política do executor e revisões.
2. Publicar API/Web, aplicar migrações e iniciar os workers da mesma revisão.
3. Homologar QR + texto + eventos num número, com isolamento e retomada.
4. Instalar o adaptador CCLX e provar entrada/saída/estados/loops e handoff.
5. Ampliar contratos por chave para mídia e demais tipos, um recurso por vez com
   prova de capacidade. Chamadas são projeto próprio, não uma flag da mensageria.

Não fazer retry em lote das entregas antigas. `UNKNOWN` precisa de conciliação.
