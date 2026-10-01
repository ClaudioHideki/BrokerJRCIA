# Broker-first — baseline de execução

Data: 30/09/2026. Branch: codex/broker-first-completion-20260930.
Base: 9466f6a6587034d8b09e1d1f180e2c51d38799fe, conteúdo confirmado equivalente à main pelo conector GitHub; main tem um commit de merge adicional e nenhum arquivo diferente. CLI Git local não possui remote-https; resolver ancestralidade antes de publicar.

Correções locais de FlowCanvas.tsx, seu teste e AutomationStudio.tsx preservadas; documentos de planejamento preservados. Migration atual 0033; 0034 reservada para R1.

| Comando | Resultado atual |
|---|---|
| npm test | 222 arquivos, 1423 testes aprovados; 146.79s |
| npm run typecheck | aprovado |
| npm run build | aprovado |
| npm run test:web:bundle | 11 arquivos; nenhuma ocorrência |
| git diff --check --ignore-submodules | aprovado |

esbuild/Vite precisaram de execução fora da restrição de arquivos; a primeira tentativa falhou antes de carregar a configuração. Build produz avisos de comentário PURE em Zod/Rollup; testes incluem aviso jsdom canvas e logs esperados dos cenários HTTP. Node local 24.16.0; CI fixa 24.19.0. Não houve atualização de dependências.

Integração, E2E, CI Linux/imagem e homologação externa permanecem gates posteriores. PostgreSQL/Redis de testes ficam no laboratório local; credenciais operacionais não são fixtures.

| Capacidade | Estado de partida |
|---|---|
| Destino/conta/caixa/canal, suporte, lifecycle, roles/limites | EXISTING; homologação nova ainda necessária |
| Autoridade de binding, sessão serial, handoff remoto, editor completo | GAP conforme subplanos R/U |
| Central JRC, Chatwoot externo, número piloto QR, App/WABA Meta e carga anunciada | NEEDS_EXTERNAL_VALIDATION |

Este registro comprova a base local; não certifica produção nem encerra BROKER_READY.
