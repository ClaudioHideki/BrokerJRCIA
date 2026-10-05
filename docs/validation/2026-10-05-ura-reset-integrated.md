# Integração local de URA e redefinição de senha

Data: 05/10/2026. Branch: `codex/broker-ura-reset-integration-20261005`.
Conteúdo inicial equivalente à main `135bd952d0b782d33b22c8f5f88492586dee6f08`.

## Entrega

Os patches de URA nativa e redefinição de senha foram integrados no mesmo código.
O Studio configura um time ou agente da central como destino de transferência.
O worker registra o efeito, confirma o resultado remoto e respeita a prioridade
humana; resultados incertos não autorizam repetir a atribuição automaticamente.
O painel administrativo oferece redefinição de senha com prévia dos vínculos e
revogação das sessões antigas do usuário.

Dos cinco arquivos compartilhados pelos patches, quatro tinham conflitos:
manifesto das migrações, versão exigida pelo runtime, teste do schema e inventário
SQL. A composição de `app.ts` foi mesclada preservando os dois serviços. O manifesto
agora contém 43 migrações, com 0042 antes de 0043 e índices sequenciais.

Os dois cenários de `combined-upgrade.test.ts` falharam no baseline e verificam
que as duas migrações são exigidas. Um histórico com reset isolado é considerado
divergente; não é silenciosamente aceito como uma atualização completa.

## Evidências desta execução

- Build TypeScript e Vite: aprovado.
- Typecheck: aprovado.
- Suíte geral: 258 arquivos, 1.714 testes aprovados.
- API compilada: 2 arquivos, 2 testes aprovados, sem pulos, com PostgreSQL e Redis.
- Bundle web: 11 arquivos, nenhuma ocorrência no verificador de exposição.
- Contratos públicos e licenças do navegador: aprovados.
- OpenAPI: gerado novamente a partir do código integrado.
- Revisão estática independente: nenhum achado acionável confirmado; não substitui os testes.
- Segurança automatizada: 226 rotas verificadas, nenhuma ocorrência dos scanners.
- PostgreSQL/Redis: a execução completa teve 73 arquivos aprovados e dois com
  quatro falhas (471 testes aprovados). Após corrigir fixtures e expectativas,
  os dois arquivos passaram com 29 testes, incluindo uma regressão nova.
  Os 75 arquivos ficam cobertos pelas execuções completa e focada, sem falhas
  remanescentes conhecidas; a suíte completa não foi repetida após esses ajustes.
- Navegador: execução completa com 33 aprovações, duas falhas e cinco pulos
  previstos por seleção desktop/mobile. Após as correções de acessibilidade,
  as duas jornadas de administração passaram em desktop e celular (35 jornadas
  distintas aprovadas no conjunto das execuções, cinco puladas).

As quatro regressões PostgreSQL eram: fixture com grafo publicado vazio (agora
substituída por início/fim válido, com teste separado de rejeição do inválido),
expectativa de INSERT direto em login_sessions, revogada pela 0043, e inventário
de policies anterior aos patches. A matriz de privilégios continua exata e a
verificação de RLS/proprietário/grants foi estendida ao ledger de handoff.

As falhas de navegador detectaram rolagem sem foco no diálogo de senha e contraste
insuficiente do indicador Ativa (4,18:1). A região agora tem nome acessível e foco
por Tab; a cor do indicador foi escurecida. A jornada verifica foco, acessibilidade,
reset e ausência da senha no armazenamento do navegador.

Ambiente: Node 24.19.0, PostgreSQL 16.4, Redis 7.4.0, Docker 29.5.2. Contêineres
exclusivos, dados sintéticos e portas em loopback. A primeira tentativa de integração
foi interrompida após timeouts; os logs do banco mostraram checkpoints de cerca de
20 segundos. A repetição usa PGDATA temporário em memória e dois workers. Essa
execução não comprova durabilidade em disco nem recuperação de backup.

## Limites e sequência

Nada foi publicado ou implantado. Não foram alterados dados ou flags de produção.
O inventário de imagens instaladas, histórico de migrações e backup incluindo Redis
continua como requisito de release. Se 0043 já estiver instalada isoladamente, é
necessário preparar um caminho posterior para URA, sem reescrever história aplicada.

Este incremento prepara a base do atendimento. A unificação do Flow do host ainda
é a próxima entrega: definição/catálogo compartilhados, edição delegada e execução
única no Broker. Não foi alterado o código do JRC Conversas neste incremento.
A homologação final deve ocorrer com o módulo integrado na central, incluindo
menu, captura de resposta, transferência confirmada e prioridade humana.

Chatwoot comum não oferece atribuição compare-and-set; a janela entre consulta e
mutação permanece documentada em `docs/automations/native-handoff.md`. Os testes
locais usam respostas controladas da central e não atestam seu servidor real.
