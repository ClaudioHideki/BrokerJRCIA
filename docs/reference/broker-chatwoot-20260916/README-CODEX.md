# Pacote de desenvolvimento - Broker JRC + Chatwoot

Este pacote contem plano e especificação. Não contem patch de aplicacao, secrets, sessões ou acesso a produção.

## Uso

Disponibilize os dois repositórios no ambiente de desenvolvimento do Codex. Coloque `docs/superpowers` e `docs/validation` deste pacote no checkout de planejamento do broker, preservando arquivos existentes. Mantenha `PROMPT-CODEX.md` disponível e envie seu conteúdo ao Codex.

A especificação e o contrato compartilhado ficam no broker. O plano 02 aponta explicitamente para arquivos do JRC Conversas; esses arquivos só podem ser editados no checkout dele. Não colocar o repositório Rails dentro do monorepo Node. O commit das copias de documentos ocorre apenas na branch de desenvolvimento autorizada, nunca na main.

## Ordem

1. Ler a especificação e os AGENTS.md de ambos os repositórios.
2. Executar o plano 01: destinos externos e controle no broker.
3. Executar o plano 02: interface nativa do JRC Conversas.
4. Executar o plano 03: Dashboard App externo, sem tornar o iframe requisito para operar.
5. Preencher a matriz de aceite com evidências reais e limitacoes.

Os planos incluem arquivos existentes, arquivos propostos, interfaces, exemplos de testes, comandos, gates e commits sugeridos. Os trechos de teste são conteúdo a implementar; não são testes executados neste pacote.

Mudanca de HEAD exige comparar o diff antes de editar. Não fazer checkout destrutivo dos commits de referencia nem apagar trabalho local. Se apenas um repositório estiver acessível, concluir as tarefas independentes dele e registrar o limite, sem simular alterações no outro.

Resultado esperado: código incremental verificável nos dois produtos, com envio/recebimento preservados e interfaces de QR autorizadas. Implantacao e piloto com telefone real continuam exigindo credenciais e autorização operacional explícitas.
