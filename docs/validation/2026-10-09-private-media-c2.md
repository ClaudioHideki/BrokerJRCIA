# C2 — mídia privada durável

Incremento do programa aprovado P8, com a migração `0052_durable_private_media`. Não encerra os módulos delegados, grupos com Flow, voz, capacidade física ou homologação final.

## Entrega

O backend opcional S3 mantém objetos privados cifrados e metadados por empresa e canal. A quota reúne mídia histórica inline e reservas privadas. A mídia histórica permanece legível; não há transferência automática de bytes antigos.

Uploads possuem operação persistida, confirmação de integridade e estado incerto reconciliável por leitura. Um resultado `UNKNOWN` não autoriza repetir PUT. Exclusão usa a role de lifecycle, lease e confirmação de ausência remota antes do purge. Repetir um job do Chatwoot não reinicia um upload privado rejeitado.

API, worker de mensagens e worker de lifecycle recebem o mesmo perfil pela configuração privada do Compose. O padrão permanece `postgres`. O perfil validado exige bucket MinIO dedicado e privado, sem versionamento, política de bucket ou Object Lock, e PUT condicional preservando o objeto anterior em caso de colisão. Produção exige HTTPS; o laboratório usa HTTP loopback restrito a testes.

## Verificação do checkout canônico

- Patch de 48 arquivos conferido contra o candidato e revisão independente sem achados críticos ou importantes pendentes.
- Build de TypeScript e WEB aprovado.
- Suíte global de código: 312 arquivos e 2.534 testes aprovados, duração 638,26 s.
- Bundle com 11 arquivos e nenhum achado; contratos públicos, sete notices, fronteira Evolution e auditoria npm sem vulnerabilidades.
- A primeira suíte global PostgreSQL/Redis teve 837 testes aprovados e 13 falhas. Quatro expectativas antigas de baseline foram corrigidas para 0052, conservando o histórico e as verificações estruturais. Os testes QR falharam antes dos cenários por claim ausente; a causa original não foi demonstrada. A fixture passou a utilizar o relógio PostgreSQL, arredondado para a precisão de Date, sem modificar regras de runtime ou repetir o claim.
- Os seis arquivos de integração afetados passaram em nova execução: 71 testes, incluindo os 36 cenários QR e os três cenários de arquivamento concorrente. Essa execução não substitui a suíte global do CI da release.
- MinIO real no checkout canônico: cinco testes aprovados, duração 32,69 s. Foram exercitados PUT condicional, negativa anônima, histórico inline/quota combinada, perda de recibo com reinício, leitura autorizada e limpeza/purge sem repetição de escrita.

O gate de armazenamento usa configuração explícita e falha quando ela falta. CI e workflow de imagens executam o laboratório real com binário MinIO fixado por release e SHA-256 antes de publicar. Aprovação local, CI, imagem publicada e instalação têm evidências distintas.

## Instalação e limites

Procedimento e ENV em [operação de mídia privada](../operations/private-media-minio.md). Tanto o modo `postgres` quanto o modo S3 requerem a migração 0052. Conservar destino e chave de criptografia enquanto existirem objetos; mudar o perfil não migra dados.

O procedimento anterior de backup não coleta automaticamente o bucket. Backup e restauração conjunta de banco, objetos e chaves pertencem ao C5, que continua pendente. O caminho HTTPS, a troca de mídias na central e a limpeza precisam ser homologados no servidor após a instalação.

Não houve novo deploy ou teste real de atendimento neste incremento: o executor de navegador falhou antes de acessar Broker/JRC Conversas. O programa permanece aberto até os cenários de integração e a jornada controlada serem comprovados.
