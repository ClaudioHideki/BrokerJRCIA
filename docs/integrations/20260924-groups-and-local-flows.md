# Incremento DEV03: grupos econômicos e conversão de flows locais

Data: 24/09/2026. Este incremento não constitui homologação HTTPS nem publicação.

## Grupos econômicos

`/jrc/grupos` permite à administração global criar grupos e selecionar suas organizações. Suporte consulta; SUPER_ADMIN altera. Os endpoints `/v1/platform/groups` e `/v1/platform/groups/:id/organizations` exigem sessão opaca da plataforma, motivo auditado e, para alterações, Origin exata e CSRF. A vinculação usa revisão otimista e bloqueio de linhas; uma organização só pertence a um grupo.

A migration candidata `0031_economic_groups.sql` cria grupo e associação administrativa sob RLS exclusiva de jrc_platform. Não altera memberships, não concede acesso aos contatos, mensagens ou caixas e não cria uma conta operacional para o grupo. Grupo operacional precisa de organização/conta própria.

## Flows locais do JRC Conversas

O importador identifica exports com engine native, settings ou kind, distinguindo-os do grafo nativo Broker. Converte start/message/variable/end e condições; switch vira cadeia ordenada de condições com comparação normalizada como no JRC. Delay exige revisão de política de interrupção. Captura com timeout, assign com IDs locais, CRM, NICO e demais blocos sem equivalência permanecem explicitamente incompatíveis: não são descartados nem classificados como exatos.

Vínculos, horários, gatilhos e políticas de atendimento não são ativados pela importação. Um marcador persistente bloqueia publicação até revisão. IDs de equipe, agente e caixa não migram para outra empresa. O artefato original continua criptografado no ledger de importações existente. A interface mostra as notas por bloco. Novos exports do Broker usam `jrc-broker-flows/1`, mantendo leitura dos formatos antigos.

Isto entrega conversão verificável de um subconjunto; não é equivalência de todos os blocos, migração automática em lote do banco JRC nem autorização para trocar o motor de uma caixa.

## Evidência

- Broker: suíte completa com 191 arquivos e 1.238 testes aprovados; duas primeiras execuções apontaram referências de OpenAPI/migrations e inventário de políticas que foram corrigidas antes da execução integral verde.
- PostgreSQL: 9 testes de administração aprovados, incluindo duas organizações agrupadas, memberships independentes, exclusividade do vínculo e recusa de papel tenant no schema de grupos.
- JRC: 42 exemplos Rails aprovados, incluindo concessão explícita de pareamento e revogação durante a requisição.
- Não houve pareamento WhatsApp real ou acesso ao LAB: a ferramenta de navegador falhou ao inicializar. A1/A2, A3, A4 e ciclo de vida distribuído continuam com seus critérios próprios de aceite.

Documentação de coordenação DEV02 incorporada até `02ead4a`, sobre a base conciliada `f8e81df`. Nenhuma imagem ou configuração de produção foi promovida.
