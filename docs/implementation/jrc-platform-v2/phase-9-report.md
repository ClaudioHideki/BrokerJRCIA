# Fase 9 — consolidação e migração legada

Data da validação: 22/09/2026

## Resultado

A Fase 9 consolida o snapshot atual do Broker JRC e conclui a migração controlada dos flows legados para o Automation Studio JRC. A implementação preserva origem, identificadores, versões, checksums e bindings; impede dois runtimes ativos no mesmo canal; mantém flows incompatíveis como `LEGACY`; e permite cutover e rollback auditáveis sem excluir os dados antigos.

O runtime novo continua sendo o JRC. Typebot e n8n são fontes de importação e referência de compatibilidade, sem execução implícita ou dependência obrigatória.

## Código implementado

- Migration `0029_legacy_flow_migration.sql` com relacionamentos, constraints, RLS, grants mínimos, estados de reconciliação e trilha de transição de owner.
- Conversão determinística e idempotente, com checksum canônico, versões imutáveis, detecção de divergência e relatório de incompatibilidade.
- Cutover transacional com drain de execuções antigas, lock do canal, owner único e recusa de conflito ou concorrência insegura.
- Rollback transacional que restaura o owner legado somente quando não existe execução viva no runtime JRC.
- CLI paginada por organização e flow, com retomada por cursor e lotes acima de 200 itens.
- API tenant para listar, migrar, fazer cutover e rollback, com Bearer, RBAC, `Idempotency-Key`, isolamento por organização e auditoria.
- OpenAPI público atualizado, sem expor operações internas dos providers.
- Painel de migração no Automation Studio com estados `CONVERTED`, `WAITING_FOR_DRAIN`, `MANAGED`, `LEGACY`, `CONFLICT` e `ROLLED_BACK`.
- Pacote reproduzível por manifesto SHA-256 verificado, inclusive fora de um checkout Git.
- Correção dos links internos da console legada para manter criação, detalhe e retorno no fluxo legado enquanto `/channels` permanece a entrada canônica.

## Banco e atualização

A cadeia completa de migrations e o caminho incremental `0028 -> 0029` foram executados em PostgreSQL 16 real. O teste incremental usa uma base 0028 sanitizada, preserva os registros anteriores e valida descoberta, RLS, constraints e permissões após o upgrade. O runtime comum usa `jrc_app` sem `BYPASSRLS`; descoberta administrativa fica limitada ao papel explícito de migração.

## Matriz de aceite local

| Gate | Resultado |
| --- | --- |
| `npm ci` | 318 pacotes, 0 vulnerabilidades; aviso de engine apenas porque o host possui Node 24.16.0 |
| `npm run typecheck` | aprovado |
| `npm run build` | aprovado |
| `npm test` | 182 arquivos, 1.199 testes aprovados |
| `npm run test:integration -- --maxWorkers=1` | 41 arquivos, 253 testes aprovados em PostgreSQL 16 |
| `npm run test:e2e` | 27 aprovados; 5 pulados intencionalmente por projeto/viewport |
| `npm run security:contracts` | aprovado |
| `npm run security:notices` | aprovado, 7 pacotes de navegador inventariados |
| `npm audit --audit-level=high` | 0 vulnerabilidades |
| imagem Docker | build aprovado com Node 24.19.0 fixado por digest |
| smoke da imagem `jrc-whatsapp-broker:phase9` | `/health`, `/ready`, migrations e dependências aprovados; UID 1000 |
| auditoria/PDF | 9 testes de artefato aprovados; PDF de 19 páginas A4 verificado a 150 DPI |

O build da imagem confirmou a versão exigida Node 24.19.0. Os comandos executados diretamente no host usaram Node 24.16.0; por isso a evidência da versão exata se limita ao build e smoke do container, e não é apresentada como propriedade dos testes executados no host.

## Operação recomendada

1. Criar e verificar backup do PostgreSQL e dos objetos/arquivos antes da migration.
2. Aplicar as migrations com o papel administrativo dedicado, começando por homologação restaurada do backup.
3. Executar a migração em modo de descoberta e lotes pequenos; revisar `LEGACY` e `CONFLICT` antes de avançar.
4. Monitorar checksums, bindings, execuções vivas, filas, webhooks e auditoria por organização.
5. Solicitar o cutover somente depois de `WAITING_FOR_DRAIN` chegar a zero execuções antigas.
6. Confirmar owner e binding únicos no canal após cada cutover.
7. Se necessário, executar rollback com motivo e ator identificados; a API recusará a operação enquanto houver execução JRC viva.
8. Manter schemas e dados legados durante a janela de observação. Exclusão exige processo separado, retenção aprovada e backup verificável.

## Rollback e riscos

O rollback troca binding e owner em uma transação e não apaga definições, versões ou histórico. O principal risco operacional é realizar cutover antes do drain ou ignorar um conflito de checksum; ambos são bloqueados e expostos na UI/API. Interrupção entre lotes é recuperável por reconciliação idempotente. A remoção prematura dos dados legados eliminaria essa garantia e não faz parte desta fase.

## Integrações ainda não homologadas

Os seguintes itens exigem credenciais, ativos e endpoints externos reais e permanecem fora da homologação local:

- aplicativo Meta da JRC, Embedded Signup, WABA, número, permissões, revisão e webhook público HTTPS;
- sessão Baileys/WhatsApp real, leitura de QR em aparelho e reconexão contra o provider de produção;
- endpoint externo do JRC Conversas/Chatwoot e validação de callback em ambiente público;
- publicação da imagem no GitHub Container Registry e implantação no Dokploy.

Nenhuma migration foi aplicada em produção, nenhuma imagem foi publicada e nenhum deploy foi realizado nesta fase.
