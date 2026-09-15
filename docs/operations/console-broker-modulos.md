# Console operacional e referências

Referências fornecidas pelo usuário: capturas do Evolution Manager 2.3.7 e https://ligo.cloud/plataforma/bots/ (consultada em 14/09/2026). A página pública Ligo apresenta editor por blocos, atendimento humano, IA com conhecimento de arquivos, relatórios e integrações. O painel privado enviado exige autenticação; seus controles internos não foram verificados.

## Organização do produto JRC

| Área | Responsabilidade e situação |
|---|---|
| Conexões | Meta e Baileys por empresa. Lista com busca/filtro; painel Baileys com identidade, registros sincronizados e configurações reais. |
| Automações | Typebot como editor externo e execução por API. Vínculo atual com canais Meta; Baileys ainda exige ingestão e saída canônicas. |
| Atendimento | Meta possui recursos parciais de conversa/pausa humana. Inbox Baileys, atribuição a agentes e histórico paginado ainda pendentes. |
| Eventos | Histórico de provisionamento, conexão e desconexão. Entregas de webhook para clientes, assinatura, retry e DLQ não estão nesta tela. |
| Integrações | Atalhos para módulos implementados. Adaptadores n8n/Chatwoot/Dify/Flowise, proxy e filas externas não são habilitados por simples inclusão de botões. |
| Administração JRC | Empresas, responsáveis, usuários, planos, limites e suporte auditado. Resumo da situação das empresas carregadas; separado do portal cliente. |
| IA e conhecimento | Referência Ligo para evolução de bots; base de conhecimento própria, templates e relatórios de automação permanecem pendentes. |

## Painel por conexão

`GET /v1/instances/:id/workspace` exige JWT de organização. Resolve a instância no PostgreSQL usando RLS e só então consulta seu identificador privado no motor. Resposta contém perfil, contagens, sete configurações permitidas e até 30 operações recentes; não contém token, proxy, estado de autenticação nem dados de outra instância. Provedor indisponível gera contagens nulas, apresentadas como “—”. Contagens refletem registros sincronizados, não necessariamente o histórico completo do celular.

`PUT /v1/instances/:id/settings` exige OWNER/ADMIN vigente e empresa ativa, valida sete campos sem propriedades extras e registra tentativa antes da chamada externa e resultado depois. Revalida membership no banco; o guard de autenticação consulta usuário ativo com o papel de banco de autenticação. Não amplia permissões de `jrc_app`. Rejeita alteração de instâncias ainda não provisionadas. API keys não acessam essas rotas de console.

A resposta de atualização do motor precisa confirmar instância e valores. Resultado não confirmado retorna erro, sem nova tentativa automática. Integração de voz ativa no motor impede atualização porque a implementação upstream pode apagar seu token em memória quando omitido. Nenhum segredo de voz é retornado ou reenviado. Autorização e chamada externa não são atômicas: suspensão concorrente após autorização pode coincidir com uma alteração já iniciada. Falha de auditoria final impede resposta de sucesso; a tentativa permanece registrada e exige investigação.

Alterações de configurações ficam em `audit_logs`; a aba Eventos atualmente lista `provider_operations`. Evite interpretar essa aba como histórico integral de auditoria ou mensagens.

## Operação local e publicação

Usar os mesmos Compose, env e Dockerfile descritos em `dokploy-saas.md`. Novas funcionalidades não exigem migração, credencial pública do motor ou reinício de sessões Baileys. Recriar apenas API e web ao aplicar este incremento. Imagens são construídas localmente; nenhuma publicação GitHub/registry ou implantação externa foi executada.

Na conexão real já pareada, a validação deste incremento deve limitar-se a leitura. Não disparar mensagens, salvar configurações, reiniciar, desconectar ou gerar novo pareamento para testar a interface.

## Evidências de validação — 14/09/2026

- 19 testes de gateway, serviço e HTTP passaram (incluem duas organizações, papel rebaixado, API key recusada, suspensão e indisponibilidade do motor).
- 143 testes de interface passaram. TypeScript completo e verificação de fronteira do contrato público passaram.
- Regressão completa executada: 850 passaram e 9 falharam inicialmente por inventário/expectativa de rotas desatualizados. Após correção, os quatro arquivos afetados passaram integralmente: 31 testes. Não interpretar esse resultado como validação de todos os módulos futuros.
- Imagens API e web construídas com sucesso; containers atualizados e API saudável. Motor permaneceu ativo durante a atualização.
- Consulta HTTP real autenticada: Alfa obteve perfil, contadores e configurações da conexão existente; Beta recebeu 404 para o mesmo ID. Ambas foram impedidas de acessar a administração global com token de cliente. A conexão permaneceu CONNECTED.
- Nenhuma mensagem real enviada e nenhuma configuração real alterada para testes. Banco/Redis/credenciais/sessões preservados. Nenhum commit ou publicação.
