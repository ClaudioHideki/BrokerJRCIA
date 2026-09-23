# QA das jornadas do Broker JRC — 23/09/2026

## Escopo e resultado

Revisão das 16 capturas enviadas, das rotas e serviços correspondentes e dos testes locais. As capturas mostram produção; as correções deste relatório estão no código da branch `codex/broker-qa-journeys-20260923`. Não houve alteração de dados, envio de mensagens, publicação de imagem ou deploy em produção nesta revisão.

A experiência principal passa a ser **Caixas de entrada → WhatsApp → central de atendimento → Automações JRC**. A implementação usa o runtime próprio existente. As integrações anteriores e seus dados são preservados para recuperação explícita.

## Matriz de problemas e correções

| Evidência nas capturas | Problema | Correção / verificação |
|---|---|---|
| 1: Conversas oferece configuração Typebot | Dois caminhos de automação e configuração técnica sem jornada clara | Retirado o formulário externo; links para Automações JRC e caixas. Templates aparecem apenas no WhatsApp oficial. |
| 2–4: `/legacy/flows`, importação e canvas vazio | Caminho antigo concorrente, rascunho incompleto rejeitado, coordenadas fora da área visível | URLs de flows direcionam para Automações. Recuperação explícita dos dados antigos. Importação automática do formato; salvar rascunho incompleto permitido. Enquadramento de coordenadas negativas/distantes. |
| QA no navegador: importação presa em Processando | Hook HTTP assíncrono retornava reply sem enviar resposta | Corrigidos hooks de importação, credenciais e webhooks. Três testes HTTP reproduziram timeout antes e passaram depois. |
| QA no navegador: editor em desktop/celular | Baixo contraste, ausência de título principal e zoom sobrepondo bloco no celular | Contraste, título e posição da barra corrigidos; verificação axe na jornada. |
| 3: vários blocos importados incompatíveis | Um JSON externo não equivale a um fluxo executável JRC | Relatório de conversão e bloco persistente de revisão obrigatória; publicar/simular bloqueados até adaptar. Proteção também para exportações JRC que encapsulam workflows externos. |
| 5: saúde operacional com nome do motor, códigos e unidades técnicas | Informações pouco úteis ao cliente | Rótulos de serviço WhatsApp, unidades em português e estados operacionais. Códigos de diagnóstico não são apresentados como nome de produto. |
| 6–8 e 16: integração e botão de emissão de chave | Texto pressupunha módulo já instalado dentro da central | Explicação de instalação separada; removidos links para telas presumidas. Jornada disponível de caixa API explicitada. Chave continua restrita à conta e exibida uma vez. |
| 8 e 14: vínculo pausado sem possibilidade de desfazer cadastro | Sem remoção segura de vínculo criado por engano | Excluir vínculo desativado/com falha sem referências. FK protege histórico e vínculos de automação; quando usado, manter pausado. Nunca apaga a caixa remota silenciosamente. |
| 9–13: administração | Ausência de ações diretas de ciclo de vida | Desativar/reativar empresa e acesso do usuário; proteção do último responsável; nova aba Caixas de entrada com arquivamento/restauração auditados. Suporte tem leitura; alterações exigem administrador global. |
| 12: indicadores | Risco de contar o WhatsApp QR duas vezes | Contagem separa instâncias QR e canais oficiais; espelho interno de mensagens não duplica a contagem. |
| 15: canais com transporte/provedor, sem jornada | Cadastro técnico confundido com caixa operacional | Nome, identidade mascarada, estado do WhatsApp, automação e caixa da central. Configuração em três passos. Informações técnicas ficam em detalhe secundário. |
| QA de código: QR em BASE64 | Imagem sem prefixo poderia não renderizar | Normalização para data URL; expiração e atualização do pareamento verificadas. |
| QA de código: cancelamento e retomada | Corridas podiam reativar execução cancelada | Locks/rechecagem de estado no PostgreSQL; timer não ressuscita execução cancelada. Handoff aponta para controle de modo da conversa. |
| QA de código: arquivar e depois ativar por outra rota | Interface sozinha não protegia o recurso | Triggers e verificações no backend impedem reativação de instância arquivada por mensagens, worker, binding ou atendimento. |

## O que cada ação faz

| Recurso | Ação disponível | Efeito e restrições |
|---|---|---|
| Caixa WhatsApp QR | Desconectar | Encerra conexão; cadastro e histórico permanecem. Novo pareamento pode ser necessário. |
| Cadastro QR | Arquivar / restaurar | Retira da lista ativa e libera cota de cadastro. Exige desconexão, ausência de operação/envio pendente ou incerto, automação desvinculada e atendimento pausado. Restaurar verifica limite e não reconecta automaticamente. |
| Automação | Arquivar / restaurar | Preserva versões e execuções. Recusa trabalho ativo ou efeitos pendentes/incertos. Desativa vínculos; restauração não os reativa. |
| Rascunho | Cancelar alterações | Volta ao último rascunho salvo e limpa recuperação local da edição cancelada. |
| Importação | Cancelar importação | Fecha a revisão sem criar uma automação. O artefato de análise já recebido pelo servidor segue a retenção aplicável. |
| Binding de automação | Pausar / retomar novas entradas / desvincular | Controla novas entradas. Execuções iniciadas continuam; devem ser tratadas na lista de execuções. Um vínculo desvinculado é terminal: crie novo vínculo para ativar novamente. |
| Execução | Cancelar / tentar novamente | Cancelar somente fila, espera ou falha, sem envio em andamento/incerto. Cancela esperas e efeitos ainda pendentes atomicamente. Não promete recolher mensagem já enviada. |
| Atendimento | Pausar / retomar | Controla encaminhamento. Preserva entregas pendentes. |
| Vínculo de atendimento | Excluir vínculo sem histórico | Somente desativado/com falha e sem referências. Não exclui conta nem inbox remoto. |
| Empresa | Desativar / reativar | Mantém dados e auditoria. Suspensão e desativação continuam com as políticas operacionais existentes. |
| Usuário de empresa | Desativar / reativar acesso | Não apaga identidade global nem vínculos de outras empresas. Não remove o último responsável ativo. |
| Chaves / credenciais | Revogar / desativar nos módulos existentes | Credencial deixa de autorizar chamadas; histórico preservado. |
| Ativos Meta | Autorização/revogação no fluxo oficial | Não se aplica o arquivamento de instâncias QR. Não foi implementada exclusão de ativos Meta nesta correção. |

A opção segura assumida para cadastros com histórico foi arquivamento/desativação. Exclusão física de empresa, mensagens, arquivos e sessões remotas não é um efeito implícito de nenhum destes botões. Deve seguir procedimento próprio de retenção/exclusão já documentado pela plataforma.

## Verificação

Resultados finais registrados abaixo. Dados sintéticos, PostgreSQL/Redis isolados, provider e atendimento simulados nos testes de navegador. O teste de banco utiliza RLS e papéis reais; não usa o banco de produção.

- Integração PostgreSQL: **44 arquivos, 266 testes passaram**.
- Regressões novas demonstraram falhas antes das correções: rascunho incompleto, importação parcial, origem do canvas, cancelamento concorrente, proteção de arquivamento e QR BASE64.
- Comandos restantes e contagens: ver seção Evidência final no fim deste documento.

## Banco, ambiente e entrega

Esta correção ampla exige a migration aditiva `0030_instance_archive.sql`: coluna de arquivamento, cálculo de cota sem duplicação, proteção de reativação e de referências de atendimento. Não modifica segredos, não concede BYPASSRLS ao runtime, não exige apagar/recriar PostgreSQL ou Redis.

A atualização envolve **API e WEB**. A solicitação anterior de publicar apenas API era para o bug SQL pontual, já corrigido antes desta revisão. Nenhum novo digest é anunciado aqui sem execução de release.

Para publicar esta revisão: revisar/mesclar a branch, passar CI e gerar as duas imagens pelo workflow aprovado; fixar os digests correspondentes no Dokploy. Fazer backup e aplicar a migration pelo serviço `migrate` do compose existente antes de iniciar a versão nova. Preservar volumes, nome do projeto, credenciais, banco e sessões do provider. Não executar `down -v`, `flushall` ou recriar o banco.

O compose já possui `AUTOMATION_RUNTIME_V2_ENABLED`, cujo padrão é `false`. Para usar o caminho principal de automações próprias, a implantação deve habilitar **`AUTOMATION_RUNTIME_V2_ENABLED=true`** nos serviços que compartilham a configuração e manter automation-worker, automation-io-worker e scheduler-worker saudáveis. Esta revisão não alterou o ENV do servidor.

## Pendências que exigem ambiente ou material externo

1. O arquivo JSON completo do fluxo de 62 blocos não foi disponibilizado nesta revisão. A captura é insuficiente para adaptar expressões, Redis, chamadas externas e credenciais. Importadores suportam subconjuntos; não há garantia de equivalência automática.
2. Pareamento real, recebimento e resposta por WhatsApp e JRC Conversas/Chatwoot precisam de homologação com conta autorizada. Os testes automatizados usam adapters simulados.
3. Meta requer o aplicativo JRC, permissões e configuração de Embedded Signup; não foi validada com ativos reais.
4. Módulos nativos dentro da central exigem o repositório/versão do JRC Conversas ou Chatwoot. O Broker oferece as APIs; emitir chave não instala esses módulos. A especificação está em `docs/integrations/jrc-conversas-modulos-broker.md`.
5. Não foi feita exclusão física de ativos Meta, empresas com histórico, contas remotas ou números reais.

## Evidência final

| Verificação | Resultado |
|---|---|
| `npm test` | 189 arquivos, 1.232 testes passaram |
| `npm run test:integration -- --no-file-parallelism` | 44 arquivos, 266 testes passaram |
| Build TypeScript + WEB / OpenAPI | Passaram; OpenAPI regenerado |
| Testes compilados com PostgreSQL/Redis descartáveis | 2 arquivos, 2 testes passaram, incluindo início e encerramento do entrypoint real |
| `playwright test` | 29 passaram; 5 ignorados conforme restrições existentes de desktop/mobile |
| Segurança de contratos / licenças / bundle | Passaram, nenhum achado no bundle |
| `security:release` | PASS, 182 rotas e zero achados de scanner; sem publicação |
| `git diff --check` | Sem erros |
| Revisão independente de código | Achados de concorrência, importação e handoff corrigidos; sem bloqueador residual identificado nos diffs revisados |

O E2E novo executou em desktop e celular: criar QR, obter challenge sintético, observar conectado, importar JSON com coordenadas negativas e campo incompleto, bloquear publicação inválida, corrigir/salvar/publicar, verificar acessibilidade com axe, vincular e desvincular chatbot, desconectar e arquivar, conferir filtro de arquivados. A suíte também cobre portal, administração, duas organizações, autenticação, chaves, integração e atendimento sintéticos. Testes com providers simulados não certificam entrega em serviços reais.

Os testes HTTP novos mostraram três timeouts antes da correção e respostas concluídas depois. Os testes de importação e QR demonstraram também os bloqueios e representação BASE64 corrigidos. Não foram incluídos dados de cliente nem credenciais reais nas fixtures.
