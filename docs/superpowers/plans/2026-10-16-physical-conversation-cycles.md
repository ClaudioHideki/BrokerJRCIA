# Plano: ciclos centrais do transporte físico

Spec: `../specs/2026-10-16-physical-conversation-cycles-design.md`. Execução inline autorizada do programa; sem push, imagem, deploy ou ativação.

## Entrega e fronteiras

Reutilizar a unicidade parcial por contato/chave nula; preservar mapas imutáveis. Novo helper `modules/integrations/chatwoot-conversation-cycle.ts` para promoção local. Helper de leitura `modules/attendance/conversation-cycle-fence.ts` para negar automação/retomada/tomada em ciclo retirado e detectar ações humanas antigas em trânsito. Worker continua único e com HTTP fora de transação. Não duplicar motor nem mudar transporte central.

- [x] RED PostgreSQL por helper/worker: novo ID remoto do mesmo contato, saída antiga preservada, entrada seguinte na conversa corrente, UNKNOWN adia e mantém pausa.
- [x] Implementar promoção transacional, reserva da chave antiga, conversa HUMAN e nova associação; revalidar identidade e escopo. Se houver adiamento, confirmar pausa e job PENDING antes de retornar, sem contabilizar falha de transporte.
- [x] RED de fences: ciclo retirado não executa Flow/retomada/tomada NICO; ação humana antiga pausa corrente e impede execução enquanto pendente.
- [x] Integrar fences aos caminhos canônicos de autoridade e envio; preservar echoes/sistema/grupos e centrais.
- [x] Regressões focais, índice/probe/migração se necessários, typecheck, npm test, revisão e evidência. Somente commit local ao concluir.

Ruling: não atualizar remote_conversation_id de um mapa existente. Não tratar ON CONFLICT como sucesso quando seu destino é outro ID remoto. A inspeção confirmou que a leitura do mapa já é refeita sob lock, portanto não há motivo para introduzir uma correção fictícia de idempotência para colisão entre IDs remotos diferentes.

## Revisão e correções

Revisão independente somente leitura identificou três achados Important. Todos reproduzidos antes da correção: (1) ingestão histórica pausava somente o ciclo anterior, (2) reply automatizado selecionado herdava autoridade humana, (3) envio sem lock de canal observava chave antes da promoção e inseria após o lock. Correções: pausa do ciclo corrente na admissão de HUMAN_PUBLIC/HUMAN_PRIVATE, fence também para jobs humanos PENDING/RUNNING/UNKNOWN, promoção e prova histórica restritas a HUMAN_PUBLIC, verificação da chave após o lock já existente da conversa/contato. Teste com intercalação PostgreSQL comprova rejeição do envio stale sem introduzir upgrade de lock conversa→canal.

Ruling: uma resposta automatizada selecionada pode continuar sendo transportada em sua rota válida; isso não autoriza substituir a conversa corrente nem assumir outra como humano. Nota privada histórica pausa, mas não gera envio público. Atividade histórica não pausa a corrente.

Migração aditiva 0066: índice por organização/canal/contato/id, sem atualização de mapas ou permissões. Probe exige índice válido, pronto, não parcial, com colunas/owner previstos. A cadeia de migrations e as expectativas do manifesto foram atualizadas; nenhuma alteração de Compose/ENV.
