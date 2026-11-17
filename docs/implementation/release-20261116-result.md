# Atualização do Broker e Grupo JRC — 16/11/2026

## Resultado

**Publicação e deploy concluídos. Aceite operacional do WhatsApp ainda parcial.**

O JRC foi atualizado primeiro; em seguida, o Broker. As verificações no servidor confirmaram as imagens esperadas, a prontidão dos serviços e a compatibilidade nativa das seis caixas conectadas. Isso não comprova importação completa do histórico nem entrega física de toda mensagem.

## Código e imagens

| Componente | Fonte funcional | Imagem em execução |
|---|---|---|
| JRC / Rails / Sidekiq | `d468beb8744856c4bcaa972ecde4d885b60ee432` | `ghcr.io/claudiohideki/jrc-conversas-lab2@sha256:21dfe92cdde1b2e8c3da838681bec5684bc87261f9aef2d4e39df0510c5128d4` |
| Broker API e workers | `9661910f73faf86971e812cc69fcc3a7d9342af2` | `ghcr.io/claudiohideki/brokerjrcia-api@sha256:31f2c5890c7b7e353ef98ccd2d1fc058479d580b6fc4908da9215dd698b6e050` |
| Broker interface | Mesmo código do Broker API | `ghcr.io/claudiohideki/brokerjrcia-web@sha256:64df750728c785e740ac9bb2c134511422fc2856ef6b1e347b420fdb6fbcc9e4` |

Broker main no momento da promoção: `a6b01ca579d4ebfbcc8ca64eff994844739ccf09`. A diferença para a fonte da imagem é somente o pin do workflow E2E no LAB2 d468, sem alteração de runtime. Commits posteriores contendo apenas este registro documental não mudam as imagens acima.

LAB2 preserva a retirada dos filtros de segmento (`c8efa1d`) e o popup de proposta (`5d57f3c`). A frente Call Center `d648747d`, marcada como WIP/no_release, permaneceu fora da promoção. As duas branches main foram reconferidas antes do deploy, sem atualização concorrente.

## Evidências de teste e publicação

- Broker: [CI ampla](https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/43968595756), [imagens](https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/43968969416), [regressão final](https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/43982483825) e [E2E final com LAB2 d468](https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/43982483924): SUCCESS.
- LAB2: [delivery](https://github.com/ClaudioHideki/jrc-conversas-lab2/actions/runs/43982120349), [Backoffice](https://github.com/ClaudioHideki/jrc-conversas-lab2/actions/runs/43982120316) e [Projetos](https://github.com/ClaudioHideki/jrc-conversas-lab2/actions/runs/43982120413): SUCCESS no SHA d468.
- [Build final LAB2](https://github.com/ClaudioHideki/jrc-conversas-lab2/actions/runs/43984768943): SUCCESS, incluindo identidade interna, conteúdo, Rails/Sidekiq, OCR isolado e smoke repetido no digest publicado. Retry concorrente: uma tentativa/um POST; reentrega: nenhum novo POST. Artefatos runtime 14286384748 e Dockerbuild 14287522620.
- A construção anterior 43981129768 não publicou: identificou uma fixture Cloud com conta inconsistente. O reparo final passou os 39 exemplos iniciais e os 168 exemplos da regressão Cloud. Não foram afrouxados os filtros produtivos por conta.
- Os testes integrados usam transportes/origens sintéticos. Não equivalem a mensagens enviadas por um aparelho real.

## Conferência em produção

- Dokploy: ambos os deploys terminaram em DONE.
- JRC: Rails e Sidekiq conferem com o digest e o SHA interno; init encerrou com código 0; saúde HTTP 200.
- JRC: schema `20261116190000`, tabela de recibos LIVE, índice único de identidade, trigger de imutabilidade e coluna de origem histórica presentes.
- Broker: os nove serviços de API/worker e a interface conferem com as imagens esperadas. API, worker, PostgreSQL e Redis saudáveis.
- Broker: diagnóstico operacional READY, schema compatível `0095_history_retention_guard`, banco acessível, readiness HTTP 200, nenhum erro nessa verificação. Runtime Node v24.19.0 e PostgreSQL 16.4.
- Os mesmos containers de engine WhatsApp e PostgreSQL foram preservados. A engine continua Evolution 2.3.7, digest `1bd8afc4a6cf48822e6cf02469aeae7bd35a12a6b616eacd1291926307f4d339`. A overlay JRC de captura V2 não foi instalada.
- As seis caixas responderam HTTP 200 e `native_supported=true` ao probe de capability. Isso verifica vínculo/autoridade/protocolo; não testa criação de conversa, distribuição, grupos ou mídia.
- Na sessão autenticada validada, Minhas caixas + Todas e histórico carregou 25 → 34 conversas pela rolagem, sem carregamento permanente. Não foram abertas conversas nem enviadas mensagens nesse teste.
- Flow: o seletor corrigido carregou 19 caixas (20 opções incluindo a opção inicial). Nenhuma automação foi publicada ou ativada. A simulação de transferência já havia passado.
- Nenhum novo recibo LIVE estava presente na leitura pós-deploy. O teste com WhatsApp real continua pendente.

## Pendências operacionais

1. **Grupos:** nenhum grupo selecionado nas seis caixas auditadas; há catálogos ausentes/vencidos. Configurar e verificar o mesmo escopo antes de espelhar grupos.
2. **Distribuição:** cinco caixas mantêm autoatribuição legada incompatível com a criação de conversas controladas pelo Broker. Confirmar destino humano e preservar política exclusiva/supervisor antes de alterar; desligar a opção isoladamente pode deixar conversas pendentes sem agente.
3. **Histórico e incerteza:** reconciliar diferenças por identificador e recibo. Tentativas genéricas antigas não ganham idempotência retroativa; não reenviar UNKNOWN indiscriminadamente.
4. **S3:** seis amostras recentes retornaram HEAD 200, mas três áudios antigos retornaram 404 apesar de existirem referências no JRC. Lifecycle respondeu 403 AccessDenied; causa e momento da indisponibilidade não comprovados. A imagem não recupera esses objetos.
5. **Meta oficial:** número CONNECTED, conta APPROVED, saúde AVAILABLE e aplicativo inscrito. A consulta conjunta inclui um campo de faturamento restrito a BSP e falha. Separar essa consulta da prontidão e depois vincular o canal existente ao JRC. A correção Meta e o vínculo não foram feitos nesta release; novo login do CEO não é necessário pela causa diagnosticada.
6. **Flow:** melhorar a distinção entre rascunho, versão publicada e versão ativa por caixa; diagnósticos em português; confirmação da transferência; testes de pausa, horário, timeout e retorno ao humano.

Nenhum backup, dump, restore, expurgo, pareamento, requeue manual, replay em massa, publicação de robô ou alteração de credencial foi executado.

Relatório detalhado local: `output/history-retention-release-20261116/`, com CHECKPOINT.md, POSTDEPLOY-RESULT.json, DIAGNOSTICO-ENTREGA.md, META-OFICIAL-DIAGNOSTICO.md e evidências visuais.
