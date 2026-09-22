# 08 — Comparação dos motores de fluxo

## Conclusão

O Broker e o JRC Conversas possuem motores distintos. O Broker já cobre o ciclo de vida SaaS do fluxo e o transporte por Agent Bot; o JRC Conversas tem um catálogo operacional mais amplo. Unificar a experiência exige um modelo canônico e adaptadores, sem executar JSON arbitrário de n8n ou Typebot.

| Capability | Broker Flow | JRC Conversas Flow | Reusar conceito? | Portar? | Permanecer JRC? | Novo desenvolvimento? | Evidência/estado |
|---|---|---|---|---|---|---|---|
| Rascunho, versão, publicação e vínculo | Presente | Parcial | Sim | Sim, como autoridade | Não | Compatibilidade | `flows` + migrations 0024/0025 — IMPLEMENTED |
| Mensagem, entrada, menu e condição | Presente | Presente | Sim | Sim | Não | Uniformizar schema | `packages/contracts/src/flows.ts`, `jrc_flows` — IMPLEMENTED |
| Variáveis e encerramento | Presente | Presente | Sim | Sim | Não | Contexto tipado | mesmos módulos — IMPLEMENTED |
| Handoff humano | Presente | Via inbox | Sim | Adaptador | Atendimento | Estado explícito | `flows/chatwoot-service.ts` — IMPLEMENTED |
| Mídia | Ausente no catálogo | Presente | Sim | Sim | Transporte da inbox | Nó nativo | JRC `jrc_flows`, Broker contracts — PARTIAL |
| Contato, etiquetas, atribuição e status | Ausente | Presente | Sim | Como adaptador | Sim | Nós Chatwoot | JRC actions — PARTIAL |
| CRM e Nico | Ausente | Presente | Não no core | Não | Sim | Plugin futuro | JRC services — LEGACY |
| Delay, switch e timeout | Incompleto | Presente | Sim | Sim | Não | Persistência durável | JRC workflow engine — PARTIAL |
| HTTP seguro | Ausente | Limitado | Sim | Conceito | Não | I/O worker + SSRF guard | JRC workflow engine — MISSING |
| Code/QuickJS | Ausente | Sandbox separado | Sim | Conceito | Temporariamente | Sandbox isolado | JRC `services/flows-sandbox` — MISSING |
| Subfluxo | Ausente | Limitado | Sim | Sim | Não | Versão fixa/aciclicidade | JRC workflow engine — MISSING |
| IA | Ausente no core Flow | Agent/Nico | Parcial | API genérica | Nico/CRM | Nós com tools autorizadas | JRC workflow engine — PARTIAL |
| Importação n8n | Equivalentes seguros | Executor de subconjunto | Sim | Conversor | Não | Relatório | Broker import preview/JRC engine — PARTIAL |
| Importação Typebot | Origem configurável | Sem equivalência geral | Parcial | Conversor/adaptador | Não | Decisão de licença | env/docs — CONFIG_ONLY |
| Execução arbitrária n8n/JS | Não | Parcial no legado | Não | Não | Só durante migração | Fora do runtime principal | escopo de segurança — NOT_APPLICABLE |

## Modelo de convergência

1. Definir `AutomationDefinition` canônica, versionada e validada por esquema.
2. Migrar os nós equivalentes sem alterar a semântica publicada.
3. Manter adaptadores para Agent Bot, Chatwoot gerenciado e Chatwoot externo.
4. Importar n8n/Typebot como conversão: cada nó recebe `SUPPORTED`, `DEGRADED` ou `UNSUPPORTED` antes da publicação.
5. Executar integrações externas apenas por nós declarativos e políticas de destino.

## Invariantes do runtime

- Uma mensagem de entrada gera no máximo uma transição efetiva por chave idempotente.
- Cada execução fixa a versão publicada; edições não mudam execuções em andamento.
- Efeitos externos passam pela outbox e registram tentativa, resultado e correlação.
- Timeout, pausa, retomada e handoff sobrevivem a reinício de worker.
- O tenant, canal e inbox são resolvidos no servidor e nunca aceitos apenas do cliente.
