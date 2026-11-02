# Auditoria de infraestrutura — evidências e lacunas

Fotografia herdada de30/10/2026,12:06–12:15UTC, `evidencias/baseline-20261030/servidor-evidencias.md`. Esta frente não consultou produção. Código/Compose foram inspecionados na base d1b66a. Atualização do executor principal: Docker inicialmente negou acesso no sandbox; consulta elevada retornou ServerVersion 29.5.2. Laboratório integrado ainda precisa ser preparado; acesso ao daemon não é homologação.

## Release rastreável

| Componente | Evidência anterior |
|---|---|
| API | ghcr.io/claudiohideki/brokerjrcia-api@sha256:fb54ad27beeb3e7777703959e08a13e0dd5da8b6f101f6d5e56d711d1af484e5 |
| Web | ghcr.io/claudiohideki/brokerjrcia-web@sha256:1485c277f2e72d2b85e346d75d77dc5775c262a7cb389ffff16c39fb891059c4 |
| Evolution | evoapicloud/evolution-api:v2.3.7@sha256:1bd8afc4a6cf48822e6cf02469aeae7bd35a12a6b616eacd1291926307f4d339 |
| Schema |77 migrations; latest1794177600000; fingerprint0b6c21a5cb58605eee93023a92252341 |
| Dokploy | Compose em main, caminho infra/dokploy/compose.yaml, autodeploy off |
| Engine |2CPU/2GiB, RestartCount46 histórico, LOG_LEVEL não explícito |

ImageID local de Docker não é o mesmo objeto que digest de manifesto multiarch. Não comparar strings desses tipos como se divergência provasse imagem errada. O contador46 não demonstra OOM nem falha de release.

## Recursos e topologia

Compose declara web0,5CPU/256m, API1/1g, messaging1/768m, automation e IO0,75/512m cada, partner/scheduler/history/lifecycle0,25/256m cada, sandbox0,5/160m, PostgreSQL2/2g, Redis0,5/512m, Evolution2/2g. São limites de configuração, não reserva efetiva ou capacidade de sessão comprovada.

Pool defaults Broker somam potencialmente46 conexões com uma instância de cada perfil; não incluem Evolution, importadores externos, admin, migrations, backup, monitoramento ou overlap do rollout. APP/AUTH10+10 preservam connectionTimeout0; há risco de espera sem prazo. Confirmar max_connections, role limits, pg_stat_activity/locks e custo por query antes de ajustar.

Redis AOF/noeviction está declarado. Aceite requer verificação efetiva de persistência, memória, rejeição de escrita e recuperação; evitar concluir que Redis healthy prova filas duráveis. Workers sem healthcheck individual exigem heartbeat e atraso do último processamento útil.

## Recuperação

Abas Dokploy estavam sem backups/volume backups; rotina externa permanece NÃO VERIFICADA. Definir RPO/RTO, retenção, cifragem, cópia externa, responsáveis e teste periódico. Cobrir PG Broker+engine, objetos privados, sessões/chaves, manifests e configuração não secreta. Chaves devem ser recuperáveis em canal separado e controlado.

Laboratório C5 existente recupera recorte limitado; não prova cluster novo com roles nem sessões Evolution. Restore precisa destino vazio, IDs/hashes reconciliados e bloqueio de efeitos externos até avaliação de UNKNOWN.

Comparador de journal74/77 retorna DIVERGED; isso prova regra do verificador, não toda incompatibilidade funcional. Testar upgrade74→77, dados novos, binário antigo e retorno à candidata por digest, sem editar journal ou remover proteção SQL.

## Gate de infraestrutura

1. Manifesto único com SHAs, digests, schema, versões e topologia.
2. Ambiente isolado identificado; nenhuma variável produtiva herdada.
3. Inventário de recursos, volumes, pools, reservas, observabilidade e rotinas de backup.
4. Restore medido e teste de restart/indisponibilidade/pressão sem perda ou duplicidade.
5. Só então campanha de capacidade representativa.

Nenhum ajuste de daemon, deploy, backup, restore ou carga foi executado nesta frente. O bloqueio local não deve ser contornado usando o cluster produtivo.
