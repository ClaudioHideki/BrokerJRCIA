# ADR 0006: Navegação de menus e novo atendimento após resolução

- Status: Aceita
- Data: 2026-11-24

## Contexto

O cliente precisa corrigir uma seleção da URA e retornar ao bot depois de encerrar um atendimento no JRC. Reexecução do Flow não elimina o controle humano persistido no transporte. Outros clientes e atendimentos humanos ativos devem ser preservados.

## Decisão

Duas políticas opcionais, desabilitadas por ausência no bloco inicial. menuNavigationVersion=1 permite 0/voltar nos menus e mantém histórico limitado do caminho, variáveis e pilha de subfluxos para retorno sem executar ações intermediárias. As opções de negócio não são renumeradas. restartAfterResolution=true com reentry=ALWAYS encerra o ciclo físico somente quando a resolução autenticada e atual do JRC pertence ao mesmo tenant, caixa, conexão, conta, destino e credencial.

O encerramento preserva o mapa remoto imutável, o modo humano histórico e os recibos. Não envia mensagens, não retoma mensagens antigas e não altera responsáveis no JRC. A próxima entrada cria outro ciclo BOT, inclusive quando chegar antes da varredura periódica. Operações humanas abertas, observação humana posterior, envios incertos e integrações pendentes impedem o encerramento.

## Consequências e validação

Sem migration ou mudança das configurações de outros clientes. Há uma consulta limitada antes da admissão e uma recuperação periódica. Políticas novas exigem publicação e vínculo explícitos. Testes cobrem retorno, variáveis, menus compartilhados, subfluxo, políticas ausentes, resolução, preservação humana e recibo incerto. PostgreSQL real é gate da CI; homologação física do WhatsApp é evidência separada. Não executar backup, dump, restore ou replay operacional.
