# Defeitos reproduzidos e erros operacionais

## Causas comprovadas neste incremento

| Defeito | Reprodução / causa | Correção / limite |
|---|---|---|
| Aceite genérico não distingue persistência | Worker legado aceita 2xx. RED do contrato estrito e receptor antigo demonstra ausência de recibo | Negociação opt-in, parser estrito e ledger0079. HTTP continua comportamento válido para consumidores legados; não classificamos todo 2xx como defeito |
| QR pode sobreviver à troca de vínculo no LAB2 | Policy usa objeto original; teste com classes Ruby reais remove/troca vínculo durante resposta remota e libera challenge antigo | Verificação persistida do tuple id/account/inbox/integration/instance e leituras uncached; 20 cenários locais. Request Rails completo ainda não executado |
| Instrução ausente e diagnóstico de origem errado | Dois enums HISTORY não tinham orientação; revisão encontrou UNAVAILABLE produzido por falha de importação na central | Mapa exaustivo de dez códigos, título/ação da central, preservar mesma identificação. RED/GREEN de componentes |
| Jornadas mobile não exercitadas | Quatro skips gerais escondiam caminhos; ao habilitar, três passaram e Chaves expirou por menu fechado | Teste abre drawer pelo botão acessível, verifica expansão/fechamento, fixtures por projeto. Não foi necessário afrouxar UI/RBAC |

O teste de cache Rails modela repositório com cache aquecido. Como `Control.policy` já executa reload, esse teste é defesa adicional, não prova de exploração do query cache real. O defeito do vínculo removido/trocado foi reproduzido separadamente.

## Fotografia histórica, não consulta atual

O pacote 977ab0e registra 436 FAILED, quatro UNKNOWN e 1382 PENDING (1031 em vínculos desativados, 351 READY). `partner_event_deliveries` estava vazio. Não atualizamos esses números: o controle do servidor falhou antes da leitura. Não houve replay, reset de contador ou edição SQL.

| Código / quantidade histórica | O código indica | Para comprovar causa e decidir correção |
|---|---|---|
| GROUP_CENTRAL_SCOPE_CHANGED / 274 | Fence do escopo de grupo mudou | Comparar revisões de grupo/canal/destino/inbox do job com as atuais; não remover fence |
| CHATWOOT_ATTENDANCE_POLICY_REQUIRES_CONFIGURATION / 119 | Política da caixa difere do contrato | Ler greeting/auto-assignment do destino e comparar modo esperado; só depois ajustar configuração autorizada |
| CHATWOOT_INVALID_RESPONSE / 19 | Resposta não satisfaz parser | Correlacionar rota/status/schema e amostra sanitizada; HTML de proxy e fork incompatível são hipóteses |
| CHATWOOT_REQUEST_REJECTED / 9 | Rejeição remota | Verificar status, escopo de credencial e requestId sem divulgar token |
| MEDIA_DOWNLOAD_FAILED / 5 | Download/redirect não concluído | URL de origem válida, timeout, expiração, allowlist e resposta; não liberar domínio arbitrário |
| CHATWOOT_CONVERSATION_ALREADY_BOUND / 5 | Identidade já vinculada | Comparar registro de conversa/canal/contato, sem mover histórico automaticamente |
| MEDIA_SIZE_LIMIT / 2 | Limite de bytes | Conferir tamanho real e limite do canal; não elevar arbitrariamente |
| MEDIA_TYPE_UNSUPPORTED / 2 | Tipo não aceito | Conferir bytes/MIME/provider; extensão não comprova arquivo válido |
| CHATWOOT_CYCLE_CONTACT_CHANGED / 1 | Contato/ciclo divergiu | Ler ciclo e contato atuais, preservar fence e histórico |
| UNKNOWN / 4 | Efeito remoto incerto | Consultar destino por identidade estável e ledger; sem prova, manter indeterminação |

Essas famílias têm implementação em `apps/api/src/modules/integrations/` (`chatwoot-group-worker`, `chatwoot-client`, `chatwoot-worker`, `chatwoot-conversation-cycle`). Nenhuma foi declarada corrigida em produção só pelo seu nome ou quantidade.

## Próxima coleta somente leitura

Restabelecer controle da aba já autorizada ou fornecer export sanitizado via acesso administrativo existente. Coletar: digest efetivo, schema/manifesto, resumo por estado/código/revisão, idade das pendências, vínculo ativo/inativo, estado físico/identidade/entrega separados; depois amostra por família e os quatro UNKNOWN individualmente. Não coletar ENV, prompts, QR, auth state, corpo de cliente ou segredos em relatório. Com esses dados, acrescentar reprodução mínima e teste antes da próxima mudança.
