# Flow: validação operacional e próximos incrementos

Data: 16/11/2026. Escopo: código da candidata, interface autenticada Grupo JRC e simulador sem envio. Nenhuma automação foi publicada, ativada, removida ou vinculada durante esta análise.

## Constatado

| Área | Evidência | Resultado |
|---|---|---|
| Caixas e vínculos | Lista de conexões:19, sendo6 conectadas; automação não selecionada | Conexão não comprova bot ativo nem entrega |
| Automações cadastradas |4 entradas,1 com versão3 publicada e3 rascunhos | Publicação é distinta do vínculo na caixa |
| Seletor de caixas | BoxRoutingPanel solicitava pageSize200; API channels aceita no máximo100 | Defeito reproduzido e corrigido na candidata em carregamento inicial e paginação |
| Regressão do seletor | RED1falha/5aprovados; GREEN6/6 | Testa próxima página, duplicata e isolamento entre empresas |
| Rascunho de homologação | Bloco IA classificar desconectado e configuração incompleta:8 diagnósticos | Bloqueio de validação funciona; isso não identifica o conteúdo da versão3 publicada |
| Modelo de recepção da operadora |17 blocos,21 conexões; validação estrutural aprovada | Ainda rascunho, sem versão publicada |
| Simulação de suporte | Olá → menu → opção2 → relato sintético → transferência simulada para time2 | Caminho aprovado no simulador; nenhuma atribuição real |
| Execuções da homologação | Intervalo10–17/11 UTC sem resultados | Não extrapolar para outras datas/versões/empresas |
| Testes locais de interface |24 testes anteriores em5 suítes aprovados; regressão adicional do seletor aprovada | Não substitui teste do bot com WhatsApp real |

## Capacidades já existentes a preservar

- Rascunho separado de versões publicadas imutáveis; conversas existentes continuam na versão admitida.
- Editor com menu, captura de resposta, horário, condições, variáveis, dados, subflow versionado, HTTPS, IA, mídia, atendimento humano e ações no JRC.
- Perfis por caixa com times/atendentes, revisões de ownership/perfil e ativação explícita.
- Simulação pura (`modules/automations/simulation.ts`): sem injetar transporte, agendamento ou credenciais reais; permite mensagens e avanço de relógio sintéticos.
- Execuções filtráveis por versão/tempo/status/correlação, inclusive reconciliação; conclusão do Flow não equivale a confirmação do efeito externo.

## Prioridades recomendadas

1. **Confiabilidade de configuração:** publicar e conferir a correção do seletor. Mostrar causa específica quando faltam permissão, caixa, integração, perfil ou versão, com ação para corrigir. Não enfraquecer validação da API para esconder erro do frontend.
2. **Publicação clara:** apresentar lado a lado “rascunho atual”, “versão publicada” e “versão ativa em cada caixa”; conservar sessões em andamento. O rótulo Publicada sozinho pode sugerir que o rascunho editável já foi homologado.
3. **Experiência em português:** traduzir diagnósticos de schema/IA para nome do campo e instrução de correção; usar fuso da empresa na busca de execuções com indicação explícita do fuso. Manter identificadores técnicos nos detalhes de diagnóstico.
4. **Homologação de atendimento:** usar o modelo de recepção como base, configurar times por caixa e validar cada destino, ausência/pausa do agente, horário, resposta inválida, timeout, retomada e intervenção humana. Simulação de time2 não comprova que ele é o destino produtivo adequado.
5. **Observabilidade:** correlacionar entrada WhatsApp, execução/bloco, intenção de envio, confirmação do transporte e recibo JRC. Alertar sobre filas antigas, UNKNOWN, mídia pendente e transferência sem confirmação. Não registrar texto, telefone, tokens ou URLs privadas nas métricas.
6. **Reuso entre empresas:** ampliar biblioteca de modelos com variáveis e destinos configurados por caixa; aproveitar subflows/versionamento existentes, sem copiar IDs, credenciais ou regras de outra empresa.

## Próximo aceite físico

Somente após as imagens e os vínculos terem sido conferidos: uma caixa de homologação com humano responsável deve validar texto, grupo, áudio, imagem e documento; resposta inválida/timeout; transferência que silencia o bot; retorno explícito; reinício/reentrega sem duplicação. Publicar o produto não autoriza automaticamente ativar um rascunho em caixas reais.
