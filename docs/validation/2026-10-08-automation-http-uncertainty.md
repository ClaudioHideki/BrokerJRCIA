# P3 — resultado incerto de chamadas HTTP

Incremento publicado na main com CI e imagens aprovados. O programa P0–P10 permanece aberto e nenhuma instalação no servidor foi executada pelo agente.

## Comportamento

Uma chamada POST/PUT/PATCH/DELETE que perdeu a resposta após invocar o conector pode ter executado a ação remota. O worker conserva o efeito UNKNOWN, a espera IO e a ordem da outbox: não repete a chamada, não escolhe uma porta de erro como se nada tivesse sido enviado e não inicia o efeito seguinte. O detalhe da execução passa a guardar somente um código de erro reconhecido, com CAS por organização, efeito, token de claim e status atual. Um resultado antigo não sobrescreve reconciliação posterior.

Erros comprovados antes do despacho continuam utilizando a porta de falha/timeout. GET mantém as tentativas limitadas e as portas existentes. Uma resposta completa 2xx/4xx/5xx mantém sua saída real. Falha ao gravar auditoria também conserva UNKNOWN. URL, credencial, cabeçalho e causa bruta não entram no diagnóstico. SQL, IA e código não mudam neste incremento.

CONFIRMED_NOT_SENT explícito permite nova tentativa. CONFIRMED_SENT sozinho ainda não fornece a resposta HTTP nem retoma a espera IO; um recibo não fabrica output. A operação continua reconciliável/cancelável pelos contratos existentes. Completar uma resposta verificada sem repetição requer um contrato posterior; este incremento não encerra toda a família HTTP nem P3.

## Evidências

Candidato: RED comportamental para timeout POST e vazamento de erro, seguido de 40/40 unitários e 3/3 PostgreSQL. Na integração ativa, o diagnóstico teve RED adicional com duas falhas; um segundo caso detectou a passagem do erro bruto ao repositório. Após restringir o código no coordenador e no repositório, **41/41 testes focais** passaram. **19/19 testes PostgreSQL**, incluindo a ordem canônica da outbox, passaram.

O banco descartável usa migrations fonte e role jrc_app com contexto de tenant. Foram verificados reinício, lease expirado, espera IO, ausência de EXPLICIT_RESUME indevido, bloqueio do efeito sucessor, isolamento e recusa de diagnóstico com token/tenant/status indevidos. Conector HTTP sintético: nenhum destino real foi chamado. Revisão independente por leitura não encontrou Critical/Important neste corte.

Typecheck final e build aprovados. A primeira regressão completa executou 2.311 testes: 2.310 passaram e somente o teste de layout do PDF excedeu seus 30 segundos. Depois, os seis testes desse arquivo passaram isoladamente, sem alteração dos limites ou do código de testes. Essa repetição focal não é apresentada como uma execução integral aprovada; o CI do SHA publicado deve fechar a regressão completa. Bundle web, contratos públicos, notices e npm audit passaram, este último sem vulnerabilidades.

O gate original do submódulo Evolution passou, preservando `fa09d37892cdbb1d65a250155d293d92230c5b30`. O gate de release passou com 254 rotas e zero achados dos scanners. Os limites de CI permanecem iguais; somente os comandos locais PostgreSQL usam um orçamento maior. Não foi executado navegador local ou teste da caixa real.

## Publicação verificada

Main `003aab1afd91ff80e01050c14a9781aae25a3681`. [CI 37831296242](https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/37831296242) aprovado integralmente, incluindo PostgreSQL/Redis, jornadas de navegador, OpenAPI, container, restore e segurança. A execução do CI fecha a regressão integral desse SHA; não altera o resultado registrado da primeira execução local.

[Imagens 37833925328](https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/37833925328) aprovadas para o mesmo SHA. Os manifests GHCR das duas imagens coincidem com a tag do commit e o artefato, com plataforma linux/amd64 e manifest de atestação. O workflow registra SBOM, provenance mode=max e assinatura GitHub OIDC; não foi executada verificação Cosign independente.

```dotenv
JRC_API_IMAGE=ghcr.io/claudiohideki/brokerjrcia-api@sha256:751e175f1533516659fc491ef34c8971546e099e6ec6df7482e32005ee45aa7a
JRC_WEB_IMAGE=ghcr.io/claudiohideki/brokerjrcia-web@sha256:fd45f2e6f0dae048879022745c2752fd4eec33e6c9df99ee4c187aa63deb4d1e
```

Baseline estrutural permanece `0050_whatsapp_group_catalog`. A publicação não comprova instalação no Dokploy nem execução do bot na caixa real. O [procedimento de instalação e homologação](2026-10-08-http-release-dokploy.md) mantém essas evidências separadas.
