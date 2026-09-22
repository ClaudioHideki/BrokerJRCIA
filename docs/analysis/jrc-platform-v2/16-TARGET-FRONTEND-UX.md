# 16 — Frontend e experiência alvo

## Navegação proposta

| Rota alvo | Origem | Decisão |
|---|---|---|
| `/dashboard` | dashboard atual | manter e corrigir estados parciais |
| `/channels` | conexões + providers + WhatsApp oficial | consolidar |
| `/channels/new` | nova conexão + onboarding Meta | consolidar por assistente |
| `/channels/:id` | detalhe da conexão | ampliar com quatro estados |
| `/automations` | flows + mensagens/automações | consolidar |
| `/automations/:id/edit` | canvas de flows | evoluir para Studio |
| `/automation-executions` | runs dispersos | criar |
| `/destinations` | JRC Conversas/integrations | consolidar |
| `/credentials` | chaves e credenciais de integração | separar por finalidade |
| `/settings/*` | minha empresa/configurações | manter |
| `/jrc/*` | console global | manter com correção de API/autorização |

Rotas antigas recebem redirect e aviso de depreciação; não são removidas no primeiro lançamento.

## Assistente de canal

1. Escolher QR ou Meta.
2. Configurar/autorizar provedor.
3. Validar transporte.
4. Escolher destino humano.
5. Escolher ou criar automação.
6. Revisar e ativar.

Cada etapa salva progresso e apresenta erro acionável com `correlationId`.

## Regras de interface

- Ações indisponíveis explicam papel ou pré-requisito faltante.
- Segredos nunca voltam preenchidos; apenas estado, máscara e rotação.
- Publicação mostra diferenças entre rascunho e versão ativa.
- Canvas bloqueia publicação com erro estrutural, mas permite salvar rascunho.
- Execuções mostram dados redigidos e permitem filtrar por canal, conversa, versão e estado.
- Console global lista todas as empresas somente para `SUPER_ADMIN`; usuário comum permanece limitado às memberships.

## Acessibilidade e resiliência

Teclado, foco, rótulos, contraste, estados vazios e leitores de tela integram o aceite. Atualizações otimistas precisam de reversão visual. Falhas 401 renovam sessão uma vez; 403 não entram em loop; 5xx exibem correlação e preservam edição local.

