# Infraestrutura, release e recuperação

## Estado reconciliado para a continuação da PR #6

Base ea58a897b923fc5889e99ea039b4bd61c385d781; CI41326586560 e workflow de imagens41326614599 concluídos com sucesso na reconciliação desta execução. API: `ghcr.io/claudiohideki/brokerjrcia-api@sha256:df2444b85ae9a5589950c54e74e9b647eb4619e79c4b5816069f5535f43071c4`. Web: `ghcr.io/claudiohideki/brokerjrcia-web@sha256:ce5eeaba1268b376f7d1f4396f3303713323302110608c2e0e333d3a523ed15e`.

Essas imagens não contêm o novo incremento local descrito em 10-INCREMENTO-ORIGEM-CUSTODIA-20261101.md. Nenhuma imagem nova foi gerada/publicada e nenhum servidor foi alterado nesta continuação. O estado atual do Dokploy e seus backups não foi inspecionado; não usar a observação histórica abaixo como estado corrente. Migration0078 aplicada apenas nos bancos sintéticos descartáveis.

## Histórico anterior preservado

Candidata publicada b076e05864c168f88eb303177016543c68583ad7; workflow https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/41320633958 .

API: ghcr.io/claudiohideki/brokerjrcia-api@sha256:2a12022bc5b990682e4a1ee8e885d8588327377a6e03385de4183a5c7d6560a2
Web: ghcr.io/claudiohideki/brokerjrcia-web@sha256:2fb521fcfb0874e2bc6bb7dce8b1d66b607a42f23fd81f8f2ac2b7da3ba86605
SBOM/provenance e assinatura GitHubOIDC gerados no workflow. Não implantadas nesta execução.

Produção observada: API d82eb3c44892 healthy; web2151025cd209 running; PG/Redis healthy,13 containers. Compose main, autodeploy desligado. Imagens ainda fb54ad27… e1485c277… do d1b66a. Mesmos seis blobs de infraestrutura da reconciliação; não houve modificação local de infra nesta execução.

Gate atual: Dokploy Backups mostra No backups configured. Backup externo/restore completo não verificados. Exceção histórica não substitui a missão nova. Antes de deploy: definirRPO/RTO, destino privado cifrado, guardar DB+objetos+sessão+chaves e ensaiar restore isolado. Imagem antiga sozinha não comprova rollback de schema.

Laboratório PG descartável foi separado dos containers locais já existentes. Não reiniciar nem estressar serviços compartilhados. APIs públicas /ready e / retornaram200 via Nodefetch antes da atualização; falha de TLS do PowerShell é limitação do cliente local, não evidência de queda remota.

CI049a410 aprovado. Novoscomponentes posteriores aindaexigemgatesnovos. Oensaio cifradofoireforçado: consultasRLSapósrestoreecomparação dosbytessintéticos, semgarantia deRPOoperacional. Evidências emrestore-drill-reforcado.json. Nenhumbackuprealfoicriado.
