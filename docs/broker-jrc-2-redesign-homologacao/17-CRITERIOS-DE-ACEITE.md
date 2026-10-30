# Critérios de aceite

## Primeiro piloto

| Critério | Evidência exigida | Situação |
|---|---|---|
| Separar saúde/configuração/histórico | Teste de tela e captura de 18 componentes | VALIDADO localmente |
| Não prometer entrega com conexão/configuração | Texto explícito e ausência de replay | VALIDADO localmente |
| Refresh falho mantém aviso | Teste erro → dados antigos → recuperação | VALIDADO localmente |
| Consulta travada não bloqueia para sempre | Timeout 20s, abort, retry manual e descarte tardio | VALIDADO localmente |
| Resposta antiga não contamina novo contexto | Teste de troca de cliente e revisão do Outlet por organizationId | PARCIAL: falta jornada de troca real com backend |
| Contrato tolera extensões e clock skew | Testes parser; rejeita contagens inválidas | VALIDADO localmente |
| Acessibilidade | Axe/jsdom, controles/labels, contraste visual e mobile | PARCIAL: leitor de tela/teclado integral e auditoria WCAG não realizados |
| Build, tipos e regressão | Logs da revisão atual | Ver RESULTADOS.md |
| Rotas/tenant/permissões preservados | Diff sem backend, auth, migrations ou contratos alterados | VALIDADO por revisão estática |
| Produção preservada | Nenhum deploy, envio ou mutação nesta execução | VALIDADO no escopo das ações realizadas |

## Homologação integral JRC — gates ainda abertos

- **Integridade:** persistir antes de confirmar, nenhuma perda ou efeito duplicado em retry/restart, UNKNOWN reconciliado com evidência.
- **Mídia:** origem conservada até recibo válido, cópia privada verificável por hash/tamanho, expiração/ACK perdido/restore testados. HTTP 200 isolado não prova custódia.
- **Segurança:** RLS/escopos/tenant negativos; canários sem segredos nos logs; credenciais cifradas e rotação; SSRF, replay e URLs temporárias.
- **Operação:** heartbeat, backlog/idade, filas de integração e parceiro distinguidas; incidentes com causa/tempo/ação; backup externo e restauração ensaiada.
- **Escala:** pools somados por réplica e reserva operacional; distribuição de sessões; receptor lento não causa starvation; três execuções por estágio com p95/p99, perda e duplicidade.
- **Produto:** jornadas de administração e empresa completas, carregamento/erro/vazio, responsividade, navegação e documentação compatíveis com cada endpoint real.
- **Release:** SHA/digest/Compose/journal reconciliados, rollback ou recuperação para frente ensaiados, revisão antes de publicação.

Nenhum desses gates se encerra apenas por build verde, HTTP 200, screenshot, valor de quota ou simulador sem conexão ao worker real. As matrizes 02/11/12 devem ser atualizadas por evidência, sem substituir PENDENTE por VALIDADO por inferência.
