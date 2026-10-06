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

## Atualização em 06/10/2026: bloqueio da imagem por dependência

A correção do vínculo chegou à main em `1c6e49a83db7635671330165df512f169ca974fc`. Seu CI https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/37372981801 foi aprovado, incluindo E2E. A primeira tentativa de imagem, 37373019507, não adquiriu runner hospedado. A repetição https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/37461503650 iniciou e falhou por um motivo diferente.

O usuário forneceu o trecho final: 263 arquivos/1.733 testes PASS, bundle sem achados e submódulo PASS; `npm audit --audit-level=high` bloqueou source-map-js 1.2.1 pelo aviso [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q). O artefato de imagens não existe porque a publicação foi impedida antes do build das imagens. Nenhum log remoto foi baixado.

A correção pontual atualiza somente versão, URL e SHA512 de source-map-js para 1.2.2 no package-lock.json; preserva licença e gates. `npm view source-map-js@1.2.2` confirmou a integridade do lock; audit local RED mostrou uma vulnerabilidade alta e GREEN mostrou zero em todas as severidades. Build limpo, bundle (11 arquivos/nenhum achado) e limite do submódulo passaram. Revisão independente não identificou bloqueios; sua tentativa própria de consulta ao registro não produziu validação TLS utilizável, portanto a integridade externa foi confirmada pelo executor.

Regressão completa após a atualização: 263 arquivos e 1.733 testes PASS em 364,12 segundos; build limpo, bundle e limite do submódulo PASS. O audit atualizado retornou zero vulnerabilidades em todas as severidades. `git diff --check` foi verificado antes do commit. A suíte E2E completa local anteriormente recusada não foi repetida.

O incremento P2 A foi registrado separadamente em `1bd6906`; não faz parte desta correção de segurança. A geração de imagens corrigidas requer o novo commit na main e aprovação do workflow; os digests de 9bc0b7c acima continuam sendo evidência apenas da versão anterior.

## Release intermediário confirmado: 4fe35ba

Main: `4fe35badb475ff5d5ea69b3c91b198b5731a5f29`.

- [CI](https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/37468304706): completed/success.
- [Imagens](https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/37468365833): completed/success.
- Artefato de release: revision correspondente, component all, published true, SBOM true, provenance mode=max e assinatura github-oidc.
- API: `ghcr.io/claudiohideki/brokerjrcia-api@sha256:01176c85eb21ed134d1dbf7d24508abebe64d193bfb475b38a8856b105c8b981`.
- Web: `ghcr.io/claudiohideki/brokerjrcia-web@sha256:d8e43b30c9e44d547e3fdbe8a372852455f3eae26bd62844067bfb12036f0332`.

Essas imagens incluem a retomada P1, a correção do seletor de vínculo e a dependência corrigida. Não incluem P2 A/B nem encerram o programa. Não foi executada implantação no Dokploy; não confundir publicação do artefato com funcionamento real no servidor ou homologação das integrações.
