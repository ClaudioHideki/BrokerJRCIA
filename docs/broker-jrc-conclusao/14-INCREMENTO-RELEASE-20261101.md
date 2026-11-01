# Continuidade, custódia e jornada de conexão — 01/11/2026

Base: `2f1effdfc365592ac9e0f5bbb5bd19b8668ce259`, continuação da PR #6. Este documento descreve o incremento de código; o resultado de publicação e implantação será registrado separadamente após execução. Não é declaração de homologação integral.

## Origem Evolution (B02)

Foram adicionados composição/host/overlay de laboratório que conectam o journal ao construtor e ao processamento das classes completas da fonte Evolution fixada. A captura precede o callback e transporta uma capacidade opaca pós-COMMIT com o tipo notify/append original. O registro de callbacks respeita a ordem de chegada, mesmo quando o COMMIT anterior é lento. O webhook da composição consulta o mesmo registro congelado do host: não pode assumir ownership na captura e liberar o HTTP legado porque uma variável global está diferente ou foi alterada depois.

Os testes de regressão cobrem mutação durante COMMIT, ordem notify/append, decisão local/global, identidade divergente, ausência de proveniência e configuração divergente. A suíte final passou em55/55, zero falhas/skips,70,15s, após as duas correções P1 da revisão independente. O teste de crash usa processos filhos, SIGKILL, PostgreSQL e Broker HTTP reais, com dependências WhatsApp/auth/enriquecimento sintéticas. Não é homologação de sessão física nem substitui a imagem Evolution produtiva.

O staging preserva a árvore upstream e os avisos de licença, verifica sete fontes por hash, copia apenas os dez módulos runtime necessários e gera manifesto. O typecheck completo e o bundle main.ts CJS/ESM passaram em container local limitado. Essa compilação precede as correções de revisão; as classes finais foram recompiladas/testadas e o staging final foi conferido por bytes. Um novo build integral foi condicionado à memória disponível e não iniciado com apenas484MiB livres no host. A primeira configuração multi-entry excedeu o limite de memória; esse resultado não foi omitido. Imagem/runtime completo, ativos opcionais, ownership produtivo, sessões e provisionamento seguro continuam pendentes. O estado UNPROVEN permanece bloqueado.

## Custódia de mídia e worker parceiro (B03/B12)

O novo receptor de laboratório recebe o contrato real do worker parceiro. O harness usa autenticação de API, HMAC, routes, trigger SQL, claim/settle, downloads autenticados, storage e recibo de custódia do Broker reais. Somente a obtenção do conteúdo no provedor e o transporte do destino fixo para loopback são portas sintéticas explícitas.

Uma assinatura inválida produz FAILED terminal, sem reenvio automático. O replay autorizado preserva a identidade do evento. O receptor grava bytes sintéticos no MinIO privado, faz GET/readback e verifica SHA256/tamanho antes do COMMIT do inbox/projeção/recibo; somente depois registra a custódia no Broker e responde. A perda real do socket após COMMIT produz PENDING, retry e uma única projeção/recibo, sem duplicar efeito. A regressão combinada passou em 22 testes, zero skips.

O worker genérico continua considerando qualquer 2xx uma entrega; não valida um ACK estruturado de persistência. O recibo do Broker é uma declaração do receptor, com `physicalStorageVerified=false`; a leitura física independente é evidência do teste, não um novo fato atribuído pela API. A retenção permanece KEEP e não autoriza expurgo. Os bytes de destino do teste são plaintext sintético; o sufixo `.cipher` não demonstra criptografia. Custódia produtiva, criptografia/chaves, provedor e LAB2 reais ainda precisam de homologação.

## Interface da empresa

Lista e detalhe agora recuperam falhas de leitura por retry explícito, sem ficar presos no carregamento. Acesso negado e registro ausente são diferenciados. Tentativas pendentes/incertas de pareamento impedem repetir QR/reconexão; DISCONNECTED/DEGRADED não comprovam término da operação. Somente CONNECTED ou futura prova inequívoca permite retirar esse aviso. O erro CONNECT_RECONCILIATION_REQUIRED também ativa a proteção. O backend mantém a autorização definitiva.

A aba de diagnóstico usa o resumo existente, somente leitura e carregamento sob demanda. Os totais são explicitamente de toda a empresa. Erros não são apresentados como zero falhas; refresh não perde foco e a guarda impede requisições simultâneas. Permanecem os controles de papel e tenant. Testes novos e regressões cobrem esses caminhos; Chromium sintético foi conferido em 320/390/1280, com limitações de contraste mobile registradas. Não se afirma que mocks HTTP homologam engine, API ou sessões reais.

## Verificação local da candidata

A rodada unitária geral terminou com3628 aprovados e1 falha em465 arquivos: a lista exata de abas de BotSetupJourney ainda esperava seis abas. O teste foi corrigido para as sete abas, acrescentando End/Home/foco e ausência de consulta antecipada; o reteste dos três arquivos relacionados passou em31/31. Essa correção não é apresentada como uma segunda rodada geral: o CI do SHA final deve repetir a suíte integral.

Typecheck, build Broker, inspeção do bundle, contratos públicos, avisos/licenças, submódulo e geração OpenAPI sem drift passaram. Auditoria PDF6/6, parceiro QR34/34 e orçamento de pools11/11 passaram. O perfil compiled passou1 e pulou1 caso dependente de banco; esse caso deve rodar no CI com PostgreSQL. Não existe script de lint: `git diff --check` passou. A revisão independente fechou os dois P1 da origem e o P2 de reconexão, sem findings abertos no recorte examinado. Nenhum desses resultados equivale à homologação produtiva dos módulos completos.

## Compatibilidade e escopo

Neste diff sobre2f1effd não foram adicionados endpoints públicos nem removidos contratos, dados ou funcionalidades. Não houve alteração de dependências. A imagem candidata também inclui o trabalho local anterior2f1effd, ainda não implantado: consultar os documentos10/11 para seus contratos e gates. A migration0078 já pertence a essa base local e permanece aditiva. O Dockerfile API/web não incorpora o overlay de laboratório na engine; publicar essas imagens não instala o journal na Evolution.

Backup/dump/restore/políticas foram excluídos expressamente deste incremento. O código existente foi preservado e os workflows registram a exceção somente nesta candidata. Não há prova de recuperação ou perda zero decorrente dessa dispensa.

## Situação dos requisitos maiores

| Item | Situação | Próximo aceite ainda necessário |
|---|---|---|
| B02 | PARCIAL | Imagem engine efetiva, instalação de ownership, sessão/reconexão real controlada |
| B03 | PARCIAL | Custódia produtiva e política de criptografia/chaves; ponta a ponta LAB2 |
| B05 | PARCIAL | Canários de segredo na imagem/coletores efetivos |
| B07 | PARCIAL | Regressão completa e conciliação com a fonte produtiva |
| B12 | PARCIAL | Homologação do receptor real; não confundir partner deliveries com integration_jobs |
| B13 | PARCIAL | Inventário efetivo de pools e medições de utilização/conexões |
| B14 | PARCIAL | Ensaio de fairness com tenant lento e backlog concorrente |
| LAB2 | PARCIAL | Host Rails completo, TLS/permissões, mensagens e mídias, sessão controlada |
| Redesign completo | PARCIAL | Jornadas restantes de administração e empresa, RBAC real e acessibilidade integral |
| 50/400/900 | NÃO VERIFICADO | Piloto autorizado, duração real e carga progressiva mensurada |

Relatórios e logs detalhados desta execução ficam em `output/increment-release-20261101/`; o pacote de entrega deve conter apenas evidências selecionadas e sanitizadas, sem Environment, tokens, dumps, payloads de clientes ou auth state.
