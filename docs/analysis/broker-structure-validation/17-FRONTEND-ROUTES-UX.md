# 17 — Frontend Routes e UX

**Repository:** ClaudioHideki/BrokerJRCIA
**Branch auditada:** `codex/jrc-platform-v2-complete-exec`
**Base SHA (merge-base com origin/main):** `a16c1cdbb00aac593fc0db2149e904b47fb723f6`
**HEAD funcional auditado:** `628218cf902096cdbdada37b4e7210b3e10cfee5`
**DEPLOY_STATUS padrão:** `UNKNOWN` — nenhum ambiente remoto foi consultado.

| Rota | Classificação |
|---|---|
| `/dashboard`, `/channels*`, `/automations*`, `/automation-executions*`, `/credentials`, `/health`, `/relatorios`, `/uso-custos`, `/chaves-api`, `/minha-empresa`, `/jrc/*` | KEEP |
| `/integracoes`, `/mensagens` | CONSOLIDATE conforme a navegação alvo |
| `/providers`, `/conexoes*`, `/whatsapp-oficial`, `/flows` | REDIRECT |
| `/legacy/providers`, `/legacy/conexoes*`, `/legacy/flows` | LEGACY |

A navegação canônica já separa tenant e plataforma. Duplicações antigas estão preservadas para compatibilidade e migração. **CODE_STATUS: IMPLEMENTED. TEST_STATUS: PASS.** Gap menor: página explícita de documentação OpenAPI no menu e refinamento visual/touch.
