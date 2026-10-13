# G3a — integração do bot de grupos QR

## Escopo

Composição sobre main a27d2e0: pacote G3a de 49 arquivos revisados, mais renovação de catálogo pelo worker existente. Dependência 0053_flow_delegation e migration 0054_whatsapp_group_automation. A presença da estrutura 0053 não afirma que os módulos nativos P9 estejam instalados ou concluídos.

O grupo conserva seu JID e o participante iniciador; não é convertido em telefone individual. O motor canônico executa início, texto, menu e fim. Ativação explícita, revisão de autoridade, identidade observada e isolamento por empresa são exigidos antes do envio. Uma tentativa incerta não é reenviada automaticamente.

## Evidências reutilizadas

- Candidato original: 57 testes de runtime aprovados na execução que também identificou uma falha de prontidão; após correção, seis testes de estrutura e uma jornada PostgreSQL aprovados. Não representar isso como uma suite integral de 63 testes aprovada.
- Testes focais já observados do candidato: interface 1, ingresso 3, composição 6, comando 1, leitura 5, UNKNOWN 3, rotas/inventário 5 e diagnóstico de identidade 1; TypeScript aprovado.
- Na integração canônica: sete testes em três arquivos de HTTP/rotas/composição aprovados; TypeScript e geração OpenAPI aprovados.
- Renovação adicionada pelo root: cinco testes de serviço aprovados, incluindo recusa de publicação após prazo, mais três testes de comando/composição; TypeScript aprovado. O teste do prazo modela a condição SQL, sem alegar bloqueio físico PostgreSQL medido.
- Revisão independente identificou seleção repetida de caixa sem autoridade e ausência de prazo na gravação final. Ambos os pontos receberam correção; a segunda revisão aprovou o delta e conferiu a preservação das guardas na composição com o roteamento Evolution.
- Bundle web gerado; auditoria de segurança aprovada sem achados CRITICAL/HIGH abertos e varredura dos 11 arquivos do bundle sem achados.

## Correção dos contratos de regressão no CI

O CI do commit 3251463 (execução 38430911475) encontrou dez falhas em sete arquivos: expectativas anteriores de disponibilidade de grupos, quantidade de migrations e assinatura das guardas de autoridade. Foram atualizadas as expectativas para o contrato implementado, mantendo rejeição de flags inválidas e acrescentando normalização de grupo/participante válido. Os sete arquivos afetados passaram localmente: 75 testes aprovados. Este resultado é focal; não substitui o próximo CI consolidado.

## Limites de entrega

G3b (grupos na central), mídia e demais famílias de nós de grupos continuam fora deste corte. A renovação não altera a configuração do provedor, nem comprova capacidade física para 10 mil conexões. As migrações, a imagem e o WhatsApp real ainda precisam da instalação/homologação combinada. A aprovação do CI de a27d2e0 refere-se ao predecessor; não é evidência antecipada deste novo commit.
