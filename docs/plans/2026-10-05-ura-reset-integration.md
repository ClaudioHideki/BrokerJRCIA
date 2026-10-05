# Integração URA e redefinição de senha

Plano de execução do primeiro incremento do plano aprovado em 2026-10-05.

1. Reutilizar o worktree isolado com conteúdo do baseline 135bd952 e preservar os arquivos locais existentes.
2. Reproduzir em teste a ausência das duas migrações. Integrar os patches de Downloads, preservando os testes e resolvendo os cinco arquivos compartilhados.
3. Executar build, tipos, testes gerais, PostgreSQL/Redis, contratos e verificações de diff. Corrigir regressões do conjunto.
4. Revisar autenticação/revogação e transferência humana em conjunto. Registrar evidências atuais e limitações.
5. Próximo incremento: catálogo e definição compartilhados, sessão delegada de edição e execução exclusiva no Broker. A jornada final será homologada após integrar o Flow no host.

## Decisões

- Migrações locais: baseline 0041 -> 0042 URA -> 0043 reset; índices 41 e 42. Não reescrever migrações antigas.
- Se o servidor já tiver recebido o reset isolado, este caminho não se aplica: inventariar o histórico e preparar uma migração posterior antes do deploy.
- Nenhuma migração, alteração de flags ou implantação em produção faz parte deste incremento.
- O inventário instalado de Broker, host e Evolution e a cobertura de backup Redis continuam pendentes. CI e imagens publicadas não comprovam implantação.
- As validações históricas dos ZIPs não substituem os testes do conjunto integrado.
