# 01 — Baseline dos repositórios

Data da inspeção: 2026-09-21. Nenhum provider real, secret, número ou ambiente de produção foi acessado.

| Repositório | Branch | HEAD inspecionado | Estado |
| --- | --- | --- | --- |
| BrokerJRCIA | `codex/broker-omnichannel-20260918` | `7e01151d48c4788740a2ec4918f80da3d86d1678` | limpo; igual ao baseline informado |
| JRC Conversas | `codex/jrc-omnichannel-20260918` | `14e7416b7b49f08f1c6edde454803752feae86c4` | limpo; igual ao baseline informado |

Comparações: Broker `origin/main` em `a16c1cd` e candidato anterior `48eb663`; JRC `origin/main` em `62c14af`. A referência remota `codex/jrc-flows-broker-release-20260917` não resolveu para SHA no checkout local e deve ser buscada antes de uma comparação final.

Evidência: `git status`, `git rev-parse`, `git log`; `AGENTS.md` dos dois repositórios. O Broker exige TDD e proíbe deploy sem tarefa de release; o JRC exige worktree isolada para mudanças. Esta fase produz somente documentação.

Conclusão: `7e01151` + `14e7416` formam o baseline canônico desta análise. Refatorações posteriores devem partir desses SHAs ou registrar explicitamente a divergência.
