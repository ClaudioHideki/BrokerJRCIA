# Mapa de navegação — candidata de 29/10/2026

Fonte executável única: `apps/web/src/layout/navigation.ts`. Sidebar da empresa,
pesquisa, centro de configurações e breadcrumbs consomem esse registro. O export
administrativo `platform/model.ts#sections` preserva compatibilidade com a mesma fonte.

| URL preservada ou nova | Rótulo anterior | Rótulo/área da candidata |
|---|---|---|
| `/dashboard` | Dashboard | Dashboard / Visão geral |
| `/channels` | Caixas de entrada | Conexões e caixas / Atendimento |
| `/provisionamento` | Provisionamento | Provisionamento / Atendimento |
| `/mensagens` | Conversas | Conversas / Atendimento |
| `/automations` | Automações | Flows e automações / Atendimento |
| `/integracoes` | JRC Conversas | Integrações / Integrações |
| `/api-webhooks` (nova) | — | API e webhooks / API e webhooks |
| `/chaves-api` | Chaves de API | Chaves de API / API e webhooks |
| `/operations/health` | Saúde operacional | Saúde operacional / Monitoramento |
| `/relatorios` | Relatórios | Relatórios / Monitoramento |
| `/uso-custos` | Uso e custos | Uso e custos / Monitoramento |
| `/brain` | JRC Brain | Diagnóstico por regras / Monitoramento |
| `/configuracoes` (nova) | — | Configurações / Configurações |
| `/minha-empresa` | Configurações | Minha empresa e limites / Configurações |
| `/credentials` | Credenciais | Credenciais / Configurações |
| `/suporte` | Suporte | Suporte / Configurações |

`/documentation/` continua um portal servido separadamente, acessado por link HTML
na nova página API. Os assets PDF/OpenAPI/Postman são os produzidos pelo gerador
existente. O frontend não recebe senha de provider, não emite chave e não executa
um teste com efeito externo só por abrir essa página.

## Compatibilidade e papéis

- Preservados os redirects `/providers`, `/conexoes`, `/conexoes/nova`,
  `/conexoes/:id`, `/whatsapp-oficial`, `/flows` e as páginas `/legacy/*`.
- Chaves de API aparecem somente para OWNER/ADMIN. O deep link restrito continua
  exibindo a orientação da página existente e o backend continua validando autoridade.
- OPERATOR/VIEWER mantêm os destinos de leitura de conexões, Flows, credenciais,
  integrações e monitoramento. Menu não concede escrita nem substitui grants.
- Plataforma permanece na sessão SUPER_ADMIN/SUPPORT, com os mesmos sete destinos
  `/jrc*`, busca própria e contexto visível. Não há atalho que converta a sessão
  administrativa em autoridade de uma empresa.
- Seções podem ser recolhidas mantendo os nomes; busca ignora acentos e usa
  descrições/sinônimos. Troca de empresa limpa descoberta; menu móvel usa primeiro
  link visível ou o campo de busca e restaura foco ao fechar/limpar.
- Nas conexões QR, o rótulo **Histórico operacional** substitui **Eventos**, mantendo
  o ID interno `events` e os mesmos handlers. Eventos de mensagem, webhooks e grupos
  não são apresentados como se fossem esse histórico.

## Limites desta entrega

Campanhas, mídia/storage e chamadas não ganharam links para telas inexistentes.
Grupos e histórico continuam contextuais à conexão. Capacidade/provider, identidade,
configuração, limites e estados de entrega continuam verificados nas telas e APIs
existentes; disponibilidade no registro significa somente página implementada.
