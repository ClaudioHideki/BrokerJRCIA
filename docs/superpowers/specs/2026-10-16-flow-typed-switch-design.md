# Switch tipado no motor único do Flow

Incremento autorizado do programa consolidado. Só candidata local; não publicar nem ativar bots.

Adicionar um bloco `switch`, preservando integralmente a condição textual legada. O bloco escolhe uma entre 1–20 saídas por igualdade estrita de uma variável existente: texto, número finito, booleano ou null. Não converter número em texto, interpretar código, consultar ERP ou emitir efeito externo. Objetos, listas e variável ausente seguem a saída obrigatória `default`; null explícito pode ter seu próprio caso.

Configuração versionada `switchVersion:1`, `variable` segura, casos com `id` estável, `label` e `value` escalar. Valores tipados duplicados são inválidos; texto "1" e número1 são distintos. Saídas `case-ID` e `default` devem estar conectadas antes da publicação. O rótulo pode mudar sem alterar a identidade da saída. Exclusão de caso não deve reconectar nem apagar silenciosamente ligações antigas: o validador apresenta a saída inválida para revisão.

O editor do Broker e suas superfícies embutidas reutilizam o mesmo FlowCanvas, catálogo, contratos e motor. Não criar módulo JRC paralelo nem outra engine. Apenas publicações futuras podem incluir o bloco; nenhuma versão existente é modificada.

Verificação: contrato/configuração/portas, simulação com tipos distintos e fallback, UI de criação/edição e integração com publicação versionada em banco sintético. Regressões atuais de runtime/editor e verificação TypeScript. Sem credenciais, migrations, Compose ou ENV novos.
