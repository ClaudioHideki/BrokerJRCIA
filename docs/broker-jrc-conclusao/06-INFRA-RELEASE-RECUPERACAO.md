# Infraestrutura, release e recuperação

Candidata publicada b076e05864c168f88eb303177016543c68583ad7; workflow https://github.com/ClaudioHideki/BrokerJRCIA/actions/runs/41320633958 .

API: ghcr.io/claudiohideki/brokerjrcia-api@sha256:2a12022bc5b990682e4a1ee8e885d8588327377a6e03385de4183a5c7d6560a2
Web: ghcr.io/claudiohideki/brokerjrcia-web@sha256:2fb521fcfb0874e2bc6bb7dce8b1d66b607a42f23fd81f8f2ac2b7da3ba86605
SBOM/provenance e assinatura GitHubOIDC gerados no workflow. Não implantadas nesta execução.

Produção observada: API d82eb3c44892 healthy; web2151025cd209 running; PG/Redis healthy,13 containers. Compose main, autodeploy desligado. Imagens ainda fb54ad27… e1485c277… do d1b66a. Mesmos seis blobs de infraestrutura da reconciliação; não houve modificação local de infra nesta execução.

Gate atual: Dokploy Backups mostra No backups configured. Backup externo/restore completo não verificados. Exceção histórica não substitui a missão nova. Antes de deploy: definirRPO/RTO, destino privado cifrado, guardar DB+objetos+sessão+chaves e ensaiar restore isolado. Imagem antiga sozinha não comprova rollback de schema.

Laboratório PG descartável foi separado dos containers locais já existentes. Não reiniciar nem estressar serviços compartilhados. APIs públicas /ready e / retornaram200 via Nodefetch antes da atualização; falha de TLS do PowerShell é limitação do cliente local, não evidência de queda remota.

CI049a410 aprovado. Novoscomponentes posteriores aindaexigemgatesnovos. Oensaio cifradofoireforçado: consultasRLSapósrestoreecomparação dosbytessintéticos, semgarantia deRPOoperacional. Evidências emrestore-drill-reforcado.json. Nenhumbackuprealfoicriado.
