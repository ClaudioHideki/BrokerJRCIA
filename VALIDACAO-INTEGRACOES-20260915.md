# Entrega — integração JRC Conversas e preparação Docker

Data: 15/09/2026. Desenvolvimento e validação locais; publicação no GitHub/GHCR e implantação em servidor aguardam a próxima solicitação.

## Implementado

- Administração JRC com e-mail/senha, dashboard atualizado e gestão da integração por empresa.
- Vínculo exclusivo de conta Chatwoot por organização, caixas API por canal, criação de contas/responsáveis por Platform App e associação de atendentes da própria conta.
- Conector QR com recebimento autenticado, estados e envio; canal Meta com onboarding existente e tratamento de mídia.
- Mensagens e tarefas persistentes no PostgreSQL, processamento automático de novas empresas, tentativas com atraso, pausa, fila de falhas, IDs de rastreamento e conciliação de operações incertas.
- Respostas públicas do JRC Conversas para WhatsApp; prevenção de eco/notas privadas, validação de conta/caixa/contato no primeiro atendimento e mensagens com múltiplos anexos.
- Mídia cifrada com isolamento por empresa, limites de tamanho/cota e download autenticado. Download externo restrito às origens e ativos autorizados.
- Imagens separadas API/worker e frontend, Compose Dokploy, migrations de manutenção, readiness, verificação de atividade do worker e ferramenta de backup cifrado.
- Correções de largura em celular, contraste, navegação por teclado e descrição acessível da empresa ativa.
- Workflow de imagens com submódulos e verificações. A CI valida rotas/varreduras atuais sem reescrever o relatório histórico como se fosse uma nova auditoria manual.

## Evidências locais

| Verificação | Resultado |
|---|---|
| Regressão unitária, contratos e HTTP | 936 testes aprovados em 128 arquivos na execução completa antes do envio ao GitHub |
| Integração PostgreSQL/Redis | 166 testes aprovados na execução completa; suíte ampliada de QR/Chatwoot aprovada com 17 testes, incluindo os dois cenários adicionais |
| Distribuição compilada | 2 testes aprovados, incluindo inicialização real |
| Rotas e varreduras atuais | 82 rotas inventariadas; zero achados nos scanners executados |
| Dependências npm | Zero vulnerabilidades conhecidas reportadas na consulta desta data |
| API Docker | Migração em banco vazio, `/health`, `/ready` e execução como UID 1000 aprovados |
| Web Docker e Compose | Build das duas imagens; configuração Dokploy, páginas, assets, proxy, CSP, Permissions-Policy e UID 1000 aprovados |
| Backup e restauração | Cópias cifradas antes/depois das migrations; restauração em PostgreSQL separado conferida |
| Componentes após ajustes finais | 173 testes aprovados |
| Navegador desktop/celular | 9 jornadas aprovadas; 5 combinações de dispositivo omitidas pela configuração original da suíte |

Os logs de execução ficam em `.sessions/` e não devem ser publicados: esse diretório também contém configuração e backups privados. Os testes de navegador incluem cadastro de empresa, login por senha, integração pendente, suspensão, suporte, atendimento, API keys e acessibilidade.

## Ambiente local atualizado

- Console: `http://127.0.0.1:4317`; administração: `/jrc`; integração do cliente: `/integracoes`.
- API: porta 3000, readiness verificado; worker local iniciado.
- Migrations aplicadas até `0017_chatwoot_attachments`.
- Preservados os cinco cadastros de empresas atuais, cinco usuários/filiações, três instâncias e o administrador. Nenhum número foi desconectado por esta atualização.
- Verificado acesso do motor ao callback privado da API via Docker Desktop.
- O banco local não tinha contas Chatwoot vinculadas ou mensagens pendentes no momento da atualização. Os testes de tráfego usaram outro banco e respostas HTTP controladas.

## Configuração e homologação ainda necessárias

1. Definir o domínio HTTPS e preparar a stack no servidor. O Compose atual opera em um servidor; não comprova HA/cluster.
2. Cadastrar/vincular a organização JRC à conta 1 e usar contas separadas para os clientes. Informar o token autorizado de cada conta, ou configurar a Platform App para provisionamento automático.
3. Configurar aplicativo JRC, Embedded Signup e credenciais Meta. A análise/verificação/permissões e a liberação do número dependem da Meta.
4. Homologar na instalação remota QR e Meta, texto/anexos nos dois sentidos, assinatura do webhook, atendentes, estados e retomada após falha.
5. Implantar backup fora do servidor, snapshot Redis, monitoramento/alertas e teste de restauração no ambiente definitivo.

Cluster/HA, agendamento de mensagens, migração de histórico, exclusão por retenção e alertas externos por SLA permanecem trabalhos de expansão/operação. A validação local não comprova aprovação Meta ou funcionamento dos números reais.

Guia operacional: [integração JRC Conversas](docs/operations/integracao-jrc-conversas.md). Instalação futura: [Dokploy](docs/operations/dokploy-saas.md).
