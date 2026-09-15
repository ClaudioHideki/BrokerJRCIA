# Administração JRC — interface atualizada

## Correção

A rota `/jrc` ainda renderizava o layout anterior, fora do tema da console executiva. Ela agora usa o mesmo padrão visual do portal: navegação lateral branca, identidade JRC, ações azuis, cartões, gráficos e tabelas.

O acesso administrativo continua separado dos acessos de clientes. No ambiente local configurado, a entrada usa somente e-mail e senha. As contas e os limites existentes foram preservados.

## Navegação disponível

| Área | Rota | Função |
|---|---|---|
| Dashboard | `/jrc` | Empresas por situação, distribuição por plano, capacidade contratada e empresas recentes |
| Empresas | `/jrc/empresas` | Busca, filtro, cadastro e gestão de cada empresa |
| Usuários e acessos | `/jrc/usuarios` | Papéis e acessos vinculados à empresa selecionada |
| Planos e limites | `/jrc/planos` | Situação da empresa, plano e quatro limites operacionais |
| Monitoramento | `/jrc/monitoramento` | Indicadores armazenados da empresa selecionada |
| Suporte | `/jrc/suporte` | Consulta operacional e registro auditado do atendimento |

O detalhe de cada empresa também oferece essas funções em abas. O motivo do atendimento permanece disponível em uma faixa compacta. A consulta e as alterações continuam usando exclusivamente `/v1/platform`, com cookie administrativo, CSRF, papel e auditoria existentes. SUPPORT consulta dados e registra atendimento; SUPER_ADMIN também cadastra e altera empresas e acessos.

## Dados e limites da leitura

- O dashboard utiliza a lista real retornada pelo servidor, limitada às 200 empresas mais recentes. Ao atingir esse limite, a tela informa a abrangência da consulta.
- Capacidade de conexões e usuários representa a soma dos limites configurados, não o consumo ou a quantidade conectada.
- O monitoramento por empresa mantém a semântica existente: instâncias conectadas e canais Meta, mensagens na fila, falhas de mensagens e eventos recebidos.
- Falhas de carregamento apresentam indisponibilidade. Respostas de uma empresa anteriormente selecionada não substituem os dados da seleção atual.
- Não foram adicionados indicadores financeiros, SLA ou dados fictícios. A integração com os canais mantém o estado documentado na atualização de clientes de teste.

## Verificação

- 13 testes específicos da administração: login, navegação, busca, cadastro, planos, usuários, permissões de suporte, resposta tardia entre empresas, indisponibilidade e teclado no menu móvel.
- Regressão completa da interface: **165 testes aprovados em 24 arquivos**, executados com `npm run test:web -- --maxWorkers=2`. Dois testes de conexões excederam a espera na primeira execução simultânea com o build; passaram isoladamente e na repetição completa com dois processos.
- TypeScript e build de produção aprovados.
- Inspeção do navegador com o administrador real e os dois clientes cadastrados: dashboard com duas empresas ativas; cada detalhe apresenta seu respectivo usuário e limites.
- Desktop em 1440 px e celular em 390 px; menu móvel com Escape e retorno de foco. Corrigido o excesso de largura causado pelo cabeçalho acessível da tabela.
- A inspeção visual não alterou contas, planos ou conexões existentes.

As evidências históricas e pendências gerais do projeto continuam no plano mestre e nos relatórios anteriores. Esta atualização cobre a interface administrativa local.
