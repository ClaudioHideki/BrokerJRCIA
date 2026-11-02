# Dependências exclusivamente CCLX — fronteira precisa

Uma dependência é exclusiva apenas se a evidência só pode vir do ambiente ou da operação do cliente. “Integração ainda não homologada” não transfere correções JRC para o cliente.

| Evidência exclusiva | O que solicitar | Aceite |
|---|---|---|
| Versão/fork real | Manifesto da instalação, extensões e contrato exposto | Versão identificada e comportamento reproduzido |
| Jobs/PubSub reais | Topologia, semântica de confirmação/retry, observação autorizada | Evento persistido e projeção correta na instalação |
| Grants por operador/loja/inbox | Matriz de acesso e contas de homologação | Permitidos funcionam; cruzamentos/revogação são negados |
| Cópia permanente sob operação CCLX | Retenção, storage, backup e responsáveis | Arquivo recuperado, hash/tamanho iguais e acesso privado |
| Restore operado pelo cliente | Destino e janela autorizados, procedimento e evidência | DB/objetos/checkpoints recuperados dentro do RPO/RTO combinado |

Não pedir dados reais sensíveis para testes que podem usar fixture. Compartilhamento de credenciais deve usar canal apropriado, fora de docs/logs.

## Trabalho compartilhado

Contrato bilateral de evento/ACK/custódia; mapeamento de identidades; conector; compatibilidade; tratamento de retry; reconciliação; janela de retenção; definição de SLO e plano de homologação. Cliente fornece características reais; JRC implementa, testa e documenta sua parte.

## Trabalho interno que continua desbloqueado

Durabilidade da origem Evolution B02, redaction B05, ordem poll/webhook B07, replay B12 e métricas, pools B13, fairness B14, correção de saúde H01, admissão por escopo G01, backups/restore JRC, laboratório PG/Redis/S3, documentação pública, UX e campanha de capacidade. Nenhum desses itens deve ser marcado “exclusivamente CCLX”.

O simulador pode provar commit antesACK, deduplicação, isolamento, falhas, cópia privada e protocolo de custódia internos. Ele não prova a operação real do cliente. Recibo DURABLY_STORED atual é atestação declaratória, com KEEP/physicalStorageVerified=false; não substitui demonstração física do CCLX.

## Critério de entrega

Manter uma coluna para evidência JRC concluída e outra para validação real CCLX pendente. Só liberar jornada conjunta quando a matriz de contrato, erros, autoridade, recuperação e responsabilidades estiver satisfeita. Enquanto aguarda ambiente cliente, completar todo trabalho interno autorizado e publicar limitações exatas.
