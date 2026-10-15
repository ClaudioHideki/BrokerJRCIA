# Captura com prazo persistido — plano de implementação

Executado inline com TDD, sem novos agentes, commits, push ou deploy. [Desenho aprovado](../specs/2026-10-15-input-timeout-design.md). TypeScript/React/Zod, Vitest e PostgreSQL com RLS; nenhuma dependência nova.

## Limites e divisão

- Contrato/motor: automation-input.ts, catálogo/index, RuntimeInput/State/Result e engine.
- Persistência: migration 0061, journal/probe e repository/event-router; service.ts somente runOnce. 0062 e fences de tomada pertencem ao incremento coordenado e são preservados.
- Retomada humana: somente construção do estado/wait no confirm de resume-worker.ts, após os gates existentes; política de grupos repassada pelo repository.
- UI/simulação: InputEditor, default input do FlowCanvas, simulation, espera EVENT no Studio e texto de CONTINUE. app.ts e ações remotas de conversa fora do escopo.
- Laboratório sintético PostgreSQL/Redis separado, DB único por helper e --maxWorkers=1; exclusividade de bootstrap coordenada entre implementadores. Não executar a suíte integral neste incremento.

## Contrato/motor

- [x] Conferir base liberada após `4c7a5eff1a3fa427aa52ef57636b9e00c7ad7fd8`.
- [x] Aplicar regressões preparadas e observar RED: 20 falhas de 27 casos, por ausência de schema/portas/deadline/identidade/editor.
- [x] Implementar marcador explícito, duração limitada, portas e compatibilidade legada.
- [x] Salvar UUID e deadline por tentativa; validar envelope interno sem consultar payload.
- [x] Cobrir reentrada, timer antigo e subflow com retorno ao pai após restart.

## Persistência e autoridade

- [x] Observar RED PostgreSQL: UUID da wait diferente do estado antes da implementação.
- [x] Acrescentar 0061 sem editar migrations publicadas; coordenar journal/probe/baseline com 0062.
- [x] Gravar admissão com clock_timestamp após execution lock, sanear envelope externo.
- [x] Salvar UUID/deadline/state juntos e decidir MESSAGE/TIMER na ordem execution → wait.
- [x] Deduplicar INPUT_TIMEOUT por waitId, preservar autoridade e scheduler existentes.
- [x] Observar e corrigir RED de RESUME genérico que consumia a captura.
- [x] Observar RED de política de grupos omitida e propagá-la sem relaxar default.
- [x] Observar RED de CONTINUE humano; rearmar nova identidade/prazo somente após confirmação; verificar ciclo anterior isolado em PostgreSQL.
- [x] Observar RED do bootstrap scheduler e passar a política física com o mesmo fleet scope, sem iniciar outro worker/HTTP.
- [x] Verificar em PostgreSQL que política ausente nega e autorização se restringe a tenant, canal e seleção atuais. Input continua GROUP_NODE_UNSUPPORTED.

## Editor, simulação e documentação

- [x] Observar RED e implementar configuração explícita/permissões/validação do editor.
- [x] Avançar deadline EVENT pelo motor canônico; expor avanço no Studio após RED próprio.
- [x] Migrar desenho/plano de preparação ignorados para docs/superpowers rastreável.
- [x] Documentar e verificar texto de nova tentativa em CONTINUE.

## Evidência e fechamento

- [x] Lote focal: 13 arquivos / 178 testes verdes; não repetido após mera correção de narrowing TypeScript.
- [x] Typecheck `node node_modules/typescript/bin/tsc -b --pretty false` verde.
- [x] PostgreSQL inicial completo: 8/8 verdes em 16.55s. Um hook anterior expirou durante bootstrap concorrente; rerun coordenado confirmou todos os casos.
- [x] Repository focal após guard RESUME: 6/6 verdes; RED anterior retornava true quando deveria rejeitar.
- [x] PostgreSQL final: 10/10 timeout verdes, incluindo CONTINUE humano e rejeição de RESUME genérico; 1/1 autoridade de grupo verde (57 casos não executados pelo filtro).
- [x] Focais adicionais: 8/8 política/UI de retomada e policy legada; 6/6 bootstrap scheduler/configuração; typecheck final verde.
- [x] Registros finais das regressões adicionais e diff --check.
- [x] Entregar arquivos e limites ao coordenador; suíte integral/Git/release feitos por ele.

Comandos focais: `node node_modules/vitest/vitest.mjs run <arquivos de contrato/unit/UI> --maxWorkers=1`; PostgreSQL: `node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts apps/api/tests/integration/automation-input-timeout.test.ts --maxWorkers=1`. Endereços e credenciais operacionais não fazem parte da documentação de produto.
