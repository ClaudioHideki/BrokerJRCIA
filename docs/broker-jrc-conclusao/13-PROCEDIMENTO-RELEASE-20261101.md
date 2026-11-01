# Atualização restrita da candidata — 01/11/2026

Autorização: atualizar a aplicação Broker após os gates. Não fazer merge na main, modificar credenciais, substituir a Evolution produtiva, conectar números, enviar mensagens ou reprocessar UNKNOWN. Backup/dump/restore não serão executados neste incremento.

## Estado observado antes da atualização

Dokploy usa `ClaudioHideki/BrokerJRCIA`, branch `main`, `infra/dokploy/compose.yaml`, sem Run Command personalizado. O arquivo Compose da candidata foi comparado ao da main sem diferenças. O banco tem 77 migrations; o hash final corresponde ao conteúdo LF de `0077_partner_delivery_replay`. Conferência somente leitura confirmou fsync, full_page_writes e synchronous_commit habilitados. O ledger adicional é `0078_qr_origin_receipts.sql`.

API atual: `ghcr.io/claudiohideki/brokerjrcia-api@sha256:fb54ad27beeb3e7777703959e08a13e0dd5da8b6f101f6d5e56d711d1af484e5`.

Web atual: `ghcr.io/claudiohideki/brokerjrcia-web@sha256:1485c277f2e72d2b85e346d75d77dc5775c262a7cb389ffff16c39fb891059c4`.

Essas observações não são prova de saúde de todas as entregas. O recorte operacional de FAILED, UNKNOWN e PENDING foi registrado separadamente nas evidências privadas da execução. Não alterar seus estados durante esta publicação.

## Sequência

1. Rever diff e testes aplicáveis; consolidar somente os arquivos do incremento. Conferir novamente o HEAD remoto antes do push normal da candidata.
2. Executar CI e o workflow oficial de imagens para o mesmo SHA. `publish=true`, `component=all`. Verificar sucesso, digests, SBOM, proveniência e assinaturas. Não usar uma tag móvel.
3. No Environment, substituir exclusivamente `JRC_API_IMAGE` e `JRC_WEB_IMAGE`. Antes de salvar, comparar todas as demais linhas com o conteúdo completo capturado em memória. Não reconstruir o ENV a partir das linhas visíveis de um editor virtualizado. Não salvar credenciais em evidências.
4. Executar uma única manutenção com a imagem nova: conferir `inspectSchemaStatus` contra todos os hashes e timestamps do manifesto da imagem, admitindo somente77 aplicadas com0078 pendente ou78 já CURRENT. Depois chamar `runMigrations(process.env.MIGRATION_DATABASE_URL)` do módulo compilado `apps/api/dist/db/migrate.js` no serviço `migrate`, com entrypoint `node`, e exigir78 CURRENT na pós-condição. Não chamar `provision.mjs`, que também redefine senhas de papéis. A função de migrations preserva as senhas e aplica o schema com o papel existente `jrc_migrator`.
5. Se utilizado Run Command temporário para essa manutenção, restaurar imediatamente seu valor original vazio. Então executar o deploy padrão. Não reiniciar, trocar imagem ou alterar sessões da Evolution por este procedimento.
6. Conferir count/hash de migrations, readiness, containers, imagens e interface pública. Registrar a evidência de implantação separadamente dos testes locais e do CI.

## Compatibilidade e reversão da aplicação

0078 adiciona um ledger de recibos, RLS, grants restritos e uma entrada no catálogo de ciclo de vida. Não apaga dados. O recibo de origem permanece opt-in; ownership UNPROVEN continua recusado. A imagem de aplicação pode voltar aos dois digests anteriores mantendo o ledger e as obrigações já registradas. Não executar down migration nem apagar recibos/journal. Se a captura de origem vier a ser ativada em uma etapa futura, sua interrupção/reversão exige coordenação própria antes de qualquer troca binária.

A existência desse procedimento não comprova recuperação de dados, RPO/RTO ou ausência de perda. Esta atualização também não homologa sessões reais, LAB2 completo nem capacidade para 50/400/900 números.
