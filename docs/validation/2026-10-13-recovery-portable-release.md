# Recuperação isolada — entrega portátil de 13/10/2026

O código de recuperação acompanha a fonte da main e usa o mesmo ledger e adaptador privado da aplicação. Não adiciona um segundo motor de mensagens, uma migration ou um novo serviço ao Compose. Os scripts ficam na fonte Git; esta entrega não os apresenta como comandos já instalados na imagem de produção.

## Provas novas e afetadas

- Ensaio portátil físico: dois arquivos e cinco testes aprovados em 120,93 segundos. Quatro cenários usam PostgreSQL, Redis e MinIO reais e o CLI capture/restore; o quinto verifica o relógio Redis.
- Revisão independente: aprovada após corrigir a soma de todos os artefatos no limite de 64 MiB. O teste novo falhou antes da correção e passou depois.
- Três contratos afetados do CLI aprovados: verify sem conexão, capture com writers não pausados e autorização do restore antes de efeitos. Os 15 contratos originais já tinham passado no corte anterior e não foram repetidos apenas para aumentar contagens.
- Fonte canônica usada no ensaio: main `3f720a2da139a631e3bc71d974cbcc12c76ab68e`, baseline `0052_durable_private_media`, acrescida dos scripts portáteis ainda não publicados durante o teste. O manifesto do ensaio registra `UNPUBLISHED_SOURCE_OVERLAY`; não atribui falsamente os scripts a uma imagem já publicada.

O teste provou restauração do dump em banco vazio, ledger inicialmente idêntico, bytes privados legíveis, negativa de outra empresa, conservação dos prazos Redis e reconciliação por leitura. O PUT incerto com objeto presente foi confirmado por observação; o PUT ausente e o DELETE ainda presente permaneceram UNKNOWN. Depois da restauração, o runtime executou zero PUT, zero DELETE e manteve zero mensagens na outbox.

## Limites e operação

O laboratório aceita apenas recursos próprios em loopback: bancos efêmeros, namespace Redis e bucket MinIO dedicados. O orçamento é 64 MiB agregados, 32 objetos e 128 keys. Artefatos ficam cifrados; HMAC do manifesto e autenticação de todos os arquivos são conferidos antes de efeitos. Uma intenção de restauração é persistida antes do PUT; resultado incerto autoriza observação, sem nova tentativa cega.

A declaração de writers pausados é responsabilidade do operador e não pausa serviços. Hashes do ledger não substituem uma janela consistente. O corte não restaura um cluster vazio com suas roles, o Redis global, as sessões Evolution ou a infraestrutura produtiva. RPO/RTO, capacidade, TLS e recuperação integral continuam no programa. Consulte [o procedimento de laboratório](../operations/recovery-laboratory.md).

Nenhuma alteração foi aplicada ao servidor por esta entrega. O usuário adiou a instalação e as jornadas reais até a conclusão das entregas de código e imagens.
