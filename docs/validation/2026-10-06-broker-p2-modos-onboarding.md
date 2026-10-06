# P2 C — Perfil observado e orientação de configuração

Incremento C1/C2 na branch codex/broker-p2-modes-catalog-20261005, sobre cb93c68 (P2 B). Ainda não publicado na main, incorporado em imagem ou implantado.

## Comportamento implementado

GET /v1/channels/:id/operation-profile exige JWT e OWNER/ADMIN atuais, no-store e organização ativa. O perfil resolve o ID público QR/META para o canal interno em uma consulta de banco, sem ativar canal, escrever estado ou chamar a central. Retorna apenas escopo e diagnóstico, nunca credencial cifrada, token ou telefone completo.

O modo é observado por caixa: STANDALONE, JRC_MANAGED ou CHATWOOT_EXTERNAL. Destino global cadastrado sem vínculo da caixa não elimina o modo local. Conexão FAILED/DISABLED/UNKNOWN/PENDING, autoridade central residual ou escopo incompatível nunca vira standalone. Origem managed precisa coincidir com a configuração do servidor. IDs iguais de Account/Inbox em hosts diferentes não são intercambiáveis. A flag de integração externa permanece obrigatória.

BROKER_TRANSPORT descreve a origem do número cadastrado no Broker. Executor legado/remoto é bloqueado e não é anunciado como transporte central do motor atual. CENTRAL_TRANSPORT está reservado no contrato para P2 D e ainda não é ativável por este perfil.

READY é prontidão da configuração de conexão/central para teste, não autorização de execução, disponibilidade do runtime, publicação do bot ou prova de entrega. deliveryVerified é sempre false. Capacidade e callback precisam de evidências datadas da credencial e revisão atuais; callback também é específico da integração/caixa. As operações existentes revalidam suas próprias permissões.

Na caixa, a consulta explícita mostra modo, pendências e passos. O caminho local leva a Conversas/times/agentes do Broker. O central leva ao onboarding durável existente: aprovação, conta/credencial, caixa e webhook, com substituição explícita. Automação e teste real são passos separados. Troca de organização/canal/revisão e consulta malsucedida removem a prontidão anterior.

## Evidência local

| Verificação | Resultado |
| --- | --- |
| TDD contrato/API | RED: rota ausente e perfil contraditório aceito; corrigidos |
| TDD UI | RED por componente ausente; 5 cenários de consulta, orientação, escopo, atraso e sanitização aprovados na rodada focada |
| Contratos + HTTP + UI + canais atuais | 22 testes aprovados antes da última correção de callback; confirmação da árvore final na suíte abaixo |
| Perfil PostgreSQL final focado | 18 cenários aprovados, incluindo QR público/canal interno, canal não ativado sem escrita, tenant suspenso, origem/IDs, flags e legado |
| Revisão de callback | RED em quatro cenários com duas caixas da mesma conta: ausente, credencial antiga, destino antigo, reset. GREEN após exigir evidência individual |
| Rodada anterior de regressões PostgreSQL | 7 arquivos existentes aprovados; rodada conjunta NÃO aprovada devido a falha no perfil com data artificial. Fixture passou a usar relógio SQL, como a gravação real |
| Regressões PostgreSQL finais | 8 arquivos, 57 testes aprovados; 288,41 s |
| Build/typecheck/OpenAPI finais | Aprovados na árvore com a correção de callback |
| Bundle/contratos públicos finais | 11 arquivos sem achados; fronteira de contratos PASS |
| Suíte completa da árvore final | 270 arquivos, 1.778 testes aprovados; 356,86 s |
| Revisão independente final | Achado de callback corrigido; sem bloqueios no delta; gates finais aprovados |

Os testes PostgreSQL usam banco descartável, RLS/papel da aplicação reais e centrais/provedores sintéticos. A fixture de evidência usa timestamp do banco e mantém rejeição de data futura. A conta da central não confirma callback de outra caixa. Nenhum dado real foi utilizado; não houve nova execução E2E completa local recusada.

## O que permanece pendente

A seleção integral de perfil, origem de transporte e ativação guiada depende da integração do transporte central P2 D para que a interface não ofereça um caminho ainda inexistente. O fluxo existente de provisionamento por Broker foi reaproveitado; não se criou outro provisionador. A orientação de C2 não substitui o wizard futuro para número originalmente conectado na central. As regressões de isolamento existentes passaram; a validação de isolamento do novo transporte será feita junto com D.

Tenants JRC A/B, Chatwoot externo, servidor, digests/migrations efetivos e jornada real continuam NOT_RUN. Preparação em [homologação](2026-10-06-broker-preparacao-homologacao.md). Os incrementos locais não encerram P2 nem o programa P0–P10. Imagens da main 4fe35ba são a correção de segurança/P1 e não contêm P2 A/B/C.
