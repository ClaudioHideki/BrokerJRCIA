# Plano P0: handoff cooperativo

Spec: `../specs/2026-10-16-handoff-cooperativo-design.md`. Execução local direta autorizada; sem push, imagem, deploy ou ativação de bot.

1. [x] RED em `apps/api/tests/unit/automation-handoff-readiness.test.ts`: aceitar política de time explicitamente true, continuar rejeitando unknown.
2. [x] RED em `apps/api/tests/unit/native-handoff-service.test.ts`: atribuição automática humana confirmada por validateTarget(team,agent), rejeições por vínculo/credencial e reconciliação sem POST.
3. [x] RED PostgreSQL em `apps/api/tests/integration/native-handoff.test.ts`: callback automático estabelece HUMAN_ACTIVE e operação APPLIED; timeout reconcilia por GET sem repetir POST; intervenção humana bloqueia o restante.
4. [x] Implementar `handoff-readiness.ts`, `handoff-service.ts`, `handoff-repository.ts`; preservar payload do nó e verificações de lease/tenant/ciclo.
5. [x] GREEN unitários, integração focal e typecheck; suite npm test: 408 arquivos, 3123 testes aprovados. Build web completo fica para o fechamento consolidado, pois não há alteração de interface neste incremento.
6. [x] Revisar escopo e diff, registrar evidência e próximas lacunas. Não publicar.

Revisão independente encontrou concorrência importante: o agente B podia substituir A durante a leitura de associação de A. Regressão PostgreSQL reproduziu SENT indevido; o serviço agora fixa o alvo canônico validado somente em memória, e o guard final compara esse alvo à última observação APPLIED sob lock. Divergência mantém UNKNOWN, bot pausado e reconciliação por novas leituras; não repete mutações. GREEN focal: 33 testes. O alvo transitório nunca é reutilizado de uma tentativa persistida anterior.

Interfaces: validateTarget já aceita time+agente para verificar associação, mas o nó permanece com destino único. Repositório de liquidação deve devolver número de revisões de controle esperadas e se houve ativação humana, sem presumir que toda transferência de time deixa agente nulo.

Ruling: o desenho inicial exigia atribuição despachada pelo Broker para qualquer conclusão. Dois testes de integração existentes documentam a conclusão manual do destino durante timeout de abertura. Essa conclusão é segura porque somente lê o resultado final e nunca retoma bot nem despacha outra mutação. Preservar esse contrato com recibo CANONICAL_RECONCILIATION; retirar o novo teste baseado na suposição contrária. Custo se incorreto: recibo precisará distinguir de modo ainda mais visível resultado obtido de autoria do efeito; não há envio ou atribuição adicional.
