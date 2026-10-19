# Comandos nativos do Flow — candidata local

O nó `domain` usa o mesmo motor, fila e controle de atendimento do Flow. As três
ações são criar/reutilizar o lead da conversa, criar tarefa e registrar reunião
no CRM da central. Reunião é um registro de agenda; não envia convite nem inicia
ligação. Nenhum destes comandos envia mensagem pública.

## Configuração e compatibilidade

A caixa deve operar com uma central e vínculo verificado de conta, organização,
integração e inbox. A central precisa anunciar `jrc-domain-commands/1`; uma central
antiga ou Chatwoot sem essa extensão continua sem esses comandos. Os quatro
efeitos anteriores conservam seu protocolo e hashes.

O editor busca responsáveis no catálogo da conta. O serviço nativo confirma de
novo permissão CRM, identidade, contato, revisão de atendimento e cobertura
corporativa antes de persistir. Um administrador não ganha cobertura de outra
unidade por ser administrador. A unidade do lead existente é preservada na tarefa
ou reunião; o responsável escolhido também precisa ter acesso ao lead.

Para um lead novo, uma cobertura com uma única unidade ativa fornece a origem.
Quando há várias unidades possíveis e a conversa ainda não tem lead classificado,
a central recusa `domain_business_unit_ambiguous`: classificar o lead no CRM antes
de usar o comando. O sistema não escolhe emissor arbitrariamente. Não confundir
empresa cliente do contato com empresa/unidade operadora.

## Entrega e retomada

O Broker grava a intenção antes do HTTP. A central grava efeito e recibo na mesma
transação. O recibo contém identidade do recurso e evento causal tipado; não é um
atestado de entrega WhatsApp nem uma assinatura global de eventos do CRM.
Resposta incerta mantém `UNKNOWN/WAITING`; a recuperação consulta o recibo
autenticado e não repete cegamente o POST. Intervenção humana impede continuar o
bot mesmo se a consulta confirmar um efeito remoto anterior.

## Atualização futura

Instalar primeiro o adaptador e as migrations aditivas da candidata JRC em ambiente
isolado. Depois aplicar a migration Broker `0068_flow_domain_commands` e usar a
mesma imagem em API e workers. O editor JRC compartilhado deve ser gerado do commit
Broker aprovado. Não publicar grafos novos para imagens antigas que desconhecem o
nó. Não ativar automações como efeito da atualização.

Reverter a migration JRC de resultados após recibos de domínio é deliberadamente
recusado para preservar os fatos gravados. Uma reversão operacional deve manter
o esquema aditivo e os grafos novos isolados até revisão; não há promessa de
rollback destrutivo sem perda.

As validações desta entrega usam dados sintéticos locais. Meta, Chatwoot externo,
qualidade de áudio e carga de 10 mil conexões continuam com aceite próprio.

## Evidência de fechamento local

Suíte geral `npm test -- --maxWorkers=2 --bail=1`:421 arquivos/3221 testes
aprovados. O teste genérico dos nós recebeu a configuração do novo domínio e
continua exigindo configuração válida e efeito IO tipado; nenhuma asserção foi
removida. Catálogo, motor, simulação e Studio:137 testes focais aprovados. A
simulação confirma `simulated:true` sem chamar transporte ou inventar recurso.
Adaptadores:10 testes PostgreSQL aprovados no corte. A revisão de cobertura nativa
passou em22Rails; a regressão consolidada JRC/NICO cobre332 casos executados,
incluindo21 casos de concorrência em rodada própria sem pending.

TypeScript aprovado, bundle11 arquivos/findings[] e auditoria npm zero
vulnerabilidades reportadas. São evidências locais; este documento não atesta CI,
imagem publicada, servidor atualizado ou homologação física.
# Fechamento do CI de integração

O CI39314595063 passou3211+ testes gerais e652 de interface, mas encontrou três expectativas antigas de baseline0065 em testes de readiness. A implementação exige0068. Atualizadas somente essas três expectativas literais; verificações de RLS, grants, constraints e estruturas preservadas. `npm test -- --config vitest.integration.config.ts` nos três arquivos:36 testes aprovados. O CI completo será executado novamente sobre o commit de correção. Código de produção e editor permanecem idênticos ao commit42848bf.
