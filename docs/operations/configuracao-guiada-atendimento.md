# Configuração guiada de atendimento

Este guia descreve o procedimento reutilizável do Broker para uma empresa e uma caixa por configuração. Disponibilidade do assistente, publicação de um robô, vínculo de uma caixa e entrega física de uma mensagem são verificações diferentes.

## Antes de começar

O administrador JRC cria a empresa e habilita o módulo de automações pelo processo administrativo existente. Um proprietário ou administrador da empresa abre **Caixas de entrada → Configuração guiada**. O nome da empresa ativa deve corresponder à instalação que será configurada.

O piloto usa a variável pública de runtime `GUIDED_SETUP_TENANTS`, com UUIDs de organizações separados por vírgula. Vazio desabilita o assistente; `all` libera explicitamente para todas as organizações. O piloto deve conter somente a organização autorizada da Branef. O código não contém um identificador fixo de cliente. Alterar essa variável exige recriar o serviço da API; não altera vínculos existentes.

Os modelos Compose do repositório encaminham essa variável para o container da API. Em um Compose já instalado e personalizado, confira também a seção `api.environment`: ela deve conter `GUIDED_SETUP_TENANTS: ${GUIDED_SETUP_TENANTS:-}`. Preencher somente o Environment do Dokploy não injeta variáveis que o Compose não encaminha. A opção vazia mantém o assistente desabilitado.

## Empresa e destino

Informe um nome para a configuração. Escolha QR ou Meta. Na primeira etapa, confira a empresa e configure a instalação JRC no painel nativo de integração. Use o endereço HTTPS da instalação, a conta e a credencial no formulário protegido. Um destino externo pode depender da aprovação administrativa já existente no Broker.

A credencial de uma instalação não autoriza outra empresa, conta ou caixa. Credenciais permanecem cifradas no cofre existente e não fazem parte de pacotes JSON, URLs, relatórios ou do progresso salvo do assistente.

## WhatsApp

Selecione a conexão pelo nome, ou crie uma conexão pelo formulário nativo. QR exibe o desafio de pareamento; conecte o número autorizado e confira a identidade observada. Trocar de número exige nova conferência e invalida a homologação anterior.

Meta usa o fluxo nativo de conexão e suas permissões de WABA, número e aplicativo. O assistente não substitui essa autorização. Sem um número Meta autorizado para teste, a comprovação física dessa rota permanece pendente mesmo quando os testes com adaptadores passam.

## Caixa e atendentes

Selecione a caixa JRC vinculada à conexão. Use o painel nativo para criar/adotar uma caixa caso necessário. Confira instalação, conta e caixa; IDs numéricos iguais em instalações diferentes não identificam o mesmo recurso.

Marque os atendentes pelo nome e selecione um agente ou equipe como destino humano. O assistente adiciona os participantes selecionados à caixa e confere novamente o catálogo; não remove os demais participantes. Para uma equipe, pelo menos um membro precisa estar elegível na caixa.

## Robô e vínculos

É possível escolher uma versão já publicada na própria empresa ou importar um arquivo. A versão escolhida é explícita; publicar outra versão não troca automaticamente o vínculo da caixa.

O formato portátil nativo é `jrc-broker-package/1`, com `rootKey` e `flows` contendo chaves lógicas, nomes e grafos. Cada importação intencional recebe novas identidades locais. Subfluxos repetidos compartilham a mesma definição dentro do pacote; suas referências são reescritas. O fechamento contém somente dependências acessíveis na empresa de origem. Ciclos, dependências ausentes, versões incompatíveis, profundidade excessiva e arquivos grandes são recusados.

Limites do pacote: até 32 versões/fluxos, 2 MiB no arquivo HTTP, profundidade e tamanho total dos grafos sujeitos aos limites vigentes do motor. Cada grafo também conserva os limites nativos de nós, arestas e bytes. A importação histórica continua disponível por conversão e revisão explícita. Um JSON antigo que referencia subfluxos sem incluir seu conteúdo não se torna um pacote completo sozinho.

**Importar rascunhos** salva todo o pacote atomicamente. Repetir a mesma intenção após timeout devolve o resultado salvo; outro conteúdo com a mesma chave é conflito. Importar não publica, não vincula a caixa e não copia tokens.

Use **Aplicar caixa e destino humano aos rascunhos** para selecionar explicitamente os vínculos comuns a partir da configuração observada no servidor. Essa ação é permitida somente enquanto todos os fluxos do pacote são rascunhos privados ainda não publicados. Credenciais, mídia, etiquetas, atributos e configurações de módulos continuam sendo selecionados nos blocos indicados. Os links abrem o bloco no Flow; salve antes de usar **Voltar à configuração guiada**.

**Publicar pacote** valida e publica primeiro as dependências e depois a raiz. Uma falha conserva as versões já publicadas e permite retomar a operação. Resultado desconhecido exige conferência; não indica que a publicação falhou nem que deve ser repetida cegamente. A publicação não inicia atendimento.

**Exportar pacote portátil** usa a versão publicada selecionada e suas dependências. Remove os campos conhecidos de referências executáveis locais, preservando textos e dados comuns de negócio. Não inclui credenciais do cofre ou mídia binária.

## Conferência, homologação e ativação

1. Clique em **Conferir configuração**. Resolva as pendências de número, identidade, instalação, caixa, atendentes, destino e versão do robô.
2. Defina uma palavra exclusiva com pelo menos oito caracteres e inicie a homologação. Se houver um executor na caixa, a troca exige confirmação explícita e revisão esperada do vínculo atual.
3. O Broker cria uma cópia imutável da raiz com entrada restrita à palavra escolhida, preservando as versões dos subfluxos. O rascunho e os gatilhos da raiz original não são editados por esse teste.
4. De outro WhatsApp, envie a palavra ao número autorizado. Percorra as opções, solicite atendimento humano e assuma a conversa na caixa JRC. Não responda como atendente antes da etapa humana, pois a prioridade humana pausa o robô.
5. Clique em **Verificar teste real**. O servidor consulta registros nativos de entrada, escolhas, entrega confirmada pelo transporte, espelhamento no JRC, transferência confirmada e pausa humana. Uma mensagem somente aceita/enviada não comprova entrega. Informações fornecidas pelo navegador não substituem esses registros.
6. Somente com as verificações aprovadas use **Ativar atendimento**. O servidor revalida identidade, escopo, credenciais, agentes, destino, versão e proprietário da caixa. A ativação vincula a versão original escolhida, separadamente da cópia restrita de teste.

O teste da Branef deve usar a configuração documental com escritas remotas no GLPI desabilitadas. Não habilitar avisos, pesquisas ou abertura de chamados reais como consequência da homologação. A importação de árvores legadas não autoriza reativar chamadas HTTP antigas.

## Retomada, interrupção e manutenção

Recarregar a página conserva o andamento no servidor. Trocar de empresa limpa a tela e descarta respostas atrasadas. A autenticação define o tenant de cada operação; referências de outra empresa são recusadas.

Em caso de timeout, use **Atualizar andamento** e **Conferir e retomar**. A reconciliação lê o proprietário/versões efetivos antes de tentar nova mutação. Uma operação com reserva vigente deve terminar ou expirar antes de ser retomada. Uma execução atrasada perde autoridade quando a reserva é abandonada.

**Interromper teste ou atendimento** retira somente o vínculo pertencente a esta configuração. Um robô instalado posteriormente por outro operador é preservado e causa conflito de revisão. As atribuições humanas e os recursos criados permanecem. Após interromper, revise a configuração e faça nova homologação. Retornar a outra versão usa o vínculo nativo com revisão esperada; não apaga versões ou históricos.

Cancelar uma configuração em edição conserva caixas, agentes e robôs para reutilização. Recursos ativos ou operações desconhecidas precisam ser interrompidos/conferidos antes do cancelamento. Retirar um tenant da lista de disponibilidade esconde o assistente, mas não desativa seu atendimento; use primeiro a interrupção ou o mecanismo nativo de vínculo quando necessário.

## Arquitetura e evidências

### Atualização do schema

A API e os workers não aplicam migrações no startup. Antes de iniciar a revisão que exige `0085_guided_setup`, use o serviço de manutenção com a imagem aprovada, a partir da pasta e do arquivo Compose realmente instalados. Para uma atualização de schema, execute diretamente o migrador:

```sh
docker compose --profile maintenance run --rm --no-deps --workdir /app --entrypoint node migrate --input-type=module -e 'import {runMigrations} from "./apps/api/dist/db/migrate.js"; const url=process.env.MIGRATION_DATABASE_URL; if(!url) throw new Error("MIGRATION_DATABASE_URL required"); await runMigrations(url); console.log("Schema atualizado");'
```

O comando reutiliza a credencial protegida do perfil de manutenção, aplica as migrações pendentes pelo Drizzle e mantém seu journal. O provisionador completo `infra/app/provision.mjs`, usado na instalação inicial, também configura senhas de roles; para atualização use a entrada direta acima. Confira o resultado do migrador, a prontidão do schema e a saúde da API antes de liberar o piloto. Preserve os volumes e as credenciais atuais.

O assistente coordena os serviços existentes; não cria outro motor de mensagens. A migração aditiva `0085_guided_setup` acrescenta manifestos de pacotes e de progresso, com isolamento forçado por organização, restrições de escopo, privilégios limitados e cadastro no ciclo de vida. O processo da API não recebe privilégio de exclusão nessas tabelas.

Reservas e confirmações usam transações curtas. Consultas remotas de prontidão acontecem fora delas. Mutações de proprietário mantêm as travas nativas da caixa, revisão esperada e uma verificação da reserva do assistente na mesma transação. Operações administrativas são atribuídas ao operador efetivo, inclusive quando outra pessoa retoma a configuração.

O relatório da implantação deve registrar SHA da fonte, referências imutáveis das imagens anterior/nova, tenant piloto, serviços recriados e verificações efetivas de runtime. Relate separadamente testes unitários, PostgreSQL/Redis isolados, E2E visual, saúde do runtime e entrega física QR/Meta. Não incluir segredos nem conteúdo de conversas nos artefatos.
