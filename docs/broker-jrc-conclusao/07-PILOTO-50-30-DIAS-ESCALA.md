# Piloto e escala

Marcos distintos: softwareJRC, integraçãoLAB2, recuperação, aptidão para50,50/30dias,GO400,Ready900,900real eCCLXreal. Nenhum está implicitamente homologado pela publicação.

Sequência:1–2 números autorizados→até50→30dias acompanhados→100→200→400→preparação900. Eventos sintéticos não representam sessões reais. Não iniciar mensagens ou sessões reais automaticamente.

Medir entrada/saída/status/tentativas/mídia separadamente, p50/p95/p99 por fronteira, idade/backlog/drenagem,UNKNOWN/duplicação,reconexão,RAM/sessão,CPU,IOPS/WAL/rede e custo.250mil mensagens/dia média2,89/s não dimensiona picos ou900sessões.

Aceite: aceitos duravelmente=concluídos+pendentes justificáveis+falhas explícitas+incertos. Carga finita precisa drenar; operação contínua precisa backlog/idade estáveis. SLOs são propostas até aprovação.30dias não podem ser executados em uma sessão.

Plano detalhado anterior: ../broker-jrc-2-redesign-homologacao/13-PLANO-CAPACIDADE-400-900.md.

## Gate progressivo atualizado — 01/11/2026

O novo preflight `labs/capacity-pool-budget/` calcula o orçamento declarado por servidor, incluindo web app/auth/plataforma, todos os workers, fontes de histórico, migrator, engine, reserva e réplicas simultâneas de rollout. O teste do modelo entrou nos workflows; ainda não foi preenchido nem aprovado o inventário real do servidor.

| Fase | Ensaio requerido | Critério para avançar | Estado nesta execução |
|---|---|---|---|
| Software e contratos | PG/Redis/MinIO, crash do sender, dedupe, falha de COMMIT, guard de destino, contratos LAB2 | Nenhum falso ACK, efeito duplicado ou cruzamento de tenant; falhas explicitamente retidas | Componentes locais em validação; engine completa e LAB2 completo pendentes |
| Engine fixada | Build com patches/proveniência; captura e ownership instalados antes dos eventos; restart com journal e sessão preservados | Replay de entrada com identidade estável, sem repetir envio externo incerto; nenhum gap entre captura e fila volátil | PENDENTE |
| Recuperação | Restore em destino vazio de PostgreSQL + objetos + chaves + sessão; leitura por hash e prova de autoridade | RPO/RTO medidos; bytes e obrigações reconciliados, sem reenvio cego | PENDENTE |
| 1–2 números | Ambiente controlado e autorização específica, entrada/saída/mídia/reconexão | Identidade e inbox corretos; comparação dos eventos na origem, Broker e destino | NÃO EXECUTADO |
| 50 números / 30 dias | Operação acompanhada, picos medidos, manutenção/restart controlados | Nenhuma perda silenciosa/duplicação ou vazamento; backlog drena no orçamento acordado, recuperação exercitada, incidentes registrados | PENDENTE; exige duração real |
| 100 e 200 | Aumentar um estágio por vez, distribuir sessões entre nós e repetir falhas | Orçamento de pool, RAM, CPU, disco/WAL e rede preservado inclusive no rollout e com um nó indisponível conforme arquitetura aprovada | NÃO VERIFICADO |
| 400 | Carga sustentada, mix texto/mídia/status/reconexão; destino lento e tenant ruidoso | SLOs aprovados atendidos e fairness comprovada; filas/idade estáveis; restauração e retorno ensaiados | NÃO VERIFICADO |
| Preparação 900 | Planejamento medido de shards/nós, concorrência, cotas, retenção, HA e custo | Capacidade extrapolada apenas como hipótese; ensaio específico antes de qualquer promessa | NÃO VERIFICADO |

Cada ensaio deve registrar SHA da aplicação, digest/binário da engine, topologia, limites reais e recursos livres, perfil de tráfego por tenant e versão do consumidor. Coletar CPU/RSS, conexões e espera de pool, Redis, latência de COMMIT, IOPS/WAL, rede, p50/p95/p99, idade máxima da fila, tentativas, UNKNOWN, duplicatas lógicas, erros e reconexões. Medir recebimento durável, entrega ao consumidor e confirmação do WhatsApp separadamente.

Interromper progressão se houver falso ACK, perda não explicada, entrega a outro tenant/inbox, replay de envio UNKNOWN ou aumento de backlog sem drenagem no perfil finito. Latências e capacidade de pico precisam de baseline e SLO aprovado; não aumentar limites para esconder saturação. 250.000 mensagens/dia correspondem somente à média aproximada de 2,89/s e não representam o pico, fanout de eventos ou custo de mídia.

O benchmark finito existente usa 50/100/200/400 **eventos**, duas organizações sintéticas e duplicatas deliberadas. Não cria 50/100/200/400 sessões. Suas medições são prova funcional do receptor PostgreSQL, não capacidade do Broker completo, fairness dos workers ou homologação da Evolution.
