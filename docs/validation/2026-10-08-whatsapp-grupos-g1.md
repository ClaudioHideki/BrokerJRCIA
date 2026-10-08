# Grupos WhatsApp G1 — catálogo por conexão

Registro de desenvolvimento em 08/10/2026. O programa P0–P10 continua aberto. Este incremento não foi instalado no servidor pelo agente.

## Comportamento implementado

O Broker consulta os grupos do número conectado à caixa QR, guarda um snapshot por organização/canal/identidade e apresenta uma lista paginada na caixa. OWNER e ADMIN podem atualizar e selecionar grupos; OPERATOR pode consultar. O servidor revalida o usuário, a membership, a caixa e o número após as chamadas ao provedor. API keys e VIEWER não autorizam este módulo.

Não há dependência de saúde do Chatwoot para a consulta standalone. A rota usa o ID canônico do canal de mensageria, que pode ser diferente do ID da instância QR apresentado na fachada da caixa.

A Evolution fornece um catálogo completo por `group/fetchAllGroups`; o Broker aplica paginação local. Respostas excessivas, incompletas, inválidas ou vencidas preservam o catálogo anterior como desatualizado. A seleção exige snapshot e revisões atuais, além de uma nova observação da identidade do número. Mudança de número invalida as seleções anteriores.

Selecionar um grupo ainda não envia mensagens nem ativa o bot. Eventos de participantes, representação de conversa em grupo e execução do Flow pertencem a G2/G3. A interface não apresenta esta seleção como automação pronta.

## Persistência e upgrade

Migration aditiva `0050_whatsapp_group_catalog`, depois de `0049_qr_outbound_observations`. Dois objetos possuem FORCE RLS, ownership do migrator, grants restritos e admission do lifecycle. O upgrade não fabrica grupos para conexões existentes, não altera seu destino Evolution e preserva mensagens, outbox e ledger QR anteriores.

Consultas ao provedor acontecem fora das transações. Leases e revisões são conferidos com o relógio do PostgreSQL após adquirir os locks, incluindo concorrência com archive/exclusão. Telefones e participantes completos não aparecem no contrato do catálogo nem na auditoria.

## Evidências locais

- Contratos/adaptador: 63 testes aprovados, incluindo limite de corpo e deadline durante leitura.
- Serviço PostgreSQL: 14 testes aprovados; revogação durante I/O, archive concorrente, lease vencido durante espera por lock e mudança de número cobertos.
- Rotas: 30 testes aprovados; autenticação atual, papéis, paginação estrita e problemas sanitizados.
- UI e montagem na caixa: 40 testes aprovados; troca de empresa, cancelamento, resposta atrasada e uso do ID canônico.
- Composição/OpenAPI/readiness: 17 testes aprovados. Typecheck e build aprovados; bundle, contratos públicos, notices e npm audit aprovados, sem vulnerabilidades reportadas.

A primeira regressão PostgreSQL terminou com 729 testes aprovados e quatro referências de baseline/código de erro desatualizadas. Essas asserções foram corrigidas: os quatro arquivos afetados passaram integralmente na repetição, 34/34 testes. A primeira regressão unitária aprovou 2.285 testes e teve um timeout na geração do PDF de auditoria. Uma tentativa isolada também observou alteração do fingerprint enquanto os arquivos auditados eram modificados. A fonte foi congelada para a repetição completa: **294 arquivos e 2.286 testes aprovados**. Os limites explícitos dos testes e os defaults de CI foram preservados.

Build limpo e entrypoints compilados: 2/2 testes aprovados com PostgreSQL/Redis locais. O primeiro comando compilado sem essas variáveis pulou o caso de runtime; a repetição incluiu esse caso. Gate original do submódulo Evolution aprovado com o Git instalado, sem alteração do upstream. Release check aprovado, 254 rotas e zero achados nos scanners. `git diff --check` aprovado. Nenhum navegador local foi executado.

O adaptador privado S3/MinIO C2a incluído nesta release é uma fundação testada; ainda não substitui a persistência de mídia em produção.

## Main e imagens verificadas

Main `386103cd94982680a3a0e08e93231387b3897945`. [CI 37815849855](https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/37815849855) aprovado nesse SHA, incluindo a matriz PostgreSQL/Redis completa, jornadas de navegador, OpenAPI, container, restore drill e segurança. [Imagens 37817442029](https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/37817442029) aprovadas no mesmo SHA, com SBOM, provenance mode=max e assinatura GitHub OIDC registrada pelo workflow.

```dotenv
JRC_API_IMAGE=ghcr.io/claudiohideki/brokerjrcia-api@sha256:d3ab559ac14540d922dd2e5d9ec14f5dc2e08f6ec5a1e6439d6e4f5cf01fb722
JRC_WEB_IMAGE=ghcr.io/claudiohideki/brokerjrcia-web@sha256:886d61497dec4e2a8b700c39a200abb42ea1928d3f0b248132cc46ebe3bdb3c5
```

Verificação direta no GHCR: os dois manifests coincidem com a tag SHA e o artefato, com plataforma linux/amd64 e manifest de atestação. A verificação criptográfica independente do Cosign não foi executada. Nenhuma instalação ou consulta real de grupos na Evolution do servidor foi confirmada.

## Homologação após instalação

Confirmar baseline 0050 compatível, imagem efetiva e workers; abrir a caixa física de testes do Welton, atualizar o catálogo e comparar seus grupos com o aparelho. Selecionar/desselecionar dois grupos; reabrir e verificar persistência. Repetir com outro tenant, usuário somente leitura, revogação com tela aberta, desconexão e troca controlada do número. Não trocar a conexão real para CENTRAL para simular esse resultado.

Registrar versão, correlação, quantidade e resultado observado sem nomes, telefones ou conteúdo de clientes. O resultado local não comprova a consulta real na versão Evolution instalada.
