# Main, imagens e regressão do vínculo — 2026-10-05

## Publicação confirmada

A main remota foi verificada em `9bc0b7c393f8e23736ece2b75d919a20bd0e185c`.

- CI da main: https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/37368408566 — success.
- Imagens da main: https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/37368415081 — success.
- Artefato `jrc-image-release-9bc0b7c393f8e23736ece2b75d919a20bd0e185c`: revision correspondente, component all, published true, SBOM, provenance mode=max e assinatura github-oidc.
- API: `ghcr.io/claudiohideki/brokerjrcia-api@sha256:6d1d54db4db3a5c2be6c7c12ea6f033fa3e9e4b04ee6eaf0940bad971410fe38`.
- Web: `ghcr.io/claudiohideki/brokerjrcia-web@sha256:c2995635304e7a2a2b20d069957edab649ca50c3d7356662366ca47d40296b9d`.

Essas evidências confirmam publicação no GitHub/GHCR; não confirmam implantação no servidor nem homologação real pelo WhatsApp.

## Por que houve resultados diferentes para o mesmo commit

A execução da branch https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/37368411857 usou o mesmo commit. Build, testes unitários e integração passaram; a etapa E2E falhou na jornada mobile `broker-journeys.spec.ts:22`. O log fornecido pelo usuário mostra 36 aprovados, 5 pulados e 1 falha: o botão Vincular automação ficou desabilitado por 120 segundos.

Na tela, as consultas do catálogo e do vínculo inicial eram paralelas. Uma resposta atrasada com binding null podia apagar a automação que o usuário já selecionara. Essa ordem de respostas foi reproduzida deterministicamente em teste unitário: o seletor perdeu o valor após a resposta. A falha de aquisição de runner das tentativas anteriores é um evento diferente e não explica esta execução.

## Correção isolada

- Preservar a seleção editada pelo usuário ao aplicar a primeira resposta do vínculo.
- Bloquear o vínculo enquanto a revisão atual do canal não foi lida; não inventar ownerRevision.
- Manter o bloqueio se a consulta falhar, com mensagem para atualizar a página.
- Bloquear mudança de seleção durante uma operação em andamento.
- E2E retém a resposta do vínculo até depois da seleção e verifica a preservação antes do envio, em desktop e mobile.

Evidências locais observadas: teste unitário RED → GREEN, suíte Channels 10/10 e E2E da jornada 2/2. Build, typecheck e auditoria do bundle aprovados. Regressão completa da correção isolada: 263 arquivos e 1.733 testes aprovados (381,43 segundos). Revisão independente concluída sem achados bloqueantes. Uma nova execução adicional da suíte E2E completa não foi autorizada; o resultado local disponível da jornada afetada é 2/2, obtido antes de isolar o trabalho P2. O CI da nova main deverá verificar a suíte completa no candidato publicado.

As mudanças do primeiro incremento do P2 foram preservadas separadamente em stash; não estão incluídas nesta correção de release. Nenhuma implantação foi executada.
