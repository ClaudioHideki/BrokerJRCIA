# C0a — baseline offline de planejamento de capacidade

O coletor `scripts/operations/capacity-report.mjs` recebe um arquivo JSON de inventário agregado fornecido pelo operador. Não consulta host, banco, Redis, motores QR, bucket ou serviço externo; não lê variáveis de ambiente ou credenciais e não instala dependências. O inventário efetivo do servidor permanece **UNKNOWN** até o operador fornecer observações atuais. Esta entrega não demonstra capacidade para 500 empresas ou 10.000 sessões WhatsApp.

As metas de 500 empresas e 10.000 conexões aparecem em `targets`, separadas dos valores recebidos. `monthlyConversations` é o **total mensal informado**, não o volume por empresa. O coletor nunca multiplica automaticamente 250.000 conversas pelas 500 empresas.

Prova lógica adicional em 07/10: `apps/api/tests/integration/tenant-logical-capacity.test.ts` passou em três testes com 500 empresas, proprietário ativo por empresa, quotas/grants de 20 conexões, 5.000 canais QR e 5.000 Meta sintéticos. A role `jrc_app` vê somente os 20 canais do tenant e não altera um canal conhecido de outro tenant. Não cria operações externas ou sockets, mede throughput, dimensiona hardware nem comprova 10.000 sessões WhatsApp simultâneas.

## Contrato de entrada

Raiz estrita: `schemaVersion: 1`, `workload` obrigatório, `resources` e `pools` opcionais. Campos desconhecidos em qualquer objeto são rejeitados, inclusive URLs, tokens, senhas, nomes de clientes, telefones, hosts e rótulos livres. Não colocar esses dados no arquivo. As funções `estimateWorkload(input)` e `buildCapacityReport(input)` também validam o contrato; não modificam o objeto recebido.

| Campo | Limite aceito |
| --- | --- |
| `resources.cpuCores` | Número finito positivo, até 65.536; fração permitida |
| `resources.ramBytes`, `resources.diskBytes` | Inteiro positivo seguro, até `Number.MAX_SAFE_INTEGER` |
| `workload.organizations` | Inteiro de 1 a 100.000 |
| `workload.connections` | Inteiro de 0 a 1.000.000 |
| `workload.monthlyConversations` | Inteiro de 0 a 1.000.000.000; total de todas as empresas informadas |
| `workload.messagesPerConversation` | Número finito positivo, até 10.000; média fracionária permitida |
| `workload.daysPerMonth` | Inteiro de 1 a 366 |
| `workload.peakMultiplier` | Número finito de 1 a 10.000; hipótese fornecida pelo operador |
| `workload.mediaFraction` | Número finito de 0 a 1 |
| `workload.meanMediaBytes` | Inteiro de 0 a 1.000.000.000 |
| `workload.retentionDays` | Inteiro de 0 a 36.500 |
| `pools.maxConnections` | Inteiro de 1 a 1.000.000 |
| `pools.reservedConnections` | Inteiro de 0 a `maxConnections` |
| `pools.components[].replicas` | Inteiro de 1 a 10.000 |
| `pools.components[].maxPerReplica` | Inteiro de 1 a 1.000.000 |

Esses tetos são limites de validação/aritmética do coletor, não capacidade suportada pelo Broker. `workload` exige todos os nove campos da tabela. `resources` pode conter um subconjunto de seus três campos; ausência é desconhecida, nunca zero. `pools`, quando fornecido, exige os três campos e de um a nove componentes distintos. `name` aceita somente `API`, `AUTH`, `MESSAGING`, `AUTOMATION`, `AUTOMATION_IO`, `SCHEDULER`, `LIFECYCLE`, `MIGRATOR` ou `EVOLUTION`. Repetição de componente é erro; agregar as réplicas de cada tipo em uma entrada. O orçamento SQL cobre somente os componentes declarados; a presença da lista não comprova que o inventário operacional está completo.

São rejeitados `null`, strings numéricas, arrays em lugar de objetos, versões desconhecidas, campos extras, valores não finitos/fora da dimensão e contagens fracionárias. Cálculos que ultrapassem a magnitude de um inteiro seguro falham com `CAPACITY_ESTIMATE_OVERFLOW`. Médias e taxas são aproximações numéricas de planejamento, não contagens observadas de eventos.

## Saída e cálculos

Todas as medições recebidas em `observations` têm `{ value, source: "OPERATOR_INPUT" }`. Os cálculos possuem `source: "OPERATOR_INPUT"` e `kind: "DERIVED_PLANNING"` para indicar de onde vêm as hipóteses. As metas possuem `source: "PLANNING_TARGET"`. Não há classificação PASS, resultado de benchmark ou estimativa automática de número de servidores.

- `PARTIAL`: falta CPU, RAM, disco ou o bloco de pools; `missing` enumera os campos faltantes. Orçamento SQL ausente aparece como `null`.
- `PLANNING_ONLY`: recursos e pools presentes e válidos. Esse estado significa apenas que o input mínimo foi preenchido.
- `capacityValidated` é sempre `false`, inclusive quando sobra orçamento SQL ou as entradas coincidem com as metas.

Fórmulas:

```text
monthlyMessages = monthlyConversations × messagesPerConversation
averageMessagesPerSecond = monthlyMessages ÷ (daysPerMonth × 86.400)
peakMessagesPerSecond = averageMessagesPerSecond × peakMultiplier
connectionsPerOrganization = connections ÷ organizations
averageMediaBytesPerDay = monthlyMessages × mediaFraction × meanMediaBytes ÷ daysPerMonth
retainedMediaBytes = averageMediaBytesPerDay × retentionDays
configuredConnections = soma(replicas × maxPerReplica)
availableConnections = maxConnections − reservedConnections
headroomConnections = availableConnections − configuredConnections
```

Folga SQL negativa é preservada e resulta em `withinConfiguredBudget: false`; não invalida o arquivo nem esconde excesso declarado. Folga positiva não prova latência, throughput, capacidade do PostgreSQL ou das sessões QR. A mídia estimada considera somente o mix informado, sem incluir automaticamente índices, metadados, WAL, replicação, backups, armazenamento Evolution ou margem operacional.

## Exemplo sintético

Salvar este JSON como `.sessions/capacity-inventory.synthetic.json`. Os números são fictícios e não descrevem o servidor instalado:

```json
{
  "schemaVersion": 1,
  "resources": {
    "cpuCores": 8,
    "ramBytes": 17179869184,
    "diskBytes": 1099511627776
  },
  "workload": {
    "organizations": 500,
    "connections": 10000,
    "monthlyConversations": 250000,
    "messagesPerConversation": 12,
    "daysPerMonth": 30,
    "peakMultiplier": 5,
    "mediaFraction": 0.2,
    "meanMediaBytes": 1000000,
    "retentionDays": 90
  },
  "pools": {
    "maxConnections": 100,
    "reservedConnections": 20,
    "components": [
      { "name": "API", "replicas": 2, "maxPerReplica": 10 },
      { "name": "MESSAGING", "replicas": 3, "maxPerReplica": 4 },
      { "name": "EVOLUTION", "replicas": 1, "maxPerReplica": 10 }
    ]
  }
}
```

```text
node scripts/operations/capacity-report.mjs .sessions/capacity-inventory.synthetic.json
node scripts/operations/capacity-report.mjs .sessions/capacity-inventory.synthetic.json > .sessions/capacity-report.synthetic.json
npm test -- tests/capacity-report.test.mjs --maxWorkers=1
```

Resultado de planejamento do exemplo: 3.000.000 mensagens/mês, aproximadamente 1,1574 mensagem/s de média e 5,7870 mensagem/s de pico hipotético, 20 conexões por empresa, 20.000.000.000 bytes de mídia/dia e 1.800.000.000.000 bytes retidos. Budget SQL: 42 configuradas, 80 disponíveis, folga 38. Status `PLANNING_ONLY`; `capacityValidated: false`.

## Fronteira da CLI e próximos dados

A CLI aceita exatamente um caminho de arquivo regular UTF-8/JSON e lê no máximo 65.536 bytes; também verifica crescimento durante a leitura. Sucesso emite somente o relatório JSON saneado. Erro termina com código 1, stdout vazio e uma linha estática no stderr: `CAPACITY_USAGE`, `CAPACITY_INPUT_UNREADABLE`, `CAPACITY_INPUT_TOO_LARGE`, `CAPACITY_INVALID_INPUT` ou `CAPACITY_ESTIMATE_OVERFLOW`. Não imprime input, caminho, URL ou stack. A CLI não grava arquivos por conta própria.

Este input não coleta versões/digests, rede/IOPS, p95, backlog/recuperação, distribuição QR/Meta, concorrência real, alta disponibilidade, S3/restore ou RPO/RTO. Continuam dependências C0–C4 no [plano de capacidade](../superpowers/plans/2026-10-06-broker-capacidade-operacao.md). O operador fornecerá inventário agregado atual e as hipóteses; carga sintética e sessões reais progressivas exigem etapas posteriores. Nenhum teste local deste coletor altera esse limite de evidência.
