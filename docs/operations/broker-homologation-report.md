# Registro offline de homologação H01–H24

Este comando prepara e consolida resumos da [matriz obrigatória](../validation/2026-10-05-broker-programa-baseline.md). Não acessa servidor, banco, engine, dispositivo ou URL; não executa jornadas nem confere a autenticidade de arquivos de evidência. A implantação, testes com conversas/dispositivos reais e aceite final do usuário/operador continuam pendentes. Os testes unitários deste script usam fixtures sintéticas e não constituem homologação.

```sh
node scripts/operations/homologation-report.mjs --template > homologation-input.json
node scripts/operations/homologation-report.mjs homologation-input.json > homologation-report.json
```

O primeiro comando cria somente preparação com `NOT_RUN` e condições desconhecidas. O segundo lê um arquivo regular UTF-8 de até 262144 bytes e publica JSON sanitizado. Exit `0` indica `RECORDED`, pronto para revisão manual; exit `1` acompanha relatório `PENDING`/`FAIL` ou apenas código estático em stderr se a entrada for inválida. Nunca publica caminho, conteúdo inválido, stack ou credencial em mensagens de erro. Nenhuma variável de ambiente é lida.

O schema exige `schemaVersion: 1`, `profiles` e `runs`; `release` pode ser preenchido gradualmente, mas ausência de metadados impede consolidação. Aceita apenas campos allowlist; não existe campo de texto livre. Tokens, telefones, payloads, dumps, URLs, nomes de cliente e dados de conversa não pertencem ao arquivo.

`profiles` contém até sete objetos `{id, flow, integrated, centralUi}`. IDs válidos: `S0`, `J1`, `J2`, `E1`, `C1`, `G1`, `V1`; as condições aceitam `true`, `false` ou `null`. Registre condição confirmada para o perfil instalado; ausente equivale a desconhecida. O consolidado exige os sete perfis. `Todos` aplica-se a eles; `Todos com Flow` e `Todos integrados` usam a condição correspondente. H21 usa `centralUi` somente em J1/J2/E1. Condição `null` aparece em `unresolvedPairs` e impede RECORDED; `false` aparece em `excludedPairs`, para revisão explícita do escopo. O script não presume Flow ou integração em G1/V1.

Combinações explicitamente listadas na matriz permanecem obrigatórias, incluindo H18/G1 e H19/V1. `NOT_APPLICABLE`, `BLOCKED`, `NOT_RUN` e origem simulada não encerram uma combinação requerida. Excluir uma condição não aprova a capacidade solicitada; a revisão manual ainda precisa conferir se o perfil e seu escopo correspondem ao programa. Depois de resolver condições do template, consulte `requiredPairs` do relatório e acrescente os registros faltantes; não crie cenários fora dessas combinações.

Metadados de `release`:

| Campo | Formato/condição para RECORDED |
| --- | --- |
| `version` | Versão numérica `x.y.z`, até três dígitos por componente. Não implica faixa suportada. |
| `commit` | SHA Git completo, 40 caracteres hexadecimais minúsculos. |
| `baseline`, `expectedBaseline` | Identificador `NNNN_nome`; esperado retirado da release aprovada, observado do registro do operador. Divergência produz FAIL. |
| `journalVerified` | `true` somente após conferência manual do journal/logs; probe estrutural não substitui essa conferência. |
| `flags` | `{ "AUTOMATION_RUNTIME_V2_ENABLED": true }`; ausência/false deixa PENDING. |
| `digests` | Objeto com valores `sha256:` + 64 hex; requer API, MESSAGING, AUTOMATION, AUTOMATION_IO, SCHEDULER, LIFECYCLE e MIGRATOR. EVOLUTION é aceito adicionalmente quando aplicável. |
| `externalVersions` | Lista `{profile, version}` sem duplicatas; versão numérica exigida em cada perfil declarado integrado. |

Esses metadados são declarações do operador sobre a release efetivamente usada. Identidade/digests dos hosts externos, engine aplicável, flags de cada worker, logs, backup/restore e artefatos de dispositivo permanecem sujeitos à conferência manual restrita; o arquivo não determina a infraestrutura instalada.

Cada item de `runs` admite somente `{id, profile, result, origin, executedAt, correlation, evidenceRef, observed, incident}`. `id` é H01–H24; perfil deve pertencer à combinação requerida. `result` aceita PASS/FAIL/BLOCKED/NOT_RUN/NOT_APPLICABLE. `origin` aceita REAL/SIMULATED/NOT_RECORDED; REAL é declaração de execução manual real, não classificação derivada pelo script. `observed` aceita MATCHED/MISMATCHED/UNRECORDED, como resumo da comparação com o resultado esperado na matriz.

Um PASS só consolida com origem REAL, observação MATCHED, data UTC exata `YYYY-MM-DDTHH:mm:ss.sssZ`, `correlation` no formato `corr_` seguido de 32–64 hex e `evidenceRef` no formato `ev_` seguido de 64 hex. `incident` é opcional, `inc_` + 64 hex. Use referências opacas/hash para localizar o material em armazenamento restrito, sem inserir IDs reais, números, tokens ou URLs. O script confere formato; não garante anonimização, integridade ou existência do material. Duplicatas/conflitos de ID+perfil, perfis e versões externas são rejeitados; registre uma única observação consolidada por execução/arquivo, preservando históricos separados fora deste arquivo.

Exemplo de preparação parcial sintética, que permanece PENDING:

```json
{
  "schemaVersion": 1,
  "profiles": [{ "id": "S0", "flow": true, "integrated": false, "centralUi": false }],
  "release": {},
  "runs": [{ "id": "H01", "profile": "S0", "result": "NOT_RUN", "origin": "NOT_RECORDED" }]
}
```

`PENDING` identifica pares, seletores ou metadados faltantes; `FAIL` indica baseline divergente ou FAIL/MISMATCHED. `RECORDED` significa apenas que as declarações locais atendem o schema e cobrem a matriz selecionada pelas condições informadas. Em todos os casos: `source: "OPERATOR_ATTESTED"`, `homologationApproved: false`, `evidenceIndependentlyVerified: false`. Mesmo todos os registros REAL/PASS não tornam a leitura offline prova independente nem aprovam P10.

Códigos estáticos: `HOMOLOGATION_USAGE`, `HOMOLOGATION_INVALID_INPUT`, `HOMOLOGATION_DUPLICATE`, `HOMOLOGATION_INPUT_TOO_LARGE`, `HOMOLOGATION_INPUT_UNREADABLE`.

Verificação local do pacote, com fixtures sintéticas e um worker:

```sh
npm test -- tests/homologation-report.test.mjs --maxWorkers=1
node --check scripts/operations/homologation-report.mjs
```
