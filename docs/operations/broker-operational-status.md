# Estado operacional local do Broker

Dentro do container da API de uma imagem que inclua este comando, execute:

```sh
node /app/apps/api/dist/commands/operational-status.js
```

O comando usa o ambiente já existente do container, sem argumentos. Não cole `.env`, `DATABASE_URL`, credenciais ou scripts de conexão na evidência. O JSON permite compartilhar os campos publicados; host/porta do Evolution ainda são metadados de infraestrutura e devem seguir o acesso normal da equipe.

Exit `0` significa `status: "READY"`: flag V2 explicitamente `true`, URL do Evolution válida, conexão PostgreSQL e estrutura exigida pelo binário compatíveis, além do `/ready` local responder HTTP 200 com JSON `status: "ready"`. Exit `1` com JSON `status: "PARTIAL"` preserva os sinais disponíveis e códigos estáticos de falha. HTTP 200 sozinho não produz READY global. Falha inesperada ou argumentos adicionais produzem apenas `OPERATIONAL_STATUS_FAILED` ou `OPERATIONAL_STATUS_USAGE` em stderr, com exit `1`.

Exemplo sintético, sem credenciais:

```json
{
  "schemaVersion": 1,
  "status": "READY",
  "checkedAt": "2026-10-07T16:00:00.000Z",
  "nodeVersion": "v24.19.0",
  "flags": { "AUTOMATION_RUNTIME_V2_ENABLED": true },
  "evolution": { "configured": true, "protocol": "http", "host": "evolution", "port": 8080 },
  "schema": { "baseline": "0049_qr_outbound_observations", "compatible": true },
  "db": { "reachable": true, "version": "16.4" },
  "readiness": { "status": "READY", "httpStatus": 200 },
  "memory": { "rssBytes": 100000000, "heapTotalBytes": 20000000, "heapUsedBytes": 12000000 },
  "scope": "CONTAINER_PROCESS",
  "capacityValidated": false,
  "errors": []
}
```

`flags.AUTOMATION_RUNTIME_V2_ENABLED` é `null` quando ausente ou diferente dos literais `true`/`false`. `evolution.configured` descreve a validade da configuração, sem chamada ao engine: somente HTTP(S), sem usuário, senha, query ou fragmento. O caminho é descartado e host/porta são extraídos da URL; porta padrão implícita é omitida. URL inválida resulta somente em `{ "configured": false }`.

`db.reachable` confirma conexão, inclusive quando uma consulta seguinte é negada. `schema.compatible` é `null` quando não foi possível avaliar a estrutura. `schema.baseline` vem do código da imagem (`RUNTIME_SCHEMA_BASELINE`); não afirma que esse identificador foi aplicado nem compara hashes do journal. A probe reutiliza a consulta de catálogos de `runtime-schema.ts` e lê `SHOW server_version`. Usa `pg.Client`, `default_transaction_read_only=on`, timeout de conexão e consultas de 3 segundos e `statement_timeout=3000`; parâmetros da URI não podem desativar essas opções. Não altera schema, dados ou roles e não oferece SQL arbitrário.

O único HTTP permitido é `http://127.0.0.1:3000/ready`, com redirecionamento rejeitado, timeout total de 3 segundos e corpo limitado a 4096 bytes, inclusive por streaming. Nenhum outro campo da resposta é publicado. A probe de banco e o HTTP local são independentes; conexão e duas consultas podem consumir seus próprios timeouts, portanto o tempo total do comando não se limita a 3 segundos.

| Códigos publicados em `errors` | Interpretação |
| --- | --- |
| `AUTOMATION_RUNTIME_DISABLED`, `AUTOMATION_RUNTIME_UNKNOWN` | Flag V2 desativada, ausente ou inválida. |
| `EVOLUTION_CONFIGURATION_INVALID` | Configuração ausente ou URL fora do formato permitido. |
| `DATABASE_URL_REQUIRED`, `DATABASE_CONFIGURATION_INVALID`, `DATABASE_UNAVAILABLE` | Ambiente incompleto, URI inválida ou banco indisponível sem diagnóstico publicável. |
| `08006`, `28P01`, `42501`, `ECONNREFUSED`, `ETIMEDOUT` | Código conhecido de conexão, autenticação, permissão ou timeout; mensagem e stack descartadas. |
| `SCHEMA_INCOMPATIBLE`, `SCHEMA_UNAVAILABLE` | Estrutura exigida ausente/incompatível ou avaliação indisponível. |
| `READINESS_NOT_READY` | Resposta HTTP diferente de 200 ou JSON sem o status exato `ready`. |
| `READINESS_INVALID_RESPONSE`, `READINESS_BODY_TOO_LARGE` | Resposta fora do contrato JSON ou acima de 4096 bytes. |
| `READINESS_TIMEOUT`, `READINESS_UNAVAILABLE` | Timeout ou falha local não publicável. |

`memory` mede o novo processo Node que executa este comando. Não representa o processo API já em execução, workers, limite cgroup, memória disponível do container, RAM do host ou soma dos serviços. `scope: "CONTAINER_PROCESS"` e `capacityValidated: false` permanecem em todo relatório. READY é uma observação local de implantação e não comprova 500 empresas, 10 mil conexões, carga, entrega de mensagens ou jornadas externas.

Para fechar a evidência de uma release, o operador ainda registra manualmente identidade da imagem/digest de cada serviço, flags e saúde dos workers, journal e logs do migrator, backup/restore e jornadas da matriz de homologação. Este comando não coleta nem inventa esses dados. O último baseline do servidor comprovado na documentação continua D2/0046 até uma nova execução manual documentada; o exemplo 0049 acima descreve a expectativa deste código, sem declarar alteração no servidor. Uma imagem anterior sem o arquivo precisa receber uma nova release pelo fluxo aprovado antes de usar o comando.

Teste local reproduzível, sem banco ou engine reais:

```sh
npm test -- apps/api/tests/unit/operational-status.test.ts --maxWorkers=1
```

As dependências internas injetadas pelos testes simulam somente banco e HTTP. O CLI não expõe flags para injetar endereços, queries ou dependências.
