# 06 — Infraestrutura atual

O Compose Dokploy contém `web`, `api`, `worker`, `migrate`, `postgres`, `redis` e `evolution`. API e worker usam a mesma imagem; o worker opera em modo automático com shards. PostgreSQL é a fonte durável; Redis atende rate limit/cache/fila curta; Evolution preserva instâncias em volume.

Controles presentes: imagens por digest, containers read-only onde aplicável, `cap_drop: ALL`, non-root na imagem própria, redes backend/internal e egress separadas, healthchecks, limites de CPU/memória, segredos fora do Git.

Gaps para Automation v2:

- worker único mistura mensageria, Flow, Chatwoot, onboarding e media;
- não há automation-worker, I/O worker, scheduler ou sandbox isolado;
- backup Dokploy precisa de destino externo; dump no mesmo volume não é DR;
- não há object storage dedicado para artefatos; avaliar sem introduzir antes de necessidade;
- não há fila externa; PostgreSQL/outbox é suficiente até benchmark contradizer.

Evidência: `infra/dokploy/compose.yaml`, `infra/app/Dockerfile`, `commands/messaging-worker.ts`, workflow `images.yml`.
