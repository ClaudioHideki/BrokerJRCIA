# IA delimitada no Flow

O corte permite gerar texto, classificar em categorias escolhidas, extrair campos de texto/número/booleano e resumir. Usa o motor e a outbox `IO_AI` existentes. Agentes genéricos, ferramentas e schemas manuais não fazem parte da criação de blocos.

## Preparação administrativa

Em Credenciais, um OWNER/ADMIN cadastra o endpoint HTTPS público e a chave do provedor. O segredo é separado da política: modelos aprovados, preços estimados de entrada/saída por milhão de tokens e orçamento mensal em micros. A API não devolve a chave. O catálogo do editor contém apenas nomes, revisões e política, com paginação vinculada à empresa e ao fluxo principal.

Use o identificador exato de modelo retornado pelo provedor, preferindo uma versão fixa. O adaptador exige igualdade entre o modelo solicitado/aprovado e o modelo da resposta para vincular usage ao preço revisado. Um alias que retorne outro identificador conserva UNKNOWN e sua reserva; não há aceitação automática de uma versão ou preço diferente. A compatibilidade exige um único completion, texto, usage inteiro explícito e nenhuma ferramenta. `tool_calls` omitido ou `null` é suportado; valores não nulos são rejeitados. Não foi realizada chamada paga para provar compatibilidade de um fornecedor real.

Preço configurado é uma estimativa na moeda de orçamento definida pela empresa, não uma fatura do fornecedor. Um milhão de micros representa uma unidade dessa moeda; entrada/saída devem usar a mesma moeda. Custos usam arredondamento para cima. O orçamento é compartilhado pelas credenciais da empresa no mês UTC. Alterar política, rotacionar ou revogar muda a revisão; os blocos precisam ser selecionados novamente por nome antes de publicação/despacho.

## Criação e teste

Escolha o bloco, a credencial pelo nome e um modelo aprovado. Configure conteúdo com variáveis, destino da resposta, tempo limite, tokens de saída, tamanho máximo e teto estimado individual. Classificação apresenta categorias; extração apresenta campos e seus tipos. Nenhum JSON ou UUID é necessário nesses formulários.

A publicação verifica a política duas vezes e inclui dependências em subflows. O despacho verifica novamente credencial/revisão/modelo/preço e o conteúdo interpolado antes de reservar o custo máximo. A reserva pertence ao tenant, ao mês UTC e ao ID da outbox, antes de um único POST sem redirects nem retries.

A simulação aceita somente resposta fictícia do bloco atualmente aguardando IA. A resposta segue os mesmos caminhos success/error/timeout/unknown e o mesmo motor. Não chama o provedor e não consome orçamento. Testar uma credencial, quando acionado pelo administrador, consulta o catálogo de modelos; isso não comprova uma conclusão de IA nem substitui homologação autorizada.

## Resultados incertos e consumo

A tela de execução mostra modelo, mês, tokens observados, custo estimado liquidado ou reserva retida. Timeout após despacho, saída/usage inválidos, divergência do modelo, resposta com ferramenta, falha de audit/persistência ou resultado incerto conservam UNKNOWN. Um rótulo manual não libera a reserva nem autoriza reexecutar o POST. Reinício e mudança de mês não criam outra reserva para a mesma outbox.

Uso observado só liquida a reserva na mesma transação que persiste a retomada do motor e confirma a outbox. Falha nessa transação conserva a reserva anterior. Uma falha comprovada antes do transporte pode liberar a reserva na transação terminal. Limpeza segura de outbox já liquidada conserva o custo mensal; as barreiras de lifecycle continuam protegendo UNKNOWN.

Blocos históricos sem `aiConfigVersion` conservam execução/ports anteriores e não recebem quota implícita. A migração `0057_automation_ai_budget.sql` sucede 0056; instalação exige o journal e probes integrados e verificação do deploy completo pela rotina de release. A existência do código ou de uma imagem não confirma instalação no servidor.
