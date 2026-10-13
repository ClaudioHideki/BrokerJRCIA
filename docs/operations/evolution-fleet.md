# Distribuição privada de motores Evolution

No Dokploy, a instalação com uma Evolution continua usando somente `infra/dokploy/compose.yaml`. Para vários motores, mantenha um arquivo privado no servidor contendo `EVOLUTION_ENGINES_JSON` e as variáveis de chave referenciadas por ele. Defina `EVOLUTION_FLEET_ENV_FILE` com seu caminho absoluto e inclua `-f ./infra/dokploy/compose.fleet.yaml` depois do Compose principal em todos os comandos dessa instalação. Esse override encaminha o mesmo arquivo à API e aos workers, sem expor as chaves no Git. Não coloque variáveis alheias à frota nesse arquivo.

Após aplicar as migrações, o registro inicial usa o serviço de manutenção do override: `docker compose -p jrc-broker-broker-ophydn -f ./infra/dokploy/compose.yaml -f ./infra/dokploy/compose.fleet.yaml --profile maintenance run --rm fleet-register --first-registration`. Depois inicie a composição normal com os mesmos dois arquivos. Para atualizar estados e orçamentos, omita `--first-registration`. A rede deve permitir que API e workers alcancem os motores configurados; o arquivo não cria servidores Evolution adicionais.

A instalação tradicional, com apenas EVOLUTION_BASE_URL/EVOLUTION_API_KEY e sem registro administrativo, conserva o destino histórico e não recebe quota nova de sessões nem de I/O. A migration0056 fornece o contrato; ela não registra nem distribui sessões automaticamente. Aplicar somente depois de0053/0054/0055 no journal e nos probes consolidados da versão final.

Para optar pela frota, configure EVOLUTION_ENGINES_JSON como objeto privado por ID opaco. Cada entrada aceita baseUrl (origem HTTP/HTTPS sem path/credencial/query), apiKeyEnv e signingKeyEnv (referências a variáveis EVOLUTION_* privadas), generation positiva, sessionBudget explícito, state ACTIVE/DRAINING/DISABLED (default ACTIVE) e operationBudget1–256 (default8). Não forneça essas entradas por API, browser ou webhook. O motor reservado legacy usa o destino atual, generation1 e as variáveis atuais; não pode ser redefinido no JSON.

EVOLUTION_LEGACY_SESSION_BUDGET é opt-in. Sem esse orçamento, o registro mantém o histórico legacy em DRAINING, sem atribuir novas sessões a ele. EVOLUTION_LEGACY_STATE permite definir seu estado administrativo e EVOLUTION_LEGACY_OPERATION_BUDGET seu orçamento de I/O após registro. Esses valores não limitam a instalação tradicional sem registro.

Com a configuração privada idêntica nas réplicas API/workers e uma conexão de manutenção autorizada a SET ROLE jrc_migrator em MIGRATION_DATABASE_URL, execute uma vez:

```
node apps/api/dist/commands/evolution-fleet-register.js --first-registration
```

O comando assume o mesmo perfil NOSUPERUSER/NOBYPASSRLS das migrations, fixa os bindings e snapshots históricos na mesma transação e mostra somente IDs, geração, fingerprint, estados e orçamentos. Em atualizações de estados/orçamentos, execute sem --first-registration. O registro exige a lista completa de motores existentes e não autoriza troca de geração/destino de uma identidade registrada. Uma nova identidade de motor pode atender novas sessões; auth state existente não é transferido. Antes de iniciar réplicas com a nova frota, confirme o registro; configuração explícita sem registro bloqueia I/O, com diagnóstico específico.

Novas instâncias escolhem atomicamente um motor ACTIVE com orçamento disponível, por proporção de bindings existentes e desempate estável. Bindings arquivados mas ainda não purgados continuam contando até a limpeza ser confirmada. DRAINING conserva sessões existentes e bloqueia novas atribuições. DISABLED permite leituras de reconciliação e fatos de entrega históricos; impede novas mutações, download de mídia, catálogo e eventos que concedem nova autoridade. Falha, ausência de configuração ou fingerprint divergente nunca seleciona outro motor.

Todo I/O registrado usa uma lease persistida, orçamento comum por motor e backoff com jitter persistido. Expiração de uma lease de mutação ou falha depois do dispatch conserva UNKNOWN e bloqueia outra mutação até a reconciliação nominada. Uma leitura de status isolada não libera a intenção. As sagas existentes de conexão/provisionamento/desconexão, o ledger QR e o ledger de configuração de eventos fornecem a confirmação nominada. CONFIRMED ou abandono humano já autorizado de uma tentativa QR resolve somente a intenção ligada àquele ledger; não declara que um POST incerto foi reenviado. Ad hoc settings/ativação cujo efeito permaneça incerto continuam bloqueados e exigem análise de manutenção; não existe limpeza automática dessas tombstones nem autorização para repetir o efeito.

Webhooks de motores novos usam signing key/generation/fingerprint/binding derivados no servidor. O escopo histórico legacy permanece igual. Uma geração/configuração antiga não pode alterar conexão, identidade ou conceder autoridade. A ingestão revalida o binding dentro da transação. Mensagens individuais, grupos e mídia usam o mesmo destino persistido e fazem a confirmação final dentro do ledger existente.

A limpeza continua no lifecycle worker atual. Seu snapshot é autenticado pela lease de deleção, tenant/instância/upstream correspondentes e ator corrente, antes/depois de I/O e na confirmação final. O orçamento de I/O é compartilhado com os clientes normais. UNKNOWN requer a reconciliação somente leitura existente; nunca repete DELETE automaticamente. Históricos privados de operação/I/O/cleanup sobrevivem ao purge e não contêm endpoints, API keys, signing keys, telefone ou auth state.

Este corte comprova o contrato em PostgreSQL16.4 e transportes sintéticos. Não comprova instalação no servidor, sessões físicas QR, capacidade por hardware, RPO/RTO ou10.000 conexões. A homologação real permanece uma etapa posterior.
