# Broker para o JRC Conversas — release 17/09/2026

> Histórico da release de 17/09. O escopo foi ampliado em 18/09 para Flows no
> Broker e caixas Chatwoot externas. Para o candidato atual, consulte
> [Broker independente e Flows](broker-omnichannel.md).

A interface de Flows e o motor de execução desta versão pertencem ao JRC Conversas. O Broker cuida da empresa, instância, pareamento, vínculo à caixa e transporte. O experimento de editor Flows no Broker não faz parte deste candidato. Embed em Chatwoot de terceiros permanece beta desligado.

Esta consolidação parte de `origin/main` a16c1cd e integra ce878f8 (controle, destinos por organização, saúde, QR delegado e integração com JRC). Preserva os nove commits remotos de ajustes de Compose e reúne os treze commits locais de integração. O conflito foi no Compose; as credenciais de administração da plataforma ficaram somente na API, conforme o isolamento já exigido pelo projeto.

## Imagens e atualização

Revise e integre a branch candidata. Execute o workflow **Build reviewed SaaS images** com `publish=false` para validar; depois `publish=true` para publicar a revisão aprovada. As imagens são `ghcr.io/claudiohideki/brokerjrcia-api:<SHA completo>` e `ghcr.io/claudiohideki/brokerjrcia-web:<SHA completo>`. API e worker compartilham a imagem API; web usa a imagem web da mesma revisão.

No Dokploy mantenha a stack, volumes, domínio e segredos atuais. Use o Compose consolidado `infra/dokploy/compose.yaml`. As regras Traefik existentes foram preservadas; compare o Preview Compose com a instalação real. Siga o procedimento de backup/migração de `dokploy-saas.md`. O serviço pontual `migrate` aplica inclusive as migrações novas 0018–0023. Não execute `docker compose down -v` para atualizar.

Variáveis para este escopo:

```dotenv
CHATWOOT_BASE_URL=https://conversas.example.com
CHATWOOT_EXTERNAL_DESTINATIONS_ENABLED=true
CHATWOOT_CONTROL_ENABLED=true
CHATWOOT_EMBED_ENABLED=false
```

`EXTERNAL_DESTINATIONS` é o nome técnico da capacidade de destinos por organização; ela também atende as empresas do próprio JRC. A chave não concede a uma empresa acesso a outra. Aprovação, conta, contexto e tokens continuam separados. Aprove apenas instalações JRC previstas nesta release. Preserve `INTEGRATION_ENCRYPTION_KEY`, chaves de autenticação e credenciais do banco entre deploys.

## Vínculo com o JRC

1. Cadastre a organização e seus usuários. Configure e aprove o destino JRC (origem HTTPS exata, ID da conta e token autorizado).
2. Emita a chave de controle com escopos adequados para a organização; configure-a na conta correspondente do JRC, junto da origem do Broker e do UUID da organização. Não use credencial administrativa global no navegador.
3. No JRC, habilite globalmente e por conta `jrc_broker` e `jrc_flows`. O administrador cria/vincula a instância à caixa e pareia o WhatsApp. Agentes precisam de acesso à caixa e delegação para reconexão.
4. Valide primeiro entrada/saída manual. No Flows do JRC, selecione a caixa e teste o chatbot antes de ativar. Não mantenha Typebot ou outro bot no mesmo canal: esta release não transfere sessões nem arbitra automações concorrentes entre os dois produtos.

O guia completo, com overlay do JRC, chaves, sandbox, sequência de implantação e rollback, fica em `docs/DEPLOY-FLOWS-BROKER.md` no repositório JRC Conversas. Os resultados locais deste candidato ficam em `docs/validation/2026-09-17-jrc-release.md` neste repositório. Não confundir testes com dados sintéticos com homologação de um número WhatsApp real ou deploy no servidor.
