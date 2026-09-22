# 17 — Infraestrutura alvo

## Serviços

| Serviço | Responsabilidade | Escala inicial |
|---|---|---|
| `web` | SPA/painel | 1+ |
| `api` | autenticação, comandos e consultas | 2 quando necessário |
| `messaging-worker` | transporte Meta/Evolution/Chatwoot | 1 por shard |
| `automation-worker` | máquina de estados do Studio | 1, escalável por fila |
| `io-worker` | HTTP e integrações externas | 1, rede restrita |
| `scheduler` | timeouts, delays e manutenção | singleton com lock |
| `sandbox` | código permitido no futuro | isolado e desabilitado por padrão |
| `migrate` | migrações one-shot | por release |
| `postgres` | fonte de verdade | gerenciado ou volume + backup externo |
| `redis` | filas, locks, cache efêmero | persistência conforme fila |
| `evolution` | transporte QR | versão fixada por digest |

## Dokploy

Publicar API e Web da mesma revisão por digest. O compose deve referenciar variáveis secretas do ambiente, healthchecks e dependências por saúde. `migrate` roda antes da troca da API; workers entram depois da compatibilidade do schema.

Variáveis atuais de Chatwoot e shards continuam necessárias. Meta só fica habilitada com o conjunto completo validado. `TYPEBOT_ORIGINS_JSON` passa a ser cadastro controlado por destino e deixa de ser a única fonte após o cofre de credenciais.

## Dados e recuperação

- Backup PostgreSQL externo, restaurado em teste periódico; arquivo dentro do mesmo volume não é estratégia de desastre.
- Registrar digests, versão de schema e artefato OpenAPI por release.
- Rollback de app usa digests anteriores compatíveis com schema expandido.
- Object storage é recomendado para mídia e anexos quando retenção/volume forem definidos; até lá permanece `PARTIAL`.

## Observabilidade

Métricas por tenant sem identificadores sensíveis: latência/falha de webhook, idade da outbox, profundidade de fila, execução por nó, entrega por provedor e handoff. Logs estruturados usam correlação, redaction e amostragem. Alertas distinguem transporte, automação e destino humano.

Não introduzir Kafka/RabbitMQ enquanto Postgres outbox + Redis atenderem throughput, retenção e recuperação medidos.
