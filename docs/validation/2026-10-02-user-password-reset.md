# Redefinição global de senha pelo superadmin

## Escopo e base

Implementação isolada sobre `135bd952d0b782d33b22c8f5f88492586dee6f08` (baseline informado como implantado). Nenhuma conta real, senha real, banco remoto, push, merge, imagem ou deploy faz parte desta entrega. Os testes usam identidades sintéticas e PostgreSQL temporário de loopback.

A cópia original da URA e seu ZIP não foram modificados. O reset é um patch separado; não inclui a transferência nativa URA.

## Atenção: ordem das migrations e URA pendente

O baseline termina em `0041`. O reset usa nome `0043_user_password_reset`, com índice de journal sequencial imediatamente após o baseline. O número `0042` reservado à URA não significa que ela possa ser aplicada depois: o Drizzle usa `when` e o verificador exige prefixo de hashes/ordem.

**Não aplique o antigo patch/ZIP URA sobre este incremento.** Para instalar URA posteriormente, é obrigatório preparar e testar um novo rebase do incremento URA, renumerando sua migration inédita (por exemplo `0044`), com índice e `when` posteriores ao reset, conciliando os arquivos comuns (journal, runtime schema, app e testes). A compatibilidade funcional não substitui esse trabalho de integração. Não editar migrations já aplicadas nem executar SQL manual para contornar divergência.

O preflight que acompanha a entrega exige o HEAD baseline e árvore rastreada limpa, confere checksum do patch e executa `git apply --check`. Recusa aplicação em base/árvore diferente. Aplicar o patch localmente não é autorização para deploy.

## Desenho de segurança

- Identidade tenant global, separada de `platform_users`; ação exige operador SUPER_ADMIN atual e ativo no serviço, além de sessão/Origin/CSRF na rota.
- Prévia completa, confirmação e-mail e token assinado com domínio específico e prazo de cinco minutos. Alteração de identidade, geração ou vínculos invalida a confirmação.
- Transação única atualiza hash pelo helper existente, revoga autenticação e grava auditoria segura; falha de auditoria causa rollback.
- Nova geração de autenticação protege também JWT já emitido e corridas com autenticação iniciada antes do reset; tokens e sessões permanecem isolados por usuário.
- UI não repete automaticamente mutações, mostra consequência global, limpa segredos em cancelamento/sucesso/erro de prévia e bloqueia duplo envio.
- Credenciais API pertencem à empresa, não à sessão de usuário, e não são alteradas. Requisição autorizada antes do commit pode terminar; requisições seguintes são revalidadas.

## Validação desta cópia

Execução local final em Node.js 24.19.0, dependências fixadas do lockfile, sem serviços externos:

- `npm run build`, `npm run typecheck`, `npm run test:web:bundle`: PASS; bundle com 11 arquivos e zero findings.
- `npm test`: 245 arquivos/1621 testes PASS; quatro testes do único arquivo `tests/dokploy-compose-config.test.mjs` falharam por `spawnSync docker ENOENT` (Docker não instalado). Não é um passe integral do gate.
- PDF de auditoria rasterizado: PASS após configurar cache Fontconfig gravável; não alteramos teste nem ignoramos diagnósticos.
- Integração PostgreSQL real isolada: 10 arquivos/62 testes PASS, incluindo auth-grants, browser-session-switch, refresh-rotation, user-auth-revocation, password-reset, password-reset-upgrade-review, platform, chatwoot-embed-auth, chatwoot-control-auth e runtime-schema-readiness.
- Suíte web: 57 arquivos/352 testes PASS. E2E desktop/mobile expandido e descoberto, mas **não executado em navegador real**: Chromium local bloqueado pelo runtime (`socket() Operation not permitted`), cloud browser negou localhost (`ERR_BLOCKED_BY_CLIENT`). Layout visual/axe/E2E permanecem pendentes.
- Testes compilados: resolução de workspaces PASS (1); entrypoint com PostgreSQL+Redis SKIP (1), pois Redis de teste não disponível.
- OpenAPI regenerado e os seis testes de contrato/reprodutibilidade PASS.
- `security:contracts`, `security:notices`, `security:submodule` e `git diff --check`: PASS.
- Revisão independente: sem bloqueio remanescente após corrigir sessões delegadas; 48 testes PostgreSQL e 45 testes UI/API/token/redaction também passaram em execução independente.

TDD observou rota inexistente (404), campos adicionais não redigidos e sessões/aprovações embed sobrevivendo ao reset antes das correções. Testes de regressão comprovam invalidação global, concorrência nas duas ordens, aprovação/exchange delegado tardio, rollback de senha/geração/seleção por falha de auditoria, confirmação usada uma única vez, isolamento de outro usuário, estados de empresa preservados e upgrade0041→0043 com JWT legado geração0.

Não executados: suite completa de integração dependente de Redis, runtime compilado completo, E2E/inspeção visual, imagens/container, `ci:verify`, auditoria de dependências on-line, homologação de staging/produção e comportamento com usuários/canais reais. Não há alegação de release pronta para produção. Os gates pendentes devem ser concluídos em ambiente autorizado antes de implantar.

## Cutover e recuperação exigidos antes de publicação

A migration e a API nova mudam emissão/revalidação de autenticação. **Não executar rollout misto com instâncias antigas atendendo:** planejar janela coordenada, backup verificado e interrupção/drenagem das instâncias antigas; aplicar a migration pelo migrador e iniciar apenas API nova validada antes de liberar a UI de reset. A antiga API não verifica a geração; a migration também remove inserção direta de seleções pelo papel de autenticação.

**Voltar apenas o código para a API antiga não é um rollback seguro após qualquer reset**, pois ela poderia aceitar JWT anteriormente revogado. Não remover a geração, reaplicar hashes antigos, restaurar sessões antigas ou reverter a migration manualmente. Recuperação precisa preservar a revogação e usar código compatível; plano operacional explícito e validação em staging são condições para implantação. Este pacote não executa migration, reinício, backup ou recuperação.

A revogação é de autenticação humana, incluindo sessões delegadas do módulo embutido e suas aprovações pendentes. Não desconecta números/caixas, não encerra canais de atendimento, não revoga tokens de serviços/integrações nem API keys da empresa. Esses recursos não são sessões de login do usuário.
